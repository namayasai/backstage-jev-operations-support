import { describe, expect, it, vi } from 'vitest';
import {
  evaluatePullRequestMarkdown, prepareDelivery, planReadiness, evaluateReadinessDocuments, evaluateChangeReviewFromListing,
  ChangeReviewUnavailableError, matchesDocumentationPath, parsePullRequestEvent,
} from './github';
import { GitHubLimitError } from './client';
import type { ChangeReviewSettings } from './changeReview';
import type { GitHubClient, GitHubPullRequest } from './client';

describe('GitHub webhook document filters', () => {
  it('allows direct and nested paths for a double-star glob', () => {
    expect(matchesDocumentationPath('docs/runbook.md', ['docs/**/*.md'])).toBe(true);
    expect(matchesDocumentationPath('docs/operations/runbook.md', ['docs/**/*.md'])).toBe(true);
    expect(matchesDocumentationPath('docs/runbook.txt', ['docs/**/*.md'])).toBe(false);
  });

  it('requires a repository, PR number, and pinned head SHA', () => {
    const event = parsePullRequestEvent({
      action: 'opened', number: 12, repository: { full_name: 'acme/service' },
      pull_request: { head: { sha: 'a'.repeat(40), repo: { full_name: 'acme/service' } }, base: { sha: 'b'.repeat(40) } },
    });
    expect(event).toMatchObject({ action: 'opened', repository: 'acme/service', pullRequestNumber: 12, headSha: 'a'.repeat(40) });
    expect(parsePullRequestEvent({ action: 'opened', repository: { full_name: 'acme/service' }, pull_request: { head: { sha: 'not-a-sha' } } })).toBeUndefined();
  });
});

describe('the onMatched hook', () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  function client(overrides: Partial<GitHubClient> = {}): GitHubClient {
    return {
      getPullRequest: vi.fn().mockResolvedValue({ number: 1, headSha, baseSha, headRepoFullName: 'acme/service', title: 'A PR', body: 'A body.' }),
      listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'docs/runbook.md', status: 'modified' }]),
      listChangedFilesForChangeReview: vi.fn().mockResolvedValue({ files: [{ filename: 'docs/runbook.md', status: 'modified', additions: 1, deletions: 0, patch: 'diff' }], truncated: false }),
      getFile: vi.fn().mockResolvedValue({ path: 'docs/runbook.md', content: 'Enough operational context here.', size: 30 }),
      getAuthenticatedLogin: vi.fn(), createCommitStatus: vi.fn(), listIssueComments: vi.fn(), createIssueComment: vi.fn(), updateIssueComment: vi.fn(),
      ...overrides,
    } as unknown as GitHubClient;
  }
  const event = { action: 'opened', repository: 'acme/service', pullRequestNumber: 1, headSha, baseSha, headRepoFullName: 'acme/service' };

  it('fires once matching documents are confirmed, before any document is fetched or evaluated', async () => {
    const calls: string[] = [];
    const c = client({ getFile: vi.fn(async () => { calls.push('getFile'); return { path: 'docs/runbook.md', content: 'Enough operational context here.', size: 30 }; }) });
    const evaluate = vi.fn(async () => {
      calls.push('evaluate');
      return { model: 'test', answers: {
        startup: { type: 'noul' as const, noul: 0.9 }, health: { type: 'noul' as const, noul: 0.9 },
        rollback: { type: 'noul' as const, noul: 0.9 }, escalation: { type: 'noul' as const, noul: 0.9 },
      } };
    });
    const onMatched = vi.fn(async () => { calls.push('onMatched'); });
    await evaluatePullRequestMarkdown({
      client: c, evaluate, repositories: ['acme/service'], documentationPaths: ['docs/**'], allowForks: false,
      maxDocuments: 3, maxChangedFiles: 10, maxPages: 1, maxFileBytes: 1000, maxTotalBytes: 16000, confidenceThreshold: 0.8, onMatched,
    }, event, new AbortController().signal);
    expect(calls).toEqual(['onMatched', 'getFile', 'evaluate']);
  });

  it('never fires when no changed document matches the path filter', async () => {
    const c = client({ listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'src/index.ts', status: 'modified' }]) });
    const onMatched = vi.fn();
    const outcome = await evaluatePullRequestMarkdown({
      client: c, evaluate: vi.fn(), repositories: ['acme/service'], documentationPaths: ['docs/**'], allowForks: false,
      maxDocuments: 3, maxChangedFiles: 10, maxPages: 1, maxFileBytes: 1000, maxTotalBytes: 16000, confidenceThreshold: 0.8, onMatched,
    }, event, new AbortController().signal);
    expect(outcome).toEqual({ status: 'ignored', reason: 'no_documentation_changes' });
    expect(onMatched).not.toHaveBeenCalled();
  });
});

