import { describe, it, expect, vi } from 'vitest';
import { createGitHubClient, createJevClient, GitHubClientError, GitHubLimitError, GitHubResponseSizeError } from './client';
import type { JevRequest } from '@namayasai/backstage-plugin-jev-operations-support-common';

const request: JevRequest = { state: { context: 'Example document', candidates: [] }, questions: { ready: { type: 'noul', instructions: 'Is this ready?', criteria: { true: 'Ready', false: 'Not ready' } } } };
describe('Jev transport', () => {
  it('uses the documented endpoint, pinned model, server credential and deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { ready: { type: 'noul', noul: 0.91 } } })));
    const result = await createJevClient({ apiKey: 'test-only', model: 'jev-1.13.0', fetch: fetcher }).evaluate(request);
    expect(result.answers.ready).toEqual({ type: 'noul', noul: 0.91 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body)).model).toBe('jev-1.13.0');
    expect(JSON.stringify(init?.body)).not.toContain('test-only');
  });
  it.each([401, 422, 429, 529, 500])('sanitizes provider errors for HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE DOCUMENT AND KEY', { status }));
    const client = createJevClient({ apiKey: 'test-only', model: 'test', fetch: fetcher });
    await expect(client.evaluate(request)).rejects.not.toThrow('PRIVATE');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports a caller cancellation without claiming a specific caller', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { ready: { type: 'noul', noul: 0.91 } } }));
    });
    const client = createJevClient({ apiKey: 'test', model: 'test', fetch: fetcher });
    await expect(client.evaluate(request, controller.signal)).rejects.toThrow('cancelled before a decision was returned');
    await expect(client.evaluate(request, controller.signal)).rejects.not.toThrow(/webhook|redeliver/i);
  });

  it('combines the caller signal with the client deadline and bounds the body read', async () => {
    const hangingBody = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response);
    await expect(createJevClient({ apiKey: 'test', model: 'test', timeoutMs: 30, fetch: hangingBody }).evaluate(request)).rejects.toThrow('timed out');
    expect(hangingBody.mock.calls[0][1]?.signal?.aborted).toBe(true);

    const parent = new AbortController();
    const hangingRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      queueMicrotask(() => parent.abort());
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const client = createJevClient({ apiKey: 'test', model: 'test', timeoutMs: 60_000, fetch: hangingRequest });
    await expect(client.evaluate(request, parent.signal)).rejects.toThrow('cancelled before a decision was returned');
  });

  it('rejects malformed success responses and transport failures', async () => {
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"answers":{}}'));
    await expect(createJevClient({ apiKey: 'test', model: 'test', fetch: malformed }).evaluate(request)).rejects.toThrow('invalid or incomplete');
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error('contains secret details'));
    await expect(createJevClient({ apiKey: 'test', model: 'test', fetch: failed }).evaluate(request)).rejects.toThrow('could not be reached');
  });

  it('uses the pull request files endpoint and fetches Markdown at the pinned head SHA', async () => {
    const headSha = 'a'.repeat(40);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 7, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: 'b'.repeat(40) } })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ filename: 'docs/runbook.md', status: 'modified' }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'file', path: 'docs/runbook.md', encoding: 'base64', size: 5, content: Buffer.from('hello').toString('base64') })));
    const client = createGitHubClient({ token: 'github-test-token', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    const pr = await client.getPullRequest('acme/service', 7, new AbortController().signal);
    const files = await client.listChangedFiles('acme/service', 7, { maxPages: 1, maxFiles: 10 }, new AbortController().signal);
    const file = await client.getFile('acme/service', files[0].filename, pr.headSha, 100, new AbortController().signal);
    expect(files).toEqual([{ filename: 'docs/runbook.md', status: 'modified' }]);
    expect(file.content).toBe('hello');
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      'https://api.github.test/repos/acme/service/pulls/7',
      'https://api.github.test/repos/acme/service/pulls/7/files?per_page=100&page=1',
      `https://api.github.test/repos/acme/service/contents/docs/runbook.md?ref=${headSha}`,
    ]);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer github-test-token' });
  });

  it('parses title/body from the pull request and additions/deletions/patch/previous_filename from the file listing', async () => {
    const headSha = 'a'.repeat(40);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 7, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: 'b'.repeat(40) }, title: 'Replace endpoint', body: 'Migrates v1 to v2.' })))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
        { filename: 'src/b.ts', status: 'renamed', previous_filename: 'src/old-b.ts', additions: 0, deletions: 0 },
      ])));
    const client = createGitHubClient({ token: 'test', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    const pr = await client.getPullRequest('acme/service', 7, new AbortController().signal);
    expect(pr.title).toBe('Replace endpoint');
    expect(pr.body).toBe('Migrates v1 to v2.');
    const files = await client.listChangedFilesTolerant('acme/service', 7, { maxPages: 1, maxFiles: 10, includePatchFields: true }, new AbortController().signal);
    expect(files.truncated).toBe(false);
    expect(files.files[0]).toMatchObject({ filename: 'src/a.ts', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' });
    expect(files.files[1]).toMatchObject({ filename: 'src/b.ts', previous_filename: 'src/old-b.ts' });
  });

  it('falls back to an empty title and null body when the pull request response omits them', async () => {
    const headSha = 'a'.repeat(40);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ number: 7, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: 'b'.repeat(40) } })));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    const pr = await client.getPullRequest('acme/service', 7, new AbortController().signal);
    expect(pr.title).toBe('');
    expect(pr.body).toBeNull();
  });

  it('leaves listChangedFiles unchanged: still throws on a limit, and never returns the change-review-only fields for a caller that never reads them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ filename: `f${i}.md`, status: 'modified' })))));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    await expect(client.listChangedFiles('acme/service', 7, { maxPages: 1, maxFiles: 4 }, new AbortController().signal)).rejects.toThrow('configured limit');
  });

  it('truncates instead of throwing when listChangedFilesTolerant hits the file-count limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ filename: `f${i}.md`, status: 'modified' })))));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    const result = await client.listChangedFilesTolerant('acme/service', 7, { maxPages: 1, maxFiles: 4, includePatchFields: false }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(4);
  });

  it('truncates instead of throwing when listChangedFilesTolerant hits the page limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.md`, status: 'modified' })))));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    const result = await client.listChangedFilesTolerant('acme/service', 7, { maxPages: 1, maxFiles: 1000, includePatchFields: false }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(100);
  });

  it('bounds a single raw patch even when GitHub returns an enormous one', async () => {
    const hugePatch = 'x'.repeat(500_000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ filename: 'src/a.ts', status: 'modified', patch: hugePatch }])));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    const result = await client.listChangedFilesTolerant('acme/service', 7, { maxPages: 1, maxFiles: 10, includePatchFields: true }, new AbortController().signal);
    expect(result.files[0].patch!.length).toBeLessThan(hugePatch.length);
  });

  it('F7: retains no additions/deletions/patch/previous_filename at all when includePatchFields is false, not merely leaving them unused', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([
      { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: 'CANARY_PATCH_TEXT', previous_filename: 'src/old.ts' },
    ])));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    const result = await client.listChangedFilesTolerant('acme/service', 7, { maxPages: 1, maxFiles: 10, includePatchFields: false }, new AbortController().signal);
    expect(result.files[0]).toEqual({ filename: 'src/a.ts', status: 'modified' });
    expect(Object.keys(result.files[0])).toEqual(['filename', 'status']);
  });

  it('F3: a page-1 response-size failure is a genuine error (nothing to truncate to yet)', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ filename: 'src/a.ts', status: 'modified', patch: 'x'.repeat(2 * 1024 * 1024) }])));
    const client = createGitHubClient({ token: 'test', fetch: fetcher, maxResponseBytes: 1024 * 1024 });
    await expect(client.listChangedFilesTolerant('acme/service', 7, { maxPages: 3, maxFiles: 100, includePatchFields: true }, new AbortController().signal))
      .rejects.toBeInstanceOf(GitHubResponseSizeError);
  });

  it('does not misclassify a GitHub rejection on a later page as response truncation', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ filename: `src/${i}.ts`, status: 'modified' })))))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    await expect(client.listChangedFilesTolerant('acme/service', 7, { maxPages: 10, maxFiles: 300, perPage: 30, includePatchFields: true }, new AbortController().signal)).rejects.toMatchObject({ name: 'GitHubClientError', status: 401 });
  });

  it('F3: a page >=2 response-size failure truncates instead of throwing, keeping what page 1 already collected', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url: unknown) => {
      const page = Number(new URL(String(url)).searchParams.get('page'));
      if (page === 1) return new Response(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ filename: `page1-${i}.ts`, status: 'modified', patch: 'small' }))));
      // Page 2's response alone exceeds the configured cap.
      return new Response(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ filename: `page2-${i}.ts`, status: 'modified', patch: 'x'.repeat(100_000) }))));
    });
    const client = createGitHubClient({ token: 'test', fetch: fetcher, maxResponseBytes: 1024 * 1024 });
    const result = await client.listChangedFilesTolerant('acme/service', 7, { maxPages: 3, maxFiles: 1000, perPage: 30, includePatchFields: true }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(30);
    expect(result.files.every(f => f.filename.startsWith('page1-'))).toBe(true);
  });

  it('refuses a changed-file response that is not the documented array', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ files: [{ filename: 'docs/runbook.md' }] })));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    await expect(client.listChangedFiles('acme/service', 7, { maxPages: 1, maxFiles: 10 }, new AbortController().signal)).rejects.toThrow('no changed-file list');
  });

  it('stops oversized GitHub documents before decoding them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ type: 'file', path: 'docs/large.md', encoding: 'base64', size: 101, content: '' })));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    await expect(client.getFile('acme/service', 'docs/large.md', 'a'.repeat(40), 100, new AbortController().signal)).rejects.toBeInstanceOf(GitHubLimitError);
  });

  it('writes a commit status to the fixed statuses endpoint with a target_url only when given one', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 1 })));
    const client = createGitHubClient({ token: 'test', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    await client.createCommitStatus('acme/service', 'a'.repeat(40), { state: 'success', description: 'ok', context: 'jev/readiness' }, new AbortController().signal);
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://api.github.test/repos/acme/service/statuses/${'a'.repeat(40)}`);
    const [, init] = fetcher.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ state: 'success', description: 'ok', context: 'jev/readiness' });
  });

  it('caches the authenticated login across calls and re-fetches after a failure', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not json', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'jev-bot' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'jev-bot' })));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    await expect(client.getAuthenticatedLogin(new AbortController().signal)).rejects.toBeInstanceOf(GitHubClientError);
    expect(await client.getAuthenticatedLogin(new AbortController().signal)).toBe('jev-bot');
    expect(await client.getAuthenticatedLogin(new AbortController().signal)).toBe('jev-bot');
    expect(fetcher).toHaveBeenCalledTimes(2); // first failure not cached, second success is
  });

  // The issue-comments endpoint (unlike the repo-level events endpoint) has no `sort`/`direction` query
  // parameters and is always oldest-first, so these fakes exercise the real mechanism: read page 1 once for its
  // `Link: rel="last"` header, then read backwards from the last page.
  function commentsPage(page: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: page * 1000 + i, body: `p${page}c${i}`, user: { login: 'jev-bot' } }));
  }
  function pagedResponse(body: unknown, lastPage: number) {
    const headers = new Headers();
    if (lastPage > 1) headers.set('link', `<https://api.github.test/x?page=2>; rel="next", <https://api.github.test/x?page=${lastPage}>; rel="last"`);
    return new Response(JSON.stringify(body), { headers });
  }
  function pageNumber(url: unknown): number {
    return Number(new URL(String(url)).searchParams.get('page'));
  }

  it('reads page 1 once for its Link header, then the requested number of pages backwards from the end', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url: unknown) => pagedResponse(commentsPage(pageNumber(url), 100), 5));
    const client = createGitHubClient({ token: 'test', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    const comments = await client.listIssueComments('acme/service', 7, { maxPages: 2 }, new AbortController().signal);
    expect(fetcher.mock.calls.map(call => pageNumber(call[0]))).toEqual([1, 5, 4]);
    expect(comments).toHaveLength(200);
    // Newest-first overall: page 5's own comments (reversed, newest of that page first), then page 4's.
    expect(comments[0]).toMatchObject({ id: 5 * 1000 + 99 });
    expect(comments[99]).toMatchObject({ id: 5 * 1000 + 0 });
    expect(comments[100]).toMatchObject({ id: 4 * 1000 + 99 });
  });

  it('treats a missing Link header as a single page and still searches it newest-first', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => pagedResponse(commentsPage(1, 3), 1));
    const client = createGitHubClient({ token: 'test', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    const comments = await client.listIssueComments('acme/service', 7, { maxPages: 3 }, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(comments.map(c => c.id)).toEqual([1002, 1001, 1000]);
  });

  it('finds a marker comment on the newest page before ever reading the older pages within the bound', async () => {
    // The marker lives on page 5 (the newest); page 4 is never even needed by a caller that stops at the first match.
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url: unknown) => {
      const page = pageNumber(url);
      const comments = page === 5 ? [{ id: 1, body: '<!-- marker -->', user: { login: 'jev-bot' } }, ...commentsPage(page, 99)] : commentsPage(page, 100);
      return pagedResponse(comments, 5);
    });
    const client = createGitHubClient({ token: 'test', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    const comments = await client.listIssueComments('acme/service', 7, { maxPages: 3 }, new AbortController().signal);
    const markerIndex = comments.findIndex(c => c.body === '<!-- marker -->');
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    // It is near the front of the newest-first result, not buried after two full oldest-first pages.
    expect(markerIndex).toBeLessThan(100);
  });

  it('creates and updates issue comments against the documented endpoints', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ id: 1 })));
    const client = createGitHubClient({ token: 'test', apiBaseUrl: 'https://api.github.test/', fetch: fetcher });
    await client.createIssueComment('acme/service', 7, 'hello', new AbortController().signal);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.github.test/repos/acme/service/issues/7/comments');
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
    await client.updateIssueComment('acme/service', 9, 'hello again', new AbortController().signal);
    expect(String(fetcher.mock.calls[1][0])).toBe('https://api.github.test/repos/acme/service/issues/comments/9');
    expect(fetcher.mock.calls[1][1]?.method).toBe('PATCH');
  });
});
