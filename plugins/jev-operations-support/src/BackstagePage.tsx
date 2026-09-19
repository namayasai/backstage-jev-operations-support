import { useApi, useRouteRef, discoveryApiRef, fetchApiRef, configApiRef } from '@backstage/core-plugin-api';
import { useCallback, useState } from 'react';
import { catalogApiRef, useEntity, entityRouteRef } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef, parseEntityRef, type Entity } from '@backstage/catalog-model';
import { Link } from 'react-router-dom';
import type { EvaluationRequest, EvaluationResult, WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { JevWorkbench, type TechDocsOptions } from './Workbench';
import { AlertInbox, parseAlertNotificationPage } from './AlertInbox';

const TECHDOCS_REF_ANNOTATION = 'backstage.io/techdocs-ref';

function errorMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim();
  if (value.error && typeof value.error === 'object') return errorMessage(value.error);
  return undefined;
}

function retryAfterMessage(value: string | null): string {
  if (!value) return '';
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return ` Retry after ${Math.ceil(seconds)} seconds.`;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return ` Retry after ${Math.max(0, Math.ceil((date - Date.now()) / 1000))} seconds.`;
  return ` Retry according to the server's Retry-After value (${value}).`;
}

/** Convert an HTTP error into a readable message without reflecting HTML or object coercion. */
export async function responseError(response: Response, action: string): Promise<Error> {
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  const message = errorMessage(payload) ?? `${action} (HTTP ${response.status}).`;
  return new Error(`${message}${retryAfterMessage(response.headers.get('Retry-After'))}`);
}

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
}

export function JevPage({ initialText, contextNote, techDocs, showAlerts = true }: JevPageProps) {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const catalog = useApi(catalogApiRef);
  const entityRoute = useRouteRef(entityRouteRef);
  const [view, setView] = useState<'workbench' | 'alerts'>('workbench');
  // Stable callbacks: the alert inbox reloads its list whenever these change identity.
  const evaluate = useCallback(async (input: EvaluationRequest): Promise<EvaluationResult> => {
    const url = await discovery.getBaseUrl('jev-operations-support');
    const response = await fetchApi.fetch(`${url}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw await responseError(response, 'Evaluation failed');
    try { return await response.json() as EvaluationResult; }
    catch { throw new Error('Evaluation returned a non-JSON response.'); }
  }, [discovery, fetchApi]);
  async function loadCandidates(workflow: WorkflowId, term: string) {
    const kind = workflow === 'templates' ? 'Template' : workflow === 'ownership' ? 'Group' : undefined;
    const result = await catalog.queryEntities({
      limit: 20,
      ...(kind ? { filter: { kind } } : {}),
      orderFields: [{ field: 'kind', order: 'asc' }, { field: 'metadata.namespace', order: 'asc' }, { field: 'metadata.name', order: 'asc' }],
      ...(term.trim() ? { fullTextFilter: { term: term.trim(), fields: ['metadata.name', 'metadata.title', 'metadata.description', 'metadata.tags'] } } : {}),
    });
    return result.items.map(entity => ({
      id: stringifyEntityRef(entity), entityRef: stringifyEntityRef(entity),
      title: (entity.metadata.title ?? entity.metadata.name).slice(0, 200),
      description: [entity.metadata.description, entity.kind, ...(entity.metadata.tags ?? [])].filter(Boolean).join(' · ').slice(0, 1500),
    }));
  }
  const loadNotifications = useCallback(async (offset: number, limit: number) => {
    // The optional AWS module returns the signed-in user's own notifications from the
    // standard Notifications backend, with the structured alert details it stores.
    const baseUrl = await discovery.getBaseUrl('jev-operations-support');
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/aws-alerts`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const response = await fetchApi.fetch(url.toString());
    if (response.status === 404) throw new Error('AWS alerts are unavailable: install and configure the optional AWS notifications backend module (jevOperationsSupport.awsNotifications).');
    if (!response.ok) throw await responseError(response, 'AWS alerts could not be loaded');
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error('Notifications returned a non-JSON response.'); }
    return parseAlertNotificationPage(raw);
  }, [discovery, fetchApi]);
  const workbench = <JevWorkbench evaluate={evaluate} loadCandidates={loadCandidates} initialText={initialText} contextNote={contextNote} techDocs={techDocs} renderCandidateLink={candidate => {
    try { const ref = parseEntityRef(candidate.entityRef!); return <Link to={entityRoute({ ...ref, kind: ref.kind.toLocaleLowerCase('en-US') })}>Open {candidate.title} in catalog →</Link>; }
    catch { return <code>{candidate.entityRef}</code>; }
  }} />;
  if (!showAlerts) return workbench;
  return <div>
    <nav className="jev-tabs" aria-label="Operations Support views">
      <button aria-pressed={view === 'workbench'} onClick={() => setView('workbench')}>Operations workbench</button>
      <button aria-pressed={view === 'alerts'} onClick={() => setView('alerts')}>AWS alerts</button>
    </nav>
    {view === 'alerts' ? <AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} /> : workbench}
  </div>;
}

/** Entity context stays separate from the editable document; TechDocs loading is user initiated. */
export function EntityJevContent() {
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
  return <JevPage key={entityRef} showAlerts={false} contextNote={<><div>Service: {entityRef}</div>{entity.metadata.description && <div>Description: {entity.metadata.description}</div>}</>} techDocs={techDocs} />;
}
