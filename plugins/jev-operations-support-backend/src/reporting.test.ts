import { describe, expect, it, vi } from 'vitest';
import type { EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import {
  reportPending, reportFinal, reportChangeReviewPending, reportChangeReviewFinal, reportCombinedComment,
  describeOutcome, describeChangeReviewOutcome, buildCommentBody,
  STATUS_CONTEXT, CHANGE_REVIEW_STATUS_CONTEXT, COMMENT_MARKER, NEUTRAL_DESCRIPTION, type ReportOptions,
} from './reporting';
import { buildChangeReviewContext, type ChangeReviewSettings } from './changeReview';
import { GitHubClientError } from './client';
import type { PullRequestEvent } from './github';
import type { GitHubClient } from './client';

const headSha = 'a'.repeat(40);
const event: PullRequestEvent = { action: 'opened', repository: 'acme/service', pullRequestNumber: 42, headSha, baseSha: 'b'.repeat(40) };

function result(findings: EvaluationResult['findings']): EvaluationResult {
  return { workflow: 'readiness', model: 'jev-1.13.0', evaluatedAt: '2026-09-20T00:00:00.000Z', mode: 'live', findings, needsReview: findings.some(f => f.status !== 'pass') };
}
function finding(id: string, status: 'pass' | 'attention' | 'review', overrides: Partial<EvaluationResult['findings'][number]> = {}): EvaluationResult['findings'][number] {
  return { id, title: `Check ${id}`, statement: 'Statement', status, value: 0.9, kind: 'noul', guidance: `Fix ${id}`, ...overrides };
}
function client(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha, baseSha: 'b'.repeat(40), headRepoFullName: 'acme/service' }),
    listChangedFiles: vi.fn(),
    getFile: vi.fn(),
    getAuthenticatedLogin: vi.fn().mockResolvedValue('jev-bot'),
    createCommitStatus: vi.fn().mockResolvedValue(undefined),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}
function options(overrides: Partial<ReportOptions> = {}): ReportOptions {
  return { client: client(), mode: 'status', blockOn: 'never', maxCommentPages: 3, ...overrides };
}

describe('describeOutcome', () => {
  it('counts findings and stays advisory when blockOn is never, even with an attention finding', () => {
    const documents = [{ path: 'docs/a.md', result: result([finding('a', 'pass'), finding('b', 'attention'), finding('c', 'review')]) }];
    expect(describeOutcome(documents, 'never')).toEqual({ state: 'success', description: '1 clear · 1 attention · 1 needs review — advisory' });
  });
  it('fails only on an attention finding when blockOn is attention; review alone never blocks', () => {
    const reviewOnly = [{ path: 'docs/a.md', result: result([finding('a', 'pass'), finding('b', 'review')]) }];
    expect(describeOutcome(reviewOnly, 'attention').state).toBe('success');
    const withAttention = [{ path: 'docs/a.md', result: result([finding('a', 'attention')]) }];
    expect(describeOutcome(withAttention, 'attention')).toEqual({ state: 'failure', description: '0 clear · 1 attention · 0 needs review — blocking' });
  });
});

describe('reportPending', () => {
  it('writes a pending status with the fixed context and the PR number on the head SHA', async () => {
    const c = client();
    await reportPending(options({ client: c }), event, new AbortController().signal);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'pending', context: STATUS_CONTEXT, description: expect.stringContaining('PR #42') }), expect.anything());
  });
  it('does nothing when reporting is off', async () => {
    const c = client();
    await reportPending(options({ client: c, mode: 'none' }), event, new AbortController().signal);
    expect(c.createCommitStatus).not.toHaveBeenCalled();
  });
  it('never throws when the write fails, and does not retry (single best-effort attempt)', async () => {
    const createCommitStatus = vi.fn().mockRejectedValue(new GitHubClientError(true, 'network down'));
    const c = client({ createCommitStatus });
    const onWriteFailure = vi.fn();
    await expect(reportPending(options({ client: c, onWriteFailure }), event, new AbortController().signal)).resolves.toBeUndefined();
    expect(onWriteFailure).toHaveBeenCalledWith('pending status', expect.any(Error));
    expect(createCommitStatus).toHaveBeenCalledTimes(1);
  });
});

