import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Card, CardContent, CardHeader, Chip, Divider, FormControlLabel, Grid, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Switch, TextField, Typography, makeStyles } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { evaluationRequestSchema, type Candidate, type EvaluationRequest, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { isEvaluationResult } from './evaluationResult';
import { ResponsePlanSection, type RequestResponsePlan } from './ResponsePlan';
import { FindingList } from './Findings';
import { useLivePreference, type EvaluateOptions } from './useLiveEvaluation';

export const AWS_ALERT_TOPIC = 'jev-aws-alerts';
const alertStates = ['ALARM', 'OK', 'INSUFFICIENT_DATA'] as const;
const evaluationStatuses = ['evaluated', 'failed', 'not-evaluated'] as const;
type AwsState = typeof alertStates[number];
type EvaluationStatus = typeof evaluationStatuses[number];

export interface JevAwsAlertMetadata {
  source: 'aws-cloudwatch';
  context: string;
  awsState: AwsState;
  alarmArn: string;
  region: string;
  evaluationStatus: EvaluationStatus;
  result?: EvaluationResult;
  errorCode?: string;
  /** Owner suggestion made at receipt (`jevOperationsSupport.awsNotifications.ownerSuggestion`).
   * Absent entirely on installs that never enabled it, or for a non-`ALARM` alert. */
  ownerStatus?: EvaluationStatus;
  ownerResult?: EvaluationResult;
  /** The shortlist actually sent (titles only), so a runner-up candidate in the result's
   * probability breakdown can be labelled instead of showing a raw `c0`/`c1` key. */
  ownerCandidates?: { id: string; title: string }[];
  /** The shortlist was shortened or had candidates dropped to fit the shared byte budget. */
  ownerShortened?: boolean;
  ownerErrorCode?: string;
}

export interface AwsAlertNotification {
  id: string;
  /** Standard Backstage Notifications fields, unchanged by this plugin. */
  created?: string;
  updated?: string;
  title: string;
  description: string;
  severity?: 'critical' | 'high' | 'normal' | 'low';
  /**
   * Structured alert context restored by the backend from the module's own table.
   * It is absent when the row expired under the retention policy, was never stored,
   * or could not be read; the alert itself still belongs in the inbox.
   */
  metadata?: JevAwsAlertMetadata;
  /** Details were returned but do not match the contract, so they are not shown. */
  detailsUnreadable: boolean;
  /** When the backend last wrote the structured details for this alert. */
  detailsUpdated?: string;
  /** The stored details carried a result that does not match the evaluation contract. */
  resultUnreadable: boolean;
  /** The stored owner result does not match the evaluation contract or the `ownership` workflow. */
  ownerResultUnreadable: boolean;
}

export interface AlertNotificationPage {
  totalCount: number;
  notifications: AwsAlertNotification[];
  skipped: number;
}

export interface AlertInboxProps {
  loadNotifications: (offset: number, limit: number) => Promise<AlertNotificationPage>;
  evaluate: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  /** Generates response suggestions for a manual re-check on request. Stored receipt results keep their own plan. */
  requestResponsePlan?: RequestResponsePlan;
  /** Catalog teams to choose an owner from. Without it, no owner suggestion is offered. */
  loadOwners?: () => Promise<Candidate[]>;
  renderCandidateLink?: (candidate: Candidate) => ReactNode;
  /** How often the list is refreshed in the background; 0 turns it off. */
  pollMs?: number;
  /** Assess an active alarm that arrived without a Jev result as soon as it is opened. */
  autoCheck?: boolean;
  /** Whether this inbox is the view the reader is currently looking at. Hidden views poll and assess nothing. */
  active?: boolean;
  /** `false` forces automatic sends off for this component regardless of the reader's preference; omitted or `true` follows the reader's preference. */
  live?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Notifications may serialize a timestamp as a Date; only a readable instant is kept. */
function timestampValue(value: unknown): string | undefined {
  const raw = value instanceof Date ? value.toISOString() : stringValue(value);
  if (!raw) return undefined;
  return Number.isNaN(new Date(raw).getTime()) ? undefined : raw;
}

/** Concise, timezone-explicit receipt time: locale formatting would vary per reader. */
function instantLabel(value: string): string {
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The stored owner result must also be an `ownership` evaluation: any other workflow is not a stored owner suggestion. */
function isOwnerResult(value: unknown): value is EvaluationResult {
  return isEvaluationResult(value) && value.workflow === 'ownership';
}

/**
 * Defensive, best-effort parse of the stored owner shortlist: an array of at most 20
 * records with a string `id` and `title`. This is supplementary display data, not a
 * safety-relevant contract like `ownerResult`, so a malformed value is silently
 * ignored (falling back to raw `c0`/`c1`-style keys being shown as "Candidate N" by
 * `Findings.tsx`) rather than flagged as unreadable or hiding anything.
 */
function isOwnerCandidateList(value: unknown): value is { id: string; title: string }[] {
  return Array.isArray(value) && value.length <= 20 && value.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string');
}

/** Parse the structured details the backend restored, or report them as unreadable. */
function parseDetails(metadata: Record<string, unknown>): { metadata: JevAwsAlertMetadata; resultUnreadable: boolean; ownerResultUnreadable: boolean } | undefined {
  if (metadata.source !== 'aws-cloudwatch' || !alertStates.includes(metadata.awsState as AwsState) || !evaluationStatuses.includes(metadata.evaluationStatus as EvaluationStatus)) return undefined;
  const context = stringValue(metadata.context);
  const alarmArn = stringValue(metadata.alarmArn);
  // CloudWatch may omit the region; the backend forwards it as an empty string.
  if (!context || !alarmArn || typeof metadata.region !== 'string') return undefined;
  // An unusable result must not hide the alarm itself; the AWS state stays the authoritative signal.
  const result = isEvaluationResult(metadata.result) ? metadata.result : undefined;
  // Owner fields are absent entirely on installs that never enabled owner suggestion; only a
  // present-but-unreadable ownerStatus is dropped rather than shown as something it is not.
  const ownerStatus = evaluationStatuses.includes(metadata.ownerStatus as EvaluationStatus) ? (metadata.ownerStatus as EvaluationStatus) : undefined;
  const ownerResult = isOwnerResult(metadata.ownerResult) ? metadata.ownerResult : undefined;
  const ownerCandidates = isOwnerCandidateList(metadata.ownerCandidates) ? metadata.ownerCandidates : undefined;
  return {
    resultUnreadable: metadata.result !== undefined && !result,
    ownerResultUnreadable: metadata.ownerResult !== undefined && !ownerResult,
    metadata: {
      source: 'aws-cloudwatch',
      context,
      awsState: metadata.awsState as AwsState,
      alarmArn,
      region: metadata.region.trim(),
      evaluationStatus: metadata.evaluationStatus as EvaluationStatus,
      ...(result ? { result } : {}),
      ...(stringValue(metadata.errorCode) ? { errorCode: stringValue(metadata.errorCode) } : {}),
      ...(ownerStatus ? { ownerStatus } : {}),
      ...(ownerResult ? { ownerResult } : {}),
      ...(ownerCandidates ? { ownerCandidates } : {}),
      ...(metadata.ownerShortened === true ? { ownerShortened: true as const } : {}),
      ...(stringValue(metadata.ownerErrorCode) ? { ownerErrorCode: stringValue(metadata.ownerErrorCode) } : {}),
    },
  };
}

function parseNotification(row: unknown, index: number): AwsAlertNotification | undefined {
  if (!isRecord(row)) return undefined;
  const payload = isRecord(row.payload) ? row.payload : row;
  if (payload.topic !== AWS_ALERT_TOPIC) return undefined;
  const title = stringValue(payload.title) ?? stringValue(row.title);
  // Without a title there is nothing honest to list; everything else may be missing.
  if (!title) return undefined;
  const metadataRoot = isRecord(payload.metadata) ? payload.metadata : undefined;
  const raw = metadataRoot && isRecord(metadataRoot.jevOperationsSupport) ? metadataRoot.jevOperationsSupport : undefined;
  const details = raw ? parseDetails(raw) : undefined;
  const description = stringValue(payload.description) ?? stringValue(payload.reason) ?? stringValue(row.description) ?? '';
  // Backstage Notifications reports `created`, and `updated` when the row itself was rewritten.
  const created = timestampValue(row.created);
  const updated = timestampValue(row.updated);
  return {
    // The index keeps ids unique within a page when the notification service omits one.
    id: stringValue(row.id) ?? `${title}:${created ?? ''}:${index}`,
    created,
    ...(updated && updated !== created ? { updated } : {}),
    title,
    description,
    ...(['critical', 'high', 'normal', 'low'].includes(String(payload.severity)) ? { severity: payload.severity as AwsAlertNotification['severity'] } : {}),
    ...(details ? { metadata: details.metadata } : {}),
    detailsUnreadable: Boolean(raw) && !details,
    ...(raw && timestampValue(raw.updatedAt) ? { detailsUpdated: timestampValue(raw.updatedAt) } : {}),
    resultUnreadable: details?.resultUnreadable ?? false,
    ownerResultUnreadable: details?.ownerResultUnreadable ?? false,
  };
}

/** Validate the small notification contract while dropping malformed rows safely. */
export function parseAlertNotificationPage(raw: unknown): AlertNotificationPage {
  if (!isRecord(raw) || !Array.isArray(raw.notifications) || typeof raw.totalCount !== 'number' || !Number.isFinite(raw.totalCount) || raw.totalCount < 0) throw new Error('Notifications returned an invalid response.');
  const notifications: AwsAlertNotification[] = [];
  raw.notifications.forEach((row, index) => {
    const parsed = parseNotification(row, index);
    if (parsed) notifications.push(parsed);
  });
  return { totalCount: Math.floor(raw.totalCount), notifications, skipped: raw.notifications.length - notifications.length };
}

function statusLabel(status: EvaluationStatus): string {
  return status === 'evaluated' ? 'Evaluated' : status === 'failed' ? 'Jev evaluation failed' : 'Jev not evaluated';
}

function storedResultNote(notification: AwsAlertNotification, metadata: JevAwsAlertMetadata): string {
  if (notification.resultUnreadable) return 'The stored Jev result does not match the evaluation contract, so it is not shown. The AWS state above is unaffected.';
  if (metadata.evaluationStatus === 'evaluated') return 'This alert is marked as evaluated but carries no stored result.';
  if (metadata.evaluationStatus === 'failed') return 'Automatic evaluation failed for this alert, so no result was stored.';
  if (metadata.errorCode === 'jev-demo-mode') return 'This backend runs in demo mode, so no automatic evaluation was made for this alert.';
  return 'No automatic Jev result is stored on this alert.';
}

/**
 * The alert stays visible without its stored context. Nothing about the AWS state is
 * invented from the notification text, and no re-check is offered without a context.
 */
function missingDetailsNote(notification: AwsAlertNotification): string {
  const cause = notification.detailsUnreadable
    ? 'The stored alert details could not be read.'
    : 'The stored alert details are unavailable: they may have been removed by the backend retention policy, or never written.';
  return `${cause} The alarm state, context, and any Jev result cannot be shown for this alert, and a re-check is not offered. The notification above is unchanged.`;
}

/**
 * One place mapping the owner suggestion's stable error codes to a readable sentence.
 * This must cover every code in the backend's `awsAlertOwnerErrorCodes` (see
 * `plugins/jev-operations-support-aws-notifications/src/index.ts`); a test in
 * `AlertInbox.test.tsx` checks that coverage.
 */
export const ownerErrorMessages: Record<string, string> = {
  'jev-not-configured': 'No Jev API key is configured, so no owner was suggested automatically for this alert.',
  'jev-demo-mode': 'This backend runs in demo mode, so no owner was suggested automatically for this alert.',
  'incident-not-evaluated': 'Automatic owner suggestion did not run because the automatic incident evaluation for this alert did not succeed.',
  'no-catalog-groups': 'No catalog Group entities were available to suggest an owner from.',
  'catalog-unavailable': 'The catalog could not be read when this alert was received, so no owner was suggested.',
  'evaluation-capacity-reached': 'The per-process Jev capacity was full when this alert was received, so no owner was suggested.',
  'alert-context-too-large': 'The alarm context alone exceeded the evaluation size budget, so no owner was suggested.',
  'invalid-owner-request': 'The candidate list could not be fitted for this alert, so no owner was suggested.',
  'jev-busy': 'Jev was busy when this alert was received, so no owner was suggested.',
  'jev-error': 'The automatic owner suggestion call failed when this alert was received.',
  'evaluation-pending': 'The automatic owner suggestion for this alert has not completed yet.',
};

/** A plain sentence explaining a `failed` or `not-evaluated` stored owner status. */
function ownerStatusNote(notification: AwsAlertNotification, metadata: JevAwsAlertMetadata): string {
  if (notification.ownerResultUnreadable) return 'The stored owner suggestion does not match the evaluation contract, so it is not shown.';
  if (metadata.ownerErrorCode && ownerErrorMessages[metadata.ownerErrorCode]) return ownerErrorMessages[metadata.ownerErrorCode];
  return metadata.ownerStatus === 'failed' ? 'Automatic owner suggestion failed for this alert.' : 'No automatic owner suggestion is stored on this alert.';
}

/**
 * List-row chip: a stored owner suggestion is worth a glance only when its single
 * finding is a confident `pass` naming a candidate. A `review` finding (low
 * confidence, or the model chose "none") shows nothing in the row — the full
 * picture, including the "needs review" state, is in the detail pane's
 * "Suggested owner from receipt" section.
 */
function ownerChipLabel(metadata?: JevAwsAlertMetadata): string | undefined {
  const findings = metadata?.ownerResult?.findings;
  if (!findings || findings.length !== 1) return undefined;
  const [finding] = findings;
  if (finding.status !== 'pass' || !finding.candidate) return undefined;
  const title = finding.candidate.title;
  return typeof title === 'string' && title.trim() ? `Owner: ${title}` : undefined;
}


const impactGroups = [
  { id: 'widespread', label: 'Widespread impact' },
  { id: 'degraded', label: 'Degraded service' },
  { id: 'limited', label: 'Limited impact' },
  { id: 'unknown', label: 'Impact not established' },
  { id: 'unassessed', label: 'Not assessed by Jev' },
  { id: 'recovered', label: 'Alarm returned to OK' },
] as const;
type GroupId = typeof impactGroups[number]['id'];

/** Jev's reading of an alert; monitoring OK is shown separately, not as resolved customer impact. */
export function categorizeAlert(notification: AwsAlertNotification, recheck?: EvaluationResult): { group: GroupId; area?: string } {
  const result = recheck ?? notification.metadata?.result;
  const value = (id: string) => { const found = result?.findings.find(finding => finding.id === id)?.value; return typeof found === 'string' ? found : undefined; };
  const area = value('area');
  if (notification.metadata?.awsState === 'OK') return { group: 'recovered', area };
  const impact = value('impact');
  return { group: impactGroups.some(group => group.id === impact) ? impact as GroupId : 'unassessed', area: area === 'unknown' ? undefined : area };
}

const useStyles = makeStyles(theme => ({
  cardHeader: {
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    '& .MuiCardHeader-content': { minWidth: 200, overflowWrap: 'anywhere' },
    '& .MuiCardHeader-action': { marginLeft: 0, marginTop: 0, alignSelf: 'center' },
  },
  table: { minWidth: 740, tableLayout: 'fixed' },
  typeColumn: { width: 110, whiteSpace: 'nowrap' },
  severityColumn: { width: 100, whiteSpace: 'nowrap' },
  log: { width: '40%', overflowWrap: 'anywhere' },
  rowButton: { padding: 0, border: 0, background: 'none', color: theme.palette.primary.main, textAlign: 'left', cursor: 'pointer', font: 'inherit', '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}` } },
  chips: { '& .MuiChip-root': { maxWidth: '100%' }, display: 'flex', gap: theme.spacing(0.5), flexWrap: 'wrap', marginTop: theme.spacing(0.5) },
  meta: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: theme.spacing(0.5, 2), margin: 0, '& dd': { margin: 0, overflowWrap: 'anywhere' } },
  section: { marginTop: theme.spacing(3), '&:first-child': { marginTop: 0 } },
  actions: { display: 'flex', gap: theme.spacing(1), flexWrap: 'wrap', alignItems: 'center', marginTop: theme.spacing(2) },
  empty: { border: `1px dashed ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, padding: theme.spacing(3), textAlign: 'center' },
  pager: { display: 'flex', gap: theme.spacing(1), alignItems: 'center', justifyContent: 'flex-end', padding: theme.spacing(1, 2) },
}));

function ResultSection({ label, result, candidates, renderCandidateLink, note, requestPlan }: { label: string; result: EvaluationResult; candidates?: Pick<Candidate, 'id' | 'title'>[]; renderCandidateLink?: (candidate: Candidate) => ReactNode; note?: string; requestPlan?: RequestResponsePlan }) {
  const classes = useStyles();
  return <div className={classes.section} role="group" aria-label={label}>
    <Box display="flex" justifyContent="space-between" alignItems="baseline" flexWrap="wrap" mb={1}>
      <Typography variant="subtitle2">{label}</Typography>
      <Typography variant="caption" color="textSecondary">{result.mode === 'demo' ? 'ILLUSTRATIVE RESULT' : result.model} · {instantLabel(result.evaluatedAt)}{note ? ` · ${note}` : ''}</Typography>
    </Box>
    <FindingList findings={result.findings} candidates={candidates} renderCandidateLink={renderCandidateLink} headingLevel="h4" />
    {result.workflow === 'incident' && <ResponsePlanSection result={result} requestPlan={requestPlan} />}
  </div>;
}

/**
 * Alerts arrive on their own. The table keeps notification severity and Jev's interpretation
 * separate, and expands a detail view only after the reader selects an alert.
 */
export function AlertInbox({ loadNotifications, evaluate, requestResponsePlan, loadOwners, renderCandidateLink, pollMs = 30000, autoCheck = true, active = true, live: liveProp }: AlertInboxProps) {
  const classes = useStyles();
  const limit = 20;
  const [offset, setOffset] = useState(0);
  const [notifications, setNotifications] = useState<AwsAlertNotification[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (detailsOpen) detailsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, [detailsOpen, selectedId]);
  // The alert the reader explicitly clicked, as opposed to one selected automatically; only
  // that click may trigger an unrequested evaluate call (see `needsAssessment` below).
  const [pickedId, setPickedId] = useState('');
  const [staleSelected, setStaleSelected] = useState<AwsAlertNotification>();
  const [rechecks, setRechecks] = useState<Record<string, EvaluationResult>>({});
  const [recheckErrors, setRecheckErrors] = useState<Record<string, string>>({});
  const [owners, setOwners] = useState<Record<string, { result: EvaluationResult; candidates: Candidate[] }>>({});
  const [ownerErrors, setOwnerErrors] = useState<Record<string, string>>({});
  const [checkingId, setCheckingId] = useState('');
  const [owningId, setOwningId] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState('');
  const [pollFailed, setPollFailed] = useState(false);
  const [lastLoaded, setLastLoaded] = useState<Date>();
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [hideRecovered, setHideRecovered] = useState(false);
  const [preference] = useLivePreference();
  const live = liveProp !== false && preference;
  // Manual results belong to the list that is on screen; a reload invalidates them.
  const listGeneration = useRef(0);
  const known = useRef<Set<string>>();
  // Latest notifications/selection, read from callbacks that must not depend on every render.
  const notificationsRef = useRef<AwsAlertNotification[]>([]);
  notificationsRef.current = notifications;
  const selectedIdRef = useRef('');
  selectedIdRef.current = selectedId;
  // An alert is auto-assessed at most once per mount, checked and recorded before the call
  // starts so a reload, paging back, or a StrictMode double effect can never repeat it.
  const autoAssessedRef = useRef<Set<string>>(new Set());
  // A manual re-check or owner suggestion in flight; aborted (silently) on unmount or when a
  // reload/paging bumps `listGeneration`, since its result would belong to a list already gone.
  const recheckControllerRef = useRef<AbortController>();
  const ownerControllerRef = useRef<AbortController>();
  useEffect(() => () => { recheckControllerRef.current?.abort(); ownerControllerRef.current?.abort(); }, []);
  // Stops background polling once the optional AWS module has proven unavailable, until a
  // later successful load proves it is back. A ref is read synchronously inside the poll
  // interval's closure; `availabilityGen` exists only so a flip of that ref can restart the
  // (by then cleared) interval, since a ref alone cannot re-run an effect.
  const unavailableRef = useRef(false);
  const [availabilityGen, setAvailabilityGen] = useState(0);
  function setUnavailable(value: boolean) {
    if (unavailableRef.current === value) return;
    unavailableRef.current = value;
    setAvailabilityGen(current => current + 1);
  }

  function accept(page: AlertNotificationPage, background: boolean) {
    const ids = page.notifications.map(notification => notification.id);
    // Only a background refresh can reveal an arrival; the first load and paging are not news.
    if (background && known.current) { const before = known.current; setArrived(current => new Set([...current, ...ids.filter(id => !before.has(id))])); }
    known.current = new Set([...(background ? known.current ?? [] : []), ...ids]);
    setNotifications(page.notifications);
    setTotalCount(page.totalCount);
    setSkipped(page.skipped);
    setLastLoaded(new Date());
    if (background) {
      // A background refresh must never move the reader: keep the selection, and if it fell
      // off this page, keep showing the notification object itself with an explanatory caption.
      const current = selectedIdRef.current;
      if (!current) {
        // Nothing was selected — most likely the first load failed and left the inbox empty.
        // A recovering background poll is the reader's only route back into the list, so it
        // seeds the selection instead of leaving them stuck with nothing to look at.
        setSelectedId(page.notifications[0]?.id ?? '');
        setStaleSelected(undefined);
      } else if (page.notifications.some(notification => notification.id === current)) setStaleSelected(undefined);
      else { const previous = notificationsRef.current.find(notification => notification.id === current); if (previous) setStaleSelected(previous); }
    } else {
      setStaleSelected(undefined);
      setSelectedId(current => page.notifications.some(notification => notification.id === current) ? current : page.notifications[0]?.id ?? '');
    }
  }

  useEffect(() => {
    let mounted = true;
    ++listGeneration.current;
    // This reload invalidates any manual result still in flight for the previous list.
    recheckControllerRef.current?.abort();
    ownerControllerRef.current?.abort();
    setLoading(true);
    setError('');
    setPollFailed(false);
    setRechecks({});
    setRecheckErrors({});
    setOwners({});
    setOwnerErrors({});
    setCheckingId('');
    setOwningId('');
    setArrived(new Set());
    loadNotifications(offset, limit).then(page => {
      if (!mounted) return;
      // A successful load — whether the first one or an explicit Refresh — proves the optional
      // module is reachable again, so background polling (stopped below) may resume.
      setUnavailable(false);
      accept(page, false);
    }).catch(reason => {
      if (!mounted) return;
      if (reason instanceof Error && reason.name === 'AlertsUnavailableError') setUnavailable(true);
      setNotifications([]);
      setError(reason instanceof Error ? reason.message : 'AWS alerts could not be loaded.');
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [loadNotifications, offset, refreshToken]);

  // Background refresh keeps the selection and any manual results: nothing the reader did is lost.
  useEffect(() => {
    if (!pollMs || !active) return undefined;
    const timer = setInterval(() => {
      // The optional module has proven unavailable: stop ticking instead of polling forever as
      // a no-op. `availabilityGen` below restarts this effect (a fresh interval) once a
      // successful explicit load proves the module is reachable again.
      if (unavailableRef.current) { clearInterval(timer); return; }
      if (document.visibilityState === 'hidden') return;
      const generation = listGeneration.current;
      loadNotifications(offset, limit).then(page => {
        if (generation !== listGeneration.current) return;
        accept(page, true); setPollFailed(false); setError('');
      }).catch(reason => {
        if (generation !== listGeneration.current) return;
        if (reason instanceof Error && reason.name === 'AlertsUnavailableError') { setUnavailable(true); clearInterval(timer); }
        setPollFailed(true);
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [loadNotifications, offset, pollMs, active, availabilityGen]);

  const selected = notifications.find(notification => notification.id === selectedId) ?? (staleSelected?.id === selectedId ? staleSelected : undefined);
  const showingStale = Boolean(selected) && !notifications.some(notification => notification.id === selected!.id);
  const received = notifications.length + skipped;
  const checking = Boolean(checkingId);
  const busy = loading || checking;

  async function recheck() {
    // Without stored context there is nothing to re-check; the button is not rendered.
    if (!selected?.metadata || checking) return;
    const { id, metadata } = selected;
    const generation = listGeneration.current;
    const request = evaluationRequestSchema.safeParse({ workflow: 'incident', text: metadata.context, candidates: [] });
    if (!request.success) {
      setRecheckErrors(current => ({ ...current, [id]: `This alert context cannot be evaluated. ${request.error.issues.map(issue => issue.message).join(' ')}` }));
      return;
    }
    setCheckingId(id);
    setRecheckErrors(current => ({ ...current, [id]: '' }));
    const controller = new AbortController();
    recheckControllerRef.current = controller;
    try {
      const result = await evaluate(request.data, { signal: controller.signal });
      // The same contract as a stored result: an unreadable answer is reported, never rendered.
      if (!isEvaluationResult(result)) throw new Error('Jev returned a result that does not match the evaluation contract.');
      if (generation === listGeneration.current) setRechecks(current => ({ ...current, [id]: result }));
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (generation === listGeneration.current) setRecheckErrors(current => ({ ...current, [id]: reason instanceof Error ? reason.message : 'Jev re-check failed.' }));
    } finally {
      if (recheckControllerRef.current === controller) recheckControllerRef.current = undefined;
      if (!controller.signal.aborted && generation === listGeneration.current) setCheckingId('');
    }
  }

  async function suggestOwner() {
    if (!selected?.metadata || !loadOwners || owningId) return;
    const { id, metadata } = selected;
    const generation = listGeneration.current;
    setOwningId(id);
    setOwnerErrors(current => ({ ...current, [id]: '' }));
    const controller = new AbortController();
    ownerControllerRef.current = controller;
    try {
      const candidates = await loadOwners();
      if (!candidates.length) throw new Error('The catalog returned no teams to choose from.');
      const request = evaluationRequestSchema.safeParse({ workflow: 'ownership', text: metadata.context, candidates });
      if (!request.success) throw new Error(`An owner cannot be suggested for this alert. ${request.error.issues.map(issue => issue.message).join(' ')}`);
      const result = await evaluate(request.data, { signal: controller.signal });
      if (!isEvaluationResult(result)) throw new Error('Jev returned a result that does not match the evaluation contract.');
      if (generation === listGeneration.current) setOwners(current => ({ ...current, [id]: { result, candidates } }));
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (generation === listGeneration.current) setOwnerErrors(current => ({ ...current, [id]: reason instanceof Error ? reason.message : 'Owner suggestion failed.' }));
    } finally {
      if (ownerControllerRef.current === controller) ownerControllerRef.current = undefined;
      if (!controller.signal.aborted && generation === listGeneration.current) setOwningId('');
    }
  }

  // An active alarm that arrived without an assessment gets one as soon as it is opened, once —
  // but only when the reader themselves opened it (see `pickedId`, decided at click time below):
  // never for the alert that was selected automatically, and never because a refresh or reload
  // changed the selection. `pickedId` itself already encodes whether Live and
  // this view being on screen allowed a send at the moment of the click, and is cleared again the
  // instant any of those flips to blocking — so the only deferral left here is waiting for an
  // in-flight check or the list itself to finish loading.
  const needsAssessment = Boolean(selectedId === pickedId && selected?.metadata && selected.metadata.awsState !== 'OK' && !selected.metadata.result && !rechecks[selected.id] && !(selected.id in recheckErrors) && !checking && !loading);
  // The click that set `pickedId` only expressed intent for the conditions true at that instant;
  // if any of them later flips to blocking, that intent no longer holds and must not fire late.
  useEffect(() => {
    if (!(autoCheck && live && active)) setPickedId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, live, active]);
  useEffect(() => {
    if (!needsAssessment) return;
    if (autoAssessedRef.current.has(selectedId)) return;
    // Recorded before the call starts, synchronously, so nothing can race this guard.
    autoAssessedRef.current.add(selectedId);
    recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAssessment, selectedId]);

  const categorized = notifications.map(notification => ({ notification, ...categorizeAlert(notification, rechecks[notification.id]) }));
  const visible = categorized.filter(entry => !hideRecovered || entry.group !== 'recovered');

  return <Grid container spacing={3} alignItems="flex-start" component="section" aria-label="AWS alerts">
    <Grid item xs={12}>
      <Card>
        <CardHeader className={classes.cardHeader} title="AWS alerts" titleTypographyProps={{ variant: 'h5', component: 'h2' }}
          subheader={pollFailed ? 'Background refresh failed; showing the last loaded list.' : lastLoaded ? `Last refreshed ${lastLoaded.toLocaleTimeString()}${pollMs ? ` · refreshes every ${Math.round(pollMs / 1000)}s` : ''}` : 'CloudWatch alerts delivered through Backstage Notifications.'}
          action={<Button size="small" disabled={loading} variant="outlined" style={{ margin: '8px 8px 0 0' }} onClick={() => { if (offset === 0) setRefreshToken(value => value + 1); else setOffset(0); }}>{loading ? 'Refreshing…' : 'Refresh'}</Button>} />
        <Divider />
        {error && <Alert severity="error" style={{ margin: 16 }}>{error}</Alert>}
        {skipped > 0 && <Alert severity="warning" role="status" style={{ margin: 16 }}>{skipped} row{skipped === 1 ? '' : 's'} could not be displayed because {skipped === 1 ? 'it was' : 'they were'} not readable AWS alert notifications.</Alert>}
        {loading && !notifications.length ? <CardContent><div className={classes.empty}><Typography variant="body2" color="textSecondary">Loading AWS alerts…</Typography></div></CardContent>
          : !notifications.length ? <CardContent><div className={classes.empty}><Typography variant="body2" color="textSecondary">No AWS alerts were returned.</Typography></div></CardContent>
          : <>
          <TableContainer>
            <Table className={classes.table} aria-label="AWS alert list" size="small">
              <TableHead><TableRow><TableCell className={classes.typeColumn}>Type</TableCell><TableCell className={classes.severityColumn}>Severity</TableCell><TableCell className={classes.log}>Log</TableCell><TableCell>Jev quick check</TableCell></TableRow></TableHead>
              <TableBody>{visible.map(({ notification, group, area }) => <TableRow key={notification.id} hover selected={detailsOpen && notification.id === selectedId}
                style={{ cursor: 'pointer' }} onClick={() => {
                  setSelectedId(notification.id); setDetailsOpen(true);
                  setPickedId(autoCheck && live && active ? notification.id : '');
                  setStaleSelected(undefined); setArrived(current => { const next = new Set(current); next.delete(notification.id); return next; });
                }}>
                <TableCell className={classes.typeColumn}>CloudWatch<Typography variant="caption" color="textSecondary" component="div">{notification.metadata?.awsState ?? 'State unavailable'}</Typography></TableCell>
                <TableCell className={classes.severityColumn}><Chip size="small" variant="outlined" label={notification.severity ?? 'Not provided'} color={notification.severity === 'critical' || notification.severity === 'high' ? 'secondary' : 'default'} /></TableCell>
                <TableCell className={classes.log}>
                  <button type="button" className={classes.rowButton} aria-expanded={detailsOpen && notification.id === selectedId} aria-controls="jev-alert-details">{notification.title}</button>
                  <Typography variant="body2">{notification.description || 'No log message supplied.'}</Typography>
                  <Typography variant="caption" color="textSecondary">{notification.created ? instantLabel(notification.created) : 'Received time not reported'} · {notification.metadata?.region || 'Region unknown'}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2">{impactGroups.find(item => item.id === group)!.label}</Typography>
                  {notification.metadata?.result?.mode === 'demo' && <Typography variant="caption" color="textSecondary">Illustrative result</Typography>}
                  <div className={classes.chips}>
                    {arrived.has(notification.id) && <Chip size="small" color="primary" label="New" />}
                    {area && <Chip size="small" variant="outlined" label={`Look at: ${area}`} />}
                    {ownerChipLabel(notification.metadata) && <Chip size="small" variant="outlined" label={ownerChipLabel(notification.metadata)} title={ownerChipLabel(notification.metadata)} />}
                    {checkingId === notification.id && <Chip size="small" variant="outlined" label="Assessing…" />}
                  </div>
                </TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </TableContainer>
          {!visible.length && <CardContent><Typography variant="body2" color="textSecondary">All alarms on this page are in the OK state. This does not confirm that customer impact has ended.</Typography></CardContent>}
          </>}
        <div className={classes.pager}>
          <FormControlLabel style={{ marginRight: 'auto' }} label={<Typography variant="caption">Hide OK alarms</Typography>} control={<Switch size="small" color="primary" checked={hideRecovered} onChange={event => setHideRecovered(event.target.checked)} />} />
          <Button size="small" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button>
          <Typography variant="caption" color="textSecondary">{received ? `${offset + 1}–${offset + received} of ${totalCount}` : `0 of ${totalCount}`}</Typography>
          <Button size="small" disabled={busy || offset + limit >= totalCount} onClick={() => setOffset(offset + limit)}>Next</Button>
        </div>
      </Card>
    </Grid>
    <Grid item xs={12}>
      {!detailsOpen ? null : selected ? <Card ref={detailsRef} id="jev-alert-details" component="article" aria-label="AWS alert details">
        <CardHeader className={classes.cardHeader} title={selected.title} subheader={selected.description || 'No reason supplied.'} titleTypographyProps={{ variant: 'h5', component: 'h3' }}
          action={<><Chip size="small" variant="outlined" label={selected.metadata ? `AWS state: ${selected.metadata.awsState}` : 'Details unavailable'} /><Button size="small" onClick={() => { setDetailsOpen(false); setPickedId(''); }}>Close details</Button></>} />
        <Divider />
        <CardContent>
          {showingStale && <Typography variant="caption" color="textSecondary" role="status" component="p" style={{ marginBottom: 16 }}>This alert is no longer on this page of the inbox.</Typography>}
          {selected.metadata ? <>
            {rechecks[selected.id] && <ResultSection label="Manual Jev re-check (not stored)" result={rechecks[selected.id]} requestPlan={requestResponsePlan} />}
            {selected.metadata.result
              ? <ResultSection label="Stored Jev result from receipt" result={selected.metadata.result} />
              : <>
                  <Typography variant="body2" color="textSecondary">{storedResultNote(selected, selected.metadata)}</Typography>
                  {!live && <Typography variant="body2" color="textSecondary">Choose Re-check with Jev to assess it now.</Typography>}
                </>}
            {selected.metadata.ownerResult
              ? <ResultSection label="Suggested owner from receipt" result={selected.metadata.ownerResult} candidates={selected.metadata.ownerCandidates} renderCandidateLink={renderCandidateLink} note={selected.metadata.ownerShortened ? 'shortened team descriptions were used' : undefined} />
              : (selected.metadata.ownerStatus || selected.ownerResultUnreadable) && <Typography variant="body2" color="textSecondary">{ownerStatusNote(selected, selected.metadata)}</Typography>}
            {recheckErrors[selected.id] && <Alert severity="error" style={{ marginTop: 16 }}>{recheckErrors[selected.id]}</Alert>}
            {owners[selected.id] && <ResultSection label="Suggested owner (not stored)" result={owners[selected.id].result} candidates={owners[selected.id].candidates} renderCandidateLink={renderCandidateLink} />}
            {ownerErrors[selected.id] && <Alert severity="error" style={{ marginTop: 16 }}>{ownerErrors[selected.id]}</Alert>}
            <div className={classes.actions}>
              <Button variant="contained" color="primary" size="small" disabled={busy} onClick={recheck}>{checkingId === selected.id ? 'Re-checking…' : checking ? 'Another re-check is running…' : 'Re-check with Jev'}</Button>
              {loadOwners && <Button variant="outlined" size="small" disabled={Boolean(owningId) || loading} onClick={suggestOwner}>{owningId === selected.id ? 'Finding a team…' : selected.metadata.ownerResult ? 'Re-suggest owning team' : 'Suggest owning team'}</Button>}
            </div>
            <Typography variant="caption" color="textSecondary" component="p" style={{ marginTop: 8 }}>AWS state and Jev's incident interpretation are separate signals. Re-checking previews this context and updates only this screen.</Typography>
            <div className={classes.section}>
              <TextField id="jev-alert-context" label="Context preview" variant="outlined" fullWidth multiline maxRows={8} value={selected.metadata.context} InputProps={{ readOnly: true }} />
            </div>
          </> : <Typography variant="body2" color="textSecondary">{missingDetailsNote(selected)}</Typography>}
          <Divider style={{ margin: '24px 0 16px' }} />
          <Typography variant="caption" color="textSecondary" component="dl" className={classes.meta}>
            <dt>Severity</dt><dd>{selected.severity ?? 'Not provided'} (notification priority)</dd>
            <dt>Received</dt><dd>{selected.created ? <time dateTime={selected.created}>{instantLabel(selected.created)}</time> : 'Not reported'}{selected.updated ? <> · updated <time dateTime={selected.updated}>{instantLabel(selected.updated)}</time></> : null}</dd>
            {selected.metadata && <><dt>Alarm ARN</dt><dd><code>{selected.metadata.alarmArn}</code></dd>
            <dt>Region</dt><dd>{selected.metadata.region || 'Not reported'}</dd>
            <dt>Jev status at receipt</dt><dd>{statusLabel(selected.metadata.evaluationStatus)}{selected.metadata.errorCode ? ` (${selected.metadata.errorCode})` : ''}{selected.detailsUpdated ? <> · recorded <time dateTime={selected.detailsUpdated}>{instantLabel(selected.detailsUpdated)}</time></> : null}</dd></>}
          </Typography>
        </CardContent>
      </Card> : null}
    </Grid>
  </Grid>;
}
