import { stringifyEntityRef, parseEntityRef, type Entity } from '@backstage/catalog-model';
import type { CatalogApi } from '@backstage/plugin-catalog-react';
import { catalogCandidateOrderFields, entityToCandidate, type Candidate, type WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';

/** The catalog entity kind each candidate-shortlist workflow chooses from, if any. */
export function candidateKindForWorkflow(workflow: WorkflowId): string | undefined {
  return workflow === 'templates' ? 'Template' : workflow === 'ownership' ? 'Group' : undefined;
}

/**
 * The same shortlist mapping used by every candidate-shortlist workflow: up to `limit`
 * catalog entities as Jev candidates. This delegates to the common package's
 * `entityToCandidate`, which the AWS notifications module's automatic owner-suggestion
 * path (`plugins/jev-operations-support-aws-notifications/src/index.ts`) also uses, so a
 * Group's title and description sent to Jev cannot drift between a manual "Suggest owning
 * team" click here and the automatic suggestion made at alert receipt.
 */
export function candidateFromEntity(entity: Entity): Candidate {
  return entityToCandidate(entity);
}

/** Load up to `limit` catalog entities of a workflow's candidate kind (or all kinds, filtered by `term`) as Jev candidates. */
export async function loadCatalogCandidates(catalog: CatalogApi, workflow: WorkflowId, term: string, limit = 20): Promise<Candidate[]> {
  const kind = candidateKindForWorkflow(workflow);
  const result = await catalog.queryEntities({
    limit,
    ...(kind ? { filter: { kind } } : {}),
    // The same deterministic order (kind, then namespace, then name) the AWS module's
    // owner-suggestion catalog read uses, via the shared common-package constant.
    orderFields: catalogCandidateOrderFields,
    ...(term.trim() ? { fullTextFilter: { term: term.trim(), fields: ['metadata.name', 'metadata.title', 'metadata.description', 'metadata.tags'] } } : {}),
  });
  return result.items.map(candidateFromEntity);
}

const candidateFields = ['kind', 'metadata.name', 'metadata.namespace', 'metadata.title', 'metadata.description', 'metadata.tags'];

function groupOwners(entity: Entity | undefined): string[] {
  return (entity?.relations ?? []).filter(relation => relation.type === 'ownedBy' && relation.targetRef.toLowerCase().startsWith('group:')).map(relation => relation.targetRef.toLowerCase());
}

/**
 * Teams related to one System, read with the reader's own catalog permissions: the System's
 * owning Group first, then the Groups owning entities that are part of it. Returns an empty
 * list when none are visible; the caller then falls back to the general team list and says so.
 */
export async function loadSystemOwnerCandidates(catalog: CatalogApi, systemRef: string, limit = 20): Promise<Candidate[]> {
  const ref = stringifyEntityRef(parseEntityRef(systemRef, { defaultKind: 'system' })).toLowerCase();
  const [system, parts] = await Promise.all([
    catalog.getEntityByRef(ref),
    catalog.queryEntities({ filter: { 'relations.partOf': ref }, fields: ['relations'], limit: 100 }),
  ]);
  const owners = [...new Set([...groupOwners(system), ...parts.items.flatMap(groupOwners)])].slice(0, limit);
  if (!owners.length) return [];
  const { items } = await catalog.getEntitiesByRefs({ entityRefs: owners, fields: candidateFields });
  return items.filter((entity): entity is Entity => Boolean(entity)).map(candidateFromEntity);
}
