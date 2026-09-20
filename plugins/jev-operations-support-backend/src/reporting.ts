import { findingStatusLabels, formatFindingValue, negativeFindingDisclaimer, type EvaluationResult, type Finding } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { GitHubClientError, type GitHubClient, type GitHubCommitStatusState } from './client';
import type { PullRequestEvent } from './github';
import type { ChangeReviewContext, ChangeReviewFileEntry } from './changeReview';

export type ReportMode = 'none' | 'status' | 'status+comment';
export type BlockOn = 'never' | 'attention';

/** A fixed context string identifies this integration's own status among any others posted on the same commit. */
export const STATUS_CONTEXT = 'jev/readiness';
/** Separate fixed context for the opt-in change-review feature, so it never collides with (or is confused for)
 * the readiness status above -- the two are independent GitHub statuses on the same commit. */
export const CHANGE_REVIEW_STATUS_CONTEXT = 'jev/change-review';
/** `change-risk` finding ids that represent a genuine CONCERN (as opposed to `rollback`, which is the inverse: a
 * `pass` there is the good outcome). Mirrors `buildEvaluation`'s own `case 'change-risk'` check list in the common
 * package -- kept here as a small closed set rather than importing check internals, since this module only needs
 * the three ids, not the checks themselves. */
const CHANGE_REVIEW_CONCERN_IDS = new Set(['breaking', 'migration', 'access']);
/** At most this many disclosure entries are rendered per category in the PR comment; the rest are folded into a
 * single "... and N more" line, mirroring `changeReview.ts`'s own per-list caps so neither list can push the
 * comment anywhere near its own 60,000-character cap. */
const MAX_DISCLOSURE_ENTRIES_PER_CATEGORY = 50;
/** Hidden in the comment body so a later delivery can find and update its own prior comment instead of piling up new ones. */
export const COMMENT_MARKER = '<!-- jev-operations-support:report -->';
/** Written when a `pending` had already been posted for a SHA that the pull request then moved away from -- the
 * evaluation result belongs to that old commit, but a real result is no longer meaningful to post there. This
 * resolves the dangling `pending` (which would otherwise sit forever, and can fail a merge under branch
 * protection) without claiming a readiness judgment that was never actually completed. */
export const NEUTRAL_DESCRIPTION = 'Not evaluated -- the pull request changed during the check';
const MAX_STATUS_DESCRIPTION_CHARS = 140;
const MAX_COMMENT_BODY_CHARS = 60000;
const MAX_MODEL_CHARS = 80;

/** The final status write gets up to three attempts (the initial one plus these two backoff delays) for a
 * transient failure, inside its own fixed budget, independent of whatever the caller's own deadline is doing,
 * since resolving a `pending` already posted to GitHub is important enough to retry even after the evaluation
 * itself is long past its own deadline. */
const RETRY_DELAYS_MS = [500, 1500];
const FINAL_WRITE_BUDGET_MS = 10000;
/** The pre-write head recheck gets its own small budget so a slow or hanging read can never eat into the final
 * write's own retry budget above. */
const HEAD_RECHECK_BUDGET_MS = 3000;
/** The comment write is best-effort and single-attempt, in its own budget separate from both of the above. */
const COMMENT_WRITE_BUDGET_MS = 5000;

export type ReportOptions = {
  client: GitHubClient;
  mode: ReportMode;
  blockOn: BlockOn;
  /** Only used to build a `target_url` on the status; omitted entirely when not configured. */
  baseUrl?: string;
  maxCommentPages: number;
  /** When true, `reportFinal` never writes its own (readiness-only) comment: `router.ts` takes over the comment
   * write in this case, since a change-review section belongs in the SAME marker comment as readiness's table,
   * not a second one. Has no effect on `status`-only mode, which never writes a comment either way. Defaults to
   * `false`, which reproduces `reportFinal`'s original comment behaviour exactly -- see the change-review docs. */
  changeReviewEnabled?: boolean;
  /** Test seam; production logs a sanitized one-line message and swallows the error, as writes must never throw past the queue. */
  onWriteFailure?: (step: string, error: unknown) => void;
};

/** What the final GitHub write should say. `neutral` is rule (1)'s dangling-`pending` resolution; it always
 * writes to `event.headSha` unconditionally (that is, without re-checking whether the head has since moved again --
 * the whole point of a neutral resolution is that it is harmless regardless). */
export type FinalStatus =
  | { kind: 'evaluated'; documents: Array<{ path: string; result: EvaluationResult }> }
  | { kind: 'error'; reason: string }
  | { kind: 'neutral' };

/** Change-review counterpart to `FinalStatus`. `error` covers both a `ChangeReviewUnavailableError` (a fixed,
 * content-free reason -- see `github.ts`) and any ordinary evaluation failure (a GitHub read after confirmation, a
 * Jev failure, or the deadline), classified the same way readiness's own errors are. */
