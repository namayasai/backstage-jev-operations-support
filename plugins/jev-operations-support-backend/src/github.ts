import {
  buildEvaluation,
  evaluationRequestSchema,
  summarize,
  type EvaluationResult,
  type JevRequest,
  type JevResponse,
} from '@namayasai/backstage-plugin-jev-operations-support-common';
import {
  GitHubClientError,
  GitHubLimitError,
  type GitHubClient,
  type GitHubChangedFile,
  type GitHubPullRequest,
} from './client';
import {
  buildChangeReviewContext,
  ChangeReviewContentError,
  type ChangeReviewContext,
  type ChangeReviewSettings,
} from './changeReview';

export const supportedPullRequestActions = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export type PullRequestEvent = {
  action: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha?: string;
  headRepoFullName?: string;
};

export type GitHubWebhookOutcome =
  | { status: 'evaluated'; repository: string; pullRequest: number; documents: Array<{ path: string; result: EvaluationResult }> }
  | { status: 'ignored'; reason: 'stale_delivery' | 'fork_not_allowed' | 'no_documentation_changes' | 'repository_not_allowed' };

export class PartialGitHubEvaluationError extends Error {
  constructor(public readonly documents: Array<{ path: string; result: EvaluationResult }>) {
    super('GitHub webhook evaluation completed only partially. Redeliver the event manually.');
    this.name = 'PartialGitHubEvaluationError';
  }
}

export type GitHubEvaluationOptions = {
  client: GitHubClient;
  evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
  repositories: string[];
  documentationPaths: string[];
  allowForks: boolean;
  maxDocuments: number;
  maxChangedFiles: number;
  maxPages: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  confidenceThreshold: number;
  /** Fired once, right after matching documents are confirmed and before the first document is read or evaluated.
   * Used to write a `pending` GitHub status only for deliveries that will actually be evaluated — never for a
   * delivery that turns out to touch no matching document. A failure here must not abort the evaluation. */
  onMatched?: (signal: AbortSignal) => Promise<void>;
};

export function parsePullRequestEvent(raw: unknown): PullRequestEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as {
    action?: unknown;
    repository?: { full_name?: unknown };
    number?: unknown;
    pull_request?: {
      number?: unknown;
      head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
      base?: { sha?: unknown };
    };
  };
  const action = typeof value.action === 'string' ? value.action : '';
  const repository = typeof value.repository?.full_name === 'string' ? value.repository.full_name : '';
  const pullRequestNumber = Number.isSafeInteger(value.pull_request?.number) ? Number(value.pull_request?.number) : Number(value.number);
  const headSha = typeof value.pull_request?.head?.sha === 'string' ? value.pull_request.head.sha : '';
  const baseSha = typeof value.pull_request?.base?.sha === 'string' ? value.pull_request.base.sha : undefined;
  const headRepoFullName = typeof value.pull_request?.head?.repo?.full_name === 'string' ? value.pull_request.head.repo.full_name : undefined;
  if (!action || !isRepository(repository) || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0 || !isSha(headSha)) return undefined;
  if (baseSha !== undefined && !isSha(baseSha)) return undefined;
  if (headRepoFullName !== undefined && !isRepository(headRepoFullName)) return undefined;
  return { action, repository, pullRequestNumber, headSha, baseSha, headRepoFullName };
}

