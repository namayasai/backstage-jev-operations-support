import { useMemo, type ReactNode } from 'react';
import { Box, Button, Typography } from '@material-ui/core';
import { useSearch } from '@backstage/plugin-search-react';
import type { SearchResult } from '@backstage/plugin-search-common';
import { evaluationRequestByteLength, MAX_EVALUATION_BYTES, truncateCodePoints, type Candidate, type EvaluationRequest, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { LiveSwitch } from './LiveSwitch';
import { useLiveEvaluation, useLivePreference, type EvaluateOptions } from './useLiveEvaluation';
import { useJevEvaluate } from './useJevEvaluate';

export interface JevRerankedResultsProps {
  /** The host renders its own result items; this component only decides their order. */
  children: (results: SearchResult[]) => JSX.Element;
  /** How many of the top engine results Jev may reorder. Default and hard maximum: 20. */
  limit?: number;
  /** Quiet period after the query settles before Jev is asked to rerank it. */
  liveDelayMs?: number;
  /** Override for tests; defaults to the shared `/evaluate` call. */
  evaluate?: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  /** `false` forces automatic sends off for this component regardless of the reader's preference; omitted or `true` follows the reader's preference. */
  live?: boolean;
}

const HARD_LIMIT = 20;
// The evaluation schema requires at least 10 characters of trimmed text; a shorter query
// cannot be sent, so there is nothing dishonest to pretend about — say so plainly instead.
const MIN_TERM_LENGTH = 10;
// The schema's own hard character cap. Handled here, with search's own wording, rather than
// left to surface as `useLiveEvaluation`'s generic (workbench-flavoured) "Context exceeds the
// 16,000 character limit…" blocker.
const MAX_TERM_LENGTH = 16000;

export interface Shortlist {
  candidates: Candidate[];
  /** The candidate id for each result in the engine-order head (the up-to-`limit` results this
   * shortlist was built from), aligned by index — index `i` is the `i`-th head result, in
   * engine order. Scores are looked up by this index into the *current* head, never through an
   * identity map keyed on the `SearchResult` object: a host re-render can hand back
   * fresh-but-content-equal result objects, which would make every identity-keyed entry dead.
   * A result dropped from the tail (title-only candidates still over budget) has no entry. */
  candidateIds: (string | undefined)[];
  /** Whether descriptions were shortened below their natural length to fit the byte budget. */
  shortened: boolean;
  /** Set when even a single title-only candidate does not fit alongside the query: the query
   * itself is the problem, not the shortlist. `candidates` is empty in this case. */
  reason?: 'question-too-long';
}

const EMPTY_SHORTLIST: Shortlist = { candidates: [], candidateIds: [], shortened: false };

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The caption shown once a reorder actually applied. `scored` and `total` are the number of
 * head results that received a score and the number of head results overall (`scored < total`
 * when some head result's score could not be matched to it, or was dropped from the shortlist
 * entirely). Plain when nothing is amiss; otherwise a dash-joined list of the conditions that
 * apply, so two or more can be reported together instead of one silently hiding another.
 */
export function reorderedCaption({ scored, total, anyReview, shortened }: { scored: number; total: number; anyReview: boolean; shortened: boolean }): string {
  const partial = scored < total;
  if (!anyReview && !partial) {
    return shortened
      ? 'Reordered by Jev for relevance to your question, using shortened excerpts'
      : 'Reordered by Jev for relevance to your question';
  }
  const clauses: string[] = [];
  if (partial) clauses.push(`${scored} of ${total} results ranked`);
  if (anyReview) clauses.push('low confidence for some results');
  if (shortened) clauses.push('shortened excerpts were used');
  return `Reordered by Jev — ${clauses.join('; ')}`;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without ever splitting a multi-byte character (so a surrogate pair is never cut in half). */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end -= 1; }
  }
  return '';
}