export type ChangeReviewFinalStatus =
  | { kind: 'evaluated'; result: EvaluationResult }
  | { kind: 'error'; reason: string }
  | { kind: 'neutral' };

/** Writes the initial `pending` status. Called only once a delivery is known to touch a matching document. Unlike
 * the final write below, this is a single best-effort attempt: a delivery that never gets past `pending` still
 * owes -- and gets -- a real final write once evaluation finishes, so a missed `pending` is not itself fatal to
 * the invariant, just a cosmetic gap while GitHub shows no status at all for a moment. */
export async function reportPending(options: ReportOptions, event: PullRequestEvent, signal: AbortSignal): Promise<void> {
  if (options.mode === 'none') return;
  await guarded(options, 'pending status', () => writeStatus(options, event, STATUS_CONTEXT, 'pending', withPrPrefix(event, 'Jev is evaluating the changed documentation...'), signal));
}

/** Change-review counterpart to `reportPending`, written under the separate `jev/change-review` context. Change
 * review has no "nothing matched" concept -- once enabled and the pull request head is confirmed, it is always
 * owed a `pending`. */
export async function reportChangeReviewPending(options: ReportOptions, event: PullRequestEvent, signal: AbortSignal): Promise<void> {
  if (options.mode === 'none') return;
  await guarded(options, 'change review pending status', () => writeStatus(options, event, CHANGE_REVIEW_STATUS_CONTEXT, 'pending', withPrPrefix(event, 'Jev is reviewing the pull request diff...'), signal));
}

/** Writes the one final state a delivery that reached `onMatched` (and so got a `pending`) always owes: an
 * `evaluated` result, an `error`, or (if the head moved) the neutral resolution instead of either. Returns whether
 * the write that resolves the `pending` actually succeeded -- the comment write, if any, does not affect this,
 * since the commit status is the authoritative "final state" and the comment is supplementary (and is skipped
 * entirely when the status write failed -- see below). The caller uses this to decide whether the delivery may be
 * forgotten for a *manual* GitHub redelivery to retry (see `router.ts`): reporting mode always answers `202` to
 * GitHub itself, so GitHub never automatically redelivers a failed report the way it would a `5xx` synchronous
 * response -- if every retry here is exhausted, the `pending` stays until a new commit or a manual Redeliver. */
export async function reportFinal(options: ReportOptions, event: PullRequestEvent, final: FinalStatus, signal: AbortSignal): Promise<boolean> {
  if (options.mode === 'none') return false;

  if (final.kind === 'neutral') {
    // Deliberately skips the pre-write head recheck below: a neutral resolution is only ever reached because
    // evaluation itself already confirmed the head or base moved, so re-confirming it again first would only add
    // one more read that changes nothing about what gets written.
    return writeStatusWithRetry(options, event, STATUS_CONTEXT, 'success', withPrPrefix(event, NEUTRAL_DESCRIPTION), signal, 'neutral status');
  }

  // Only a CONFIRMED moved head suppresses the real result. If the recheck itself fails (a transient GitHub error,
  // a rate limit), that is no riskier than the `pending` already sitting on `event.headSha`, so the real result is
  // still written there rather than silently dropped just because one extra read failed.
  const head = await checkHead(options, event, signal);
  if (head === 'moved') {
    return writeStatusWithRetry(options, event, STATUS_CONTEXT, 'success', withPrPrefix(event, NEUTRAL_DESCRIPTION), signal, 'neutral status');
  }

  if (final.kind === 'error') {
    return writeStatusWithRetry(options, event, STATUS_CONTEXT, 'error', withPrPrefix(event, final.reason), signal, 'error status');
  }

  const { state, description } = describeOutcome(final.documents, options.blockOn);
  const wrote = await writeStatusWithRetry(options, event, STATUS_CONTEXT, state, withPrPrefix(event, description), signal, 'commit status');
  // The status is the authoritative signal; if it could not be posted at all, a result table next to a `pending`
  // that never resolved would be actively misleading, so the comment is skipped rather than attempted anyway.
  // Skipped entirely when change review is enabled: `router.ts` writes ONE combined comment (readiness + change
  // review sections) after both contexts have resolved, instead of this readiness-only comment.
  if (wrote && options.mode === 'status+comment' && !options.changeReviewEnabled) await writeCommentBestEffort(options, event, final.documents, signal);
  return wrote;
}

/** Change-review counterpart to `reportFinal`, written under `jev/change-review`. Never writes a comment itself
 * (see `reportFinal`'s own note): the combined comment is always written from `router.ts`, once, after both
 * contexts have resolved. */