export async function evaluatePullRequestMarkdown(options: GitHubEvaluationOptions, event: PullRequestEvent, signal: AbortSignal): Promise<GitHubWebhookOutcome> {
  const repository = normalizeRepository(event.repository);
  if (!options.repositories.some(value => normalizeRepository(value) === repository)) return { status: 'ignored', reason: 'repository_not_allowed' };
  const eventFork = !event.headRepoFullName || normalizeRepository(event.headRepoFullName) !== repository;
  if (eventFork && !options.allowForks) return { status: 'ignored', reason: 'fork_not_allowed' };

  abortIfNeeded(signal);
  const current = await options.client.getPullRequest(event.repository, event.pullRequestNumber, signal);
  if (current.headSha !== event.headSha || (event.baseSha !== undefined && current.baseSha !== event.baseSha)) return { status: 'ignored', reason: 'stale_delivery' };

  const fork = eventFork || normalizeRepository(current.headRepoFullName) !== repository;
  if (fork && !options.allowForks) return { status: 'ignored', reason: 'fork_not_allowed' };

  abortIfNeeded(signal);
  // A `GitHubLimitError` thrown by this call happens before any matching document is known to exist, so the
  // caller's `onMatched` has not fired yet and nothing should ever be written to GitHub for it (see the caller).
  const changedFiles = await options.client.listChangedFiles(event.repository, event.pullRequestNumber, { maxPages: options.maxPages, maxFiles: options.maxChangedFiles }, signal);
  const candidates = changedFiles.filter(file => file.status !== 'removed' && isSafePath(file.filename) && isMarkdown(file.filename) && matchesDocumentationPath(file.filename, options.documentationPaths));
  if (candidates.length === 0) return { status: 'ignored', reason: 'no_documentation_changes' };

  // Matching is now confirmed to exist (at least one changed file matches the filter), even though the exact
  // count may still turn out to exceed the configured limit below. `onMatched` fires here — and only here — so a
  // caller can treat everything from this point on as "owed a final report", including the limit check that follows.
  if (options.onMatched) await options.onMatched(signal);
  if (candidates.length > options.maxDocuments) throw new GitHubLimitError('The pull request changed more matching documents than the configured limit.');

  abortIfNeeded(signal);
  const latest = await options.client.getPullRequest(event.repository, event.pullRequestNumber, signal);
  if (latest.headSha !== current.headSha || latest.baseSha !== current.baseSha) return { status: 'ignored', reason: 'stale_delivery' };

  const contentRepository = fork ? current.headRepoFullName : event.repository;
  const documents: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const file of candidates) {
    abortIfNeeded(signal);
    const document = await options.client.getFile(contentRepository, file.filename, current.headSha, options.maxFileBytes, signal);
    totalBytes += document.size;
    if (totalBytes > options.maxTotalBytes) throw new GitHubLimitError('The matching Markdown documents exceeded the configured total size limit.');
    documents.push({ path: document.path, content: document.content });
  }
  abortIfNeeded(signal);
  const finalState = await options.client.getPullRequest(event.repository, event.pullRequestNumber, signal);
  if (finalState.headSha !== current.headSha || finalState.baseSha !== current.baseSha) return { status: 'ignored', reason: 'stale_delivery' };
  // Every document is validated before the first provider call, so a limit violation
  // never happens after an earlier document was already evaluated and charged.
  const prepared = documents.map(document => {
    const textBytes = new TextEncoder().encode(document.content).byteLength;
    if (textBytes > options.maxTotalBytes || document.content.length > 16000) throw new GitHubLimitError(`Document ${document.path} exceeded the readiness context size limit.`);
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'readiness', text: document.content, candidates: [] });
    if (!parsed.success) throw new GitHubLimitError(`Document ${document.path} is empty, too short, or otherwise outside the readiness evaluation limits.`);
    return { path: document.path, input: parsed.data };
  });
  const results: Array<{ path: string; result: EvaluationResult }> = [];
  for (const document of prepared) {
    // Each document keeps its own readiness judgment; contexts are never merged.
    const { request, checks } = buildEvaluation(document.input);
    try {
      abortIfNeeded(signal);
      const response = await options.evaluate(request, signal);
      results.push({ path: document.path, result: summarize(document.input, response, checks, options.confidenceThreshold) });
    } catch (error) {
      if (results.length > 0) throw new PartialGitHubEvaluationError(results);
      throw error;
    }
  }
  return { status: 'evaluated', repository: event.repository, pullRequest: event.pullRequestNumber, documents: results };
}