/**
 * FNV-1a over the UTF-16 code units of `text` — a fast, non-cryptographic hash, cheap enough to
 * run on every render's worth of results. Collisions are possible but irrelevant here: the hash
 * is only ever compared alongside the length it was computed from, in a memoization key, not
 * used as an identity.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A cheap content sample for `shortlistContentKey`: the same collapsed-and-capped text
 * `fitShortlist` would turn into a description, reduced to its length and a hash so a
 * reindexed body of equal length but different content is not mistaken for unchanged content. */
function bodySample(text: string): string {
  const collapsed = truncateCodePoints(collapseWhitespace(text), 1500);
  return `${collapsed.length}:${fnv1a(collapsed).toString(36)}`;
}

function requestBytesFor(term: string, candidates: Candidate[]): number {
  return evaluationRequestByteLength({ workflow: 'search', text: term, candidates });
}

/**
 * Builds the shortlist Jev is asked to rank: up to `limit` of the top engine results, fitted
 * under the shared 24,000-byte evaluation budget. Descriptions are shrunk from an even
 * per-candidate byte allowance, found by a bounded binary search over the real (JSON-escaped)
 * request size — not a fixed per-attempt decrement, which could collapse excerpts to almost
 * nothing after a single overshoot on escape-heavy text. If even title-only candidates do not
 * fit, candidates are dropped from the tail; if even one title-only candidate does not fit
 * alongside the query, the query itself is the problem (`reason: 'question-too-long'`) and the
 * shortlist is empty rather than shipping one candidate over budget. Every candidate id is
 * unique and deterministic even when two locations share a 200-character prefix. Pure and
 * exported so the budget-fitting logic can be unit-tested directly.
 */
