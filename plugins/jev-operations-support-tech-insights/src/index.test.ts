import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, type Readable } from 'node:stream';
import { ConfigReader } from '@backstage/config';
import {
  createJevTechInsightsFactRetriever,
  defaultOptInAnnotation,
  defaultSourceAnnotation,
  defaultSourceVisibilityAnnotation,
  readJevTechInsightsSettings,
  type JevTechInsightsSettings,
} from './index';
import type { JevRequest, JevResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';

vi.mock('cross-fetch', () => ({
  default: (...args: unknown[]) => (globalThis.fetch as unknown as (...input: unknown[]) => Promise<Response>)(...args),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function settings(overrides: Partial<JevTechInsightsSettings> = {}): JevTechInsightsSettings {
  return {
    entityRefs: [],
    targetKinds: ['Component'],
    maxEntities: 50,
    maxDocumentBytes: 12_000,
    timeoutMs: 2_000,
    concurrency: 2,
    allowPrivateDocuments: false,
    model: 'jev-1.13.0',
    workflow: 'readiness',
    demoMode: false,
    ...overrides,
  };
}

function entity(name: string, annotations: Record<string, string> = {}) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      namespace: 'default',
      name,
      annotations,
    },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/platform' },
  };
}

type ReadUrl = (url: string) => Promise<{ buffer?: () => Promise<Buffer>; stream?: () => Readable }>;

function context(items: ReturnType<typeof entity>[], readUrl: ReadUrl) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(items)));
  vi.stubGlobal('fetch', fetcher);
  return {
    context: {
      config: new ConfigReader({}),
      discovery: { getBaseUrl: vi.fn().mockResolvedValue('http://catalog') },
      auth: {
        getOwnServiceCredentials: vi.fn().mockResolvedValue({ principal: { type: 'service', subject: 'test' } }),
        getPluginRequestToken: vi.fn().mockResolvedValue({ token: 'catalog-token' }),
      },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
      urlReader: { readUrl },
    },
    fetcher,
  };
}

function evaluate(request: JevRequest): JevResponse {
  return {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: 0.95 }])),
  };
}

