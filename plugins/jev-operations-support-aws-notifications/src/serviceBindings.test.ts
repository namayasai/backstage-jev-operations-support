import type { JsonValue } from '@backstage/types';
import { ConfigReader } from '@backstage/config';
import type { Entity } from '@backstage/catalog-model';
import { describe, expect, it, vi } from 'vitest';
import { readServiceBindings, resolveAlertServices, type ServiceBinding } from './serviceBindings';

const checkoutArn = 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:Checkout5xx';
const sharedArn = 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:SharedLb5xx';

function section(serviceBindings: JsonValue) {
  return new ConfigReader({ serviceBindings });
}

function entity(name: string, overrides: Partial<Entity> & { spec?: Record<string, unknown> } = {}): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name, namespace: 'default', title: `${name} service`, links: [{ url: 'https://runbooks.example.com/checkout', title: 'Runbook' }, { url: 'javascript:alert(1)', title: 'bad' }] },
    spec: { owner: 'group:default/payments', system: 'shop', lifecycle: 'production', type: 'service' },
    relations: [
      { type: 'ownedBy', targetRef: 'group:default/payments' },
      { type: 'partOf', targetRef: 'system:default/shop' },
      { type: 'dependsOn', targetRef: 'resource:default/orders-db' },
    ],
    ...overrides,
  } as Entity;
}

const payments: Entity = { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name: 'payments', namespace: 'default', title: 'Payments' } };

function catalog(entities: Record<string, Entity | undefined>) {
  return {
    getEntitiesByRefs: vi.fn(async ({ entityRefs }: { entityRefs: string[] }, _options?: { token: string }) => ({ items: entityRefs.map(ref => entities[ref]) })),
  };
}

const bindings: ServiceBinding[] = [
  { entityRef: 'component:default/checkout', environment: 'production', alarmArns: [checkoutArn, sharedArn] },
  { entityRef: 'component:default/cart', environment: 'production', alarmArns: [sharedArn] },
];

describe('service binding configuration', () => {
  it('reads bindings with canonical refs and de-duplicated ARNs', () => {
    expect(readServiceBindings(section([{ entityRef: 'Component:default/checkout', environment: ' production ', alarmArns: [checkoutArn, ` ${checkoutArn}`] }])))
      .toEqual([{ entityRef: 'component:default/checkout', environment: 'production', alarmArns: [checkoutArn] }]);
    expect(readServiceBindings(new ConfigReader({}))).toEqual([]);
  });

  it('rejects bindings that could silently resolve to the wrong service', () => {
    expect(() => readServiceBindings(section([{ entityRef: 'checkout', alarmArns: [checkoutArn] }]))).toThrow('serviceBindings[0] entityRef');
    expect(() => readServiceBindings(section([{ entityRef: 'component:default/checkout', alarmArns: [] }]))).toThrow('alarmArns must not be empty');
    expect(() => readServiceBindings(section([{ entityRef: 'component:default/checkout', alarmArns: ['Checkout5xx'] }]))).toThrow('exact alarm ARNs');
    expect(() => readServiceBindings(section([{ entityRef: 'component:default/checkout', environment: 'x'.repeat(65), alarmArns: [checkoutArn] }]))).toThrow('environment');
  });
});

