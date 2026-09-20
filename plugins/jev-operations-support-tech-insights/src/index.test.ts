import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, type Readable } from 'node:stream';
import { ConfigReader } from '@backstage/config';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  buildJevTechInsightsFactRetrievers,
  createJevOwnerSuggestionFactRetriever,
  createJevTechInsightsFactRetriever,
  defaultOptInAnnotation,
  defaultSourceAnnotation,
  defaultSourceVisibilityAnnotation,
  jevOwnerSuggestionFactRetrieverId,
  jevTechInsightsFactRetrieverId,
  readJevOwnerSuggestionSettings,
  readJevTechInsightsSettings,
  type JevOwnerSuggestionSettings,
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

function ownerSettings(overrides: Partial<JevOwnerSuggestionSettings> = {}): JevOwnerSuggestionSettings {
  return {
    enabled: true,
    maxEntities: 20,
    kinds: ['Component', 'API', 'Resource', 'System'],
    unownedValues: ['unknown', 'guests', 'group:default/guests', ''],
    maxGroups: 20,
    maxScannedEntities: 2_000,
    ...overrides,
  };
}

function ownerEntity(name: string, overrides: Partial<{ kind: string; owner: string; title: string; description: string; tags: string[]; type: string; lifecycle: string; system: string }> = {}) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: overrides.kind ?? 'Component',
    metadata: { namespace: 'default', name, title: overrides.title, description: overrides.description, tags: overrides.tags },
    spec: { type: overrides.type ?? 'service', lifecycle: overrides.lifecycle ?? 'production', owner: overrides.owner, system: overrides.system },
  };
}

function groupEntity(name: string, overrides: Partial<{ title: string; description: string; tags: string[] }> = {}) {
  return { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { namespace: 'default', name, ...overrides } };
}

/**
 * A `getEntities`/`getEntitiesByRefs` fake covering every catalog call this retriever now
 * makes: a paged `GET /entities` scan of `kinds` (`entities`, sliced by `offset`/`limit`), a
 * `GET /entities` page of Group candidates (`groups`, filtered by `kind%3DGroup`), a `POST
 * /entities/by-refs` existence check for dangling Group owners (every requested ref starts
 * with `group:`), and a second, distinct `POST /entities/by-refs` that re-fetches full records
 * for the selected window (every requested ref does *not* start with `group:`, since it
 * targets the Component/API/etc. entities themselves) — matched back to `entities` by their
 * canonical ref.
 */
function ownerContext(options: {
  entities: unknown[];
  groups?: unknown[];
  existingGroupRefs?: string[];
  resolveThrows?: boolean;
  entityRefetchThrows?: boolean;
  entitiesThrow?: boolean;
  groupsThrow?: boolean;
}) {
  const byRef = new Map((options.entities as { metadata: { name: string; namespace?: string }; kind: string }[]).map(item => [stringifyEntityRef(item as never), item]));
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { entityRefs: string[] };
      const isGroupExistenceCheck = body.entityRefs.every(ref => ref.startsWith('group:'));
      if (isGroupExistenceCheck) {
        if (options.resolveThrows) throw new Error('catalog unavailable');
        const items = body.entityRefs.map(ref => ((options.existingGroupRefs ?? []).includes(ref)
          ? { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { namespace: ref.split('/')[0].split(':')[1], name: ref.split('/')[1] } }
          : null));
        return new Response(JSON.stringify({ items }));
      }
      if (options.entityRefetchThrows) throw new Error('catalog unavailable');
      const items = body.entityRefs.map(ref => byRef.get(ref) ?? null);
      return new Response(JSON.stringify({ items }));
    }
    const parsedUrl = new URL(String(url));
    const limit = Number(parsedUrl.searchParams.get('limit') ?? Infinity);
    if (String(url).includes('/entities/by-query')) {
      // The catalog scan (`scanOwnerCandidates`, via `CatalogClient.queryEntities`): cursor
      // pagination. The fake's "cursor" is simply the offset reached so far, opaque to the
      // retriever the same way a real cursor is.
      if (options.entitiesThrow) throw new Error('catalog unavailable');
      const cursorParam = parsedUrl.searchParams.get('cursor');
      const offset = cursorParam ? Number(cursorParam) : 0;
      const all = options.entities as unknown[];
      const page = all.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < all.length ? String(nextOffset) : undefined;
      return new Response(JSON.stringify({ items: page, totalItems: all.length, pageInfo: { nextCursor } }));
    }
    if (String(url).includes('kind%3DGroup')) {
      // The Group candidate pool (`getOwnerCandidateGroups`, via `CatalogClient.getEntities` —
      // a single bounded page, not a scan, so it is not cursor-paginated).
      if (options.groupsThrow) throw new Error('catalog unavailable');
      return new Response(JSON.stringify((options.groups ?? []).slice(0, limit)));
    }
    throw new Error(`ownerContext fake: unexpected GET ${String(url)}`);
  });
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
      urlReader: { readUrl: vi.fn() },
    },
    fetcher,
  };
}

