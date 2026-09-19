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
} from './client';

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
  const changedFiles = await options.client.listChangedFiles(event.repository, event.pullRequestNumber, { maxPages: options.maxPages, maxFiles: options.maxChangedFiles }, signal);
  const candidates = changedFiles.filter(file => file.status !== 'removed' && isSafePath(file.filename) && isMarkdown(file.filename) && matchesDocumentationPath(file.filename, options.documentationPaths));
  if (candidates.length > options.maxDocuments) throw new GitHubLimitError('The pull request changed more matching documents than the configured limit.');

  abortIfNeeded(signal);
  const latest = await options.client.getPullRequest(event.repository, event.pullRequestNumber, signal);
  if (latest.headSha !== current.headSha || latest.baseSha !== current.baseSha) return { status: 'ignored', reason: 'stale_delivery' };
  if (candidates.length === 0) return { status: 'ignored', reason: 'no_documentation_changes' };

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
  const results: Array<{ path: string; result: EvaluationResult }> = [];
  for (const document of documents) {
    try {
      const textBytes = new TextEncoder().encode(document.content).byteLength;
      if (textBytes > options.maxTotalBytes || document.content.length > 16000) throw new GitHubLimitError(`Document ${document.path} exceeded the readiness context size limit.`);
      const parsed = evaluationRequestSchema.safeParse({ workflow: 'readiness', text: document.content, candidates: [] });
      if (!parsed.success) throw new GitHubLimitError(`Document ${document.path} could not fit within the readiness evaluation limits.`);
      const { request, checks } = buildEvaluation(parsed.data);
      abortIfNeeded(signal);
      const response = await options.evaluate(request, signal);
      results.push({ path: document.path, result: summarize(parsed.data, response, checks, options.confidenceThreshold) });
    } catch (error) {
      if (results.length > 0) throw new PartialGitHubEvaluationError(results);
      throw error;
    }
  }
  return { status: 'evaluated', repository: event.repository, pullRequest: event.pullRequestNumber, documents: results };
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