describe('reportFinal: every status description names the pull request (N2)', () => {
  it('so two pull requests sharing a commit at least show which one a status came from', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const c = client({ createCommitStatus });
    await reportFinal(options({ client: c }), event, { kind: 'evaluated', documents: [{ path: 'docs/a.md', result: result([finding('a', 'pass')]) }] }, new AbortController().signal);
    expect(createCommitStatus.mock.calls[0][2].description).toMatch(/^PR #42 · /);
    expect(createCommitStatus.mock.calls[0][2].description.length).toBeLessThanOrEqual(140);
  });
});

describe('reportFinal: evaluated', () => {
  const documents = [{ path: 'docs/a.md', result: result([finding('startup', 'pass')]) }];
  it('writes only a commit status in status mode, and reports success', async () => {
    const c = client();
    const wrote = await reportFinal(options({ client: c, mode: 'status' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(wrote).toBe(true);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'success' }), expect.anything());
    expect(c.createIssueComment).not.toHaveBeenCalled();
  });
  it('also writes a comment in status+comment mode', async () => {
    const c = client();
    await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createIssueComment).toHaveBeenCalledTimes(1);
  });
  it('skips the comment entirely (N5) when the commit status write itself could not be posted, since a result table next to a stuck pending would mislead', async () => {
    const createCommitStatus = vi.fn().mockRejectedValue(new GitHubClientError(false, 'permanently rejected'));
    const c = client({ createCommitStatus });
    const wrote = await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(wrote).toBe(false);
    expect(c.createIssueComment).not.toHaveBeenCalled();
  });
  it('writes the neutral resolution, not the real result, when the head is confirmed moved', async () => {
    const c = client({ getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha: 'c'.repeat(40), baseSha: 'b'.repeat(40), headRepoFullName: 'acme/service' }) });
    await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'success', description: expect.stringContaining(NEUTRAL_DESCRIPTION) }), expect.anything());
    expect(c.createIssueComment).not.toHaveBeenCalled();
  });
  it('still writes the real result — not the neutral one — when the head recheck itself fails (unconfirmed, not moved)', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const c = client({ createCommitStatus, getPullRequest: vi.fn().mockRejectedValue(new Error('502 from GitHub')) });
    await reportFinal(options({ client: c, mode: 'status' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'success' }), expect.anything());
    expect(createCommitStatus.mock.calls[0][2].description).not.toContain(NEUTRAL_DESCRIPTION);
  });
  it('sets a target_url only when a base URL is configured', async () => {
    const c = client();
    await reportFinal(options({ client: c, baseUrl: 'https://backstage.example' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createCommitStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ targetUrl: 'https://backstage.example' }), expect.anything());
    const c2 = client();
    await reportFinal(options({ client: c2 }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c2.createCommitStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.not.objectContaining({ targetUrl: expect.anything() }), expect.anything());
  });
});

describe('reportFinal: error', () => {
  it('writes an error status naming only the reason, never document content', async () => {
    const c = client();
    const wrote = await reportFinal(options({ client: c }), event, { kind: 'error', reason: 'GitHub could not be read for this pull request.' }, new AbortController().signal);
    expect(wrote).toBe(true);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'error', description: 'PR #42 · GitHub could not be read for this pull request.' }), expect.anything());
  });
  it('writes the neutral resolution instead of error when the head is confirmed moved', async () => {
    const c = client({ getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha: 'c'.repeat(40), baseSha: 'b'.repeat(40), headRepoFullName: 'acme/service' }) });
    await reportFinal(options({ client: c }), event, { kind: 'error', reason: 'Jev evaluation failed.' }, new AbortController().signal);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'success', description: expect.stringContaining(NEUTRAL_DESCRIPTION) }), expect.anything());
  });
  it('still writes the error (never silently drops it) when the head recheck itself fails', async () => {
    const c = client({ getPullRequest: vi.fn().mockRejectedValue(new Error('502 from GitHub')) });
    const wrote = await reportFinal(options({ client: c }), event, { kind: 'error', reason: 'Jev evaluation failed.' }, new AbortController().signal);
    expect(wrote).toBe(true);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'error' }), expect.anything());
  });
});