export async function reportChangeReviewFinal(options: ReportOptions, event: PullRequestEvent, final: ChangeReviewFinalStatus, signal: AbortSignal): Promise<boolean> {
  if (options.mode === 'none') return false;

  if (final.kind === 'neutral') {
    return writeStatusWithRetry(options, event, CHANGE_REVIEW_STATUS_CONTEXT, 'success', withPrPrefix(event, NEUTRAL_DESCRIPTION), signal, 'change review neutral status');
  }
  const head = await checkHead(options, event, signal);
  if (head === 'moved') {
    return writeStatusWithRetry(options, event, CHANGE_REVIEW_STATUS_CONTEXT, 'success', withPrPrefix(event, NEUTRAL_DESCRIPTION), signal, 'change review neutral status');
  }
  if (final.kind === 'error') {
    return writeStatusWithRetry(options, event, CHANGE_REVIEW_STATUS_CONTEXT, 'error', withPrPrefix(event, final.reason), signal, 'change review error status');
  }
  const { state, description } = describeChangeReviewOutcome(final.result, options.blockOn);
  return writeStatusWithRetry(options, event, CHANGE_REVIEW_STATUS_CONTEXT, state, withPrPrefix(event, description), signal, 'change review commit status');
}

async function writeStatus(options: ReportOptions, event: PullRequestEvent, context: string, state: GitHubCommitStatusState, description: string, signal: AbortSignal): Promise<void> {
  await options.client.createCommitStatus(event.repository, event.headSha, { state, description, context, targetUrl: options.baseUrl }, signal);
}

/** Retries a transient failure (a network error, a `5xx`, or GitHub's `403`/`429` rate limiting -- never `401`,
 * `404`, or `422`, which will not succeed on retry) up to twice more with backoff, inside its own fixed budget
 * (`FINAL_WRITE_BUDGET_MS`) independent of the caller's own signal lifetime. */
async function writeStatusWithRetry(options: ReportOptions, event: PullRequestEvent, context: string, state: GitHubCommitStatusState, description: string, parentSignal: AbortSignal, step: string): Promise<boolean> {
  const { signal, cancel } = withBudget(parentSignal, FINAL_WRITE_BUDGET_MS);
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await writeStatus(options, event, context, state, description, signal);
        return true;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof GitHubClientError && error.retryable;
        if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
        try { await sleep(RETRY_DELAYS_MS[attempt], signal); }
        catch { break; } // the budget ran out mid-backoff
      }
    }
    logFailure(options, step, lastError);
    return false;
  } finally { cancel(); }
}

/** Counts findings across every evaluated document. `blockOn: 'attention'` fails the status on any attention finding; low
 * confidence (`review`) alone never blocks, matching the workbench's own advisory-by-default posture. */
export function describeOutcome(documents: Array<{ path: string; result: EvaluationResult }>, blockOn: BlockOn): { state: Extract<GitHubCommitStatusState, 'success' | 'failure'>; description: string } {
  const findings = documents.flatMap(document => document.result.findings);
  const clear = findings.filter(finding => finding.status === 'pass').length;
  const attention = findings.filter(finding => finding.status === 'attention').length;
  const review = findings.filter(finding => finding.status === 'review').length;
  const blocking = blockOn === 'attention' && attention > 0;
  return { state: blocking ? 'failure' : 'success', description: `${clear} clear · ${attention} attention · ${review} needs review — ${blocking ? 'blocking' : 'advisory'}` };
}

/** Describes a `change-risk` result honestly: `breaking`/`migration`/`access` are CONCERN checks, where `summarize`
 * (in the common package) never reports `pass` -- a low probability there means the concern was "not established"
 * (`review`), which is explicitly NOT evidence the change is safe, and only a high probability reports `attention`.
 * `rollback` is the inverse (a `pass` there IS the good outcome: rollback is documented). `blockOn: 'attention'`
 * fails the status only on an `attention` CONCERN finding -- a `review` (including an unestablished concern, or an
 * unclear rollback) never blocks by itself, matching the workbench's own advisory posture. */
export function describeChangeReviewOutcome(result: EvaluationResult, blockOn: BlockOn): { state: Extract<GitHubCommitStatusState, 'success' | 'failure'>; description: string } {
  const concernFindings = result.findings.filter(finding => CHANGE_REVIEW_CONCERN_IDS.has(finding.id));
  const attention = concernFindings.filter(finding => finding.status === 'attention').length;
  const notEstablished = concernFindings.filter(finding => finding.status === 'review').length;
  const rollback = result.findings.find(finding => finding.id === 'rollback');
  const rollbackText = !rollback ? 'rollback unknown' : rollback.status === 'pass' ? 'rollback documented' : rollback.status === 'review' ? 'rollback unclear' : 'rollback not documented';
  const blocking = blockOn === 'attention' && attention > 0;
  return {
    state: blocking ? 'failure' : 'success',
    description: `${attention} concern${attention === 1 ? '' : 's'} · ${notEstablished} not established · ${rollbackText} — ${blocking ? 'blocking' : 'advisory'}`,
  };
}