/** Answers the `ownership` workflow's single `recommendation` choice question by picking
 * `choice` (a candidate key like `c0`, or `none`) with the given confidence. */
function ownerEvaluate(request: JevRequest, choice: string, confidence = 0.9): JevResponse {
  const question = request.questions.recommendation;
  const criteria = question.type === 'choice' ? question.criteria : {};
  const keys = Object.keys(criteria);
  const rest = keys.length > 1 ? (1 - confidence) / (keys.length - 1) : 0;
  return { model: 'jev-1.13.0', answers: { recommendation: { type: 'choice', choice, confidence, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? confidence : rest])) } } };
}

const noneEvaluate = async (request: JevRequest): Promise<JevResponse> => ownerEvaluate(request, 'none');

describe('Jev owner suggestion fact retriever', () => {
  it('defaults to disabled, a bounded page, the standard kinds, the standard unowned values, and a bounded scan', () => {
    const value = readJevOwnerSuggestionSettings(new ConfigReader({}));
    expect(value).toEqual({
      enabled: false,
      maxEntities: 20,
      kinds: ['Component', 'API', 'Resource', 'System'],
      unownedValues: ['unknown', 'guests', 'group:default/guests', ''],
      maxGroups: 20,
      maxScannedEntities: 2_000,
    });
  });

  it('names the full config path in a validation error, not just the bare key', () => {
    const config = new ConfigReader({ jevOperationsSupport: { techInsights: { ownerSuggestion: { maxScannedEntities: 50 } } } });
    expect(() => readJevOwnerSuggestionSettings(config)).toThrow('jevOperationsSupport.techInsights.ownerSuggestion.maxScannedEntities must be an integer between 100 and 20000');
  });

  it('selects every unowned form and a dangling group owner, skips a real owner (Group or User), and stores a lower-cased entity ref', async () => {
    const entities = [
      ownerEntity('no-owner-field'),
      ownerEntity('blank-owner', { owner: '   ' }),
      ownerEntity('unknown-owner', { owner: 'Unknown' }),
      ownerEntity('guests-owner', { owner: 'GUESTS' }),
      ownerEntity('guests-ref-owner', { owner: 'group:default/guests' }),
      ownerEntity('dangling-owner', { owner: 'group:default/ghost-team' }),
      ownerEntity('real-group-owner', { owner: 'group:default/platform' }),
      ownerEntity('real-user-owner', { owner: 'user:default/alice' }),
    ];
    const groups = [groupEntity('any-team', { title: 'Any team', description: 'Owns nothing specific.' })];
    const setup = ownerContext({ entities, groups, existingGroupRefs: ['group:default/platform'] });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    const byName = new Map(facts.map(fact => [fact.entity.name, fact.facts as Record<string, unknown>]));
    expect(byName.size).toBe(6);
    for (const name of ['no-owner-field', 'blank-owner', 'unknown-owner', 'guests-owner', 'guests-ref-owner']) {
      expect(byName.get(name)).toMatchObject({ evaluationStatus: 'evaluated', selection: 'unowned', reason: '' });
    }
    expect(byName.get('dangling-owner')).toMatchObject({ evaluationStatus: 'evaluated', selection: 'owner-not-found', reason: '', checkedOwner: 'group:default/ghost-team' });
    expect(byName.has('real-group-owner')).toBe(false);
    expect(byName.has('real-user-owner')).toBe(false);
    // Written with the same lower-cased canonical form the entity cards query with.
    const unknownFact = facts.find(fact => fact.entity.name === 'unknown-owner')!;
    expect(unknownFact.entity).toEqual({ kind: 'component', namespace: 'default', name: 'unknown-owner' });
  });

  it('writes no fact at all for an entity whose owner merely parses as a Group ref when the existence lookup fails — even a REAL, existing group owner — while unaffected unowned entities still evaluate', async () => {
    const entities = [
      ownerEntity('maybe-dangling', { owner: 'group:default/ghost-team' }),
      ownerEntity('actually-owned', { owner: 'group:default/platform' }),
      ownerEntity('definitely-unowned', { owner: 'unknown' }),
    ];
    const groups = [groupEntity('any-team', { title: 'Any team', description: 'Owns nothing specific.' })];
    // Even though 'actually-owned' really does exist, the lookup that would have confirmed it
    // never completes — proving the retriever never turns "could not check" into a guess in
    // either direction.
    const setup = ownerContext({ entities, groups, resolveThrows: true, existingGroupRefs: ['group:default/platform'] });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    const byName = new Map(facts.map(fact => [fact.entity.name, fact.facts as Record<string, unknown>]));
    expect(byName.has('maybe-dangling')).toBe(false);
    expect(byName.has('actually-owned')).toBe(false);
    expect(byName.get('definitely-unowned')).toMatchObject({ evaluationStatus: 'evaluated', selection: 'unowned' });
    // Logged once, with a count only — never entity content.
    expect(setup.context.logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = (setup.context.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(message)).not.toMatch(/maybe-dangling|actually-owned|ghost-team|platform/);
    expect(meta).toEqual({ skippedCount: 2 });
  });

  it('scans every entity of the configured kinds (not just the first maxEntities), so ownerless entities far into the catalog are still reached', async () => {
    // Entities outside the range are given a real, non-Group owner so they are excluded
    // entirely at scan time (never even a "maybe dangling" candidate) — isolating this test to
    // exactly the 21 truly-ownerless entities, none of which need the separate dangling-Group
    // existence check this fixture's `groups`/`existingGroupRefs` are not exercising here.
    const entities = Array.from({ length: 120 }, (_, index) => ownerEntity(`svc-${index}`, { owner: index >= 90 && index <= 110 ? 'unknown' : 'user:default/owner-team' }));
    const groups = [groupEntity('any-team')];
    const setup = ownerContext({ entities, groups, existingGroupRefs: ['group:default/platform'] });
    // maxEntities is smaller than the total catalog (120) but large enough to hold every
    // ownerless entity (21, at positions 90..110) without any rotation being needed — isolating
    // "were they reached by the scan at all" from windowing/rotation, which the next two tests
    // cover on their own.
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 21 }), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    const names = new Set(facts.map(fact => fact.entity.name));
    expect(names.size).toBe(21);
    for (let index = 90; index <= 110; index++) expect(names.has(`svc-${index}`)).toBe(true);
  });

  it('rotates the window by a full windowSize per day, covering all candidates within ceil(N/W) days (10 entities, window 3 → 4 days)', async () => {
    const entities = Array.from({ length: 10 }, (_, index) => ownerEntity(`svc-${index}`, { owner: 'unknown' }));
    const groups = [groupEntity('any-team')];
    const covered = new Set<string>();
    const perDayCounts = new Map<string, number>();
    for (let day = 0; day < 4; day++) { // ceil(10 / 3) = 4
      const setup = ownerContext({ entities, groups });
      const now = () => day * 86_400_000;
      const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 3 }), 0.8, noneEvaluate, now);
      const facts = await retriever.handler(setup.context as never);
      expect(facts).toHaveLength(3);
      facts.forEach(fact => {
        covered.add(fact.entity.name);
        perDayCounts.set(fact.entity.name, (perDayCounts.get(fact.entity.name) ?? 0) + 1);
      });
    }
    // Every one of the 10 entities appears at least once across the 4-day cycle...
    expect(covered.size).toBe(10);
    // ...and each is evaluated close to once per cycle: 4 days × 3 = 12 slots for 10 entities,
    // so all but the small wrap-around overlap (at most 2 entities) are evaluated exactly once.
    const counts = [...perDayCounts.values()];
    expect(counts.filter(count => count === 1).length).toBeGreaterThanOrEqual(8);
    expect(counts.every(count => count === 1 || count === 2)).toBe(true);
  });

  it('does not step the rotation by a single candidate per day (that would need N days and bill most candidates windowSize times over)', async () => {
    // A regression guard for the original bug: with 500 ownerless candidates and a window of
    // 20, stepping the start by 1 candidate/day would take 500 days to cover everyone, each
    // billed 20 Jev calls in the process. Stepping by the window size instead, day 1 must
    // already select an entirely different, disjoint slice from day 0.
    const entities = Array.from({ length: 500 }, (_, index) => ownerEntity(`svc-${index}`, { owner: 'unknown' }));
    const groups = [groupEntity('any-team')];
    const day0 = ownerContext({ entities, groups });
    const day0Facts = await createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 20 }), 0.8, noneEvaluate, () => 0).handler(day0.context as never);
    const day1 = ownerContext({ entities, groups });
    const day1Facts = await createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 20 }), 0.8, noneEvaluate, () => 86_400_000).handler(day1.context as never);
    const day0Names = new Set(day0Facts.map(fact => fact.entity.name));
    const day1Names = new Set(day1Facts.map(fact => fact.entity.name));
    expect([...day0Names].some(name => day1Names.has(name))).toBe(false);
  });

  it('respects the scan budget: an ownerless entity beyond maxScannedEntities is never selected, regardless of maxEntities', async () => {
    const entities = Array.from({ length: 150 }, (_, index) => ownerEntity(`svc-${index}`, { owner: 'unknown' }));
    const groups = [groupEntity('any-team')];
    const setup = ownerContext({ entities, groups });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 150, maxScannedEntities: 100 }), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(100);
    const names = new Set(facts.map(fact => fact.entity.name));
    for (let index = 100; index < 150; index++) expect(names.has(`svc-${index}`)).toBe(false);
  });

  it('logs a count-only warning when the scan is truncated by maxScannedEntities, and stays silent when it is not', async () => {
    const truncatedEntities = Array.from({ length: 150 }, (_, index) => ownerEntity(`svc-${index}`, { owner: 'unknown' }));
    const truncatedSetup = ownerContext({ entities: truncatedEntities, groups: [groupEntity('any-team')] });
    await createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 150, maxScannedEntities: 100 }), 0.8, noneEvaluate).handler(truncatedSetup.context as never);
    expect(truncatedSetup.context.logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = (truncatedSetup.context.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(message)).not.toMatch(/svc-/);
    expect(meta).toEqual({ scanned: 100, maxScannedEntities: 100 });

    const untruncatedEntities = Array.from({ length: 5 }, (_, index) => ownerEntity(`svc-${index}`, { owner: 'unknown' }));
    const untruncatedSetup = ownerContext({ entities: untruncatedEntities, groups: [groupEntity('any-team')] });
    await createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 5, maxScannedEntities: 100 }), 0.8, noneEvaluate).handler(untruncatedSetup.context as never);
    expect(untruncatedSetup.context.logger.warn).not.toHaveBeenCalled();
  });

  it('resolves dangling group owners with exactly one batched call, scoped to the selected window only', async () => {
    // 8 dangling candidates, but only a 3-entity window is ever selected for evaluation.
    const entities = Array.from({ length: 8 }, (_, index) => ownerEntity(`svc-${index}`, { owner: `group:default/ghost-${index}` }));
    const groups = [groupEntity('any-team')];
    const setup = ownerContext({ entities, groups });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 3 }), 0.8, noneEvaluate, () => 0);

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(3);
    const existenceCalls = setup.fetcher.mock.calls.filter(([, init]) => {
      if ((init as RequestInit | undefined)?.method !== 'POST') return false;
      const body = JSON.parse(String((init as RequestInit).body)) as { entityRefs: string[] };
      return body.entityRefs.every(ref => ref.startsWith('group:'));
    });
    expect(existenceCalls).toHaveLength(1);
    const [, init] = existenceCalls[0];
    const body = JSON.parse(String((init as RequestInit).body)) as { entityRefs: string[] };
    expect(body.entityRefs).toHaveLength(3);
  });

  it('requests exactly one catalog auth token for the whole run, reused across the scan, the dangling-Group check, the entity re-fetch, and the Group candidate pool', async () => {
    const entities = [
      ownerEntity('checkout', { owner: 'unknown' }),
      ownerEntity('search', { owner: 'group:default/ghost-team' }), // exercises the dangling-Group check too
    ];
    const groups = [groupEntity('any-team')];
    const setup = ownerContext({ entities, groups });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(2);
    expect(setup.context.auth.getPluginRequestToken).toHaveBeenCalledTimes(1);
    expect(setup.context.auth.getOwnServiceCredentials).toHaveBeenCalledTimes(1);
  });

  it('bounds the catalog Group candidate page to its configured limit', async () => {
    const entities = Array.from({ length: 5 }, (_, index) => ownerEntity(`svc-${index}`, { owner: 'unknown' }));
    const groups = Array.from({ length: 5 }, (_, index) => groupEntity(`team-${index}`, { title: `Team ${index}` }));
    const setup = ownerContext({ entities, groups });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxEntities: 2, maxGroups: 4 }), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(2);
    const groupsCall = setup.fetcher.mock.calls.find(([url]) => String(url).includes('kind%3DGroup'));
    expect(String(groupsCall![0])).toContain('limit=4');
  });

  it('stores an honest catalog-unavailable fact for the whole window when the full-entity re-fetch itself fails', async () => {
    const entities = [ownerEntity('checkout', { owner: 'unknown' }), ownerEntity('search', { owner: 'guests' })];
    const groups = [groupEntity('any-team')];
    const setup = ownerContext({ entities, groups, entityRefetchThrows: true });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8, noneEvaluate);

    const facts = await retriever.handler(setup.context as never);

    expect(facts).toHaveLength(2);
    for (const fact of facts) expect(fact.facts).toMatchObject({ evaluationStatus: 'not-evaluated', reason: 'catalog-unavailable' });
  });

  it('sends only identity, title, description, tags, kind, type, lifecycle, and system — never documentation content', async () => {
    const target = ownerEntity('checkout', {
      owner: 'unknown',
      title: 'Checkout service',
      description: 'Handles checkout and payments.',
      tags: ['payments', 'checkout'],
      type: 'service',
      lifecycle: 'production',
      system: 'payments-system',
    });
    const groups = [groupEntity('payments-team', { title: 'Payments team', description: 'Owns checkout and billing.' })];
    const setup = ownerContext({ entities: [target], groups });
    let sentText = '';
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8, async request => {
      sentText = request.state.context;
      return ownerEvaluate(request, 'c0');
    });

    await retriever.handler(setup.context as never);

    expect(sentText).toBe([
      'Entity: component:default/checkout',
      'Title: Checkout service',
      'Description: Handles checkout and payments.',
      'Tags: payments, checkout',
      'Kind: Component',
      'Type: service',
      'Lifecycle: production',
      'System: payments-system',
    ].join('\n'));
    expect(sentText).not.toMatch(/npm|runbook|health|rollback/i);
  });

  it('fits a large catalog Group shortlist under the shared budget and reports shortened', async () => {
    const target = ownerEntity('checkout', { owner: 'unknown' });
    const groups = Array.from({ length: 25 }, (_, index) => groupEntity(`team-${index}`, { title: `Team ${index}`, description: 'x'.repeat(1_500) }));
    const setup = ownerContext({ entities: [target], groups });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ maxGroups: 20 }), 0.8, async request => ownerEvaluate(request, 'c0'));

    const facts = await retriever.handler(setup.context as never);

    expect(facts[0].facts).toMatchObject({ evaluationStatus: 'evaluated', shortened: true });
    expect((facts[0].facts as { candidateCount: number }).candidateCount).toBeGreaterThan(0);
    expect((facts[0].facts as { candidateCount: number }).candidateCount).toBeLessThanOrEqual(20);
  });

  it('stores an honest not-evaluated fact, and issues no evaluation, entity re-fetch, or Group read, without a configured evaluator', async () => {
    const target = ownerEntity('checkout', { owner: 'unknown' });
    const setup = ownerContext({ entities: [target], groups: [groupEntity('any-team')] });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8);

    const facts = await retriever.handler(setup.context as never);

    expect(facts[0].facts).toMatchObject({ evaluationStatus: 'not-evaluated', selection: 'unowned', reason: 'jev-not-configured', checkedOwner: 'unknown', suggestedOwnerRef: '', confidence: 0 });
    expect(setup.fetcher.mock.calls.some(([url]) => String(url).includes('kind%3DGroup'))).toBe(false);
    expect(setup.fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('stores an honest not-evaluated fact in demo mode, distinct from an unconfigured install', async () => {
    // Mirrors the readiness retriever exactly: demo mode is why the module's `init` never
    // builds a real evaluator in the first place (see techInsightsModuleJev below), so — like
    // that retriever — this one only needs to know demoMode to pick the right message for
    // "no evaluator was supplied", not to decide whether to call one.
    const target = ownerEntity('checkout', { owner: 'unknown' });
    const setup = ownerContext({ entities: [target], groups: [groupEntity('any-team')] });
    const retriever = createJevOwnerSuggestionFactRetriever(settings({ demoMode: true }), ownerSettings(), 0.8);

    const facts = await retriever.handler(setup.context as never);

    expect(facts[0].facts).toMatchObject({ evaluationStatus: 'not-evaluated', selection: 'unowned', reason: 'jev-demo-mode' });
    expect(setup.fetcher.mock.calls.some(([url]) => String(url).includes('kind%3DGroup'))).toBe(false);
  });

  it('produces the exact fact shape: evaluated with a confident suggestion, and evaluated-but-needs-review with none', async () => {
    const confidentEntity = ownerEntity('checkout', { owner: 'unknown' });
    const uncertainEntity = ownerEntity('search', { owner: 'guests' });
    const groups = [groupEntity('payments-team', { title: 'Payments team', description: 'Owns checkout.' })];
    const setup = ownerContext({ entities: [confidentEntity, uncertainEntity], groups });
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings(), 0.8, async request => {
      const target = request.state.context.includes('checkout') ? 'c0' : 'none';
      return ownerEvaluate(request, target, target === 'c0' ? 0.95 : 0.9);
    });

    const facts = await retriever.handler(setup.context as never);
    const byName = new Map(facts.map(fact => [fact.entity.name, fact.facts as Record<string, unknown>]));

    const confident = byName.get('checkout')!;
    expect(Object.keys(confident).sort()).toEqual([
      'candidateCount', 'checkedOwner', 'confidence', 'evaluatedAt', 'evaluationStatus', 'model',
      'needsReview', 'reason', 'selection', 'shortened', 'suggestedOwnerRef', 'suggestedOwnerTitle',
    ].sort());
    expect(confident).toMatchObject({
      evaluationStatus: 'evaluated', selection: 'unowned', reason: '', checkedOwner: 'unknown', suggestedOwnerRef: 'group:default/payments-team',
      suggestedOwnerTitle: 'Payments team', needsReview: false, candidateCount: 1, shortened: false, model: 'jev-1.13.0',
    });
    expect(confident.confidence).toBeCloseTo(0.95);

    const uncertain = byName.get('search')!;
    expect(uncertain).toMatchObject({ evaluationStatus: 'evaluated', selection: 'unowned', reason: '', checkedOwner: 'guests', suggestedOwnerRef: '', suggestedOwnerTitle: '', needsReview: true });
  });

  it('reports the entity filter as the configured kinds and the retriever id', () => {
    const retriever = createJevOwnerSuggestionFactRetriever(settings(), ownerSettings({ kinds: ['Component', 'Resource'] }), 0.8);
    expect(retriever.id).toBe(jevOwnerSuggestionFactRetrieverId);
    expect(retriever.entityFilter).toEqual([{ kind: ['Component', 'Resource'] }]);
  });
});

