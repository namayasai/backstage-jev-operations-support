import { useApi, useRouteRef, discoveryApiRef, fetchApiRef, configApiRef } from '@backstage/core-plugin-api';
import { useCallback, useRef, useState } from 'react';
import { Tab, Tabs, Typography } from '@material-ui/core';
import { Content, Header, Page } from '@backstage/core-components';
import { catalogApiRef, useEntity, entityRouteRef } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef, parseEntityRef, type Entity } from '@backstage/catalog-model';
import { Link } from 'react-router-dom';
import type { Candidate, WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { JevWorkbench, type TechDocsOptions } from './Workbench';
import { ReportTriage } from './ReportTriage';
import { AlertInbox, parseAlertNotificationPage } from './AlertInbox';
import { useJevEvaluate, responseError } from './useJevEvaluate';
import { loadCatalogCandidates, loadSystemOwnerCandidates } from './catalogCandidates';

const TECHDOCS_REF_ANNOTATION = 'backstage.io/techdocs-ref';

// Re-exported so existing imports of `responseError` from this module keep working now that
// the evaluate call (and this helper) live in useJevEvaluate.ts.
export { responseError };

/** Validate a TechDocs page selector and return its safe path segments. */
export function normalizeTechDocsPath(input: string): string[] {
  const value = input.trim();
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error('TechDocs path must be a non-empty relative path.');
  }
  const parts = value.split('/');
  if (parts.at(-1) === '') parts.pop();
  if (!parts.length) throw new Error('TechDocs path must be a non-empty relative path.');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('TechDocs path cannot contain empty, dot, or parent segments.');
  }
  return parts.at(-1) === 'index.html' ? parts.slice(0, -1) : parts;
}

function buildTechDocsPageUrlFromStorageRoot(storageRoot: string, entity: Entity, relativePath: string): string {
  const namespace = entity.metadata.namespace ?? 'default';
  const kind = entity.kind.toLocaleLowerCase('en-US');
  const page = normalizeTechDocsPath(relativePath).map(encodeURIComponent);
  const root = storageRoot.replace(/\/+$/, '');
  return `${root}/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(entity.metadata.name)}/${[...page, 'index.html'].join('/')}`;
}

/** Build the page URL served by the techdocs backend, which nests storage under /static/docs. */
export function buildTechDocsPageUrl(storageBaseUrl: string, entity: Entity, relativePath: string): string {
  return buildTechDocsPageUrlFromStorageRoot(`${storageBaseUrl.replace(/\/+$/, '')}/static/docs`, entity, relativePath);
}

/** Extract readable documentation while dropping navigation and executable/style content. */
export function extractTechDocsText(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  document.querySelectorAll('script,style,nav,header,footer,aside,template,[role="navigation"],[aria-label*="navigation" i]').forEach(node => node.remove());
  const root = document.querySelector('main, article') ?? document.body;
  root.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode('\n')));
  root.querySelectorAll('li').forEach(node => node.appendChild(document.createTextNode('\n')));
  root.querySelectorAll('pre').forEach(node => {
    node.prepend(document.createTextNode('\n'));
    node.appendChild(document.createTextNode('\n'));
  });
  root.querySelectorAll('th,td').forEach(node => node.appendChild(document.createTextNode(' | ')));
  root.querySelectorAll('tr').forEach(node => node.appendChild(document.createTextNode('\n')));
  root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,div,section').forEach(node => node.appendChild(document.createTextNode('\n')));
  return (root.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface JevPageProps {
  initialText?: string;
  contextNote?: React.ReactNode;
  techDocs?: TechDocsOptions;
  showAlerts?: boolean;
  page?: 'alerts' | 'triage' | 'playground';
  /** Restrict the document checks offered here, e.g. on an entity tab. */
  reviewWorkflows?: WorkflowId[];
  /** Quiet period before an automatic check is sent; overridable so tests do not need a real wait. */
  liveDelayMs?: number;
}

const entityReviewWorkflowIds: WorkflowId[] = ['readiness', 'change-risk'];

type View = 'alerts' | 'playground';
// These checks also run in automated integrations. This page lets a person check a draft
// before a PR, handover, or service creation. Incident triage lives with Alerts.
const precheckWorkflowIds: WorkflowId[] = ['readiness', 'change-risk', 'templates', 'ownership', 'search'];
const views: { id: View; label: string }[] = [
  { id: 'alerts', label: 'Alerts' },
  { id: 'playground', label: 'Pre-check' },
];

/** Thrown when the optional AWS module is absent, so the page can open on another view. */
class AlertsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    // The default subclass `name` is inherited as "Error"; the inbox matches on this name to
    // stop polling for good once the module has proven unavailable.
    this.name = 'AlertsUnavailableError';
  }
}

