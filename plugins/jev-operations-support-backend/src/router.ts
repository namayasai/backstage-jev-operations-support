import { attachResponsePlan, type ResponsePlanner } from './responsePlan';
import { createResponsePlanRefs } from './responsePlanRefs';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import express from 'express';
import type { HttpAuthService, PermissionsService } from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { evaluationRequestSchema, buildEvaluation, summarize, demoEvaluation, jevEvaluatePermission, type JevRequest, type JevResponse, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { GitHubClientError, GitHubLimitError, ProviderError, type GitHubClient, type GitHubChangedFile } from './client';
import {
  evaluatePullRequestMarkdown,
  prepareDelivery,
  planReadiness,
  evaluateReadinessDocuments,
  evaluateChangeReviewFromListing,
  ChangeReviewUnavailableError,
  parsePullRequestEvent,
  PartialGitHubEvaluationError,
  supportedPullRequestActions,
  type GitHubWebhookOutcome,
  type DeliveryPreparation,
  type PullRequestEvent,
} from './github';
import { resolveChangeReviewSettings, type ChangeReviewSettings, type ChangeReviewContext } from './changeReview';
import { reportPending, reportFinal, reportChangeReviewPending, reportChangeReviewFinal, reportCombinedComment, type ReportMode, type BlockOn } from './reporting';

export type GitHubWebhookRouterOptions = {
  secret: string;
  client: GitHubClient;
  repositories: string[];
  documentationPaths: string[];
  allowForks: boolean;
  timeoutMs?: number;
  maxDocuments?: number;
  /** Where the evaluated result is reported back to GitHub. `none` is byte-for-byte today's behaviour: the result
   * only ever appears in the HTTP response to this webhook. Defaults to `none`. */
  report?: ReportMode;
  /** Whether an `attention` finding fails the commit status. A `review` (low-confidence) finding never blocks by
   * itself, matching the workbench's own advisory posture. Defaults to `never`. */
  blockOn?: BlockOn;
  /** Bounded in-process background queue length, used only when `report` is not `none`. */
  queueLength?: number;
  /** Opt-in pull-request diff summary sent to the `change-risk` workflow -- see `changeReview.ts` and
   * `docs/github-webhook.md`. Defaults to a fully disabled block, identical to this feature never having existed.
   * `resolveGitHubWebhookConfig` is what actually validates and refuses a misconfigured block at startup; this
   * type only carries the already-resolved settings through to the queue worker. */
  changeReview?: ChangeReviewSettings;
};

type ResolvedGitHubWebhookRouterOptions = GitHubWebhookRouterOptions & {
  timeoutMs: number;
  bodyLimitBytes: number;
  maxConcurrent: number;
  maxDocuments: number;
  maxChangedFiles: number;
  maxPages: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  dedupeTtlMs: number;
  dedupeMaxEntries: number;
  report: ReportMode;
  blockOn: BlockOn;
  queueLength: number;
  maxCommentPages: number;
  changeReview: ChangeReviewSettings;
};

const githubWebhookDefaults = {
  timeoutMs: 8000,
  bodyLimitBytes: 256 * 1024,
  maxConcurrent: 1,
  maxDocuments: 3,
  maxChangedFiles: 300,
  maxPages: 3,
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 16000,
  dedupeTtlMs: 10 * 60 * 1000,
  dedupeMaxEntries: 1000,
  report: 'none' as ReportMode,
  blockOn: 'never' as BlockOn,
  queueLength: 20,
  maxCommentPages: 3,
  // Fully disabled: `resolveChangeReviewSettings(undefined)` is the same default every caller that never sets
  // `changeReview` gets — kept as a live call (not a hand-copied literal) so this default can never drift from the
  // pure core's own idea of "disabled".
  changeReview: resolveChangeReviewSettings(undefined),
} as const;

/**
 * F3: a smaller page size than readiness's own 100, used ONLY when change review is enabled (so a listing page
 * also carries real `patch` text). A page of 100 full changed-file entries, each with a real diff `patch`, can
 * comfortably exceed the 1 MiB GitHub response cap (`client.ts`'s `maxResponseBytes`) well within the range of
 * ordinary pull requests -- a handful of files with a few hundred lines changed each is already tens of KB per
 * entry. 30 entries/page keeps a typical page (assuming an average patch on the order of a few KB to a few tens
 * of KB) comfortably under that cap for the common case; an unusually large page (very large individual diffs)
 * is still handled correctly -- not by raising this further, but by the tolerant paginator's own
 * truncate-past-page-1 behaviour in `client.ts`, which this number is chosen to make the EXCEPTION rather than
 * the rule for a normal-sized PR. Readiness's own listing (`includePatchFields: false`) keeps the full 100,
 * unaffected.
 */
const CHANGE_REVIEW_LISTING_PER_PAGE = 30;
/** F5(a): change review is guaranteed at least this much of the job deadline, taken off the top of readiness's
 * OWN sub-deadline (see `processQueueJob`) so readiness alone can never consume the whole per-delivery budget
 * when change review is also enabled. */
const CHANGE_REVIEW_DEADLINE_RESERVE_MS = 15000;

/** The `pending` write is a single best-effort attempt (see `reportPending`), so it only needs a short outer budget
 * so a slow or hanging GitHub write never blocks the queue worker for long, regardless of how much of the (much
 * larger, when reporting is on) evaluation deadline remains. */
const REPORT_PENDING_TIMEOUT_MS = 5000;
/** The final write (`reportFinal`) manages its own internal budgets for the head recheck, the retried status
 * write, and the comment — worst case a little under 20 s (3 s + 10 s + 5 s) — so this outer wrap is only a safety
 * net comfortably above that, not the thing actually shaping its timing. */
const REPORT_FINAL_TIMEOUT_MS = 20000;

export interface RouterOptions {
  httpAuth: Pick<HttpAuthService, 'credentials'>;
  permissions: Pick<PermissionsService, 'authorize'>;
  evaluate?: (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
  demoMode?: boolean;
  responsePlanner?: ResponsePlanner;
  confidenceThreshold?: number;
  requestsPerMinute?: number;
  githubWebhook?: GitHubWebhookRouterOptions;
  /** Only used to build the optional `target_url` on a reported GitHub commit status. */
  baseUrl?: string;
}

/**
 * F5(b): a delivery whose two contexts (readiness, change review) did not BOTH reach a successfully-written
 * final state is `partial`, not simply forgotten outright -- it remembers WHICH context(s) already finished, so a
 * later redelivery of the same id can skip re-running (and re-charging a provider call to) whichever one is
 * already done, and only retry the one that is not. `readinessDone`/`changeReviewDone` are meaningful only on a
 * `partial` entry; `completed` implies both are done (or change review was never enabled), and `pending` implies
 * neither has been attempted by the currently-processing (or about-to-process) job. This state is never produced
 * when change review is disabled for the webhook -- see `finalizeDelivery` -- so a delivery with change review
 * off behaves byte-for-byte as it always has: `completed` or forgotten entirely, nothing in between.
 */
type DeliveryProgress = {
  readinessDone: boolean; changeReviewDone: boolean;
  readinessPendingWritten: boolean; changeReviewPendingWritten: boolean;
};
type DeliveryEntry = { state: 'pending' | 'completed' | 'partial'; expiresAt: number } & Partial<DeliveryProgress>;
type QueueJob = {
  deliveryId: string; event: PullRequestEvent; key: string;
  /** Set only when this job is a redelivery of a `partial` entry: which context(s) already reached a
   * successfully-written final state on an earlier attempt, and so should be skipped this time -- no provider
   * call, no `pending` flip on an already-final status (F5b). */
  resume?: DeliveryProgress;
};
type LastOutcome = { code: string; at: number };

class WebhookTimeoutError extends Error {
  constructor() {
    super('GitHub webhook exceeded its processing deadline.');
    this.name = 'WebhookTimeoutError';
  }
}

export function createRouter(options: RouterOptions): express.Router {
  const router = express.Router();
  const buckets = new Map<string, { count: number; reset: number }>();
  const planRefs = createResponsePlanRefs();
  const deliveries = new Map<string, DeliveryEntry>();
  let inFlight = 0;
  let webhookInFlight = 0;
  const githubWebhook = options.githubWebhook ? { ...githubWebhookDefaults, ...options.githubWebhook } as ResolvedGitHubWebhookRouterOptions : undefined;

  // Only used when `report` is not `none`: a bounded FIFO of accepted-but-not-yet-processed deliveries, drained one
  // at a time by `pump`. `report: none` never touches this queue and behaves exactly as it did before reporting existed.
  const reportQueue: QueueJob[] = [];
  let queueProcessing = false;
  let lastOutcome: LastOutcome | undefined;
  let lastChangeReviewOutcome: LastOutcome | undefined;

  function pump(): void {
    if (queueProcessing || reportQueue.length === 0 || !githubWebhook) return;
    const job = reportQueue.shift()!;
    queueProcessing = true;
    // `.catch()` is defense in depth only: `processQueueJob` itself catches every error it can think of (including
    // an outer catch-all for anything unexpected) precisely so this never fires. See rule (9) — an unhandled
    // rejection here would otherwise be silent and could, worse, wedge the queue by never resetting `queueProcessing`.
    processQueueJob(githubWebhook, job).catch(() => {}).finally(() => { queueProcessing = false; pump(); });
  }

  /** F5(b): records whether this delivery's two contexts reached a successfully-written final state, exactly
   * once, after `processQueueJob` finishes (both its ordinary path and its outer-catch path funnel through here).
   * When change review is disabled for this webhook, this reproduces the ORIGINAL single-context dedupe
   * behaviour byte-for-byte: `completed` when readiness finished, forgotten entirely otherwise -- the `partial`
   * state below is never produced in that case. */
  function finalizeDelivery(deliveryId: string, webhook: ResolvedGitHubWebhookRouterOptions, readinessDone: boolean, changeReviewDone: boolean, readinessPendingWritten: boolean, changeReviewPendingWritten: boolean): void {
    if (!webhook.changeReview.enabled) {
      if (readinessDone) deliveries.set(deliveryId, { state: 'completed', expiresAt: Date.now() + webhook.dedupeTtlMs });
      else deliveries.delete(deliveryId);
      return;
    }
    if (readinessDone && changeReviewDone) deliveries.set(deliveryId, { state: 'completed', expiresAt: Date.now() + webhook.dedupeTtlMs });
    else if (!readinessDone && !changeReviewDone && !readinessPendingWritten && !changeReviewPendingWritten) deliveries.delete(deliveryId);
    else deliveries.set(deliveryId, { state: 'partial', expiresAt: Date.now() + webhook.dedupeTtlMs, readinessDone, changeReviewDone, readinessPendingWritten, changeReviewPendingWritten });
  }

  /** INVARIANT: every `pending` this writes gets exactly one final state (`success`/`failure` from an evaluated
   * result, `error`, or the neutral resolution), and nothing at all is written for a delivery that never confirmed
   * a matching document (readiness) or was never confirmed current (change review). This invariant is maintained
   * INDEPENDENTLY for `jev/readiness` and (when `changeReview.enabled`) `jev/change-review`: a failure in one
   * context's evaluation or reporting never skips or corrupts the other's own pending→final resolution.
   *
   * Reads are shared where possible (see `github.ts`'s `prepareDelivery` doc comment and
   * `docs/github-webhook.md`'s "Reads per delivery" note for the exact counts this produces): the pull request and
   * its changed-file listing are each read ONCE, shared by both contexts, followed by ONE shared "before
   * evaluating" staleness recheck for whichever context(s) are about to run; each context's own final-write
   * staleness recheck (inside `reportFinal`/`reportChangeReviewFinal`) is unchanged and stays separate.
   *
   * `job.resume` (F5b) skips a context that a PRIOR attempt at this same delivery id already finished
   * successfully: no second provider call, no `pending` flip on an already-final status.
   */
  async function processQueueJob(webhook: ResolvedGitHubWebhookRouterOptions, job: QueueJob): Promise<void> {
    webhookInFlight++;
    let readinessPendingWritten = job.resume?.readinessPendingWritten ?? false;
    let changeReviewPendingWritten = job.resume?.changeReviewPendingWritten ?? false;

    const readinessAlreadyDone = job.resume?.readinessDone ?? false;
    const changeReviewAlreadyDone = job.resume?.changeReviewDone ?? false;
    const readinessWillAttempt = !readinessAlreadyDone;
    const changeReviewWillAttempt = webhook.changeReview.enabled && !changeReviewAlreadyDone;

    // F5(a): split the job deadline so readiness cannot consume all of it when change review also needs to run.
    // Readiness gets a SHORTENED sub-deadline (`timeoutMs` minus the reserve); change review keeps the full
    // `timeoutMs` from job start. Shared reads and final reporting have separate deadlines, so slow GitHub
    // responses can still consume that reserve. No time is reserved, and readiness keeps the FULL timeout, when change review is
    // disabled or already done via a resumed redelivery -- identical to before change review existed.
    const changeReviewReserveMs = changeReviewWillAttempt ? Math.min(CHANGE_REVIEW_DEADLINE_RESERVE_MS, Math.floor(webhook.timeoutMs / 2)) : 0;
    const readinessDeadlineMs = Math.max(1, webhook.timeoutMs - changeReviewReserveMs);

    const overallController = new AbortController();
    let overallTimeoutReject: ((error: Error) => void) | undefined;
    const overallTimer = setTimeout(() => { overallController.abort(); overallTimeoutReject?.(new WebhookTimeoutError()); }, webhook.timeoutMs);
    const overallDeadline = new Promise<never>((_resolve, reject) => { overallTimeoutReject = reject; });

    const readinessController = new AbortController();
    let readinessTimeoutReject: ((error: Error) => void) | undefined;
    const readinessTimer = setTimeout(() => { readinessController.abort(); readinessTimeoutReject?.(new WebhookTimeoutError()); }, readinessDeadlineMs);
    const readinessDeadline = new Promise<never>((_resolve, reject) => { readinessTimeoutReject = reject; });
    const readinessSignal = AbortSignal.any([overallController.signal, readinessController.signal]);

    const reportOptions = {
      client: webhook.client, mode: webhook.report, blockOn: webhook.blockOn, baseUrl: options.baseUrl,
      maxCommentPages: webhook.maxCommentPages, changeReviewEnabled: webhook.changeReview.enabled,
    };

    let readinessDocuments: Array<{ path: string; result: EvaluationResult }> | undefined;
    let readinessCode = readinessAlreadyDone ? 'skipped:already_done' : 'ignored:not_run';
    let readinessDisposition: 'completed' | 'forget' = 'completed';
    let changeReviewForComment: { result: EvaluationResult; context: ChangeReviewContext } | undefined;
    let changeReviewCode: string | undefined = changeReviewAlreadyDone ? 'skipped:already_done' : undefined;
    let changeReviewDisposition: 'completed' | 'forget' = 'completed';
    // F6: tracks whether each context has ALREADY reached its own terminal resolution (a status write was
    // attempted, whatever its outcome) within the try block below. The outer catch consults this -- not just
    // `*PendingWritten` -- so a truly unexpected error that strikes AFTER a context has already finished
    // successfully can never overwrite that real result with a spurious `error:worker`; it only ever resolves a
    // context that is genuinely still dangling.
    let readinessFinalized = readinessAlreadyDone;
    let changeReviewFinalized = !webhook.changeReview.enabled || changeReviewAlreadyDone;

    try {
      let prepared: DeliveryPreparation | undefined;
      if (readinessWillAttempt || changeReviewWillAttempt) {
        try {
          prepared = await Promise.race([
            prepareDelivery({
              client: webhook.client, repositories: webhook.repositories, allowForks: webhook.allowForks,
              maxPages: changeReviewWillAttempt ? Math.ceil(webhook.maxPages * 100 / CHANGE_REVIEW_LISTING_PER_PAGE) : webhook.maxPages, maxFiles: webhook.maxChangedFiles,
              perPage: changeReviewWillAttempt ? CHANGE_REVIEW_LISTING_PER_PAGE : 100,
              includePatchFields: changeReviewWillAttempt,
            }, job.event, overallController.signal),
            overallDeadline,
          ]);
        } catch (error) {
          // A fresh delivery owes no status yet. A retry may still owe a final status from its earlier attempt.
          if (readinessWillAttempt) {
            const { code, reason } = classifyWebhookError(error, 'readiness');
            const wrote = readinessPendingWritten && await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'error', reason }, s));
            logUnwritten('readiness evaluation failed before a matching document was confirmed', error);
            readinessCode = code; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
          }
          if (changeReviewWillAttempt) {
            const { code, reason } = classifyWebhookError(error, 'change-review');
            const wrote = changeReviewPendingWritten && await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'error', reason }, s));
            logUnwritten('change review evaluation failed before it was confirmed', error);
            changeReviewCode = code; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
          }
        }
      }

      if (prepared) {
        if (prepared.status === 'ignored') {
          // A resumed delivery can still owe a final status on its ORIGINAL SHA.
          // Do not abandon that pending status just because the PR has since moved.
          if (readinessWillAttempt) {
            const wrote = !readinessPendingWritten || await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'neutral' }, s));
            readinessCode = `ignored:${prepared.reason}`; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
          }
          if (changeReviewWillAttempt) {
            const wrote = !changeReviewPendingWritten || await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'neutral' }, s));
            changeReviewCode = `ignored:${prepared.reason}`; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
          }
        } else {
          const { current, fork, files, filesTruncated } = prepared;

          let readinessCandidates: GitHubChangedFile[] | undefined;
          if (readinessWillAttempt) {
            try {
              const plan = planReadiness(files, filesTruncated, { documentationPaths: webhook.documentationPaths, maxChangedFiles: webhook.maxChangedFiles, maxDocuments: webhook.maxDocuments });
              if (plan.kind === 'no_match') {
                const wrote = !readinessPendingWritten || await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'neutral' }, s));
                readinessCode = 'ignored:no_documentation_changes'; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
              }
              else readinessCandidates = plan.candidates;
            } catch (error) {
              const { code, reason } = classifyWebhookError(error, 'readiness');
              const wrote = readinessPendingWritten && await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'error', reason }, s));
              logUnwritten('readiness evaluation failed before a matching document was confirmed', error);
              readinessCode = code; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
            }
          }

          // Matching (readiness) or being enabled at all (change review) is now confirmed, so `pending` is owed
          // from this point on for whichever context(s) apply -- see `github.ts`'s own comments on `onMatched`.
          // Record the obligation before the best-effort write: GitHub may accept it even if its response fails.
          if (readinessCandidates && !readinessPendingWritten) {
            readinessPendingWritten = true;
            await withDeadline(readinessSignal, REPORT_PENDING_TIMEOUT_MS, s => reportPending(reportOptions, job.event, s));
          }
          if (changeReviewWillAttempt && !changeReviewPendingWritten) {
            changeReviewPendingWritten = true;
            await withDeadline(overallController.signal, REPORT_PENDING_TIMEOUT_MS, s => reportChangeReviewPending(reportOptions, job.event, s));
          }

          // ONE shared "before evaluating" staleness recheck, for whichever context(s) are about to run. A read
          // failure here (as opposed to a confirmed move) is treated as an error for both, matching how the
          // pre-shared-listing code treated its own equivalent reads -- an UNCONFIRMED failure of the separate,
          // final-write recheck inside `reportFinal`/`reportChangeReviewFinal` remains tolerant, as before.
          let staleBeforeEvaluate = false;
          let sharedRecheckError: unknown;
          if (readinessCandidates || changeReviewWillAttempt) {
            try {
              const latest = await Promise.race([
                webhook.client.getPullRequest(job.event.repository, job.event.pullRequestNumber, overallController.signal),
                overallDeadline,
              ]);
              if (latest.headSha !== current.headSha || latest.baseSha !== current.baseSha) staleBeforeEvaluate = true;
            } catch (error) { sharedRecheckError = error; }
          }

          if (readinessCandidates) {
            if (sharedRecheckError) {
              const { code, reason } = classifyWebhookError(sharedRecheckError, 'readiness');
              const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'error', reason }, s));
              readinessCode = code; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
            } else if (staleBeforeEvaluate) {
              const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'neutral' }, s));
              readinessCode = 'ignored:stale_delivery'; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
            } else {
              try {
                if (readinessCandidates.length > webhook.maxDocuments) throw new GitHubLimitError('Too many matching documents for readiness evaluation.');
                const results = await Promise.race([
                  evaluateReadinessDocuments({
                    client: webhook.client, evaluate: options.evaluate!, maxFileBytes: webhook.maxFileBytes,
                    maxTotalBytes: webhook.maxTotalBytes, confidenceThreshold: options.confidenceThreshold ?? 0.8,
                  }, job.event, current, fork, readinessCandidates, readinessSignal),
                  readinessDeadline, overallDeadline,
                ]);
                readinessDocuments = results;
                const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'evaluated', documents: results }, s));
                readinessCode = 'evaluated'; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
              } catch (error) {
                const { code, reason } = classifyWebhookError(error, 'readiness');
                const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'error', reason }, s));
                readinessCode = code; readinessFinalized = true; readinessDisposition = wrote ? 'completed' : 'forget';
              }
            }
          }

          if (changeReviewWillAttempt) {
            if (sharedRecheckError) {
              const { code, reason } = classifyWebhookError(sharedRecheckError, 'change-review');
              const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'error', reason }, s));
              changeReviewCode = code; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
            } else if (staleBeforeEvaluate) {
              const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'neutral' }, s));
              changeReviewCode = 'ignored:stale_delivery'; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
            } else {
              try {
                const { result, context } = await Promise.race([
                  evaluateChangeReviewFromListing(
                    { evaluate: options.evaluate!, settings: webhook.changeReview, confidenceThreshold: options.confidenceThreshold ?? 0.8 },
                    files, filesTruncated, current, overallController.signal,
                  ),
                  overallDeadline,
                ]);
                changeReviewForComment = { result, context };
                const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'evaluated', result }, s));
                changeReviewCode = 'evaluated'; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
              } catch (error) {
                if (error instanceof ChangeReviewUnavailableError) {
                  // A content-assembly failure (e.g. the title alone exceeds the evaluation budget): a fixed,
                  // content-free description only — never the raw diff/title that caused it.
                  const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'error', reason: 'The pull request summary could not be assembled within limits.' }, s));
                  changeReviewCode = 'error:content'; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
                } else {
                  const { code, reason } = classifyWebhookError(error, 'change-review');
                  const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'error', reason }, s));
                  changeReviewCode = code; changeReviewFinalized = true; changeReviewDisposition = wrote ? 'completed' : 'forget';
                }
              }
            }
          }
        }
      }

      // ---- Combined comment: one marker comment, written once both contexts above have resolved. A section is
      // included only when that context's own status write actually succeeded (`reportFinal`/`reportChangeReviewFinal`
      // skip their own comment in this mode — see their doc comments), matching the existing rule that a result
      // table next to a `pending` that never resolved would be misleading. ----
      if (webhook.report === 'status+comment' && webhook.changeReview.enabled) {
        const includeReadiness = readinessDocuments !== undefined && readinessDisposition === 'completed';
        const includeChangeReview = changeReviewForComment !== undefined && changeReviewDisposition === 'completed';
        if (includeReadiness || includeChangeReview) {
          await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportCombinedComment(reportOptions, job.event, {
            readinessDocuments: includeReadiness ? readinessDocuments : undefined,
            changeReview: includeChangeReview ? changeReviewForComment : undefined,
          }, s)).catch(() => {});
        }
      }

      lastOutcome = { code: readinessCode, at: Date.now() };
      if (changeReviewCode) lastChangeReviewOutcome = { code: changeReviewCode, at: Date.now() };
      const readinessDone = readinessAlreadyDone || readinessDisposition === 'completed';
      const changeReviewDone = !webhook.changeReview.enabled || changeReviewAlreadyDone || changeReviewDisposition === 'completed';
      finalizeDelivery(job.deliveryId, webhook, readinessDone, changeReviewDone, readinessPendingWritten, changeReviewPendingWritten);
    } catch (unexpected) {
      // F6: defense in depth -- whatever this is, it must not become an unhandled rejection (the `pump` chain
      // also has its own `.catch()` as a second layer) NOR leave a dangling `pending` for a context that already
      // got one. Best-effort resolves any context whose `pending` was actually written AND that has not already
      // reached its own terminal resolution (`*Finalized`) -- so a truly unexpected error striking AFTER a
      // context already finished successfully can never overwrite that real result with a spurious
      // `error:worker`; it only ever resolves a context that is genuinely still dangling.
      logUnwritten('an unexpected error in the queue worker', unexpected);
      let readinessDone = readinessAlreadyDone;
      let changeReviewDone = !webhook.changeReview.enabled || changeReviewAlreadyDone;
      if (readinessFinalized) {
        readinessDone = readinessDisposition === 'completed';
      } else if (readinessPendingWritten) {
        const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportFinal(reportOptions, job.event, { kind: 'error', reason: 'Jev readiness check failed unexpectedly.' }, s)).catch(() => false);
        readinessCode = 'error:worker'; readinessDone = wrote;
      } else if (readinessWillAttempt) {
        readinessCode = 'error:worker'; readinessDone = false;
      }
      if (changeReviewFinalized) {
        changeReviewDone = changeReviewDisposition === 'completed';
      } else if (changeReviewPendingWritten) {
        const wrote = await withDeadline(undefined, REPORT_FINAL_TIMEOUT_MS, s => reportChangeReviewFinal(reportOptions, job.event, { kind: 'error', reason: 'Change review could not be completed.' }, s)).catch(() => false);
        changeReviewCode = 'error:worker'; changeReviewDone = wrote;
      } else if (changeReviewWillAttempt) {
        changeReviewCode = 'error:worker'; changeReviewDone = false;
      }
      lastOutcome = { code: readinessCode, at: Date.now() };
      if (changeReviewCode) lastChangeReviewOutcome = { code: changeReviewCode, at: Date.now() };
      finalizeDelivery(job.deliveryId, webhook, readinessDone, changeReviewDone, readinessPendingWritten, changeReviewPendingWritten);
    } finally {
      clearTimeout(overallTimer);
      clearTimeout(readinessTimer);
      webhookInFlight--;
    }
  }

  if (githubWebhook) {
    router.post('/webhooks/github', express.raw({ type: 'application/json', limit: githubWebhook.bodyLimitBytes }), async (req, res) => {
      await handleGitHubWebhook(options, req, res, deliveries, () => webhookInFlight++, () => webhookInFlight--, () => webhookInFlight, githubWebhook, reportQueue, pump, outcome => { lastOutcome = outcome; });
    });
  } else {
    router.post('/webhooks/github', (_req, res) => res.status(404).json({ error: 'GitHub webhook is not configured.' }));
  }

  router.use(express.json({ limit: '32kb' }));
  router.get('/status', (_req, res) => res.json({
    mode: options.demoMode ? 'demo' : 'live',
    configured: Boolean(options.demoMode || options.evaluate),
    responsePlanning: options.responsePlanner?.provider ?? 'disabled',
    // Deliberately no repository names or content: only shape-of-the-system facts an operator needs. This
    // includes `changeReview` (enabled/disabled) and its own last outcome code/time — never a path, title, diff
    // excerpt, or finding, matching `changeReview.ts`'s own log-observability rule.
    ...(githubWebhook ? { githubWebhook: {
      report: githubWebhook.report, queueLength: reportQueue.length, inFlight: webhookInFlight, lastOutcome,
      changeReview: githubWebhook.changeReview.enabled ? 'enabled' : 'disabled',
      lastChangeReviewOutcome,
    } } : {}),
  }));
  /**
   * Authenticates a signed-in user with the evaluate permission and takes one slot from their
   * per-minute bucket. Answers the request itself and returns `undefined` when it may not proceed.
   */
  async function admit(req: express.Request, res: express.Response): Promise<string | undefined> {
    const credentials = await options.httpAuth.credentials(req, { allow: ['user'] });
    const [decision] = await options.permissions.authorize([{ permission: jevEvaluatePermission }], { credentials });
    if (decision.result !== AuthorizeResult.ALLOW) { res.status(403).json({ error: 'You do not have permission to evaluate with Jev.' }); return undefined; }
    const principal = credentials.principal;
    if (principal.type !== 'user') { res.status(403).json({ error: 'A user identity is required.' }); return undefined; }
    return principal.userEntityRef;
  }
  function takeSlot(key: string, res: express.Response): boolean {
    const now = Date.now();
    for (const [bucketKey, value] of buckets) if (value.reset <= now) buckets.delete(bucketKey);
    if (!buckets.has(key) && buckets.size >= 1000) { res.status(429).json({ error: 'Evaluation capacity reached. Try again later.' }); return false; }
    const bucket = buckets.get(key) ?? { count: 0, reset: now + 60000 };
    if (bucket.count >= (options.requestsPerMinute ?? 10) || inFlight >= 4) {
      res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Too many evaluations. Wait a minute before retrying.' }); return false;
    }
    bucket.count++; buckets.set(key, bucket);
    return true;
  }
  /**
   * Interactive assessments return Jev's result on its own. When a planner could use it, the
   * result carries a short-lived reference so the reader can ask for response suggestions
   * separately, instead of every check (including Live checks) waiting on a second provider.
   */
  function withPlanRef(user: string, text: string, result: EvaluationResult): EvaluationResult {
    const planner = options.responsePlanner;
    if (!planner || result.workflow !== 'incident' || (result.mode === 'demo' && planner.provider !== 'demo')) return result;
    return { ...result, responsePlanRef: planRefs.issue(user, text, result) };
  }
  router.post('/evaluate', async (req, res, next) => {
    try {
      const user = await admit(req, res);
      if (!user) return;
      const parsed = evaluationRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(' ') }); return; }
      if (!takeSlot(user, res)) return;
      if (options.demoMode) { res.json(withPlanRef(user, parsed.data.text, demoEvaluation(parsed.data))); return; }
      if (!options.evaluate) { res.status(503).json({ error: 'Jev is not configured. Set jevOperationsSupport.apiKey in the backend.' }); return; }
      inFlight++;
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const { request, checks } = buildEvaluation(parsed.data);
        const response = await options.evaluate(request, controller.signal);
        res.json(withPlanRef(user, parsed.data.text, summarize(parsed.data, response, checks, options.confidenceThreshold)));
      } finally { res.removeListener('close', disconnected); inFlight--; }
    } catch (error) {
      if (error instanceof ProviderError) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    }
  });
  const planRefPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  router.post('/response-plan', async (req, res, next) => {
    try {
      const user = await admit(req, res);
      if (!user) return;
      const planner = options.responsePlanner;
      if (!planner) { res.status(503).json({ error: 'Response planning is not configured on this backend.' }); return; }
      const ref: unknown = req.body?.ref;
      if (typeof ref !== 'string' || !planRefPattern.test(ref) || Object.keys(req.body).length !== 1) { res.status(400).json({ error: 'A response-plan reference from a recent assessment is required.' }); return; }
      const claim = planRefs.claim(user, ref);
      if (claim.status === 'missing') { res.status(404).json({ error: 'This assessment is no longer available for response suggestions. Check the report again.' }); return; }
      if (claim.status === 'busy') { res.status(409).json({ error: 'Response suggestions for this assessment are already being generated.' }); return; }
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        if (!takeSlot(user, res)) return;
        const planned = await attachResponsePlan(claim.text, claim.result, planner, controller.signal);
        res.json(planned.responsePlan ?? { status: 'failed', provider: planner.provider, model: planner.model, code: 'unavailable' });
      } finally { res.removeListener('close', disconnected); claim.release(); }
    } catch (error) {
      next(error);
    }
  });
  // Keep validation/parser errors readable without exposing request bodies.
  router.use((err: { status?: number; type?: string; name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : err.status === 400 ? 400 : err.name === 'AuthenticationError' ? 401 : err.name === 'NotAllowedError' ? 403 : 500;
    res.status(status).json({ error: status === 413 ? 'Request exceeds the configured body limit.' : status === 401 ? 'Sign in to use Jev.' : status === 400 ? 'Malformed JSON request.' : 'Evaluation could not be completed.' });
  });
  return router;
}