// ---------------------------------------------------------------------------------------
// Shared delivery preparation, used ONLY by the background queue worker (`router.ts`'s
// `processQueueJob`, reporting mode -- change review has no `report: none` mode, since its result would
// never be visible). The synchronous `report: none` path keeps using `evaluatePullRequestMarkdown` above,
// completely unchanged (its own repo/fork/staleness checks and its own `listChangedFiles` read, never
// shared with anything).
//
// Reporting mode reads the pull request and its changed-file listing ONCE, up front, shared by both
// readiness and (when enabled) change review, instead of each doing its own separate reads:
// `prepareDelivery` below owns the repository/fork checks and the FIRST staleness check plus the ONE
// listing read; `planReadiness`/`evaluateReadinessDocuments` and `evaluateChangeReviewFromListing` then
// consume that same, already-fetched data. The queue worker itself performs the SECOND staleness check
// (shared, "before evaluating", once for whichever context(s) are about to run) and each context's own
// THIRD staleness check immediately before its own final write (via `reportFinal`/`reportChangeReviewFinal`'s
// existing `checkHead`, unchanged) -- see `docs/github-webhook.md`'s "Reads per delivery" note for the
// exact counts this produces.
// ---------------------------------------------------------------------------------------

export type DeliveryPreparation =
  | { status: 'ignored'; reason: 'stale_delivery' | 'fork_not_allowed' | 'repository_not_allowed' }
  | { status: 'ready'; current: GitHubPullRequest; fork: boolean; files: GitHubChangedFile[]; filesTruncated: boolean };

export type DeliveryPreparationOptions = {
  client: GitHubClient;
  repositories: string[];
  allowForks: boolean;
  maxPages: number;
  maxFiles: number;
  perPage: number;
  /** True only when `changeReview.enabled`: readiness never needs `patch`/`additions`/`deletions`/
   * `previous_filename`, so this call parses and retains none of them when false (see `client.ts`'s
   * `listChangedFilesTolerant`). */
  includePatchFields: boolean;
};

/** Repository allowlist, fork policy, the FIRST staleness check, and the ONE shared changed-file listing read
 * for a reporting-mode delivery. A `stale_delivery`/`fork_not_allowed`/`repository_not_allowed` result here means
 * nothing was ever owed to GitHub for EITHER context: this all happens before either context's own `onMatched`
 * could possibly fire. A thrown error (a `GitHubClientError`/`GitHubLimitError` from the reads themselves,
 * including the listing's own page-1 response-size failure) is likewise before either `onMatched` and so is an
 * error for BOTH contexts equally -- the caller's outer error handling covers this uniformly. */
export async function prepareDelivery(options: DeliveryPreparationOptions, event: PullRequestEvent, signal: AbortSignal): Promise<DeliveryPreparation> {
  const repository = normalizeRepository(event.repository);
  if (!options.repositories.some(value => normalizeRepository(value) === repository)) return { status: 'ignored', reason: 'repository_not_allowed' };
  const eventFork = !event.headRepoFullName || normalizeRepository(event.headRepoFullName) !== repository;
  if (eventFork && !options.allowForks) return { status: 'ignored', reason: 'fork_not_allowed' };

  abortIfNeeded(signal);
  const current = await options.client.getPullRequest(event.repository, event.pullRequestNumber, signal);
  if (current.headSha !== event.headSha || (event.baseSha !== undefined && current.baseSha !== event.baseSha)) return { status: 'ignored', reason: 'stale_delivery' };

  const fork = eventFork || normalizeRepository(current.headRepoFullName) !== repository;
  if (fork && !options.allowForks) return { status: 'ignored', reason: 'fork_not_allowed' };

  abortIfNeeded(signal);
  const { files, truncated } = await options.client.listChangedFilesTolerant(event.repository, event.pullRequestNumber, {
    maxPages: options.maxPages, maxFiles: options.maxFiles, perPage: options.perPage, includePatchFields: options.includePatchFields,
  }, signal);
  return { status: 'ready', current, fork, files, filesTruncated: truncated };
}