/** Names the pull request in every status description: commit statuses are keyed only by (repository, SHA,
 * context), so two open pull requests that happen to share a commit (a common shape for a stacked or rebased
 * branch) would otherwise silently overwrite each other's `jev/readiness` status with no indication which PR it
 * came from -- including a neutral or `error` resolution from one overwriting a genuine `failure` from the other
 * under `blockOn: attention`. Naming the PR does not prevent the overwrite (no extra GitHub read is made to detect
 * it), but makes it visible instead of silent; see the docs for the fuller caveat. */
function withPrPrefix(event: PullRequestEvent, text: string): string {
  return `PR #${event.pullRequestNumber} · ${text}`.slice(0, MAX_STATUS_DESCRIPTION_CHARS);
}

/** `moved` only when a fresh read confirms a different head SHA. `unknown` (the read itself failed) is treated
 * exactly like `current` by every caller: it never suppresses a write on its own (see `reportFinal`). Bounded to
 * its own small budget so a slow or hanging read cannot starve the final write's own retry budget. */
async function checkHead(options: ReportOptions, event: PullRequestEvent, parentSignal: AbortSignal): Promise<'current' | 'moved' | 'unknown'> {
  const { signal, cancel } = withBudget(parentSignal, HEAD_RECHECK_BUDGET_MS);
  try {
    const current = await options.client.getPullRequest(event.repository, event.pullRequestNumber, signal);
    return current.headSha === event.headSha ? 'current' : 'moved';
  } catch (error) {
    logFailure(options, 'head recheck before writing', error);
    return 'unknown';
  } finally { cancel(); }
}

async function writeCommentBestEffort(options: ReportOptions, event: PullRequestEvent, documents: Array<{ path: string; result: EvaluationResult }>, parentSignal: AbortSignal): Promise<void> {
  await writeMarkerCommentBestEffort(options, event, () => buildCommentBody(event, documents), parentSignal);
}

/** Combined counterpart to `writeCommentBestEffort`, called from `router.ts` -- never from `reportFinal` itself --
 * once change review is enabled, so the readiness table and the change-review section land in the SAME marker
 * comment instead of two separate ones. Each section is included only when the caller supplies it: `router.ts`
 * omits a section whose own status write did not succeed (see its own comment), and omits change review entirely
 * when it never ran. If NEITHER section is supplied, nothing is written -- there is nothing to say. */
export async function reportCombinedComment(
  options: ReportOptions,
  event: PullRequestEvent,
  sections: { readinessDocuments?: Array<{ path: string; result: EvaluationResult }>; changeReview?: { result: EvaluationResult; context: ChangeReviewContext } },
  signal: AbortSignal,
): Promise<void> {
  if (sections.readinessDocuments === undefined && sections.changeReview === undefined) return;
  await writeMarkerCommentBestEffort(options, event, () => buildCombinedCommentBody(event, sections), signal);
}

async function writeMarkerCommentBestEffort(options: ReportOptions, event: PullRequestEvent, buildBody: () => string, parentSignal: AbortSignal): Promise<void> {
  const { signal, cancel } = withBudget(parentSignal, COMMENT_WRITE_BUDGET_MS);
  try {
    await guarded(options, 'report comment', async () => {
      const login = await options.client.getAuthenticatedLogin(signal);
      // Newest-first (see `client.ts`): among up to `maxCommentPages` most-recent comments, the first marked one
      // authored by this token's own user is this integration's own prior comment. A marker older than that window
      // is not found, and a new comment is created instead of updating it -- a documented, accepted limitation of a
      // fixed page bound.
      const comments = await options.client.listIssueComments(event.repository, event.pullRequestNumber, { maxPages: options.maxCommentPages }, signal);
      // `startsWith`, not `includes`: the marker is only ever meaningful as the very first thing this integration
      // itself wrote (see `buildCommentBody`), so a comment that merely quotes or mentions the marker text
      // somewhere in its body is never mistaken for this integration's own comment.
      const existing = comments.find(comment => comment.login.toLowerCase() === login.toLowerCase() && comment.body.startsWith(COMMENT_MARKER));
      const body = buildBody();
      if (existing) await options.client.updateIssueComment(event.repository, existing.id, body, signal);
      else await options.client.createIssueComment(event.repository, event.pullRequestNumber, body, signal);
    });
  } finally { cancel(); }
}

