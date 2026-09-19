import { describe, it, expect, vi } from 'vitest';
import { createGitHubClient, createJevClient, GitHubLimitError } from './client';
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ filename: 'docs/runbook.md', status: 'modified' }] })))
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

  it('stops oversized GitHub documents before decoding them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ type: 'file', path: 'docs/large.md', encoding: 'base64', size: 101, content: '' })));
    const client = createGitHubClient({ token: 'test', fetch: fetcher });
    await expect(client.getFile('acme/service', 'docs/large.md', 'a'.repeat(40), 100, new AbortController().signal)).rejects.toBeInstanceOf(GitHubLimitError);
  });
});
