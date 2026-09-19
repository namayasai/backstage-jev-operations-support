import { useEffect, useRef, useState } from 'react';
import { evaluationRequestSchema, workflowIds, type EvaluationRequest, type EvaluationResult, type Finding } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { jevStyles } from './Workbench';

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
}

export interface AwsAlertNotification {
  id: string;
  /** Standard Backstage Notifications fields, unchanged by this plugin. */
  created?: string;
  updated?: string;
  title: string;
  description: string;
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
}

export interface AlertNotificationPage {
  totalCount: number;
  notifications: AwsAlertNotification[];
  skipped: number;
}

export interface AlertInboxProps {
  loadNotifications: (offset: number, limit: number) => Promise<AlertNotificationPage>;
  evaluate: (request: EvaluationRequest) => Promise<EvaluationResult>;
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

function isEvaluationResult(value: unknown): value is EvaluationResult {
  if (!isRecord(value) || typeof value.model !== 'string' || typeof value.evaluatedAt !== 'string' || !['live', 'demo'].includes(String(value.mode)) || typeof value.needsReview !== 'boolean' || !Array.isArray(value.findings)) return false;
  if (!workflowIds.includes(value.workflow as EvaluationResult['workflow'])) return false;
  return value.findings.every(finding => isRecord(finding) && typeof finding.id === 'string' && typeof finding.title === 'string' && typeof finding.statement === 'string' && ['pass', 'attention', 'review'].includes(String(finding.status)));
}

/** Parse the structured details the backend restored, or report them as unreadable. */
function parseDetails(metadata: Record<string, unknown>): { metadata: JevAwsAlertMetadata; resultUnreadable: boolean } | undefined {
  if (metadata.source !== 'aws-cloudwatch' || !alertStates.includes(metadata.awsState as AwsState) || !evaluationStatuses.includes(metadata.evaluationStatus as EvaluationStatus)) return undefined;
  const context = stringValue(metadata.context);
  const alarmArn = stringValue(metadata.alarmArn);
  // CloudWatch may omit the region; the backend forwards it as an empty string.
  if (!context || !alarmArn || typeof metadata.region !== 'string') return undefined;
  // An unusable result must not hide the alarm itself; the AWS state stays the authoritative signal.
  const result = isEvaluationResult(metadata.result) ? metadata.result : undefined;
  return {
    resultUnreadable: metadata.result !== undefined && !result,
    metadata: {
      source: 'aws-cloudwatch',
      context,
      awsState: metadata.awsState as AwsState,
      alarmArn,
      region: metadata.region.trim(),
      evaluationStatus: metadata.evaluationStatus as EvaluationStatus,
      ...(result ? { result } : {}),
      ...(stringValue(metadata.errorCode) ? { errorCode: stringValue(metadata.errorCode) } : {}),
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
    ...(details ? { metadata: details.metadata } : {}),
    detailsUnreadable: Boolean(raw) && !details,
    ...(raw && timestampValue(raw.updatedAt) ? { detailsUpdated: timestampValue(raw.updatedAt) } : {}),
    resultUnreadable: details?.resultUnreadable ?? false,
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

function statusClass(status: Finding['status']): string {
  return `jev-status jev-${status}`;
}

function ResultSummary({ label, result }: { label: string; result: EvaluationResult }) {
  return <div className="jev-result" role="group" aria-label={label}>
    <div className="jev-result-line"><strong>{label}</strong><span className="jev-pill">{result.model}</span></div>
    {result.findings.map(finding => <div key={finding.id} style={{ marginTop: 10 }}>
      <div className="jev-result-line"><span>{finding.title}</span><span className={statusClass(finding.status)}>{finding.status}</span></div>
      <div className="jev-help">{String(finding.value)} · {finding.statement}</div>
    </div>)}
  </div>;
}

export function AlertInbox({ loadNotifications, evaluate }: AlertInboxProps) {
  const limit = 20;
  const [offset, setOffset] = useState(0);
  const [notifications, setNotifications] = useState<AwsAlertNotification[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [rechecks, setRechecks] = useState<Record<string, EvaluationResult>>({});
  const [recheckErrors, setRecheckErrors] = useState<Record<string, string>>({});
  const [checkingId, setCheckingId] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState('');
  // Manual results belong to the list that is on screen; a reload invalidates them.
  const listGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const generation = ++listGeneration.current;
    setLoading(true);
    setError('');
    setRechecks({});
    setRecheckErrors({});
    setCheckingId('');
    loadNotifications(offset, limit).then(page => {
      if (!active) return;
      setNotifications(page.notifications);
      setTotalCount(page.totalCount);
      setSkipped(page.skipped);
      setSelectedId(current => page.notifications.some(notification => notification.id === current) ? current : page.notifications[0]?.id ?? '');
    }).catch(reason => {
      if (!active) return;
      setNotifications([]);
      setError(reason instanceof Error ? reason.message : 'AWS alerts could not be loaded.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadNotifications, offset, refreshToken]);

  const selected = notifications.find(notification => notification.id === selectedId);
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
    try {
      const result = await evaluate(request.data);
      if (generation === listGeneration.current) setRechecks(current => ({ ...current, [id]: result }));
    } catch (reason) {
      if (generation === listGeneration.current) setRecheckErrors(current => ({ ...current, [id]: reason instanceof Error ? reason.message : 'Jev re-check failed.' }));
    } finally {
      if (generation === listGeneration.current) setCheckingId('');
    }
  }

  return <main className="jev">
    <style>{jevStyles}</style>
    <section className="jev-alerts" aria-label="AWS alerts">
      <div className="jev-panel">
        <div className="jev-result-header"><div><h2>AWS alerts</h2><p>CloudWatch alerts delivered through Backstage Notifications.</p></div><button className="jev-secondary" disabled={busy} onClick={() => { if (offset === 0) setRefreshToken(value => value + 1); else setOffset(0); }}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
        {error && <div className="jev-error" role="alert">{error}</div>}
        {skipped > 0 && <div className="jev-banner" role="status">{skipped} row{skipped === 1 ? '' : 's'} could not be displayed because {skipped === 1 ? 'it was' : 'they were'} not readable AWS alert notifications.</div>}
        {loading && !notifications.length ? <div className="jev-empty">Loading AWS alerts…</div> : !notifications.length ? <div className="jev-empty">No AWS alerts were returned.</div> : <div className="jev-grid" style={{ gridTemplateColumns: 'minmax(220px, .7fr) minmax(0, 1.3fr)' }}>
          <div aria-label="AWS alert list">
            {notifications.map(notification => <button key={notification.id} className="jev-alert" aria-pressed={notification.id === selectedId} onClick={() => setSelectedId(notification.id)}>
              <div className="jev-result-line"><strong>{notification.title}</strong><span className="jev-pill">{notification.metadata ? notification.metadata.awsState : 'Details unavailable'}</span></div>
              <div className="jev-help">{notification.created ? instantLabel(notification.created) : 'Received time not reported'} · {notification.metadata?.region || 'Region unknown'}</div>
              <div className="jev-help">{notification.description || 'No reason supplied.'}</div>
            </button>)}
          </div>
          {selected && <article className="jev-result" aria-label="AWS alert details">
            <div className="jev-result-line"><h3>{selected.title}</h3>{selected.metadata ? <span className="jev-pill">AWS state: {selected.metadata.awsState}</span> : <span className="jev-pill">Details unavailable</span>}</div>
            <p>{selected.description || 'No reason supplied.'}</p>
            <dl>
              <dt>Received</dt><dd>{selected.created ? <time dateTime={selected.created}>{instantLabel(selected.created)}</time> : 'Not reported'}{selected.updated ? <> · updated <time dateTime={selected.updated}>{instantLabel(selected.updated)}</time></> : null}</dd>
              {selected.metadata && <><dt>Alarm ARN</dt><dd><code>{selected.metadata.alarmArn}</code></dd>
              <dt>Region</dt><dd>{selected.metadata.region || 'Not reported'}</dd>
              <dt>Jev status at receipt</dt><dd>{statusLabel(selected.metadata.evaluationStatus)}{selected.metadata.errorCode ? ` (${selected.metadata.errorCode})` : ''}{selected.detailsUpdated ? <> · recorded <time dateTime={selected.detailsUpdated}>{instantLabel(selected.detailsUpdated)}</time></> : null}</dd></>}
            </dl>
            {selected.metadata ? <>
              <label className="jev-label" htmlFor="jev-alert-context">Context preview</label>
              <textarea id="jev-alert-context" readOnly value={selected.metadata.context} />
              {selected.metadata.result
                ? <ResultSummary label="Stored Jev result from receipt" result={selected.metadata.result} />
                : <p className="jev-status-message" role="status">{storedResultNote(selected, selected.metadata)}</p>}
              {rechecks[selected.id] && <ResultSummary label="Manual Jev re-check (not stored)" result={rechecks[selected.id]} />}
              {recheckErrors[selected.id] && <div className="jev-error" role="alert">{recheckErrors[selected.id]}</div>}
              <div className="jev-actions"><button className="jev-primary" disabled={busy} onClick={recheck}>{checkingId === selected.id ? 'Re-checking…' : checking ? 'Another re-check is running…' : 'Re-check with Jev'}</button></div>
              <p className="jev-help">AWS state and Jev's incident interpretation are separate signals. Re-checking previews this context and updates only this screen.</p>
            </> : <p className="jev-status-message" role="status">{missingDetailsNote(selected)}</p>}
          </article>}
        </div>}
        <div className="jev-actions"><button className="jev-secondary" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button><span className="jev-count">{received ? `${offset + 1}–${offset + received} of ${totalCount}` : `0 of ${totalCount}`}</span><button className="jev-secondary" disabled={busy || offset + limit >= totalCount} onClick={() => setOffset(offset + limit)}>Next</button></div>
      </div>
    </section>
  </main>;
}