/** Never includes document content: only the path (rendered as an inert code span -- see `codeSpan`), the fixed
 * check title/guidance, the answer, the status, the model, and the evaluation time. Bounded to `maxChars`
 * (`MAX_COMMENT_BODY_CHARS` by default -- the standalone readiness-only comment `reportFinal` writes when change
 * review is not enabled), truncating the table rather than growing without limit on a pull request with an
 * unusually large number of matching documents and findings. `buildCombinedCommentBody` below passes a SMALLER
 * `maxChars` once a change-review section's own size is already known (F1: change review is built and reserved
 * FIRST, so readiness's own existing row-level truncation is what absorbs the shortfall, rather than the
 * change-review section silently losing its disclaimers to a blind tail clip of the whole concatenated body).
 * The marker is always the very first bytes of the body (see `writeCommentBestEffort`'s `startsWith` check). */
export function buildCommentBody(event: PullRequestEvent, documents: Array<{ path: string; result: EvaluationResult }>, maxChars: number = MAX_COMMENT_BODY_CHARS): string {
  const shortSha = event.headSha.slice(0, 7);
  const model = codeSpan((documents.find(document => document.result.model)?.result.model ?? 'unknown').slice(0, MAX_MODEL_CHARS));
  const evaluatedAt = sanitizePlain(documents[0]?.result.evaluatedAt ?? new Date().toISOString());
  const header = [
    COMMENT_MARKER,
    `**Jev readiness check** -- PR #${event.pullRequestNumber}, head \`${shortSha}\``,
    '',
    '| Document | Check | Answer | Status | Next step |',
    '| --- | --- | --- | --- | --- |',
  ];
  const footer = ['', `Model: ${model} · Evaluated: ${evaluatedAt}`, '', `_${negativeFindingDisclaimer}_`];
  const allRows = documents.flatMap(document => document.result.findings.map(finding => buildRow(document.path, finding)));
  // Reserve generous headroom for the header/footer/truncation notice themselves so the guard is never cut close.
  const budget = maxChars - header.join('\n').length - footer.join('\n').length - 300;
  const rows: string[] = [];
  let used = 0;
  let truncated = false;
  for (const row of allRows) {
    if (used + row.length + 1 > budget) { truncated = true; break; }
    rows.push(row);
    used += row.length + 1;
  }
  if (truncated) rows.push('| ... | ... | ... | ... | *(truncated: remaining findings omitted -- see the workbench UI for the full result)* |');
  // `header[0]` is `COMMENT_MARKER`: it is always the first bytes of the body (see the `startsWith` check above).
  return [...header, ...rows, ...footer].join('\n');
}

function buildRow(path: string, finding: Finding): string {
  return `| ${codeSpan(path)} | ${escapeMarkdownPlain(finding.title)} | ${escapeMarkdownPlain(formatFindingValue(finding))} | ${findingStatusLabels[finding.status]} | ${escapeMarkdownPlain(finding.guidance)} |`;
}

/** Same shape as `buildRow`, minus the per-document path column: a change-review result is PR-wide, not per-file. */
function buildChangeReviewRow(finding: Finding): string {
  return `| ${escapeMarkdownPlain(finding.title)} | ${escapeMarkdownPlain(formatFindingValue(finding))} | ${findingStatusLabels[finding.status]} | ${escapeMarkdownPlain(finding.guidance)} |`;
}

/**
 * The `<details>` disclosure block for the change-review section: what was sent to the provider and what was
 * withheld, and why. Deliberately never renders `rawPath` (only `path`/`reason`, which `changeReview.ts` already
 * makes display-safe -- bidi placeholders, length-capped): every path additionally passes through `codeSpan` here
 * (Markdown/HTML-inert, further strips hidden Unicode), and every reason through `escapeMarkdownPlain`, exactly
 * like every other PR-controlled string this module renders. Diff content and the PR description are NEVER
 * included, in this section or anywhere else in the comment -- only path names, reasons, and counts.
 *
 * `entryCap` bounds how many entries each category lists before folding the rest into "... and N more" -- normally
 * `MAX_DISCLOSURE_ENTRIES_PER_CATEGORY` (50), but `buildChangeReviewSection` below degrades this toward 0 when the
 * section alone would otherwise not fit its budget. The `<summary>` line's OWN counts are the true, undegraded
 * totals regardless of `entryCap` (F1: the counts are never themselves dropped or approximated), and even at
 * `entryCap: 0` every category still gets its "N" count line and, if non-zero, an "... and N more" tail -- only
 * the individual entries disappear.
 */
function buildDisclosureDetails(context: ChangeReviewContext, entryCap: number): string {
  const summary = `What was sent: ${context.included.length} included · ${context.listedOnly.length} listed only · ${context.excludedSensitive.length} excluded as sensitive · ${context.unsupportedPath.length} unsupported path · ${context.withoutPatch.length} no diff`;
  const lines: string[] = [];
  lines.push(...renderDisclosurePathList('Diff excerpts sent for review', context.included, entryCap));
  lines.push(...renderDisclosureEntryList('Files listed only, no diff sent', context.listedOnly, entryCap));
  lines.push(...renderDisclosureEntryList('Files excluded as sensitive paths (path heuristic, not secret scanning)', context.excludedSensitive, entryCap));
  lines.push(...renderDisclosureEntryList('Files with a path this check could not evaluate, no diff sent', context.unsupportedPath, entryCap));
  lines.push(...renderDisclosurePathList('Files with no diff available (binary or too large)', context.withoutPatch, entryCap));
  if (context.truncated) lines.push('', '_Some content was shortened to fit the evaluation budget._');
  return ['<details>', `<summary>${escapeMarkdownPlain(summary)}</summary>`, '', ...lines, '', '</details>'].join('\n');
}

