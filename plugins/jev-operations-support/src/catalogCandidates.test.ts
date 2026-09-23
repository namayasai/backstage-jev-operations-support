import { describe, expect, it, vi } from 'vitest';
import type { CatalogApi } from '@backstage/plugin-catalog-react';
import { loadSystemOwnerCandidates } from './catalogCandidates';

function group(name: string) {
  return { apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name, namespace: 'default', title: name.toUpperCase() } };
}

describe('System-scoped owner candidates', () => {
  it('lists the System owner first, then the owners of its parts, de-duplicated and Groups only', async () => {
    const catalog = {
      getEntityByRef: vi.fn(async () => ({ relations: [{ type: 'ownedBy', targetRef: 'group:default/platform' }] })),
      queryEntities: vi.fn(async () => ({ items: [
        { relations: [{ type: 'ownedBy', targetRef: 'group:default/payments' }] },
        { relations: [{ type: 'ownedBy', targetRef: 'group:default/platform' }] },
        { relations: [{ type: 'ownedBy', targetRef: 'user:default/ana' }] },
      ] })),
      getEntitiesByRefs: vi.fn(async ({ entityRefs }: { entityRefs: string[] }) => ({ items: entityRefs.map(ref => ref === 'group:default/payments' ? undefined : group(ref.split('/')[1])) })),
    };

    const candidates = await loadSystemOwnerCandidates(catalog as unknown as CatalogApi, 'System:default/Shop');

    expect(catalog.getEntityByRef).toHaveBeenCalledWith('system:default/shop');
    expect(catalog.queryEntities).toHaveBeenCalledWith(expect.objectContaining({ filter: { 'relations.partOf': 'system:default/shop' } }));
    expect(catalog.getEntitiesByRefs.mock.calls[0][0].entityRefs).toEqual(['group:default/platform', 'group:default/payments']);
    // A Group the reader cannot load is simply not a candidate.
    expect(candidates.map(candidate => candidate.entityRef)).toEqual(['group:default/platform']);
  });

  it('returns no candidates without asking for Groups when nothing related is visible', async () => {
    const catalog = { getEntityByRef: vi.fn(async () => undefined), queryEntities: vi.fn(async () => ({ items: [] })), getEntitiesByRefs: vi.fn() };
    expect(await loadSystemOwnerCandidates(catalog as unknown as CatalogApi, 'system:default/shop')).toEqual([]);
    expect(catalog.getEntitiesByRefs).not.toHaveBeenCalled();
  });
});