describe('prepareDelivery (F3: the shared, once-per-delivery listing used by the queue worker)', () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  function client(overrides: Partial<GitHubClient> = {}): GitHubClient {
    return {
      getPullRequest: vi.fn().mockResolvedValue({ number: 1, headSha, baseSha, headRepoFullName: 'acme/service', title: 'Replace endpoint', body: 'Migrates /v1 to /v2.' }),
      listChangedFiles: vi.fn(),
      listChangedFilesTolerant: vi.fn().mockResolvedValue({
        files: [
          { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
          { filename: 'src/.env', status: 'modified', additions: 1, deletions: 1, patch: 'CANARY_ENV_SECRET' },
          { filename: 'private/notes.md', status: 'added', additions: 3, deletions: 0, patch: 'CANARY_NOT_ALLOWLISTED' },
        ],
        truncated: false,
      }),
      getFile: vi.fn(), getAuthenticatedLogin: vi.fn(), createCommitStatus: vi.fn(), listIssueComments: vi.fn(), createIssueComment: vi.fn(), updateIssueComment: vi.fn(),
      ...overrides,
    } as unknown as GitHubClient;
  }
  const event = { action: 'opened', repository: 'acme/service', pullRequestNumber: 1, headSha, baseSha, headRepoFullName: 'acme/service' };
  const prepOptions = { repositories: ['acme/service'], allowForks: false, maxPages: 3, maxFiles: 300, perPage: 30, includePatchFields: true };

  it('reads the pull request once and the listing once, returning both for readiness and change review to share', async () => {
    const c = client();
    const prepared = await prepareDelivery({ client: c, ...prepOptions }, event, new AbortController().signal);
    expect(c.getPullRequest).toHaveBeenCalledTimes(1);
    expect(c.listChangedFilesTolerant).toHaveBeenCalledTimes(1);
    expect(prepared.status).toBe('ready');
    if (prepared.status === 'ready') expect(prepared.files).toHaveLength(3);
  });

  it('refuses a repository outside the allowlist and a fork before any read', async () => {
    const c = client();
    const outOfAllowlist = await prepareDelivery({ client: c, ...prepOptions, repositories: ['other/service'] }, event, new AbortController().signal);
    expect(outOfAllowlist).toEqual({ status: 'ignored', reason: 'repository_not_allowed' });
    const fork = await prepareDelivery({ client: c, ...prepOptions }, { ...event, headRepoFullName: 'attacker/service' }, new AbortController().signal);
    expect(fork).toEqual({ status: 'ignored', reason: 'fork_not_allowed' });
    expect(c.getPullRequest).not.toHaveBeenCalled();
  });

  it('reports a stale delivery when the head moved, without fetching the listing', async () => {
    const c = client({ getPullRequest: vi.fn().mockResolvedValue({ number: 1, headSha: 'c'.repeat(40), baseSha, headRepoFullName: 'acme/service', title: 't', body: null }) });
    const outcome = await prepareDelivery({ client: c, ...prepOptions }, event, new AbortController().signal);
    expect(outcome).toEqual({ status: 'ignored', reason: 'stale_delivery' });
    expect(c.listChangedFilesTolerant).not.toHaveBeenCalled();
  });

  it('a page-1 listing failure propagates as a genuine error (F3: an error for every context that was attempting)', async () => {
    const c = client({ listChangedFilesTolerant: vi.fn().mockRejectedValue(new GitHubLimitError('GitHub response exceeded the configured response size limit.')) });
    await expect(prepareDelivery({ client: c, ...prepOptions }, event, new AbortController().signal)).rejects.toBeInstanceOf(GitHubLimitError);
  });
});

