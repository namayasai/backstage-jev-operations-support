import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { evaluationRequestByteLength, evaluationRequestSchema, MAX_EVALUATION_BYTES, type Candidate, type EvaluationRequest, type EvaluationResult, type WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { isEvaluationResult } from './evaluationResult';

const LIVE_STORAGE_KEY = 'jev-operations-support.live';
export const candidateWorkflows: WorkflowId[] = ['templates', 'ownership', 'search'];
const MIN_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;

// A module-level store so every component sharing this tab agrees on one Live preference:
// toggling it in one view must be seen by every other mounted view at once. `undefined`
// means "nothing read from storage yet" (or storage is unavailable); it is resolved against
// the module default (`false`) only on first read, then cached here for the tab. A stored
// value always wins over the default, and no consumer can override it with its own initial
// value — that would let one mounted component silently re-enable Live for every other one.
// Live defaults to off: nothing is sent to the external API without an explicit click unless
// the reader has opted in, and the choice is remembered per browser via localStorage.
let liveValue: boolean | undefined;
const liveSubscribers = new Set<() => void>();

function readStoredLive(): boolean | undefined {
  try {
    const stored = window.localStorage.getItem(LIVE_STORAGE_KEY);
    return stored === null ? undefined : stored === 'on';
  } catch {
    return undefined;
  }
}

function notifyLiveSubscribers() { liveSubscribers.forEach(listener => listener()); }

function subscribeLive(listener: () => void): () => void {
  liveSubscribers.add(listener);
  return () => { liveSubscribers.delete(listener); };
}

function writeLive(value: boolean) {
  liveValue = value;
  try { window.localStorage.setItem(LIVE_STORAGE_KEY, value ? 'on' : 'off'); } catch { /* preference is not persisted */ }
  notifyLiveSubscribers();
}

// Another tab/window changing the preference must be reflected here too.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== LIVE_STORAGE_KEY) return;
    liveValue = readStoredLive();
    notifyLiveSubscribers();
  });
}

/** Test-only: clears the in-memory fallback so each test starts from a clean slate. */
export function resetLivePreferenceForTests() {
  liveValue = undefined;
  notifyLiveSubscribers();
}

/**
 * The live-check preference is a per-browser convenience, shared by every mounted consumer;
 * storage may be unavailable. The module default is `false` (opt-in); a stored value always
 * wins, and this hook takes no `initial` argument, so no single mounted component can override
 * the preference every other mounted component sees (see `live` props like `JevWorkbench`'s,
 * which force automatic sends off for one view without touching this shared preference).
 */
export function useLivePreference(): [boolean, (value: boolean) => void] {
  const live = useSyncExternalStore(
    subscribeLive,
    () => { if (liveValue === undefined) liveValue = readStoredLive() ?? false; return liveValue; },
    // Server snapshot for SSR hydration; this plugin is client-rendered, so it is never actually
    // read, but it may not match a real stored client preference (`readStoredLive()` above).
    () => false,
  );
  const setLive = useCallback((value: boolean) => writeLive(value), []);
  return [live, setLive];
}

export interface EvaluateOptions {
  signal?: AbortSignal;
}

export interface LiveEvaluationOptions {
  evaluate: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  workflow: WorkflowId;
  text: string;
  candidates: Candidate[];
  live: boolean;
  /** Quiet period after the last edit before an automatic check is sent. */
  delayMs?: number;
  /** Hold automatic checks while a source (TechDocs, catalog) is still loading. */
  paused?: boolean;
  /** Hold automatic checks for a reason the reader can lift (e.g. an untouched, already-sent draft). Unlike `paused`, `checkNow` is otherwise unaffected. */
  hold?: boolean;
}

export interface LiveEvaluation {
  /** The latest result for this workflow; it may describe an earlier version of the input. */
  result?: EvaluationResult;
  /** The shortlist the result was computed for, so labels never drift from the result. */
  resultCandidates: Candidate[];
  stale: boolean;
  busy: boolean;
  /** An automatic check is scheduled for the current input. */
  pending: boolean;
  /** Why the current input cannot be checked yet; empty when it can. */
  blocker: string;
  /** The input exceeds a hard limit, as opposed to simply being incomplete. */
  overLimit: boolean;
  error: string;
  requestBytes: number;
  /** While set, automatic sends are suspended after a failure until this epoch ms; `checkNow` still works. */
  retryAt?: number;
  checkNow: () => void;
}

/**
 * Keeps a Jev result in step with the input. Each distinct valid request is sent once:
 * after a quiet period when live, or on demand. After a failed automatic or manual run,
 * automatic sends are suspended until the provider's `Retry-After` (when the error carries
 * a `retryAfterMs`) or an exponential backoff elapses, so a busy provider is never hammered;
 * `checkNow` always bypasses that suspension. A superseded in-flight request is aborted.
 */
