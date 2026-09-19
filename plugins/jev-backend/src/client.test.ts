import { describe, it, expect, vi } from 'vitest';
import { createJevClient } from './client';
import type { JevRequest } from '@namayasai/backstage-plugin-jev-common';

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
});