async function handleGitHubWebhook(
  options: RouterOptions,
  req: express.Request,
  res: express.Response,
  deliveries: Map<string, DeliveryEntry>,
  increment: () => void,
  decrement: () => void,
  currentInFlight: () => number,
  webhook: ResolvedGitHubWebhookRouterOptions,
  reportQueue: QueueJob[],
  pump: () => void,
  setLastOutcome: (outcome: LastOutcome) => void,
): Promise<void> {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) { res.status(400).json({ error: 'GitHub webhook requires an application/json body.' }); return; }
  if (!verifyGitHubSignature(rawBody, req.header('x-hub-signature-256'), webhook.secret)) { res.status(401).json({ error: 'Invalid GitHub webhook signature.' }); return; }
  const deliveryId = req.header('x-github-delivery')?.trim();
  if (!deliveryId || deliveryId.length > 200) { res.status(400).json({ error: 'GitHub webhook delivery ID is required.' }); return; }
  const eventName = req.header('x-github-event')?.trim().toLowerCase();
  if (eventName !== 'pull_request') { res.status(202).json({ status: 'ignored', reason: 'event_not_supported', deliveryId }); return; }
  let raw: unknown;
  try { raw = JSON.parse(rawBody.toString('utf8')) as unknown; }
  catch { res.status(400).json({ error: 'Malformed GitHub webhook JSON.' }); return; }
  const action = raw && typeof raw === 'object' && typeof (raw as { action?: unknown }).action === 'string' ? (raw as { action: string }).action : undefined;
  if (action && !supportedPullRequestActions.has(action)) { res.status(202).json({ status: 'ignored', reason: 'action_not_supported', deliveryId }); return; }
  const event = parsePullRequestEvent(raw);
  if (!event) { res.status(400).json({ error: 'Malformed GitHub pull_request webhook.' }); return; }
  if (!webhook.repositories.some(value => normalizeRepository(value) === normalizeRepository(event.repository))) {
    res.status(202).json({ status: 'ignored', reason: 'repository_not_allowed', deliveryId }); return;
  }
  if (!options.evaluate || options.demoMode) { res.status(503).json({ error: 'Jev is not configured for GitHub webhook evaluation.', retry: 'manual', deliveryId }); return; }
  const now = Date.now();
  pruneDeliveries(deliveries, now);
  const prior = deliveries.get(deliveryId);
  let resume: QueueJob['resume'];
  if (prior) {
    if (prior.state === 'pending') {
      res.setHeader('Retry-After', '2');
      res.status(503).json({ error: 'The GitHub webhook delivery is already being processed.', retry: 'manual', deliveryId });
      return;
    }
    if (prior.state === 'completed') { res.status(200).json({ status: 'duplicate', deliveryId }); return; }
    // F5(b): `partial` -- at least one context already reached a successfully-written final state on an earlier
    // attempt. Falls through (rather than bouncing as a duplicate or a busy-503) to re-queue, carrying which
    // context(s) are already done so the queue worker skips them: no second provider call, no `pending` flip on
    // an already-final status for whichever context finished last time. Only ever reached when
    // `webhook.changeReview.enabled` -- see `finalizeDelivery`, which never produces `partial` otherwise.
    resume = {
      readinessDone: prior.readinessDone ?? false, changeReviewDone: prior.changeReviewDone ?? false,
      readinessPendingWritten: prior.readinessPendingWritten ?? false, changeReviewPendingWritten: prior.changeReviewPendingWritten ?? false,
    };
  }

  if (webhook.report !== 'none') {
    // Cheap, payload-only fork check (mirrors `evaluatePullRequestMarkdown`'s own early check in `github.ts`,
    // which needs no GitHub API call): a fork refused here never occupies a queue slot at all. The payload does
    // not by itself prove the CURRENT head repository (only a GitHub read can, after dequeuing), so the second,
    // authoritative fork check still happens inside the queued job exactly as before; this is only an early exit
    // for the common case where the webhook payload already makes the refusal obvious.
    const eventFork = !event.headRepoFullName || normalizeRepository(event.headRepoFullName) !== normalizeRepository(event.repository);
    if (eventFork && !webhook.allowForks) { res.status(202).json({ status: 'ignored', reason: 'fork_not_allowed', deliveryId }); return; }

    // Background mode: respond immediately and let the bounded single-worker queue do the rest. A newer delivery
    // for the same pull request supersedes an older one that is still queued (never one already being processed,
    // since that entry has already left `reportQueue` by the time it starts).
    const key = `${normalizeRepository(event.repository)}#${event.pullRequestNumber}`;
    const supersededIndex = reportQueue.findIndex(job => job.key === key);
    if (supersededIndex !== -1) {
      const [superseded] = reportQueue.splice(supersededIndex, 1);
      // A fresh queued delivery has never written pending and can be forgotten as completed.
      // A queued partial retry still owes its earlier final status; preserve that obligation for redelivery.
      deliveries.set(superseded.deliveryId, superseded.resume
        ? { ...superseded.resume, state: 'partial', expiresAt: now + webhook.dedupeTtlMs }
        : { state: 'completed', expiresAt: now + webhook.dedupeTtlMs });
      setLastOutcome({ code: 'superseded', at: now });
    }
    if (reportQueue.length >= webhook.queueLength || deliveries.size >= webhook.dedupeMaxEntries) {
      // Deliberately does not remember this delivery ID: GitHub's own redelivery is the retry mechanism here,
      // and remembering it would make a legitimate redelivery bounce off the dedupe map instead of retrying.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'GitHub webhook queue is temporarily full.', retry: 'manual', deliveryId });
      return;
    }
    deliveries.set(deliveryId, { state: 'pending', expiresAt: now + webhook.dedupeTtlMs });
    reportQueue.push({ deliveryId, event, key, resume });
    res.status(202).json({ accepted: true, deliveryId });
    pump();
    return;
  }

  if (currentInFlight() >= webhook.maxConcurrent || deliveries.size >= webhook.dedupeMaxEntries) {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: 'GitHub webhook capacity is temporarily full.', retry: 'manual', deliveryId });
    return;
  }
  deliveries.set(deliveryId, { state: 'pending', expiresAt: now + webhook.dedupeTtlMs });
  increment();
  const controller = new AbortController();
  let timeoutReject: ((error: Error) => void) | undefined;
  const timer = setTimeout(() => { controller.abort(); timeoutReject?.(new WebhookTimeoutError()); }, webhook.timeoutMs);
  const deadline = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
  try {
    const outcome = await Promise.race([
      evaluatePullRequestMarkdown({
        client: webhook.client,
        evaluate: options.evaluate,
        repositories: webhook.repositories,
        documentationPaths: webhook.documentationPaths,
        allowForks: webhook.allowForks,
        maxDocuments: webhook.maxDocuments,
        maxChangedFiles: webhook.maxChangedFiles,
        maxPages: webhook.maxPages,
        maxFileBytes: webhook.maxFileBytes,
        maxTotalBytes: webhook.maxTotalBytes,
        confidenceThreshold: options.confidenceThreshold ?? 0.8,
      }, event, controller.signal),
      deadline,
    ]);
    deliveries.set(deliveryId, { state: 'completed', expiresAt: Date.now() + webhook.dedupeTtlMs });
    if (outcome.status === 'ignored') { res.status(202).json({ status: 'ignored', reason: outcome.reason, deliveryId }); return; }
    res.status(200).json({ status: 'evaluated', deliveryId, repository: outcome.repository, pullRequest: outcome.pullRequest, documents: outcome.documents });
  } catch (error) {
    // A failed delivery is never marked successful. This permits a manual redelivery
    // after fixing permissions, limits, or provider configuration.
    deliveries.delete(deliveryId);
    if (error instanceof WebhookTimeoutError || controller.signal.aborted) { res.status(503).json({ error: 'GitHub webhook exceeded its processing deadline.', retry: 'manual', deliveryId }); return; }
    if (error instanceof PartialGitHubEvaluationError) { res.status(503).json({ error: error.message, retry: 'manual', partial: true, documents: error.documents, deliveryId }); return; }
    if (error instanceof GitHubLimitError) { res.status(422).json({ error: error.message, retry: 'manual', deliveryId }); return; }
    if (error instanceof GitHubClientError) { res.status(error.retryable ? 503 : 422).json({ error: error.message, retry: 'manual', deliveryId }); return; }
    if (error instanceof ProviderError) { res.status(error.status === 429 ? 503 : error.status).json({ error: error.message, retry: 'manual', deliveryId }); return; }
    res.status(503).json({ error: 'GitHub webhook evaluation failed.', retry: 'manual', deliveryId });
  } finally {
    clearTimeout(timer);
    decrement();
  }
}