export type ReadinessPlan =
  | { kind: 'no_match' }
  | { kind: 'matched'; candidates: GitHubChangedFile[] };

/** Applies readiness's OWN existing limits to the shared listing, with the SAME outward behaviour and messages
 * `listChangedFiles`'s throwing pagination used to produce directly: a truncated (or over-`maxChangedFiles`)
 * listing is a hard failure, exactly as before, and readiness never even looks at the (necessarily incomplete)
 * partial file list in that case -- it is not "no match", it is a limit violation. Only once the listing is known
 * complete does readiness filter for matching documents. The worker applies `maxDocuments` AFTER pending is attempted, so a matched-but-oversized delivery gets a visible error. Pure (no I/O, no signal). */
export function planReadiness(files: GitHubChangedFile[], filesTruncated: boolean, options: { documentationPaths: string[]; maxChangedFiles: number; maxDocuments: number }): ReadinessPlan {
  if (filesTruncated || files.length > options.maxChangedFiles) throw new GitHubLimitError('The pull request changed more files than the configured limit.');
  const candidates = files.filter(file => file.status !== 'removed' && isSafePath(file.filename) && isMarkdown(file.filename) && matchesDocumentationPath(file.filename, options.documentationPaths));
  if (candidates.length === 0) return { kind: 'no_match' };
  return { kind: 'matched', candidates };
}

export type ReadinessDocumentsOptions = {
  client: GitHubClient;
  evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
  maxFileBytes: number;
  maxTotalBytes: number;
  confidenceThreshold: number;
};

/** Reads and evaluates readiness's matching documents given an ALREADY-CONFIRMED-CURRENT `current` (the caller is
 * responsible for the shared "before evaluating" staleness recheck before calling this). Otherwise identical to
 * the tail of `evaluatePullRequestMarkdown` above: same per-document size/schema validation before any provider
 * call, same partial-failure behaviour (`PartialGitHubEvaluationError` once at least one document has already
 * been evaluated). */