/** Renders a bounded list of raw (not-yet-display-safe, per `ChangeReviewContext`'s own doc comment) paths, each
 * through `codeSpan`. Capped at `entryCap` (0 lists none, only the count/tail lines), with an "... and N more" tail. */
function renderDisclosurePathList(label: string, paths: string[], entryCap: number): string[] {
  const lines = [`- **${escapeMarkdownPlain(label)}:** ${paths.length}`];
  const shown = paths.slice(0, Math.max(0, entryCap));
  for (const path of shown) lines.push(`  - ${codeSpan(path)}`);
  if (paths.length > shown.length) lines.push(`  - … and ${paths.length - shown.length} more`);
  return lines;
}

/** Same as `renderDisclosurePathList`, for `ChangeReviewFileEntry` lists (which additionally carry an optional
 * `reason`, rendered on its own line through the plain escaper -- never appended inline to the path). */
function renderDisclosureEntryList(label: string, entries: ChangeReviewFileEntry[], entryCap: number): string[] {
  const lines = [`- **${escapeMarkdownPlain(label)}:** ${entries.length}`];
  const shown = entries.slice(0, Math.max(0, entryCap));
  for (const entry of shown) {
    lines.push(`  - ${codeSpan(entry.path)}`);
    if (entry.reason) lines.push(`    - ${escapeMarkdownPlain(entry.reason)}`);
  }
  if (entries.length > shown.length) lines.push(`  - … and ${entries.length - shown.length} more`);
  return lines;
}

/** Renders the whole "Change review" section: heading, its own findings table, the STANDING DISCLAIMERS (moved
 * ahead of the itemized disclosure list, not after it, so a later truncation of the entry lists can never reach
 * them), then the `<details>` disclosure block. These three things -- the findings table, the disclaimers, and
 * the `<summary>` line's counts -- are never dropped by degrading `entryCap`; only the itemized per-category
 * entries are. */
function buildChangeReviewSectionText(event: PullRequestEvent, result: EvaluationResult, context: ChangeReviewContext, entryCap: number): string {
  const rows = result.findings.map(buildChangeReviewRow);
  return [
    '### Change review',
    '',
    `**Jev change review** -- PR #${event.pullRequestNumber}, head \`${event.headSha.slice(0, 7)}\``,
    '',
    '| Check | Answer | Status | Next step |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `_${negativeFindingDisclaimer}_`,
    '',
    '_"Not established" is not evidence that the change is safe._',
    '',
    '_Sensitive paths are withheld by a path heuristic, not secret scanning; the pull request title and description are sent as written._',
    '',
    buildDisclosureDetails(context, entryCap),
  ].join('\n');
}

/** Per-category entry caps tried in order until the rendered section fits `budgetChars`, degrading from the
 * normal `MAX_DISCLOSURE_ENTRIES_PER_CATEGORY` down to 0 (F1). The findings table and disclaimers never shrink --
 * only how many disclosure entries per category are listed -- so even the smallest rendering (`0`) still names
 * every category's count and, when non-empty, an "... and N more" line; it just never lists individual paths. */
const DISCLOSURE_ENTRY_CAP_STEPS = [MAX_DISCLOSURE_ENTRIES_PER_CATEGORY, 25, 10, 5, 1, 0];

/** Builds the "Change review" section, shrinking its OWN disclosure lists (never the findings table or
 * disclaimers) until it fits `budgetChars` on its own -- or, failing even at the smallest step, returns that
 * smallest rendering anyway (the caller's own hard-clip safety net is the final backstop). */
function buildChangeReviewSection(event: PullRequestEvent, result: EvaluationResult, context: ChangeReviewContext, budgetChars: number): string {
  let smallest = '';
  for (const cap of DISCLOSURE_ENTRY_CAP_STEPS) {
    const text = buildChangeReviewSectionText(event, result, context, cap);
    smallest = text;
    if (text.length <= budgetChars) return text;
  }
  return smallest;
}

/** Generous headroom reserved (beyond either section's own content) for the marker, the blank-line separators
 * between sections, and the last-resort hard-clip's own truncation notice -- so the guard below is never cut close. */