/** Categorizes a thrown evaluation error into a short observability code and a GitHub-safe description
 * (never a document path, provider body, or stack trace — see the module doc in `reporting.ts`). */
function logUnwritten(step: string, error: unknown): void {
  console.error(`[jev-operations-support] GitHub webhook delivery: ${step}: ${error instanceof Error ? error.message : 'unknown error'}`);
}

/** F4: `jev/change-review` must never print readiness's own wording -- the two contexts are visibly independent
 * GitHub statuses, and a reader seeing "A changed document exceeded a configured evaluation limit." under
 * `jev/change-review` would reasonably (and wrongly) think a DOCUMENT was involved, when change review never
 * reads one. Every reason below is written for its own context; `code` stays a shared, short vocabulary (still
 * useful for `/status`'s `lastOutcome`/`lastChangeReviewOutcome` and for tests) since it carries no reader-facing
 * text. `PartialGitHubEvaluationError` is readiness-only (change review never evaluates more than one thing) and
 * so has no change-review wording of its own. */
function classifyWebhookError(error: unknown, context: 'readiness' | 'change-review'): { code: string; reason: string } {
  if (error instanceof WebhookTimeoutError) {
    return { code: 'error:deadline', reason: context === 'readiness' ? 'Jev readiness check exceeded its processing deadline.' : 'Change review exceeded its processing deadline.' };
  }
  if (error instanceof PartialGitHubEvaluationError) return { code: 'error:provider_partial', reason: 'Jev evaluation failed partway through the changed documents.' };
  if (error instanceof GitHubLimitError) {
    return { code: 'error:limit', reason: context === 'readiness' ? 'Readiness input exceeded a configured evaluation limit.' : 'The pull request could not be listed within limits.' };
  }
  if (error instanceof GitHubClientError) {
    return { code: 'error:github', reason: context === 'readiness' ? 'GitHub could not be read for this pull request.' : 'GitHub could not be read for change review.' };
  }
  if (error instanceof ProviderError) {
    return { code: 'error:provider', reason: context === 'readiness' ? 'Jev evaluation failed.' : 'Change review could not be completed.' };
  }
  return { code: 'error:unknown', reason: context === 'readiness' ? 'Jev readiness check could not be completed.' : 'Change review could not be completed.' };
}

/** Runs `run` with a signal that aborts either when `parent` aborts or after `ms`, whichever comes first.
 * Used only for GitHub report writes, which must never wait past their own short budget regardless of how the
 * caller's own (potentially much larger) deadline is doing. */
async function withDeadline<T>(parent: AbortSignal | undefined, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try { return await run(signal); }
  finally { clearTimeout(timer); }
}

export function verifyGitHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function pruneDeliveries(deliveries: Map<string, DeliveryEntry>, now: number): void {
  for (const [deliveryId, entry] of deliveries) if (entry.expiresAt <= now) deliveries.delete(deliveryId);
}

function normalizeRepository(value: string): string { return value.trim().toLowerCase(); }