describe('planReadiness (F3: readiness applies its own limits to the shared listing)', () => {
  const documentationPaths = ['docs/**'];

  it('matches a candidate exactly as the old throwing listChangedFiles-based path did', () => {
    const plan = planReadiness([{ filename: 'docs/a.md', status: 'modified' }, { filename: 'src/x.ts', status: 'modified' }], false, { documentationPaths, maxChangedFiles: 300, maxDocuments: 3 });
    expect(plan).toEqual({ kind: 'matched', candidates: [{ filename: 'docs/a.md', status: 'modified' }] });
  });

  it('reports no_match, never inspecting a removed file or a non-matching one', () => {
    expect(planReadiness([{ filename: 'docs/a.md', status: 'removed' }, { filename: 'src/x.ts', status: 'modified' }], false, { documentationPaths, maxChangedFiles: 300, maxDocuments: 3 })).toEqual({ kind: 'no_match' });
  });

  it('throws GitHubLimitError -- same message as before -- when the listing was truncated, WITHOUT ever looking at the partial files for a match', () => {
    expect(() => planReadiness([{ filename: 'docs/a.md', status: 'modified' }], true, { documentationPaths, maxChangedFiles: 300, maxDocuments: 3 })).toThrow('The pull request changed more files than the configured limit.');
  });

  it('throws GitHubLimitError when the listing exceeds maxChangedFiles even if not flagged truncated', () => {
    expect(() => planReadiness([{ filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/b.md', status: 'modified' }], false, { documentationPaths, maxChangedFiles: 1, maxDocuments: 3 })).toThrow('configured limit');
  });

  it('returns all matches so the worker can report a document-count error after pending', () => {
    const files = [{ filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/b.md', status: 'modified' }, { filename: 'docs/c.md', status: 'modified' }];
    expect(planReadiness(files, false, { documentationPaths, maxChangedFiles: 300, maxDocuments: 2 })).toEqual({ kind: 'matched', candidates: files });
  });
});

describe('evaluateReadinessDocuments and evaluateChangeReviewFromListing (the shared-listing-friendly evaluation steps)', () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const current: GitHubPullRequest = { number: 1, headSha, baseSha, headRepoFullName: 'acme/service', title: 'Replace endpoint', body: 'Migrates /v1 to /v2.' };
  const event = { action: 'opened', repository: 'acme/service', pullRequestNumber: 1, headSha, baseSha, headRepoFullName: 'acme/service' };
  const settings: ChangeReviewSettings = { enabled: true, paths: ['src/**'], maxFiles: 20, maxPatchBytes: 12000 };
  function client(overrides: Partial<GitHubClient> = {}): GitHubClient {
    return { getFile: vi.fn().mockResolvedValue({ path: 'docs/a.md', content: 'Enough operational context here for a real check.', size: 40 }), ...overrides } as unknown as GitHubClient;
  }
  function evaluateOk() {
    return vi.fn().mockResolvedValue({ model: 'test', answers: {
      startup: { type: 'noul' as const, noul: 0.9 }, health: { type: 'noul' as const, noul: 0.9 },
      rollback: { type: 'noul' as const, noul: 0.9 }, escalation: { type: 'noul' as const, noul: 0.9 },
    } });
  }
  function changeReviewEvaluateOk() {
    return vi.fn().mockResolvedValue({ model: 'test', answers: {
      breaking: { type: 'noul' as const, noul: 0.1 }, migration: { type: 'noul' as const, noul: 0.1 },
      access: { type: 'noul' as const, noul: 0.1 }, rollback: { type: 'noul' as const, noul: 0.9 },
    } });
  }

  it('evaluateReadinessDocuments reads and evaluates the given candidates against an already-confirmed current PR', async () => {
    const c = client();
    const results = await evaluateReadinessDocuments({ client: c, evaluate: evaluateOk(), maxFileBytes: 1000, maxTotalBytes: 16000, confidenceThreshold: 0.8 }, event, current, false, [{ filename: 'docs/a.md', status: 'modified' }], new AbortController().signal);
    expect(results).toHaveLength(1);
    expect(results[0].result.workflow).toBe('readiness');
  });

  it('evaluateChangeReviewFromListing builds the context from the SAME already-fetched files/current, sending only allow-listed non-sensitive content', async () => {
    const files = [
      { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
      { filename: 'src/.env', status: 'modified', additions: 1, deletions: 1, patch: 'CANARY_ENV_SECRET' },
      { filename: 'private/notes.md', status: 'added', additions: 3, deletions: 0, patch: 'CANARY_NOT_ALLOWLISTED' },
    ];
    const evaluate = vi.fn(async (request: { state: { context: string } }) => {
      expect(request.state.context).toContain('src/a.ts');
      expect(request.state.context).not.toContain('CANARY_ENV_SECRET');
      expect(request.state.context).not.toContain('CANARY_NOT_ALLOWLISTED');
      return changeReviewEvaluateOk()(request);
    });
    const { result, context } = await evaluateChangeReviewFromListing({ evaluate, settings, confidenceThreshold: 0.8 }, files, false, current, new AbortController().signal);
    expect(result.workflow).toBe('change-risk');
    expect(context.included).toEqual(['src/a.ts']);
    expect(context.excludedSensitive.map(e => e.rawPath)).toEqual(['src/.env']);
    expect(context.listedOnly.map(e => e.rawPath)).toEqual(['private/notes.md']);
  });

  it('evaluateChangeReviewFromListing runs even when no file is diff-eligible (unlike readiness, there is no "nothing matched" outcome)', async () => {
    const files = [{ filename: 'other/x.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' }];
    const { context } = await evaluateChangeReviewFromListing({ evaluate: changeReviewEvaluateOk(), settings, confidenceThreshold: 0.8 }, files, false, current, new AbortController().signal);
    expect(context.included).toEqual([]);
  });

  it('discloses a truncated listing instead of throwing', async () => {
    const files = [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' }];
    const { context } = await evaluateChangeReviewFromListing({ evaluate: changeReviewEvaluateOk(), settings, confidenceThreshold: 0.8 }, files, true, current, new AbortController().signal);
    expect(context.truncated).toBe(true);
  });

  it('throws ChangeReviewUnavailableError, not the raw content error, when even the title cannot fit the evaluation budget', async () => {
    const evaluate = vi.fn();
    const hugeCurrent: GitHubPullRequest = { ...current, title: 'x'.repeat(20000) };
    await expect(evaluateChangeReviewFromListing({ evaluate, settings, confidenceThreshold: 0.8 }, [], false, hugeCurrent, new AbortController().signal))
      .rejects.toBeInstanceOf(ChangeReviewUnavailableError);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