const COMBINED_COMMENT_SLACK_CHARS = 500;
/** However large the change-review section's own reservation is, readiness never gets pushed below this floor:
 * enough room for its own header, footer, and a single truncation notice row, so it still reads as a coherent
 * (if heavily truncated) table rather than degenerating below what `buildCommentBody`'s own fixed overhead needs. */
const MIN_READINESS_BUDGET_CHARS = 500;

/**
 * Builds the combined comment body. F1: the change-review section is built and its length RESERVED first (with
 * its own disclosure-list degradation if it alone would not fit), and readiness -- via its own existing
 * row-level truncation, now budget-aware -- gets only what remains. This is the opposite order from a naive
 * concatenate-then-clip-the-tail approach, which would silently cut the change-review section's disclaimers and
 * disclosure block off the end whenever readiness's own table happened to be large. Either section may be
 * omitted (see `reportCombinedComment`). Still hard-capped to `MAX_COMMENT_BODY_CHARS` as a last-resort safety
 * net (should not fire in ordinary use, now that budgets are reserved up front), which re-closes an `<details>`
 * left unmatched by the clip.
 */
function buildCombinedCommentBody(event: PullRequestEvent, sections: { readinessDocuments?: Array<{ path: string; result: EvaluationResult }>; changeReview?: { result: EvaluationResult; context: ChangeReviewContext } }): string {
  const SEPARATOR = '\n\n';
  let changeReviewText: string | undefined;
  if (sections.changeReview !== undefined) {
    const ceiling = MAX_COMMENT_BODY_CHARS - COMMENT_MARKER.length - SEPARATOR.length - COMBINED_COMMENT_SLACK_CHARS;
    changeReviewText = buildChangeReviewSection(event, sections.changeReview.result, sections.changeReview.context, ceiling);
  }
  let readinessText: string | undefined;
  if (sections.readinessDocuments !== undefined) {
    const reserved = changeReviewText !== undefined ? changeReviewText.length + SEPARATOR.length : 0;
    const readinessBudget = Math.max(MIN_READINESS_BUDGET_CHARS, MAX_COMMENT_BODY_CHARS - COMMENT_MARKER.length - reserved - COMBINED_COMMENT_SLACK_CHARS);
    // Reuses buildCommentBody's own budget/truncation logic exactly, including its leading marker; the marker is
    // stripped back off here since it must appear exactly once, at the very start of the WHOLE combined body.
    const readinessBody = buildCommentBody(event, sections.readinessDocuments, readinessBudget);
    readinessText = readinessBody.startsWith(COMMENT_MARKER) ? readinessBody.slice(COMMENT_MARKER.length).replace(/^\n/, '') : readinessBody;
  }
  const parts = [readinessText, changeReviewText].filter((part): part is string => part !== undefined);
  const body = [COMMENT_MARKER, ...parts].join(SEPARATOR);
  if (body.length <= MAX_COMMENT_BODY_CHARS) return closeUnmatchedDetails(body);
  // Last-resort, code-point-safe hard clip: preserves the marker (always the first bytes) and just shortens the
  // tail. Should not be reachable now that both sections reserve their own budgets up front, but kept as a final
  // backstop; `closeUnmatchedDetails` repairs an `<details>` this clip cut into.
  return closeUnmatchedDetails(truncateCodePointsSafeLocal(body, MAX_COMMENT_BODY_CHARS - 20) + '\n\n_(truncated)_');
}

/** Appends a matching `</details>` for every `<details>` the body has more of than `</details>` -- a clip that
 * lands mid-way through the change-review section's own `<details>` block would otherwise leave it permanently
 * unclosed, which some Markdown renderers display strangely for the rest of the comment. */
function closeUnmatchedDetails(body: string): string {
  const opens = (body.match(/<details>/g) ?? []).length;
  const closes = (body.match(/<\/details>/g) ?? []).length;
  return opens > closes ? body + '\n</details>'.repeat(opens - closes) : body;
}

/** Truncates to at most `maxUnits` UTF-16 code units without splitting a surrogate pair -- a small local copy
 * (this module has no existing shared truncation helper) used only as `buildCombinedCommentBody`'s last-resort
 * safety net above. */