describe('Jev Tech Insights module', () => {
  it('defaults to readiness, a bounded catalog page, and private-source blocking', () => {
    const value = readJevTechInsightsSettings(new ConfigReader({}));
    expect(value.workflow).toBe('readiness');
    expect(value.maxEntities).toBe(50);
    expect(value.maxDocumentBytes).toBe(12_000);
    expect(value.allowPrivateDocuments).toBe(false);
    expect(value.model).toBe('jev-1.13.0');
  });

  it('keeps source fetching, evaluation, and evidence statuses separate', async () => {
    const publicEntity = entity('public-service', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/runbook.md?token=secret',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const privateEntity = entity('private-service', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://private.example.test/runbook.md',
      [defaultSourceVisibilityAnnotation]: 'private',
    });
    const ignoredEntity = entity('ignored-service');
    const readUrl = vi.fn().mockResolvedValue({ buffer: async () => Buffer.from('Start with npm start. Health: GET /health returns 200.') });
    const setup = context([publicEntity, privateEntity, ignoredEntity], readUrl);
    const retriever = createJevTechInsightsFactRetriever(settings(), async request => evaluate(request));

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(2);
    expect(facts[0].facts).toMatchObject({
      fetchStatus: 'fetched',
      evaluationStatus: 'evaluated',
      evidenceStatus: 'pass',
      coverage: 1,
      source: 'https://docs.example.test/runbook.md',
    });
    expect(facts[1].facts).toMatchObject({
      fetchStatus: 'not-evaluated',
      evaluationStatus: 'not-evaluated',
      evidenceStatus: 'not-evaluated',
      errorCode: 'private-source-not-allowed',
    });
    expect(readUrl).toHaveBeenCalledTimes(1);
    expect(readUrl).toHaveBeenCalledWith('https://docs.example.test/runbook.md?token=secret', expect.anything());
    expect(setup.fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not read a document when the Jev client is not configured', async () => {
    const optedIn = entity('service', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/runbook.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const readUrl = vi.fn();
    const setup = context([optedIn], readUrl);
    const retriever = createJevTechInsightsFactRetriever(settings());

    const facts = await retriever.handler(setup.context as never);

    expect(facts[0].facts).toMatchObject({
      fetchStatus: 'not-evaluated',
      evaluationStatus: 'not-evaluated',
      evidenceStatus: 'not-evaluated',
      errorCode: 'jev-not-configured',
    });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it('stores honest not-evaluated facts in demo mode instead of calling Jev or storing fixtures', async () => {
    const value = readJevTechInsightsSettings(new ConfigReader({
      jevOperationsSupport: { apiKey: 'not-used-in-demo-mode', demoMode: true },
    }));
    expect(value.demoMode).toBe(true);

    const optedIn = entity('service', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/runbook.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const readUrl = vi.fn();
    const setup = context([optedIn], readUrl);
    const evaluateSpy = vi.fn();
    // Demo mode is why the module passes no evaluator, even though an API key is present.
    const retriever = createJevTechInsightsFactRetriever(settings({ demoMode: true }));

    const facts = await retriever.handler(setup.context as never);

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(readUrl).not.toHaveBeenCalled();
    expect(facts[0].facts).toMatchObject({
      fetchStatus: 'not-evaluated',
      evaluationStatus: 'not-evaluated',
      evidenceStatus: 'not-evaluated',
      errorCode: 'jev-demo-mode',
      passCount: 0,
      coverage: 0,
    });
  });

  it('caps document bytes and continues with other selected entities', async () => {
    const tooLarge = entity('too-large', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/large.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const valid = entity('valid', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/valid.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const readUrl = vi.fn(async (url: string) => ({
      buffer: async () => Buffer.from(url.includes('large') ? 'x'.repeat(1_100) : 'Start with npm start. Health: GET /health returns 200.'),
    }));
    const setup = context([tooLarge, valid], readUrl);
    const retriever = createJevTechInsightsFactRetriever(settings({ maxDocumentBytes: 1_000 }), async request => evaluate(request));

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(2);
    expect(facts.find(fact => fact.entity.name === 'too-large')?.facts).toMatchObject({
      fetchStatus: 'error',
      evaluationStatus: 'not-evaluated',
      evidenceStatus: 'not-evaluated',
      errorCode: 'document-too-large',
    });
    expect(facts.find(fact => fact.entity.name === 'valid')?.facts).toMatchObject({ evaluationStatus: 'evaluated' });
  });

  it('passes its deadline to the shared Jev client', async () => {
    const optedIn = entity('service', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/runbook.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const readUrl = vi.fn().mockResolvedValue({ buffer: async () => Buffer.from('Start with npm start. Health: GET /health returns 200.') });
    const setup = context([optedIn], readUrl);
    const evaluateSpy = vi.fn(async (request: JevRequest, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false);
      return evaluate(request);
    });
    const retriever = createJevTechInsightsFactRetriever(settings(), evaluateSpy);

    const facts = await retriever.handler(setup.context as never);

    expect(facts[0].facts).toMatchObject({ evaluationStatus: 'evaluated' });
    expect(evaluateSpy.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it('destroys a stalled source stream at the deadline and keeps other entities', async () => {
    const stalled = entity('stalled', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/stalled.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const valid = entity('valid', {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: 'https://docs.example.test/valid.md',
      [defaultSourceVisibilityAnnotation]: 'public',
    });
    const stream = new PassThrough();
    stream.write('Partial runbook content that never ends.');
    const readUrl = vi.fn(async (url: string) => (url.includes('stalled')
      ? { stream: () => stream }
      : { buffer: async () => Buffer.from('Start with npm start. Health: GET /health returns 200.') }));
    const setup = context([stalled, valid], readUrl);
    const retriever = createJevTechInsightsFactRetriever(settings({ timeoutMs: 50, concurrency: 2 }), async request => evaluate(request));

    const facts = await retriever.handler(setup.context as never);

    expect(facts.find(fact => fact.entity.name === 'stalled')?.facts).toMatchObject({
      fetchStatus: 'error',
      evaluationStatus: 'not-evaluated',
      errorCode: 'source-timeout',
    });
    expect(stream.destroyed).toBe(true);
    expect(facts.find(fact => fact.entity.name === 'valid')?.facts).toMatchObject({ evaluationStatus: 'evaluated' });
  });

  it('limits concurrent document evaluations', async () => {
    const entities = Array.from({ length: 5 }, (_, index) => entity(`service-${index}`, {
      [defaultOptInAnnotation]: 'true',
      [defaultSourceAnnotation]: `https://docs.example.test/${index}.md`,
      [defaultSourceVisibilityAnnotation]: 'public',
    }));
    let active = 0;
    let maximum = 0;
    const readUrl = vi.fn(async () => ({
      buffer: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return Buffer.from('Start with npm start. Health: GET /health returns 200.');
      },
    }));
    const setup = context(entities, readUrl);
    const retriever = createJevTechInsightsFactRetriever(settings({ concurrency: 2 }), async request => evaluate(request));

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(5);
    expect(maximum).toBeLessThanOrEqual(2);
  });
});
