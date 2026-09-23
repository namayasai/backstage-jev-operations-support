import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import { createAwsAlertsRouter } from './router';
import type { AwsAlertDetailsStore, StoredAwsAlertDetails } from './store';
import type { JevAwsAlertDetails } from './index';
import type { ServiceBinding } from './serviceBindings';

const ana = { principal: { type: 'user', userEntityRef: 'user:default/ana' } } as unknown as BackstageCredentials;
const notificationsBaseUrl = 'http://backstage.internal/api/notifications';

function details(overrides: Partial<JevAwsAlertDetails> = {}): JevAwsAlertDetails {
  return {
    source: 'aws-cloudwatch',
    context: 'CloudWatch alarm: Checkout5xx\nState: ALARM',
    awsState: 'ALARM',
    alarmArn: 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:Checkout5xx',
    region: 'ap-northeast-1',
    evaluationStatus: 'evaluated',
    result: { workflow: 'incident', findings: [] },
    snsMessageId: 'message-001',
    topicArn: 'arn:aws:sns:ap-northeast-1:123456789012:alerts',
    ...overrides,
  };
}

/**
 * The real Backstage Notifications response: it stores its own payload fields and
 * returns no `metadata` at all, which is why the details live in the plugin table.
 */
function nativeRow(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    id: 'notification-1',
    user: 'user:default/ana',
    created: '2026-09-19T10:00:00.000Z',
    origin: 'plugin:jev-operations-support',
    payload: {
      title: '[ALARM] Checkout5xx',
      description: 'The threshold was crossed',
      severity: 'high',
      topic: 'jev-aws-alerts',
      scope: 'aws-cloudwatch:message-001',
      ...payload,
    },
    ...overrides,
  };
}

function memoryStore(rows: Record<string, JevAwsAlertDetails>): AwsAlertDetailsStore & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async (scopes: readonly string[]) => {
    const stored = new Map<string, StoredAwsAlertDetails>();
    for (const scope of scopes) if (rows[scope]) stored.set(scope, { details: rows[scope], updatedAt: '2026-09-19T10:00:05.000Z' });
    return stored;
  });
  return { read, save: vi.fn() };
}