describe('alert service resolution', () => {
  it('describes a bound service with its owner, system, dependencies, and safe links', async () => {
    const reader = catalog({ 'component:default/checkout': entity('checkout'), 'group:default/payments': payments });
    const contexts = await resolveAlertServices({ alarmArns: [checkoutArn], bindings, catalog: reader, token: 'reader-token', timeoutMs: 1_000 });

    expect(contexts.get(checkoutArn)).toEqual({
      status: 'bound',
      services: [{
        status: 'available', entityRef: 'component:default/checkout', environment: 'production', kind: 'Component', title: 'checkout service',
        type: 'service', lifecycle: 'production', system: 'system:default/shop', dependsOn: ['resource:default/orders-db'],
        owner: { status: 'resolved', entityRef: 'group:default/payments', title: 'Payments' },
        links: [{ url: 'https://runbooks.example.com/checkout', title: 'Runbook' }],
      }],
    });
    // Both reads use the reader's token: catalog permissions decide what is returned.
    expect(reader.getEntitiesByRefs).toHaveBeenCalledTimes(2);
    for (const call of reader.getEntitiesByRefs.mock.calls) expect(call[1]).toEqual({ token: 'reader-token' });
  });

  it('keeps unbound, multiple, and inaccessible services distinct without leaking withheld refs', async () => {
    const unboundArn = 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:Other';
    // The reader may see checkout but not cart.
    const reader = catalog({ 'component:default/checkout': entity('checkout'), 'group:default/payments': payments });
    const contexts = await resolveAlertServices({ alarmArns: [unboundArn, sharedArn], bindings, catalog: reader, token: 't', timeoutMs: 1_000 });

    expect(contexts.get(unboundArn)).toEqual({ status: 'unbound' });
    const shared = contexts.get(sharedArn);
    expect(shared?.status).toBe('bound');
    expect(shared?.status === 'bound' && shared.services.map(service => service.status)).toEqual(['available', 'unavailable']);
    expect(JSON.stringify(shared)).not.toContain('cart');
  });

  it('separates a missing owner from an owner the reader cannot load', async () => {
    const unowned = entity('checkout', { relations: [], spec: { owner: 'unknown' } });
    const hiddenOwner = entity('cart', { relations: [], spec: { owner: 'secret-team' } });
    const reader = catalog({ 'component:default/checkout': unowned, 'component:default/cart': hiddenOwner });
    const contexts = await resolveAlertServices({ alarmArns: [sharedArn], bindings, catalog: reader, token: 't', timeoutMs: 1_000 });
    const shared = contexts.get(sharedArn);
    const ownersOf = shared?.status === 'bound' ? shared.services.map(service => service.status === 'available' ? service.owner : undefined) : [];

    expect(ownersOf).toEqual([{ status: 'not-set' }, { status: 'unavailable', entityRef: 'group:default/secret-team' }]);
  });

  it('reports a catalog failure as its own state rather than as unbound or ownerless', async () => {
    const reader = { getEntitiesByRefs: vi.fn(async () => { throw new Error('catalog down'); }) };
    const contexts = await resolveAlertServices({ alarmArns: [sharedArn], bindings, catalog: reader, token: 't', timeoutMs: 1_000 });

    expect(contexts.get(sharedArn)).toEqual({ status: 'catalog-unavailable', count: 2 });
  });

  it('keeps the service when only the owner lookup fails, and bounds a hanging catalog', async () => {
    const reader = {
      getEntitiesByRefs: vi.fn()
        .mockResolvedValueOnce({ items: [entity('checkout')] })
        .mockRejectedValueOnce(new Error('owner read failed')),
    };
    const contexts = await resolveAlertServices({ alarmArns: [checkoutArn], bindings, catalog: reader, token: 't', timeoutMs: 1_000 });
    const bound = contexts.get(checkoutArn);
    expect(bound?.status === 'bound' && bound.services[0].status === 'available' && bound.services[0].owner).toEqual({ status: 'unavailable', entityRef: 'group:default/payments' });

    const hanging = { getEntitiesByRefs: vi.fn(() => new Promise<never>(() => {})) };
    const timedOut = await resolveAlertServices({ alarmArns: [checkoutArn], bindings, catalog: hanging, token: 't', timeoutMs: 20 });
    expect(timedOut.get(checkoutArn)).toEqual({ status: 'catalog-unavailable', count: 1 });
  });

  it('makes no catalog call when no alert on the page is bound', async () => {
    const reader = catalog({});
    await resolveAlertServices({ alarmArns: ['arn:aws:cloudwatch:x:1:alarm:none'], bindings, catalog: reader, token: 't', timeoutMs: 1_000 });
    expect(reader.getEntitiesByRefs).not.toHaveBeenCalled();
  });
});