describe('buildJevTechInsightsFactRetrievers (module registration)', () => {
  it('always registers the readiness retriever, and additionally the owner-suggestion retriever only when explicitly enabled', () => {
    const disabled = buildJevTechInsightsFactRetrievers(new ConfigReader({}), settings());
    expect(Object.keys(disabled)).toEqual([jevTechInsightsFactRetrieverId]);

    const enabled = buildJevTechInsightsFactRetrievers(
      new ConfigReader({ jevOperationsSupport: { techInsights: { ownerSuggestion: { enabled: true } } } }),
      settings(),
    );
    expect(Object.keys(enabled).sort()).toEqual([jevOwnerSuggestionFactRetrieverId, jevTechInsightsFactRetrieverId].sort());
  });

  it('a malformed setting inside a disabled ownerSuggestion block does not break the always-on readiness retriever', () => {
    const config = new ConfigReader({
      jevOperationsSupport: { techInsights: { ownerSuggestion: { enabled: false, maxEntities: 99_999 } } },
    });
    expect(() => buildJevTechInsightsFactRetrievers(config, settings())).not.toThrow();
    expect(Object.keys(buildJevTechInsightsFactRetrievers(config, settings()))).toEqual([jevTechInsightsFactRetrieverId]);
  });

  it('still throws for a malformed setting once ownerSuggestion is actually enabled', () => {
    const config = new ConfigReader({
      jevOperationsSupport: { techInsights: { ownerSuggestion: { enabled: true, maxEntities: 99_999 } } },
    });
    expect(() => buildJevTechInsightsFactRetrievers(config, settings())).toThrow(/maxEntities/);
  });

  it('still throws when the enabled flag itself is malformed', () => {
    const config = new ConfigReader({
      jevOperationsSupport: { techInsights: { ownerSuggestion: { enabled: 123 as never } } },
    });
    expect(() => buildJevTechInsightsFactRetrievers(config, settings())).toThrow();
  });
});
