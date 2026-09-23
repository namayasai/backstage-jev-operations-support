import type { Config } from '@backstage/config';
import { parseEntityRef, stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import type { CatalogApi } from '@backstage/catalog-client';
import { isUnownedOwner } from '@namayasai/backstage-plugin-jev-operations-support-common';

/**
 * An administrator-declared link from exact CloudWatch alarm ARNs to one catalog entity
 * and, optionally, the environment those alarms monitor. Bindings are configuration, not
 * inference: nothing here guesses a service from an alarm name, and a reader's own choice
 * on screen is never written back here.
 */
export type ServiceBinding = Readonly<{
  entityRef: string;
  environment?: string;
  alarmArns: readonly string[];
}>;

export const maxServiceBindings = 500;
export const maxAlarmArnsPerBinding = 100;
const maxEnvironmentLength = 64;
const maxLinks = 20;
const maxRelated = 10;

function invalid(index: number, message: string): Error {
  return new Error(`jevOperationsSupport.awsNotifications.serviceBindings[${index}] ${message}`);
}

/** Reads and validates `serviceBindings`; an absent list is an empty one. */
export function readServiceBindings(section: Config): ServiceBinding[] {
  const entries = section.getOptionalConfigArray('serviceBindings') ?? [];
  if (entries.length > maxServiceBindings) {
    throw new Error(`jevOperationsSupport.awsNotifications.serviceBindings must contain at most ${maxServiceBindings} entries`);
  }
  return entries.map((entry, index) => {
    const rawRef = entry.getOptionalString('entityRef')?.trim();
    if (!rawRef) throw invalid(index, 'entityRef must be configured');
    let entityRef: string;
    try {
      // An explicit kind is required: a bare name could silently resolve to the wrong kind.
      entityRef = stringifyEntityRef(parseEntityRef(rawRef));
    } catch {
      throw invalid(index, 'entityRef must be a full entity ref such as component:default/checkout');
    }
    const environment = entry.getOptionalString('environment')?.trim();
    if (environment !== undefined && (!environment || environment.length > maxEnvironmentLength)) {
      throw invalid(index, `environment must be 1-${maxEnvironmentLength} characters when set`);
    }
    const alarmArns = [...new Set((entry.getOptionalStringArray('alarmArns') ?? []).map(arn => arn.trim()))];
    if (alarmArns.length === 0) throw invalid(index, 'alarmArns must not be empty');
    if (alarmArns.length > maxAlarmArnsPerBinding) throw invalid(index, `alarmArns must contain at most ${maxAlarmArnsPerBinding} entries`);
    if (alarmArns.some(arn => !arn.startsWith('arn:') || arn.length > 512)) throw invalid(index, 'alarmArns must contain exact alarm ARNs of at most 512 characters');
    return { entityRef, ...(environment ? { environment } : {}), alarmArns };
  });
}

/** Exact, case-sensitive ARN matching; every binding that lists the ARN applies. */
export function bindingsForAlarm(alarmArn: string, bindings: readonly ServiceBinding[]): ServiceBinding[] {
  return bindings.filter(binding => binding.alarmArns.includes(alarmArn));
}

export type ServiceOwner =
  | { status: 'resolved'; entityRef: string; title?: string }
  /** `spec.owner` is missing or one of the conventional "unowned" values. */
  | { status: 'not-set' }
  /** An owner is named, but the reader cannot load it: it may not exist or not be visible to them. */
  | { status: 'unavailable'; entityRef: string };

export type AlertService =
  | {
    status: 'available';
    entityRef: string;
    environment?: string;
    kind: string;
    title?: string;
    description?: string;
    type?: string;
    lifecycle?: string;
    system?: string;
    dependsOn: string[];
    owner: ServiceOwner;
    links: { url: string; title?: string }[];
  }
  /**
   * Configured, but the catalog returned nothing for this reader. The ref is withheld:
   * a missing entity and one the reader may not see are indistinguishable by design.
   */
  | { status: 'unavailable'; environment?: string };

/**
 * What the read endpoint attaches to one alert. `unbound` (no configuration for this
 * ARN) and `catalog-unavailable` (configured, but the catalog could not be asked) are
 * different facts and are never merged into one "unknown owner" state.
 */
export type AlertServiceContext =
  | { status: 'unbound' }
  | { status: 'catalog-unavailable'; count: number }
  | { status: 'bound'; services: AlertService[] };

type CatalogReader = Pick<CatalogApi, 'getEntitiesByRefs'>;

const serviceFields = [
  'kind', 'metadata.name', 'metadata.namespace', 'metadata.title', 'metadata.description', 'metadata.links',
  'spec.owner', 'spec.system', 'spec.type', 'spec.lifecycle', 'relations',
];
const ownerFields = ['kind', 'metadata.name', 'metadata.namespace', 'metadata.title'];

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function safeRef(ref: string, defaults: { defaultKind?: string; defaultNamespace?: string }): string | undefined {
  try { return stringifyEntityRef(parseEntityRef(ref, defaults)); } catch { return undefined; }
}

function relationTargets(entity: Entity, type: string, kind?: string): string[] {
  return (entity.relations ?? [])
    .filter(relation => relation.type === type && typeof relation.targetRef === 'string')
    .map(relation => relation.targetRef)
    .filter(ref => !kind || ref.toLowerCase().startsWith(`${kind}:`));
}

/** Only absolute http(s) links are passed on; anything else could be a script URL. */
function entityLinks(entity: Entity): { url: string; title?: string }[] {
  const links: { url: string; title?: string }[] = [];
  for (const link of entity.metadata.links ?? []) {
    try {
      const url = new URL(link.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      links.push({ url: url.toString(), ...(text(link.title, 200) ? { title: text(link.title, 200) } : {}) });
    } catch { /* not a URL: skipped */ }
    if (links.length >= maxLinks) break;
  }
  return links;
}

/** The owner ref named by the entity: the resolved `ownedBy` relation first, then `spec.owner`. */
function namedOwner(entity: Entity): string | undefined {
  const related = relationTargets(entity, 'ownedBy')[0];
  if (related) return related;
  const owner = typeof entity.spec?.owner === 'string' ? entity.spec.owner : '';
  if (isUnownedOwner(owner)) return undefined;
  return safeRef(owner, { defaultKind: 'group', defaultNamespace: entity.metadata.namespace ?? 'default' });
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Catalog lookup timed out')), timeoutMs);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Resolves the service context for a page of alerts with the *reader's* catalog token,
 * so the catalog's own permission rules decide what each reader sees. At most two
 * batched catalog reads per page: the bound entities, then their named owners.
 */
export async function resolveAlertServices(options: {
  alarmArns: readonly string[];
  bindings: readonly ServiceBinding[];
  catalog: CatalogReader;
  token: string;
  timeoutMs: number;
}): Promise<Map<string, AlertServiceContext>> {
  const { alarmArns, bindings, catalog, token, timeoutMs } = options;
  const contexts = new Map<string, AlertServiceContext>();
  const matched = new Map<string, ServiceBinding[]>();
  for (const arn of new Set(alarmArns)) {
    const found = bindingsForAlarm(arn, bindings);
    if (found.length) matched.set(arn, found);
    else contexts.set(arn, { status: 'unbound' });
  }
  if (!matched.size) return contexts;

  const refs = [...new Set([...matched.values()].flat().map(binding => binding.entityRef))];
  const entities = new Map<string, Entity>();
  const owners = new Map<string, Entity>();
  let ownerLookupFailed = false;
  try {
    const response = await withTimeout(catalog.getEntitiesByRefs({ entityRefs: refs, fields: serviceFields }, { token }), timeoutMs);
    refs.forEach((ref, index) => { const entity = response.items[index]; if (entity) entities.set(ref, entity); });
  } catch {
    for (const [arn, found] of matched) contexts.set(arn, { status: 'catalog-unavailable', count: found.length });
    return contexts;
  }

  const ownerRefs = [...new Set([...entities.values()].map(namedOwner).filter((ref): ref is string => Boolean(ref)))];
  if (ownerRefs.length) {
    try {
      const response = await withTimeout(catalog.getEntitiesByRefs({ entityRefs: ownerRefs, fields: ownerFields }, { token }), timeoutMs);
      ownerRefs.forEach((ref, index) => { const entity = response.items[index]; if (entity) owners.set(ref, entity); });
    } catch {
      // The service itself is still shown; its owner is reported as not loadable.
      ownerLookupFailed = true;
    }
  }

  const describe = (binding: ServiceBinding): AlertService => {
    const env = binding.environment ? { environment: binding.environment } : {};
    const entity = entities.get(binding.entityRef);
    if (!entity) return { status: 'unavailable', ...env };
    const ownerRef = namedOwner(entity);
    const ownerEntity = ownerRef && !ownerLookupFailed ? owners.get(ownerRef) : undefined;
    const owner: ServiceOwner = !ownerRef ? { status: 'not-set' }
      : ownerEntity ? { status: 'resolved', entityRef: ownerRef, ...(text(ownerEntity.metadata.title, 200) ? { title: text(ownerEntity.metadata.title, 200) } : {}) }
      : { status: 'unavailable', entityRef: ownerRef };
    const system = relationTargets(entity, 'partOf', 'system')[0]
      ?? (typeof entity.spec?.system === 'string' ? safeRef(entity.spec.system, { defaultKind: 'system', defaultNamespace: entity.metadata.namespace ?? 'default' }) : undefined);
    const optional = (key: string, value: string | undefined) => value ? { [key]: value } : {};
    return {
      status: 'available',
      entityRef: binding.entityRef,
      ...env,
      kind: entity.kind,
      ...optional('title', text(entity.metadata.title, 200)),
      ...optional('description', text(entity.metadata.description, 1_000)),
      ...optional('type', text(entity.spec?.type, 100)),
      ...optional('lifecycle', text(entity.spec?.lifecycle, 100)),
      ...optional('system', system),
      dependsOn: [...new Set(relationTargets(entity, 'dependsOn'))].slice(0, maxRelated),
      owner,
      links: entityLinks(entity),
    };
  };
  for (const [arn, found] of matched) contexts.set(arn, { status: 'bound', services: found.map(describe) });
  return contexts;
}