describe('reportFinal: neutral', () => {
  it('writes a success status with the neutral description, unconditionally, without rechecking the head again', async () => {
    const c = client();
    const wrote = await reportFinal(options({ client: c }), event, { kind: 'neutral' }, new AbortController().signal);
    expect(wrote).toBe(true);
    expect(c.getPullRequest).not.toHaveBeenCalled();
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'success', description: expect.stringContaining(NEUTRAL_DESCRIPTION) }), expect.anything());
  });
  it('reports whether the write itself succeeded', async () => {
    const c = client({ createCommitStatus: vi.fn().mockRejectedValue(new GitHubClientError(false, 'down')) });
    const wrote = await reportFinal(options({ client: c }), event, { kind: 'neutral' }, new AbortController().signal);
    expect(wrote).toBe(false);
  });
});

describe('N3: the final write retries a transient failure with backoff, inside its own budget', () => {
  it('retries a retryable GitHubClientError up to twice more (three attempts total) and eventually succeeds', async () => {
    vi.useFakeTimers();
    try {
      const createCommitStatus = vi.fn()
        .mockRejectedValueOnce(new GitHubClientError(true, 'rate limited', 429))
        .mockRejectedValueOnce(new GitHubClientError(true, 'server error', 503))
        .mockResolvedValueOnce(undefined);
      const c = client({ createCommitStatus });
      const promise = reportFinal(options({ client: c }), event, { kind: 'error', reason: 'Jev evaluation failed.' }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      const wrote = await promise;
      expect(wrote).toBe(true);
      expect(createCommitStatus).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('does not retry a non-retryable error (401/404/422)', async () => {
    const createCommitStatus = vi.fn().mockRejectedValue(new GitHubClientError(false, 'not found', 404));
    const c = client({ createCommitStatus });
    const wrote = await reportFinal(options({ client: c }), event, { kind: 'error', reason: 'Jev evaluation failed.' }, new AbortController().signal);
    expect(wrote).toBe(false);
    expect(createCommitStatus).toHaveBeenCalledTimes(1);
  });

  it('gives up after three attempts even if every one is retryable, and still reports failure honestly', async () => {
    vi.useFakeTimers();
    try {
      const createCommitStatus = vi.fn().mockRejectedValue(new GitHubClientError(true, 'always busy', 503));
      const c = client({ createCommitStatus });
      const promise = reportFinal(options({ client: c }), event, { kind: 'error', reason: 'Jev evaluation failed.' }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      const wrote = await promise;
      expect(wrote).toBe(false);
      expect(createCommitStatus).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('never retries the neutral resolution\'s own write beyond what a transient failure allows, but does still retry it', async () => {
    vi.useFakeTimers();
    try {
      const createCommitStatus = vi.fn().mockRejectedValueOnce(new GitHubClientError(true, 'busy', 503)).mockResolvedValueOnce(undefined);
      const c = client({ createCommitStatus });
      const promise = reportFinal(options({ client: c }), event, { kind: 'neutral' }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      const wrote = await promise;
      expect(wrote).toBe(true);
      expect(createCommitStatus).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('the report comment', () => {
  const documents = [{ path: 'docs/a.md', result: result([finding('startup', 'pass', { guidance: 'Keep it up' })]) }];
  it('creates a comment carrying the hidden marker when none exists yet', async () => {
    const c = client({ listIssueComments: vi.fn().mockResolvedValue([]) });
    await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createIssueComment).toHaveBeenCalledWith('acme/service', 42, expect.stringContaining(COMMENT_MARKER), expect.anything());
    expect(c.updateIssueComment).not.toHaveBeenCalled();
  });
  it('updates the newest existing marked comment authored by the token\'s own user instead of creating a new one', async () => {
    const c = client({ listIssueComments: vi.fn().mockResolvedValue([
      { id: 5, body: 'unrelated comment', login: 'jev-bot' },
      { id: 9, body: `${COMMENT_MARKER}\nold report`, login: 'jev-bot' },
    ]) });
    await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.updateIssueComment).toHaveBeenCalledWith('acme/service', 9, expect.stringContaining(COMMENT_MARKER), expect.anything());
    expect(c.createIssueComment).not.toHaveBeenCalled();
  });
  it('ignores a marked comment from someone other than the token\'s own user', async () => {
    const c = client({ listIssueComments: vi.fn().mockResolvedValue([{ id: 9, body: `${COMMENT_MARKER}\nold report`, login: 'someone-else' }]) });
    await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createIssueComment).toHaveBeenCalledTimes(1);
    expect(c.updateIssueComment).not.toHaveBeenCalled();
  });
  it('N6: only matches the marker at the very start of a comment, not merely mentioned somewhere inside it', async () => {
    const c = client({ listIssueComments: vi.fn().mockResolvedValue([{ id: 9, body: `Someone quoted the marker below:\n${COMMENT_MARKER}\nnot actually our own report`, login: 'jev-bot' }]) });
    await reportFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createIssueComment).toHaveBeenCalledTimes(1); // treated as absent, so a new one is created
    expect(c.updateIssueComment).not.toHaveBeenCalled();
  });
  it('paginates the comment search up to the configured page bound', async () => {
    const c = client();
    await reportFinal(options({ client: c, mode: 'status+comment', maxCommentPages: 3 }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.listIssueComments).toHaveBeenCalledWith('acme/service', 42, { maxPages: 3 }, expect.anything());
  });
  it('never throws when the comment write fails', async () => {
    const c = client({ createIssueComment: vi.fn().mockRejectedValue(new Error('rate limited')) });
    const onWriteFailure = vi.fn();
    await expect(reportFinal(options({ client: c, mode: 'status+comment', onWriteFailure }), event, { kind: 'evaluated', documents }, new AbortController().signal)).resolves.not.toThrow();
    expect(onWriteFailure).toHaveBeenCalledWith('report comment', expect.any(Error));
  });
});

describe('comment body construction', () => {
  it('never includes document content, only the path, check title, answer, status, and guidance', () => {
    const body = buildCommentBody(event, [{ path: 'docs/a.md', result: result([finding('startup', 'pass', { value: 0.95, kind: 'noul' })]) }]);
    expect(body).toContain(COMMENT_MARKER);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('docs/a.md');
    expect(body).toContain('Check startup');
    expect(body).toContain('Fix startup');
    expect(body).toContain('A negative finding means the supplied context did not establish the condition.');
    expect(body).toContain(headSha.slice(0, 7));
    expect(body).toContain('PR #42');
  });

  it('renders a hostile path inside an inert code span: a Markdown link never becomes a clickable link', () => {
    const body = buildCommentBody(event, [{ path: 'docs/[click me](https://evil.example).md', result: result([finding('startup', 'pass')]) }]);
    // Safe because it is entirely inside a single backtick-fenced code span (GitHub never parses Markdown, or
    // renders a link, inside a code span) — not because the bracket/paren syntax was stripped or escaped.
    expect(body).toContain('`docs/[click me](https://evil.example).md`');
  });

  it('renders a hostile path with an HTML tag literally, never as markup', () => {
    const body = buildCommentBody(event, [{ path: 'docs/<img src=x onerror=alert(1)>.md', result: result([finding('startup', 'pass')]) }]);
    expect(body).toContain('`docs/<img src=x onerror=alert(1)>.md`');
  });

  it('never turns an @mention in a path into a notification, being entirely inside a code span', () => {
    const body = buildCommentBody(event, [{ path: 'docs/@org/team/a.md', result: result([finding('startup', 'pass')]) }]);
    // GitHub does not convert an `@name` inside a code span into a mention notification, so no additional
    // zero-width-space neutralisation is needed (or applied) for content that is already code-spanned.
    expect(body).toContain('`docs/@org/team/a.md`');
  });

  it('keeps a table intact when a path contains a pipe', () => {
    const body = buildCommentBody(event, [{ path: 'docs/a|b.md', result: result([finding('startup', 'pass')]) }]);
    const row = body.split('\n').find(line => line.includes('startup'))!;
    expect(row.split('|')).toHaveLength(7); // leading empty + 5 columns + trailing empty
    expect(row).toContain('a｜b.md');
  });

  it('sizes the code span fence wider than any run of backticks already in the path', () => {
    const body = buildCommentBody(event, [{ path: 'docs/a``b.md', result: result([finding('startup', 'pass')]) }]);
    expect(body).toContain('```docs/a``b.md```');
  });

  it('strips newlines and control characters from a path so a row can never span multiple lines', () => {
    const body = buildCommentBody(event, [{ path: 'docs/a\nb\rc.md', result: result([finding('startup', 'pass')]) }]);
    const rows = body.split('\n').filter(line => line.startsWith('| `docs/'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\r\n]/);
  });

  it('N4/N7: strips a Unicode right-to-left override from a path, so it cannot visually disguise the path', () => {
    const bidiPath = `docs/${String.fromCodePoint(0x202e)}gnp.exe${String.fromCodePoint(0x202c)}.md`;
    const body = buildCommentBody(event, [{ path: bidiPath, result: result([finding('startup', 'pass')]) }]);
    expect(body).not.toContain(String.fromCodePoint(0x202e));
    expect(body).not.toContain(String.fromCodePoint(0x202c));
    expect(body).toContain('`docs/gnp.exe.md`');
  });

  it('N4/N7: strips a zero-width space hidden in a path instead of preserving it invisibly', () => {
    const hiddenPath = `docs/${String.fromCodePoint(0x200b)}secret.md`;
    const body = buildCommentBody(event, [{ path: hiddenPath, result: result([finding('startup', 'pass')]) }]);
    expect(body).not.toContain(String.fromCodePoint(0x200b));
    expect(body).toContain('`docs/secret.md`');
  });

  it('code-spans and length-caps the provider model string the same way as a path, also stripping hidden Unicode', () => {
    const longModel = `evil](https://evil.example)${String.fromCodePoint(0x202e)} ${'x'.repeat(200)}`;
    const body = buildCommentBody(event, [{ path: 'docs/a.md', result: { ...result([finding('startup', 'pass')]), model: longModel } }]);
    const modelLine = body.split('\n').find(line => line.startsWith('Model:'))!;
    expect(modelLine).toContain('`evil](https://evil.example)');
    expect(modelLine).not.toContain(String.fromCodePoint(0x202e));
    // Capped to 80 characters of model text before fencing; the line as a whole stays well short of any
    // reasonable rendering limit even with the code-span backticks and the trailing "Evaluated:" segment.
    expect(modelLine.length).toBeLessThan(160);
  });

  it('truncates the table with an explicit row instead of growing without bound', () => {
    const manyFindings = Array.from({ length: 5000 }, (_, i) => finding(`f${i}`, 'pass', { guidance: `Guidance for finding number ${i} with some extra padding text to add length.` }));
    const body = buildCommentBody(event, [{ path: 'docs/a.md', result: result(manyFindings) }]);
    expect(body.length).toBeLessThanOrEqual(60000);
    expect(body).toContain('truncated');
  });
});

function changeRiskResult(findings: EvaluationResult['findings']): EvaluationResult {
  return { workflow: 'change-risk', model: 'jev-1.13.0', evaluatedAt: '2026-09-20T00:00:00.000Z', mode: 'live', findings, needsReview: findings.some(f => f.status !== 'pass') };
}
const changeReviewSettings: ChangeReviewSettings = { enabled: true, paths: ['src/**'], maxFiles: 20, maxPatchBytes: 12000 };
function sampleContext() {
  return buildChangeReviewContext({
    title: 'Replace payments endpoint', body: 'Migrates /v1 to /v2.',
    files: [
      { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
      { filename: '.env', status: 'modified', additions: 1, deletions: 1, patch: 'CANARY_SECRET_PATCH=1' },
      { filename: 'private/notes.md', status: 'added', additions: 5, deletions: 0, patch: 'CANARY_NOT_ALLOWLISTED' },
    ],
  }, changeReviewSettings);
}

describe('describeChangeReviewOutcome', () => {
  it('reports concern findings and rollback status honestly: a low probability on a concern is "not established", not "pass"', () => {
    const findings = [
      { id: 'breaking', title: 'Compatibility concern', statement: 's', status: 'review' as const, value: 0.1, kind: 'noul' as const, guidance: 'g' },
      { id: 'migration', title: 'Data migration concern', statement: 's', status: 'attention' as const, value: 0.9, kind: 'noul' as const, guidance: 'g' },
      { id: 'access', title: 'Access control concern', statement: 's', status: 'review' as const, value: 0.5, kind: 'noul' as const, guidance: 'g' },
      { id: 'rollback', title: 'Rollback documented', statement: 's', status: 'pass' as const, value: 0.9, kind: 'noul' as const, guidance: 'g' },
    ];
    expect(describeChangeReviewOutcome(changeRiskResult(findings), 'never')).toEqual({ state: 'success', description: '1 concern · 2 not established · rollback documented — advisory' });
  });
  it('blocks only on an attention CONCERN when blockOn is attention; an unclear/undocumented rollback never blocks by itself', () => {
    const noConcern = [
      { id: 'breaking', title: 't', statement: 's', status: 'review' as const, value: 0.1, kind: 'noul' as const, guidance: 'g' },
      { id: 'rollback', title: 't', statement: 's', status: 'attention' as const, value: 0.1, kind: 'noul' as const, guidance: 'g' },
    ];
    expect(describeChangeReviewOutcome(changeRiskResult(noConcern), 'attention').state).toBe('success');
    const withConcern = [{ id: 'breaking', title: 't', statement: 's', status: 'attention' as const, value: 0.9, kind: 'noul' as const, guidance: 'g' }];
    expect(describeChangeReviewOutcome(changeRiskResult(withConcern), 'attention')).toMatchObject({ state: 'failure' });
  });
});

describe('change review pending/final: independent jev/change-review context', () => {
  it('writes pending under the separate change-review context', async () => {
    const c = client();
    await reportChangeReviewPending(options({ client: c }), event, new AbortController().signal);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ state: 'pending', context: CHANGE_REVIEW_STATUS_CONTEXT }), expect.anything());
  });
  it('writes a final evaluated status under the change-review context, independent of jev/readiness', async () => {
    const c = client();
    const findings = [{ id: 'rollback', title: 't', statement: 's', status: 'pass' as const, value: 0.9, kind: 'noul' as const, guidance: 'g' }];
    const wrote = await reportChangeReviewFinal(options({ client: c }), event, { kind: 'evaluated', result: changeRiskResult(findings) }, new AbortController().signal);
    expect(wrote).toBe(true);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ context: CHANGE_REVIEW_STATUS_CONTEXT, state: 'success' }), expect.anything());
  });
  it('writes a fixed, content-free error status', async () => {
    const c = client();
    await reportChangeReviewFinal(options({ client: c }), event, { kind: 'error', reason: 'Change review could not be assembled for this pull request.' }, new AbortController().signal);
    expect(c.createCommitStatus).toHaveBeenCalledWith('acme/service', headSha, expect.objectContaining({ context: CHANGE_REVIEW_STATUS_CONTEXT, state: 'error', description: expect.stringContaining('Change review could not be assembled') }), expect.anything());
  });
  it('never writes a comment itself, even in status+comment mode -- router.ts owns the combined comment', async () => {
    const c = client();
    const findings = [{ id: 'rollback', title: 't', statement: 's', status: 'pass' as const, value: 0.9, kind: 'noul' as const, guidance: 'g' }];
    await reportChangeReviewFinal(options({ client: c, mode: 'status+comment' }), event, { kind: 'evaluated', result: changeRiskResult(findings) }, new AbortController().signal);
    expect(c.createIssueComment).not.toHaveBeenCalled();
  });
});

describe('reportFinal skips its own comment when change review is enabled', () => {
  it('so router.ts can write one combined comment instead of two', async () => {
    const c = client();
    const documents = [{ path: 'docs/a.md', result: result([finding('startup', 'pass')]) }];
    await reportFinal(options({ client: c, mode: 'status+comment', changeReviewEnabled: true }), event, { kind: 'evaluated', documents }, new AbortController().signal);
    expect(c.createIssueComment).not.toHaveBeenCalled();
  });
});

describe('reportCombinedComment', () => {
  const readinessDocuments = [{ path: 'docs/a.md', result: result([finding('startup', 'pass')]) }];
  const findings = [
    { id: 'breaking', title: 'Compatibility concern', statement: 's', status: 'review' as const, value: 0.1, kind: 'noul' as const, guidance: 'Review it' },
    { id: 'rollback', title: 'Rollback documented', statement: 's', status: 'attention' as const, value: 0.1, kind: 'noul' as const, guidance: 'Document rollback' },
  ];

  it('writes nothing when neither section is supplied', async () => {
    const c = client();
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, {}, new AbortController().signal);
    expect(c.createIssueComment).not.toHaveBeenCalled();
    expect(c.updateIssueComment).not.toHaveBeenCalled();
  });

  it('includes a readiness table and a Change review section with its own findings table', async () => {
    const c = client();
    const context = sampleContext();
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, { readinessDocuments, changeReview: { result: changeRiskResult(findings), context } }, new AbortController().signal);
    const body = (c.createIssueComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as string;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('docs/a.md');
    expect(body).toContain('### Change review');
    expect(body).toContain('Compatibility concern');
    expect(body).toContain('Document rollback');
    expect(body).toContain('not established is not evidence that the change is safe'.replace('not established', '"Not established"'));
    expect(body).toContain('Sensitive paths are withheld by a path heuristic, not secret scanning');
  });

  it('never includes diff content or the PR description, and renders only path/reason through codeSpan/escapeMarkdownPlain -- never rawPath', async () => {
    const c = client();
    const context = sampleContext();
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, { changeReview: { result: changeRiskResult(findings), context } }, new AbortController().signal);
    const body = (c.createIssueComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as string;
    expect(body).not.toContain('CANARY_SECRET_PATCH');
    expect(body).not.toContain('CANARY_NOT_ALLOWLISTED');
    expect(body).not.toContain('Migrates /v1 to /v2'); // the PR description text
    // The sensitive/unlisted files are still named (disclosed), just never with their diff content.
    expect(body).toContain('.env');
    expect(body).toContain('private/notes.md');
  });

  it('renders hostile disclosure paths and reasons inertly (Markdown link, <img>, @org/team, backticks, bidi override)', async () => {
    const c = client();
    const context = buildChangeReviewContext({
      title: 'x',
      files: [
        { filename: 'src/[click](https://evil.example).ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { filename: `src/${String.fromCodePoint(0x202e)}gnp.exe${String.fromCodePoint(0x202c)}.ts`, status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { filename: 'src/<img src=x onerror=alert(1)>.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { filename: 'src/@org/team.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { filename: 'src/a``b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { filename: '.npmrc', status: 'modified', additions: 1, deletions: 0, patch: 'CANARY' }, // excludedSensitive, no reason
      ],
    }, changeReviewSettings);
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, { changeReview: { result: changeRiskResult(findings), context } }, new AbortController().signal);
    const body = (c.createIssueComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as string;
    expect(body).not.toContain(String.fromCodePoint(0x202e));
    expect(body).not.toContain(String.fromCodePoint(0x202c));
    expect(body).toContain('`src/[click](https://evil.example).ts`');
    expect(body).toContain('`src/<img src=x onerror=alert(1)>.ts`');
    expect(body).toContain('`src/@org/team.ts`');
    expect(body).toMatch(/`{2,}src\/a``b\.ts`{2,}/);
  });

  it('caps each disclosure category at 50 entries with an "and N more" tail', async () => {
    const c = client();
    const files = Array.from({ length: 60 }, (_, i) => ({ filename: `other/f${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: 'x' }));
    const context = buildChangeReviewContext({ title: 'x', files }, changeReviewSettings); // none match paths: src/**, so all become listedOnly
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, { changeReview: { result: changeRiskResult(findings), context } }, new AbortController().signal);
    const body = (c.createIssueComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as string;
    expect(body).toContain('and 10 more');
    expect((body.match(/other\/f\d+\.ts/g) ?? []).length).toBe(50);
  });

  it('keeps the whole comment under the 60,000-character cap', async () => {
    const c = client();
    const bigFindings = Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, title: `Finding ${i}`, statement: 's', status: 'pass' as const, value: 0.9, kind: 'noul' as const, guidance: 'g'.repeat(2000) }));
    const manyReadinessFindings = Array.from({ length: 3000 }, (_, i) => finding(`r${i}`, 'pass', { guidance: `Guidance ${i}`.repeat(3) }));
    const readinessDocs = [{ path: 'docs/a.md', result: result(manyReadinessFindings) }];
    const context = sampleContext();
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, { readinessDocuments: readinessDocs, changeReview: { result: changeRiskResult(bigFindings), context } }, new AbortController().signal);
    const body = (c.createIssueComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as string;
    expect(body.length).toBeLessThanOrEqual(60000);
  });

  it('F1: a huge readiness table never silently cuts the change-review section, its disclaimers, or its <details> block off the tail', async () => {
    const c = client();
    // 3 documents x 120 findings each with generous guidance text: large enough that readiness's OWN table alone
    // would, under the old naive concatenate-then-clip-the-tail approach, consume the whole 60,000-character
    // budget and push a NORMAL-sized change-review section (built alongside it, not degraded) off the end.
    const bigDocuments = Array.from({ length: 3 }, (_, docIndex) => ({
      path: `docs/doc-${docIndex}.md`,
      result: result(Array.from({ length: 120 }, (_, i) => finding(`f${docIndex}-${i}`, 'pass', { guidance: `Guidance text for finding ${docIndex}-${i}, padded to be unusually long so this table alone would exceed the whole 60,000-character budget on its own if it were not truncated.`.repeat(2) }))),
    }));
    const normalChangeReviewFindings = [
      { id: 'breaking', title: 'Compatibility concern', statement: 's', status: 'review' as const, value: 0.1, kind: 'noul' as const, guidance: 'Review it' },
      { id: 'migration', title: 'Data migration concern', statement: 's', status: 'review' as const, value: 0.1, kind: 'noul' as const, guidance: 'Review it' },
      { id: 'access', title: 'Access control concern', statement: 's', status: 'attention' as const, value: 0.9, kind: 'noul' as const, guidance: 'Review it' },
      { id: 'rollback', title: 'Rollback documented', statement: 's', status: 'attention' as const, value: 0.1, kind: 'noul' as const, guidance: 'Document rollback' },
    ];
    const context = sampleContext(); // an ordinary, small change-review context -- no degradation should even be needed
    await reportCombinedComment(options({ client: c, mode: 'status+comment' }), event, {
      readinessDocuments: bigDocuments,
      changeReview: { result: changeRiskResult(normalChangeReviewFindings), context },
    }, new AbortController().signal);
    const body = (c.createIssueComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as string;
    expect(body.length).toBeLessThanOrEqual(60000);
    expect(body).toContain('<details>');
    expect(body).toContain('</details>');
    expect(body).toMatch(/What was sent: \d+ included/); // the <summary> counts line
    expect(body).toContain('A negative finding means the supplied context did not establish the condition.');
    expect(body).toContain('"Not established" is not evidence that the change is safe.');
    expect(body).toContain('Sensitive paths are withheld by a path heuristic, not secret scanning; the pull request title and description are sent as written.');
    // Readiness's own table is what absorbed the shortfall (its usual truncation row), not the change-review section.
    expect(body).toContain('truncated: remaining findings omitted');
  });
});

describe('N4: this source file itself contains no raw control bytes and no literal hidden-Unicode characters', () => {
  it('uses only numeric code points for the sanitiser character classes, never an embedded raw byte or character', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(import.meta.dirname, 'reporting.ts'), 'utf8');
    const rawControlBytes = [...source].filter(char => {
      const code = char.codePointAt(0)!;
      return (code <= 0x08) || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
    });
    expect(rawControlBytes).toEqual([]);
    const hiddenUnicode = [...source].filter(char => {
      const code = char.codePointAt(0)!;
      return (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064)
        || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || code === 0x2028 || code === 0x2029 || code === 0x061c || code === 0x180e;
    });
    expect(hiddenUnicode).toEqual([]);
  });
});