export function useLiveEvaluation({ evaluate, workflow, text, candidates, live, delayMs = 900, paused = false, hold = false }: LiveEvaluationOptions): LiveEvaluation {
  const [evaluated, setEvaluated] = useState<{ key: string; result: EvaluationResult; candidates: Candidate[] }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [busyKey, setBusyKey] = useState('');
  const [demanded, setDemanded] = useState('');
  const [retryNotBefore, setRetryNotBefore] = useState<number>();
  const runId = useRef(0);
  const mounted = useRef(true);
  const backoffMs = useRef(MIN_BACKOFF_MS);
  const controllerRef = useRef<AbortController>();
  // Callers often pass an inline function; its identity must not restart the quiet period.
  const evaluateRef = useRef(evaluate);
  evaluateRef.current = evaluate;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controllerRef.current?.abort(); }; }, []);

  const draft = useMemo((): { requestBytes: number; overLimit: boolean; blocker: string; request?: EvaluationRequest; key?: string; shortlist?: Candidate[] } => {
    const shortlist = candidateWorkflows.includes(workflow) ? candidates.map(c => ({ ...c, id: c.id.trim(), title: c.title.trim() })) : [];
    const requestBytes = evaluationRequestByteLength({ workflow, text: text.trim(), candidates: shortlist });
    if (text.length > 16000) return { requestBytes, overLimit: true, blocker: 'Context exceeds the 16,000 character limit. Shorten it; no text will be truncated.' };
    if (requestBytes > MAX_EVALUATION_BYTES) return { requestBytes, overLimit: true, blocker: `Request is ${requestBytes.toLocaleString()} UTF-8 bytes; the limit is ${MAX_EVALUATION_BYTES.toLocaleString()}. Shorten the context or candidate descriptions; no text will be truncated.` };
    const parsed = evaluationRequestSchema.safeParse({ workflow, text, candidates: shortlist });
    if (!parsed.success) return { requestBytes, overLimit: false, blocker: parsed.error.issues.map(issue => issue.message).join(' ') };
    return { requestBytes, overLimit: false, blocker: '', request: parsed.data, key: JSON.stringify(parsed.data), shortlist };
  }, [workflow, text, candidates]);

  const run = useCallback(async (key: string, request: EvaluationRequest, shortlist: Candidate[]) => {
    // A new run supersedes whatever is still in flight; that one is cancelled, not reported.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++runId.current;
    setBusyKey(key); setFailure(undefined);
    try {
      const result = await evaluateRef.current(request, { signal: controller.signal });
      // A backend answering `null`/`undefined`/a malformed object, or a result for a different
      // workflow than the one requested, must not crash the render that dereferences it; it is
      // treated as an ordinary failure, going through the normal error/backoff path below.
      if (!isEvaluationResult(result) || result.workflow !== request.workflow) {
        throw new Error('Jev returned a result that does not match the evaluation contract.');
      }
      if (mounted.current && id === runId.current) {
        setEvaluated({ key, result, candidates: shortlist });
        backoffMs.current = MIN_BACKOFF_MS;
        setRetryNotBefore(undefined);
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (mounted.current && id === runId.current) {
        setFailure({ key, message: reason instanceof Error ? reason.message : 'Evaluation failed.' });
        const carried = reason instanceof Error ? (reason as Error & { retryAfterMs?: unknown }).retryAfterMs : undefined;
        const delay = typeof carried === 'number' && Number.isFinite(carried) && carried >= 0 ? carried : backoffMs.current;
        backoffMs.current = Math.min(MAX_BACKOFF_MS, backoffMs.current * 2);
        setRetryNotBefore(Date.now() + delay);
      }
    } finally {
      if (mounted.current && id === runId.current) setBusyKey('');
      if (controllerRef.current === controller) controllerRef.current = undefined;
    }
  }, []);

  const settled = !draft.key || draft.key === evaluated?.key || draft.key === failure?.key || draft.key === busyKey;
  const pending = live && !paused && !hold && !settled;
  useEffect(() => {
    const { key, request, shortlist } = draft;
    if (!pending || !key || !request || !shortlist) return undefined;
    const wait = Math.max(delayMs, retryNotBefore ? retryNotBefore - Date.now() : 0);
    const timer = setTimeout(() => run(key, request, shortlist), wait);
    return () => clearTimeout(timer);
  }, [pending, draft, delayMs, run, retryNotBefore]);

  // A blocker is only surfaced as an error once the user explicitly asked for a check.
  useEffect(() => { setDemanded(''); }, [draft.blocker]);

  // `paused` (a source still loading) or `live` turning off both mean automatic sends must
  // stop now, not just from the next run: an in-flight automatic request is cancelled rather
  // than left to land unexpectedly. `hold` is excluded: it only happens on a workflow switch,
  // where the request key itself changes and a stale in-flight run already targets a dead key.
  useEffect(() => {
    if (paused || !live) controllerRef.current?.abort();
  }, [paused, live]);

  const result = evaluated?.result.workflow === workflow ? evaluated.result : undefined;
  return {
    result,
    resultCandidates: result ? evaluated!.candidates : [],
    stale: Boolean(result) && evaluated!.key !== draft.key,
    busy: Boolean(busyKey),
    pending,
    blocker: draft.blocker,
    overLimit: draft.overLimit,
    error: draft.overLimit ? draft.blocker : demanded || (failure && failure.key === draft.key ? failure.message : ''),
    requestBytes: draft.requestBytes,
    retryAt: retryNotBefore,
    // checkNow bypasses both `hold` and any backoff suspension; it is an explicit request.
    checkNow: () => { if (draft.key && draft.request && draft.shortlist) run(draft.key, draft.request, draft.shortlist); else setDemanded(draft.blocker); },
  };
}