/**
 * Two places, by what the reader came to do: alerts that arrived on their own, and a
 * draft to check before proceeding.
 */
export function JevPage({ initialText, contextNote, techDocs, showAlerts = true, reviewWorkflows = entityReviewWorkflowIds, liveDelayMs, page }: JevPageProps) {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const catalog = useApi(catalogApiRef);
  const entityRoute = useRouteRef(entityRouteRef);
  const [view, setView] = useState<View>(showAlerts ? 'alerts' : 'playground');
  const [opened, setOpened] = useState<View[]>([showAlerts ? 'alerts' : 'playground']);
  const chose = useRef(false);
  function open(next: View) { setView(next); setOpened(current => current.includes(next) ? current : [...current, next]); }
  // Stable callback: the alert inbox reloads its list whenever this changes identity.
  const evaluate = useJevEvaluate();
  const loadCandidates = useCallback((workflow: WorkflowId, term: string) => loadCatalogCandidates(catalog, workflow, term), [catalog]);
  const loadOwners = useCallback(() => loadCandidates('ownership', ''), [loadCandidates]);
  const loadSystemOwners = useCallback((systemRef: string) => loadSystemOwnerCandidates(catalog, systemRef), [catalog]);
  const loadNotifications = useCallback(async (offset: number, limit: number) => {
    // The optional AWS module returns the signed-in user's own notifications from the
    // standard Notifications backend, with the structured alert details it stores.
    const baseUrl = await discovery.getBaseUrl('jev-operations-support');
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/aws-alerts`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const response = await fetchApi.fetch(url.toString());
    if (response.status === 404) {
      // Without the module there is no inbox to land on; open the first view that works instead.
      if (!page && !chose.current) open('playground');
      throw new AlertsUnavailableError('AWS alerts are unavailable: install and configure the optional AWS notifications backend module (jevOperationsSupport.awsNotifications).');
    }
    if (!response.ok) throw await responseError(response, 'AWS alerts could not be loaded');
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error('Notifications returned a non-JSON response.'); }
    return parseAlertNotificationPage(raw);
  }, [discovery, fetchApi, page]);
  const renderCandidateLink = useCallback((candidate: Candidate) => {
    try { const ref = parseEntityRef(candidate.entityRef!); return <Link to={entityRoute({ ...ref, kind: ref.kind.toLocaleLowerCase('en-US') })}>Open {candidate.title} in catalog →</Link>; }
    catch { return <code>{candidate.entityRef}</code>; }
  }, [entityRoute]);
  const renderEntityLink = useCallback((entityRef: string, label: string) => {
    try { const ref = parseEntityRef(entityRef); return <Link to={entityRoute({ ...ref, kind: ref.kind.toLocaleLowerCase('en-US') })}>{label}</Link>; }
    catch { return <code>{label}</code>; }
  }, [entityRoute]);
  const inboxProps = { loadNotifications, evaluate, loadOwners, loadSystemOwners, renderCandidateLink, renderEntityLink };
  const review = <JevWorkbench evaluate={evaluate} workflowIds={reviewWorkflows} loadCandidates={loadCandidates} renderCandidateLink={renderCandidateLink} initialText={initialText} contextNote={contextNote} techDocs={techDocs} liveDelayMs={liveDelayMs} />;
  if (page === 'triage') return <Content><ReportTriage evaluate={evaluate} liveDelayMs={liveDelayMs} /></Content>;
  if (!showAlerts) return review;
  if (page === 'alerts') return <Content><AlertInbox {...inboxProps} /></Content>;
  if (page === 'playground') return <Content><Typography variant="body1" color="textSecondary" paragraph>Check a draft before a pull request, service handover, or service creation. Choose what you want to check, review the findings, and address any gaps before proceeding.</Typography><JevWorkbench evaluate={evaluate} workflowIds={precheckWorkflowIds} loadCandidates={loadCandidates} renderCandidateLink={renderCandidateLink} initialText={initialText} liveDelayMs={liveDelayMs} /></Content>;
  return <Content>
    <Tabs value={view} indicatorColor="primary" textColor="primary" onChange={(_, next: View) => { chose.current = true; open(next); }} aria-label="Operations Support views" style={{ marginBottom: 24 }}>
      {views.map(item => <Tab key={item.id} value={item.id} label={item.label} id={`jev-tab-${item.id}`} aria-controls={`jev-tabpanel-${item.id}`} />)}
    </Tabs>
    {/* A view is mounted on first visit and kept, so switching never discards work in progress.
        `active` gates every unrequested send: a view the reader is not looking at sends and polls nothing. */}
    {opened.includes('alerts') && <div hidden={view !== 'alerts'} role="tabpanel" id="jev-tabpanel-alerts" aria-labelledby="jev-tab-alerts"><AlertInbox {...inboxProps} active={view === 'alerts'} /></div>}
    {opened.includes('playground') && <div hidden={view !== 'playground'} role="tabpanel" id="jev-tabpanel-playground" aria-labelledby="jev-tab-playground"><JevWorkbench evaluate={evaluate} workflowIds={precheckWorkflowIds} loadCandidates={loadCandidates} renderCandidateLink={renderCandidateLink} initialText={initialText} contextNote={contextNote} techDocs={techDocs} liveDelayMs={liveDelayMs} active={view === 'playground'} /></div>}
  </Content>;
}

/** The same views under a Backstage page header, for apps that mount the page as a plain route. */
export function JevStandalonePage(props: JevPageProps) {
  return <Page themeId="tool"><Header title="Pre-check" subtitle="Review a draft before a pull request, handover, or service creation" /><JevPage {...props} page="playground" /></Page>;
}

export function JevAlertsStandalonePage(props: JevPageProps) {
  return <Page themeId="tool"><Header title="Alerts" subtitle="Notifications and Jev assessments" /><JevPage {...props} page="alerts" /></Page>;
}

export function JevTriageStandalonePage(props: JevPageProps) {
  return <Page themeId="tool"><Header title="Triage" subtitle="Assess a reported incident before choosing the first response" /><JevPage {...props} page="triage" /></Page>;
}

/** On a service, the docs are already known and load on their own into the editor; nothing is
 * evaluated until the reader chooses Check now or turns Live on. */
export function EntityJevContent({ liveDelayMs }: { liveDelayMs?: number } = {}) {
  const { entity } = useEntity();
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const config = useApi(configApiRef);
  const entityRef = stringifyEntityRef(entity);
  const annotations = entity.metadata.annotations ?? {};
  const annotation = annotations[TECHDOCS_REF_ANNOTATION];
  const techDocsEntityAnnotation = annotations['backstage.io/techdocs-entity'];
  let unsupportedReason: string | undefined;
  if (techDocsEntityAnnotation) {
    try {
      if (stringifyEntityRef(parseEntityRef(techDocsEntityAnnotation)) !== entityRef) unsupportedReason = `This entity points to TechDocs for ${techDocsEntityAnnotation}; loading another entity's docs is not supported yet.`;
    } catch {
      unsupportedReason = 'This entity has an unrecognised backstage.io/techdocs-entity annotation; TechDocs loading is disabled.';
    }
  }
  const techDocs: TechDocsOptions = {
    entityRef,
    annotation,
    unsupportedReason,
    load: async relativePath => {
      const configuredStorageUrl = config.getOptionalString('techdocs.storageUrl');
      const storageBaseUrl = configuredStorageUrl ?? await discovery.getBaseUrl('techdocs');
      const url = configuredStorageUrl ? buildTechDocsPageUrlFromStorageRoot(configuredStorageUrl, entity, relativePath) : buildTechDocsPageUrl(storageBaseUrl, entity, relativePath);
      const response = await fetchApi.fetch(url, { headers: { Accept: 'text/html' } });
      if (!response.ok) throw await responseError(response, 'TechDocs could not be loaded');
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLocaleLowerCase('en-US');
      // The techdocs backend serves generated pages as text/plain so browsers never render them; the HTML is still extracted inertly below.
      if (contentType && contentType !== 'text/html' && contentType !== 'application/xhtml+xml' && contentType !== 'text/plain') throw new Error('TechDocs returned a non-HTML response. Choose a rendered TechDocs page.');
      let html: string;
      try { html = await response.text(); } catch { throw new Error('TechDocs returned an unreadable response.'); }
      return extractTechDocsText(html);
    },
  };
  return <JevPage key={entityRef} showAlerts={false} reviewWorkflows={['readiness', 'change-risk']} contextNote={<><div>Service: {entityRef}</div>{entity.metadata.description && <div>Description: {entity.metadata.description}</div>}</>} techDocs={techDocs} liveDelayMs={liveDelayMs} />;
}