export async function evaluateReadinessDocuments(options: ReadinessDocumentsOptions, event: PullRequestEvent, current: GitHubPullRequest, fork: boolean, candidates: GitHubChangedFile[], signal: AbortSignal): Promise<Array<{ path: string; result: EvaluationResult }>> {
  const contentRepository = fork ? current.headRepoFullName : event.repository;
  const documents: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const file of candidates) {
    abortIfNeeded(signal);
    const document = await options.client.getFile(contentRepository, file.filename, current.headSha, options.maxFileBytes, signal);
    totalBytes += document.size;
    if (totalBytes > options.maxTotalBytes) throw new GitHubLimitError('The matching Markdown documents exceeded the configured total size limit.');
    documents.push({ path: document.path, content: document.content });
  }
  // Every document is validated before the first provider call, so a limit violation
  // never happens after an earlier document was already evaluated and charged.
  const prepared = documents.map(document => {
    const textBytes = new TextEncoder().encode(document.content).byteLength;
    if (textBytes > options.maxTotalBytes || document.content.length > 16000) throw new GitHubLimitError(`Document ${document.path} exceeded the readiness context size limit.`);
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'readiness', text: document.content, candidates: [] });
    if (!parsed.success) throw new GitHubLimitError(`Document ${document.path} is empty, too short, or otherwise outside the readiness evaluation limits.`);
    return { path: document.path, input: parsed.data };
  });
  const results: Array<{ path: string; result: EvaluationResult }> = [];
  for (const document of prepared) {
    // Each document keeps its own readiness judgment; contexts are never merged.
    const { request, checks } = buildEvaluation(document.input);
    try {
      abortIfNeeded(signal);
      const response = await options.evaluate(request, signal);
      results.push({ path: document.path, result: summarize(document.input, response, checks, options.confidenceThreshold) });
    } catch (error) {
      if (results.length > 0) throw new PartialGitHubEvaluationError(results);
      throw error;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------
// Change review (opt-in): wires the pure `changeReview.ts` core into the shared listing above.
// ---------------------------------------------------------------------------------------

/** Raised only when `buildChangeReviewContext` itself throws `ChangeReviewContentError` (the pathological case
 * where even the title alone cannot fit the evaluation budget). The caller (`router.ts`) catches this specifically
 * to write a fixed, content-free `error` status for `jev/change-review` -- never the raw `ChangeReviewContentError`
 * message, which could in principle echo back a fragment of the (already-known-oversized) title. */
export class ChangeReviewUnavailableError extends Error {
  constructor() {
    super('Change review could not be assembled for this pull request: even the title exceeds the evaluation budget after every other section was removed.');
    this.name = 'ChangeReviewUnavailableError';
  }
}

export type ChangeReviewFromListingOptions = {
  evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
  /** Guaranteed `enabled: true` by the caller -- this function does not itself check the flag. */
  settings: ChangeReviewSettings;
  confidenceThreshold: number;
};

/** Builds the change-review context from the ALREADY-FETCHED `current` (its `title`/`body`) and `files`/
 * `filesTruncated` (the SAME shared listing readiness itself examined -- see `prepareDelivery`), then evaluates
 * it. No GitHub read of its own: unlike readiness, change review has no "nothing matched" outcome of its own to
 * check for, so there is nothing else here that needs a GitHub read before the provider call. */
export async function evaluateChangeReviewFromListing(options: ChangeReviewFromListingOptions, files: GitHubChangedFile[], filesTruncated: boolean, current: GitHubPullRequest, signal: AbortSignal): Promise<{ result: EvaluationResult; context: ChangeReviewContext }> {
  let context: ChangeReviewContext;
  try {
    context = buildChangeReviewContext(
      {
        title: current.title,
        body: current.body,
        filesTruncated,
        files: files.map(file => ({
          filename: file.filename,
          status: file.status ?? 'changed',
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          patch: file.patch,
          previous_filename: file.previous_filename,
        })),
      },
      options.settings,
    );
  } catch (error) {
    if (error instanceof ChangeReviewContentError) throw new ChangeReviewUnavailableError();
    throw error;
  }

  abortIfNeeded(signal);
  const { request, checks } = buildEvaluation({ workflow: 'change-risk', text: context.text, candidates: [] });
  const response = await options.evaluate(request, signal);
  const result = summarize({ workflow: 'change-risk', text: context.text, candidates: [] }, response, checks, options.confidenceThreshold);
  return { result, context };
}

export function matchesDocumentationPath(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (!pattern || pattern.includes('..')) return false;
    let escaped = '';
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index];
      if (character === '*' && pattern[index + 1] === '*' && pattern[index + 2] === '/') { escaped += '(?:.*/)?'; index += 2; }
      else if (character === '*' && pattern[index + 1] === '*') { escaped += '.*'; index++; }
      else if (character === '*') escaped += '[^/]*';
      else if (character === '?') escaped += '[^/]';
      else escaped += escapeRegex(character);
    }
    try { return new RegExp(`^${escaped}$`).test(path); }
    catch { return false; }
  });
}

function isMarkdown(path: string): boolean { return /\.(?:md|mdx|markdown)$/i.test(path); }
function isSafePath(path: string): boolean { return path.length > 0 && !path.startsWith('/') && !path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'); }
function isSha(value: string): boolean { return /^[0-9a-f]{7,64}$/i.test(value); }
function isRepository(value: string): boolean { return /^[^/\s]+\/[^/\s]+$/.test(value); }
function normalizeRepository(value: string): string { return value.trim().toLowerCase(); }
function escapeRegex(value: string): string { return value.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new GitHubClientError(true, 'GitHub webhook processing was aborted. Redeliver the event manually.');
}