function harness(options: {
  store?: AwsAlertDetailsStore & { read?: ReturnType<typeof vi.fn> };
  credentials?: () => Promise<BackstageCredentials>;
  respond?: (url: URL, init?: RequestInit) => Response;
  serviceBindings?: ServiceBinding[];
  catalog?: { getEntitiesByRefs: ReturnType<typeof vi.fn> };
} = {}) {
  const store = options.store ?? memoryStore({ 'aws-cloudwatch:message-001': details() });
  const fetchCalls: Array<{ url: URL; init?: RequestInit }> = [];
  const getPluginRequestToken = vi.fn(async ({ onBehalfOf }: { onBehalfOf: BackstageCredentials; targetPluginId: string }) => ({
    token: `plugin-token-for-${(onBehalfOf.principal as { userEntityRef: string }).userEntityRef}`,
  }));
  const logger = { warn: vi.fn(), error: vi.fn() };
  const app = express().use(createAwsAlertsRouter({
    httpAuth: { credentials: options.credentials ?? (async () => ana) } as never,
    auth: { getPluginRequestToken } as never,
    discovery: { getBaseUrl: async () => notificationsBaseUrl },
    store,
    logger,
    serviceBindings: options.serviceBindings,
    catalog: options.catalog as never,
    fetch: (async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      fetchCalls.push({ url, init });
      return options.respond
        ? options.respond(url, init)
        : new Response(JSON.stringify({ totalCount: 1, notifications: [nativeRow()] }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch,
  }));
  return { app, store, fetchCalls, getPluginRequestToken, logger };
}

describe('AWS alert read endpoint', () => {
  it('reads the signed-in user\'s own notifications and restores their stored details', async () => {
    const { app, fetchCalls, getPluginRequestToken } = harness();

    const response = await request(app).get('/aws-alerts?limit=5&offset=10');

    expect(response.status).toBe(200);
    expect(getPluginRequestToken).toHaveBeenCalledWith({ onBehalfOf: ana, targetPluginId: 'notifications' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url.toString()).toBe(`${notificationsBaseUrl}?topic=jev-aws-alerts&limit=5&offset=10`);
    expect((fetchCalls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer plugin-token-for-user:default/ana');
    // The same page shape as the Notifications API, with the metadata restored.
    expect(response.body.totalCount).toBe(1);
    expect(response.body.notifications[0]).toMatchObject({ id: 'notification-1', created: '2026-09-19T10:00:00.000Z', origin: 'plugin:jev-operations-support' });
    expect(response.body.notifications[0].payload).toMatchObject({ title: '[ALARM] Checkout5xx', description: 'The threshold was crossed', topic: 'jev-aws-alerts', scope: 'aws-cloudwatch:message-001' });
    expect(response.body.notifications[0].payload.metadata.jevOperationsSupport).toMatchObject({ ...details(), updatedAt: '2026-09-19T10:00:05.000Z' });
  });

  it('restores the owner suggestion fields alongside the incident result, when stored', async () => {
    const store = memoryStore({
      'aws-cloudwatch:message-001': details({
        ownerStatus: 'evaluated',
        ownerResult: { workflow: 'ownership', findings: [] },
      }),
    });
    const { app } = harness({ store });

    const response = await request(app).get('/aws-alerts');

    expect(response.body.notifications[0].payload.metadata.jevOperationsSupport).toMatchObject({
      ownerStatus: 'evaluated',
      ownerResult: { workflow: 'ownership', findings: [] },
    });
  });

  it('applies the fixed topic, origin, and page bounds instead of anything the caller supplies', async () => {
    const store = memoryStore({
      'aws-cloudwatch:message-001': details(),
      'aws-cloudwatch:other-plugin': details({ context: 'not this one' }),
      'aws-cloudwatch:message-bob': details({ context: 'bob only' }),
    });
    const { app, fetchCalls } = harness({
      store,
      respond: () => new Response(JSON.stringify({
        totalCount: 3,
        notifications: [
          nativeRow(),
          // Another plugin publishing into the same topic must not read this table.
          nativeRow({ id: 'notification-2', origin: 'plugin:other' }, { scope: 'aws-cloudwatch:other-plugin' }),
          nativeRow({ id: 'notification-3' }, { topic: 'other-topic', scope: 'aws-cloudwatch:other-plugin' }),
        ],
      })),
    });

    const response = await request(app).get('/aws-alerts?scope=aws-cloudwatch:message-bob&id=notification-9&topic=anything');

    expect(fetchCalls[0].url.toString()).toBe(`${notificationsBaseUrl}?topic=jev-aws-alerts&limit=20&offset=0`);
    expect(response.body.notifications.map((row: { id: string }) => row.id)).toEqual(['notification-1']);
    // Only scopes that came back from the user's own authorized page were looked up.
    expect(store.read).toHaveBeenCalledWith(['aws-cloudwatch:message-001']);
  });

  it('cannot expose another user\'s stored details', async () => {
    const store = memoryStore({ 'aws-cloudwatch:message-bob': details({ context: 'bob only' }) });
    // The Notifications backend answers for the calling identity only; ana never sees bob's row.
    const { app } = harness({ store, respond: () => new Response(JSON.stringify({ totalCount: 0, notifications: [] })) });

    const response = await request(app).get('/aws-alerts');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ totalCount: 0, notifications: [] });
    expect(store.read).toHaveBeenCalledWith([]);
    expect(JSON.stringify(response.body)).not.toContain('bob only');
  });

  it('requires a user principal and never queries Notifications otherwise', async () => {
    const unauthenticated = harness({ credentials: async () => { throw Object.assign(new Error('no credentials'), { name: 'AuthenticationError' }); } });
    const serviceCall = harness({ credentials: async () => { throw Object.assign(new Error('service principal'), { name: 'NotAllowedError' }); } });

    expect((await request(unauthenticated.app).get('/aws-alerts')).status).toBe(401);
    expect((await request(serviceCall.app).get('/aws-alerts')).status).toBe(403);
    expect(unauthenticated.fetchCalls).toHaveLength(0);
    expect(serviceCall.fetchCalls).toHaveLength(0);
    expect(unauthenticated.store.read).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range or non-numeric page', async () => {
    const { app, fetchCalls } = harness();

    for (const query of ['limit=0', 'limit=51', 'limit=abc', 'offset=-1', 'offset=100000', 'limit=5&limit=6']) {
      expect((await request(app).get(`/aws-alerts?${query}`)).status).toBe(400);
    }
    expect((await request(app).get('/aws-alerts?limit=50&offset=10000')).status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
  });

  it('keeps an alert visible when its details are missing or unreadable', async () => {
    const store = memoryStore({});
    const { app } = harness({ store });

    const response = await request(app).get('/aws-alerts');

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].payload.title).toBe('[ALARM] Checkout5xx');
    expect(response.body.notifications[0].payload.metadata).toBeUndefined();
  });

  it('keeps alerts visible when the detail store itself fails', async () => {
    const store = { save: vi.fn(), read: vi.fn(async () => { throw new Error('database unavailable'); }) };
    const { app, logger } = harness({ store });

    const response = await request(app).get('/aws-alerts');

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].payload.metadata).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports a failing or unreadable Notifications backend without inventing alerts', async () => {
    const failing = harness({ respond: () => new Response('nope', { status: 500 }) });
    const malformed = harness({ respond: () => new Response('<html>not json</html>', { status: 200 }) });

    const failure = await request(failing.app).get('/aws-alerts');
    const garbage = await request(malformed.app).get('/aws-alerts');

    expect(failure.status).toBe(502);
    expect(failure.body.error).toContain('HTTP 500');
    expect(garbage.status).toBe(502);
    expect(failing.logger.warn).toHaveBeenCalled();
  });

  it('attaches service context read with the reader\'s own catalog token, only when bindings are configured', async () => {
    const arn = details().alarmArn;
    const catalog = { getEntitiesByRefs: vi.fn(async ({ entityRefs }: { entityRefs: string[] }) => ({ items: entityRefs.map(() => undefined) })) };
    const bound = harness({ catalog, serviceBindings: [{ entityRef: 'component:default/checkout', environment: 'production', alarmArns: [arn] }] });

    const response = await request(bound.app).get('/aws-alerts');

    expect(bound.getPluginRequestToken).toHaveBeenCalledWith({ onBehalfOf: ana, targetPluginId: 'catalog' });
    expect(catalog.getEntitiesByRefs).toHaveBeenCalledWith(expect.objectContaining({ entityRefs: ['component:default/checkout'] }), { token: 'plugin-token-for-user:default/ana' });
    // Not visible to this reader: reported as unavailable, with the configured ref withheld.
    expect(response.body.notifications[0].payload.metadata.jevOperationsSupport.service).toEqual({ status: 'bound', services: [{ status: 'unavailable', environment: 'production' }] });
    expect(JSON.stringify(response.body)).not.toContain('component:default/checkout');

    const unconfigured = harness({ catalog });
    const plain = await request(unconfigured.app).get('/aws-alerts');
    expect(plain.body.notifications[0].payload.metadata.jevOperationsSupport.service).toBeUndefined();
  });

  it('still returns alerts when the catalog cannot be read for service context', async () => {
    const catalog = { getEntitiesByRefs: vi.fn(async () => { throw new Error('catalog down'); }) };
    const { app, logger } = harness({ catalog, serviceBindings: [{ entityRef: 'component:default/checkout', alarmArns: [details().alarmArn] }] });

    const response = await request(app).get('/aws-alerts');

    expect(response.status).toBe(200);
    expect(response.body.notifications[0].payload.metadata.jevOperationsSupport.service).toEqual({ status: 'catalog-unavailable', count: 1 });
    expect(logger.warn).toHaveBeenCalled();
  });
});