export function fitShortlist(term: string, results: SearchResult[], limit: number): Shortlist {
  const trimmedTerm = term.trim();
  const sliced = results.slice(0, Math.max(0, limit));
  if (!sliced.length) return EMPTY_SHORTLIST;

  const seen = new Set<string>();
  const base = sliced.map((result, index) => {
    const location = (result.document.location ?? '').trim();
    const rawTitle = (result.document.title ?? '').trim();
    const title = truncateCodePoints(rawTitle || location || `Result ${index + 1}`, 200);
    const description = truncateCodePoints(collapseWhitespace(result.document.text ?? ''), 1500);
    const prefix = location || rawTitle || `Result ${index + 1}`;
    let id = prefix.length <= 200 ? prefix : truncateCodePoints(prefix, 200);
    // Two locations sharing a 200-char prefix would otherwise collide; a truncated id is
    // treated the same way, since it is just as likely to collide with another truncated one.
    if (prefix.length > 200 || seen.has(id)) id = `${truncateCodePoints(prefix, 190)}#${index}`;
    if (seen.has(id)) id = `candidate#${index}`;
    seen.add(id);
    return { candidate: { id, title, description } as Candidate };
  });

  const natural = base.map(b => b.candidate);
  if (requestBytesFor(trimmedTerm, natural) <= MAX_EVALUATION_BYTES) {
    return { candidates: natural, candidateIds: natural.map(c => c.id), shortened: false };
  }

  // Descriptions must shrink. Start from an even per-candidate byte allowance derived from the
  // actual overhead of title-only candidates, rather than looping character by character.
  const titleOnly = base.map(b => ({ ...b.candidate, description: '' }));
  const overheadBytes = requestBytesFor(trimmedTerm, titleOnly);
  if (overheadBytes > MAX_EVALUATION_BYTES) {
    // Even title-only candidates do not fit: drop from the tail until the rest does.
    let kept = base;
    while (kept.length > 1 && requestBytesFor(trimmedTerm, kept.map(b => ({ ...b.candidate, description: '' }))) > MAX_EVALUATION_BYTES) {
      kept = kept.slice(0, -1);
    }
    const keptCandidates = kept.map(b => ({ ...b.candidate, description: '' }));
    if (requestBytesFor(trimmedTerm, keptCandidates) > MAX_EVALUATION_BYTES) {
      // Even a single title-only candidate does not fit alongside the query: the query itself
      // is the problem, and there is no shortlist that could be sent for it.
      return { candidates: [], candidateIds: sliced.map(() => undefined), shortened: false, reason: 'question-too-long' };
    }
    const candidateIds = sliced.map((_, index) => index < keptCandidates.length ? keptCandidates[index].id : undefined);
    return { candidates: keptCandidates, candidateIds, shortened: true };
  }

  const available = MAX_EVALUATION_BYTES - overheadBytes;
  const evenAllowance = Math.max(0, Math.floor(available / base.length));
  // Bounded binary search over the per-candidate byte allowance: `lo = 0` always fits (that is
  // exactly `titleOnly`, already checked above), so the search always terminates with a valid,
  // fitting shortlist. Unlike decrementing the allowance by the measured overage each attempt,
  // this converges correctly even when JSON escaping (control characters, quotes, backslashes)
  // makes a raw byte count a poor predictor of the actual request size.
  let lo = 0;
  let hi = evenAllowance;
  let fitted = titleOnly;
  for (let attempt = 0; attempt < 12 && lo <= hi; attempt++) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = base.map(b => ({ ...b.candidate, description: truncateToBytes(b.candidate.description, mid) }));
    if (requestBytesFor(trimmedTerm, candidate) <= MAX_EVALUATION_BYTES) {
      fitted = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { candidates: fitted, candidateIds: fitted.map(c => c.id), shortened: true };
}

/** A cheap key over the content that can change what `fitShortlist` produces, so the shortlist
 * is memoized on that content rather than on `engineResults`' array identity (a fresh array on
 * every render would otherwise rebuild the shortlist and restart the quiet period each time). */
function shortlistContentKey(results: SearchResult[], limit: number): string {
  const GS = String.fromCharCode(29); // ASCII group separator, unlikely to appear in real content
  const RS = String.fromCharCode(30); // ASCII record separator
  return results.slice(0, limit)
    .map(r => [r.document.location ?? '', r.document.title ?? '', bodySample(r.document.text ?? '')].join(GS))
    .join(RS);
}

/**
 * Reorders the top of a Backstage search result list by how directly each result answers
 * the query, using the `search` workflow. Used in place of `<SearchResult>` inside a host's
 * `SearchContextProvider`; the host still renders each item itself via `children`.
 *
 * Results render immediately in the search engine's own order. They are only reordered once
 * Jev's scores for the *current* question and *current* shortlist are applied — that is,
 * while `!stale` — and every other state (waiting, blocked, failed, Live off, too short)
 * says so plainly next to the Live switch instead of claiming a reorder that did not happen.
 */
export function JevRerankedResults({ children, limit = HARD_LIMIT, liveDelayMs, evaluate: evaluateOverride, live: liveProp }: JevRerankedResultsProps) {
  const { result, term } = useSearch();
  const boundedLimit = Math.max(1, Math.min(HARD_LIMIT, limit));
  const engineResults = result.value?.results ?? [];
  const trimmedTerm = term.trim();
  const shortTerm = trimmedTerm.length > 0 && trimmedTerm.length < MIN_TERM_LENGTH;

  // Memoized on the shortlist's actual content, not on `engineResults`' array identity, so a
  // re-render with the same results does not rebuild the shortlist and restart the quiet period.
  const contentKey = useMemo(() => shortlistContentKey(engineResults, boundedLimit), [engineResults, boundedLimit]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shortlist = useMemo(() => fitShortlist(trimmedTerm, engineResults, boundedLimit), [trimmedTerm, boundedLimit, contentKey]);
  const { candidates, candidateIds, shortened } = shortlist;

  const [preference, setLive] = useLivePreference();
  const forcedOff = liveProp === false;
  const live = liveProp !== false && preference;
  const defaultEvaluate = useJevEvaluate();
  const evaluate = evaluateOverride ?? defaultEvaluate;
  // Hooks run unconditionally; a term that is empty, too short, still loading, or errored
  // simply never produces a sendable request (the schema itself requires 10+ characters).
  const check = useLiveEvaluation({ evaluate, workflow: 'search', text: shortTerm || result.loading || result.error ? '' : trimmedTerm, candidates, live, delayMs: liveDelayMs });

  // Nothing honest to say yet: the search itself has not settled. No caption, no Live switch.
  if (result.loading || result.error) {
    return <>{children(engineResults)}</>;
  }

  // No results to reorder: schema internals ("This workflow needs at least one candidate.")
  // would be meaningless to the reader here, including on an untouched search box. Same
  // treatment as loading/error — no caption, no Live switch.
  if (engineResults.length === 0) {
    return <>{children(engineResults)}</>;
  }

  const liveSwitch = <LiveSwitch live={live} onChange={setLive} forcedOff={forcedOff} />;

  function withCaption(caption: ReactNode, results: SearchResult[]) {
    return <>
      <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" mb={1} style={{ gap: 8 }}>
        <Typography variant="caption" color="textSecondary" component="div">{caption}</Typography>
        {liveSwitch}
      </Box>
      {children(results)}
    </>;
  }

  if (shortTerm) {
    return withCaption('Ask a longer question (10+ characters) to let Jev reorder these results for relevance.', engineResults);
  }

  // Two distinct ways a question can be too long: `fitShortlist` found that not even a
  // title-only candidate fits alongside it under the shared byte budget, or it is over the
  // schema's own 16,000-character cap outright (byte budget aside). Both get the same plain
  // wording here, in place of `useLiveEvaluation`'s generic (workbench-flavoured) blocker text.
  if (shortlist.reason === 'question-too-long' || trimmedTerm.length > MAX_TERM_LENGTH) {
    return withCaption('This question is too long to rank results against.', engineResults);
  }

  // A result only counts as applicable when it was computed for exactly this question and
  // exactly this shortlist — `!check.stale` already means precisely that (see useLiveEvaluation).
  const scoresApply = Boolean(check.result) && !check.stale;

  function unrankedCaption(): ReactNode {
    if (!live) return <>Live check is off — results are in the search engine's order. <Button variant="contained" color="primary" size="small" onClick={check.checkNow}>Rank now</Button></>;
    if (check.blocker) return `These results could not be ranked: ${check.blocker}`;
    if (check.error) return check.retryAt ? `${check.error} Jev will retry automatically.` : check.error;
    return 'Asking Jev to rank these results…';
  }

  if (!scoresApply) {
    return withCaption(unrankedCaption(), engineResults);
  }

  const scoreById = new Map<string, number>();
  const statusById = new Map<string, string>();
  for (const finding of check.result!.findings) {
    if (finding.candidate) { scoreById.set(finding.candidate.id, Number(finding.value)); statusById.set(finding.candidate.id, finding.status); }
  }
  const head = engineResults.slice(0, boundedLimit);
  const tail = engineResults.slice(boundedLimit);
  // Looked up by index into the *current* head, never by object identity: a host re-render can
  // hand back fresh-but-content-equal `SearchResult` objects for the same shortlist.
  const headEntries = head.map((item, index) => ({ item, id: candidateIds[index] }));
  const scoredEntries = headEntries.filter(entry => entry.id !== undefined && scoreById.has(entry.id));
  const unscored = headEntries.filter(entry => entry.id === undefined || !scoreById.has(entry.id)).map(entry => entry.item);

  if (scoredEntries.length === 0) {
    // Scores landed for exactly this question and shortlist, but none of them could be matched
    // to the current head — nothing was actually reordered, so say so honestly instead of
    // claiming a reorder that did not happen, and distinctly from still waiting on a check.
    return withCaption("Jev's scores could not be matched to these results.", engineResults);
  }

  scoredEntries.sort((a, b) => scoreById.get(b.id!)! - scoreById.get(a.id!)!);
  const scored = scoredEntries.map(entry => entry.item);
  const ordered = [...scored, ...unscored, ...tail];
  const anyReview = scoredEntries.some(entry => statusById.get(entry.id!) === 'review');
  const caption = reorderedCaption({ scored: scoredEntries.length, total: headEntries.length, anyReview, shortened });

  return withCaption(caption, ordered);
}