function truncateCodePointsSafeLocal(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  let cut = value.slice(0, Math.max(0, maxUnits));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Builds a character-class regex from numeric Unicode code points, rather than embedding either an escape
 * sequence or (worse) an actual literal character in this source file: a code point is a plain decimal/hex
 * number, so there is no escape-sequence-vs-real-character ambiguity for an editor, a diff viewer, or a
 * copy/paste to introduce. A test scans this file's raw bytes and confirms it contains none of the control bytes
 * or hidden Unicode characters this module strips, precisely because they must never appear here literally. */
function charClass(singles: number[], ranges: Array<[number, number]>): RegExp {
  const chars = singles.map(codePoint => String.fromCodePoint(codePoint));
  const rangeChars = ranges.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`);
  return new RegExp(`[${[...chars, ...rangeChars].join('')}]`, 'gu');
}

// C0 control characters and DEL (0x00-0x1F, 0x7F): could otherwise inject a raw newline, tab, or other control
// byte into a single-line table cell or code span.
const CONTROL_CHARACTERS = charClass([0x7f], [[0x00, 0x1f]]);
// Unicode bidi/format/zero-width characters: none of these are "control characters" in the C0 sense, but a
// right-to-left override (0x202E) or similar can make a rendered path or model string display in a misleading
// order without changing its bytes, and a zero-width character can hide extra content invisibly. Covers explicit
// bidi embedding/override/isolate controls, zero-width space/joiner/non-joiner and the Mongolian vowel separator,
// word joiner and the invisible math operators, the byte-order mark, the Unicode line/paragraph separators, and
// the Arabic letter mark.
const HIDDEN_UNICODE = charClass(
  [0xfeff, 0x061c, 0x180e],
  [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x2028, 0x2029]],
);
/** Used only to neutralise an `@mention`, inserted (never embedded literally in this source) right after the `@`
 * so `@name` still reads the same but GitHub's mention post-processing does not treat it as one word. Applied
 * strictly after `sanitizePlain`, which would otherwise strip this same code point right back out. */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/** Strips control characters/newlines and hidden/bidi Unicode, then collapses to one line -- safe as either
 * code-span or plain content. */
function sanitizePlain(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').replace(HIDDEN_UNICODE, '').trim();
}

/** Renders `text` as a Markdown inline code span GitHub cannot parse as anything else: no link, image, HTML tag,
 * heading, emphasis, or `@mention` is ever produced from its content, and it stays inert regardless of what an
 * attacker-controlled changed-file path contains (a Markdown link, an `<img>` tag, `@org/team`, backticks,
 * newlines, or a bidi override attempting to visually disguise the path). The backtick fence is sized to one more
 * than the longest run of backticks already in the text, the standard CommonMark technique, so an embedded
 * backtick can never break out of the span. A `|` is additionally replaced by a full-width look-alike (not
 * escaped, since code-span content is literal and a backslash would render visibly) so the cell stays intact in a
 * Markdown table even under a renderer that does not protect pipes inside code spans within table cells, which
 * the GFM tables extension itself does. */
function codeSpan(text: string): string {
  const sanitized = sanitizePlain(text).replace(/\|/g, '｜');
  const longestBacktickRun = Math.max(0, ...(sanitized.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longestBacktickRun + 1);
  const pad = sanitized === '' || sanitized.startsWith('`') || sanitized.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${sanitized}${pad}${fence}`;
}

/** Defensive escaping for any fixed (non-code-span) table cell text -- today only the check title and guidance,
 * which come from the common package's own check catalog and never from PR-controlled input, but this keeps that
 * true if a future check ever interpolates something less trusted into its title or guidance. Neutralises
 * `@mentions` with a zero-width space, applied only after `sanitizePlain` has already stripped any zero-width
 * characters that might otherwise already be present (backslash-escaping `@` is not reliable against GitHub's
 * separate mention post-processing step), and backslash-escapes the remaining Markdown metacharacters named in
 * the review: `[ ] ( ) < > ! # | \` * _`. */
function escapeMarkdownPlain(value: string): string {
  const clean = sanitizePlain(value);
  const noMentions = clean.replace(/@(?=\w)/g, `@${ZERO_WIDTH_SPACE}`);
  return noMentions.replace(/([[\]()<>!#|\\`*_])/g, '\\$1');
}

/** Sleeps for `ms`, or rejects immediately if `signal` is already aborted, or as soon as it aborts -- used only
 * for the backoff between retry attempts, so an exhausted budget cuts a wait short rather than overrunning it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
}

/** A signal that aborts when `parent` does, or after `ms`, whichever comes first -- used to give a step (the head
 * recheck, the retried final write, the comment) its own fixed budget independent of how much of any other
 * budget remains. */
function withBudget(parent: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const signal = AbortSignal.any([parent, controller.signal]);
  return { signal, cancel: () => clearTimeout(timer) };
}

/** Runs `run`, logs and swallows any failure (never throws past the queue), and reports whether it succeeded. */
async function guarded(options: ReportOptions, step: string, run: () => Promise<void>): Promise<boolean> {
  try { await run(); return true; }
  catch (error) { logFailure(options, step, error); return false; }
}

function logFailure(options: ReportOptions, step: string, error: unknown): void {
  if (options.onWriteFailure) { options.onWriteFailure(step, error); return; }
  // GitHubClientError/GitHubLimitError messages are already sanitized (no secrets, tokens, or document content).
  console.error(`[jev-operations-support] GitHub report write failed (${step}): ${error instanceof Error ? error.message : 'unknown error'}`);
}
