import { CatalogClient } from '@backstage/catalog-client';
import { parseEntityRef, stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import type { AuthService, LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import {
  techInsightsFactRetrieversExtensionPoint,
  type FactRetriever,
  type TechInsightFact,
  type FactRetrieverContext,
} from '@backstage-community/plugin-tech-insights-node';
import type { FactSchema } from '@backstage-community/plugin-tech-insights-common';
import { DateTime } from 'luxon';
import {
  buildEvaluation,
  candidateSchema,
  catalogCandidateOrderFields,
  defaultUnownedOwnerValues,
  entityToCandidate,
  evaluationRequestSchema,
  fitCandidatesToBudget,
  isUnownedOwner,
  summarize,
  truncateCodePoints,
  type Candidate,
  type EvaluationRequest,
  type Finding,
  type JevOwnerSuggestionReason,
  type JevOwnerSuggestionSelection,
  type JevRequest,
  type JevResponse,
} from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createJevClient, ProviderError } from '@namayasai/backstage-plugin-jev-operations-support-backend/client';

export const jevTechInsightsFactRetrieverId = 'jevTechInsightsFactRetriever';
export const defaultOptInAnnotation = 'jev.backstage.io/tech-insights';
export const defaultSourceAnnotation = 'jev.backstage.io/tech-insights-source';
export const defaultSourceVisibilityAnnotation = 'jev.backstage.io/tech-insights-source-visibility';

/** The second, opt-in fact retriever: see `readJevOwnerSuggestionSettings` and the
 * "Feature A" block near the bottom of this file. */
export const jevOwnerSuggestionFactRetrieverId = 'jevOwnerSuggestionFactRetriever';

const defaultModel = 'jev-1.13.0';
const defaultWorkflow = 'readiness' as const;
const defaultMaxEntities = 50;
const defaultMaxDocumentBytes = 12_000;
const defaultTimeoutMs = 15_000;
const defaultConcurrency = 4;

type Evaluate = (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
export type JevTechInsightsSettings = Readonly<{
  entityRefs: string[];
  targetKinds: string[];
  maxEntities: number;
  maxDocumentBytes: number;
  timeoutMs: number;
  concurrency: number;
  allowPrivateDocuments: boolean;
  model: string;
  workflow: 'readiness';
  /** Root `jevOperationsSupport.demoMode`; the retriever produces not-evaluated facts while it is on. */
  demoMode: boolean;
}>;

export const jevTechInsightsFactSchema: FactSchema = {
  fetchStatus: {
    type: 'string',
    description: 'Whether the opted-in document source was fetched, failed, or was not evaluated.',
  },
  evaluationStatus: {
    type: 'string',
    description: 'Whether Jev evaluated the fetched document, returned an error, or was not called.',
  },
  evidenceStatus: {
    type: 'string',
    description: 'Aggregated evidence status: pass, review, attention, or not-evaluated.',
  },
  passCount: {
    type: 'integer',
    description: 'Number of evaluated checks with pass status.',
  },
  reviewCount: {
    type: 'integer',
    description: 'Number of evaluated checks needing review.',
  },
  attentionCount: {
    type: 'integer',
    description: 'Number of evaluated checks with attention status.',
  },
  checkCount: {
    type: 'integer',
    description: 'Number of checks defined for the workflow.',
  },
  evaluatedCheckCount: {
    type: 'integer',
    description: 'Number of checks represented by evaluated findings.',
  },
  coverage: {
    type: 'float',
    description: 'Fraction of defined checks represented by evaluated findings; this is retrieval coverage, not confidence.',
  },
  workflow: {
    type: 'string',
    description: 'Common Jev workflow used for this fact.',
  },
  model: {
    type: 'string',
    description: 'Jev model reported for the evaluation, or the configured model when not evaluated.',
  },
  source: {
    type: 'string',
    description: 'Sanitized document source URL explicitly selected by the entity annotation.',
  },
  evaluatedAt: {
    type: 'string',
    description: 'ISO 8601 UTC time at which this retrieval produced its result.',
  },
  errorCode: {
    type: 'string',
    description: 'Stable failure code without provider response bodies or document contents.',
  },
};

type Context = Pick<FactRetrieverContext, 'config' | 'discovery' | 'logger' | 'auth' | 'urlReader'>;

type FactResult = {
  fetchStatus: 'fetched' | 'error' | 'not-evaluated';
  evaluationStatus: 'evaluated' | 'error' | 'not-evaluated';
  evidenceStatus: 'pass' | 'review' | 'attention' | 'not-evaluated';
  passCount: number;
  reviewCount: number;
  attentionCount: number;
  checkCount: number;
  evaluatedCheckCount: number;
  coverage: number;
  workflow: 'readiness';
  model: string;
  source: string;
  evaluatedAt: string;
  errorCode: string;
};

function numberSetting(
  config: Config | undefined,
  pathPrefix: string,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = config?.getOptionalNumber(key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${pathPrefix}.${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonEmptyString(value: string | undefined, fallback: string, key: string): string {
  const result = value ?? fallback;
  if (!result.trim() || result.length > 200) {
    throw new Error(`jevOperationsSupport.techInsights.${key} must be a non-empty string of at most 200 characters`);
  }
  return result;
}

export function readJevTechInsightsSettings(config: Config): JevTechInsightsSettings {
  const section = config.getOptionalConfig('jevOperationsSupport.techInsights');
  const getNumber = (key: string, fallback: number, min: number, max: number) => numberSetting(section, 'jevOperationsSupport.techInsights', key, fallback, min, max);
  const entityRefs = section?.getOptionalStringArray('entityRefs') ?? [];
  const targetKinds = section?.getOptionalStringArray('targetKinds') ?? ['Component'];
  if (entityRefs.length > 500) throw new Error('jevOperationsSupport.techInsights.entityRefs must contain at most 500 entries');
  if (targetKinds.length === 0) throw new Error('jevOperationsSupport.techInsights.targetKinds must not be empty');

  return {
    entityRefs,
    targetKinds,
    maxEntities: getNumber('maxEntities', defaultMaxEntities, 1, 500),
    maxDocumentBytes: getNumber('maxDocumentBytes', defaultMaxDocumentBytes, 1_000, 16_000),
    timeoutMs: getNumber('timeoutMs', defaultTimeoutMs, 1_000, 60_000),
    concurrency: getNumber('concurrency', defaultConcurrency, 1, 16),
    allowPrivateDocuments: section?.getOptionalBoolean('allowPrivateDocuments') ?? false,
    model: nonEmptyString(section?.getOptionalString('model') ?? config.getOptionalString('jevOperationsSupport.model'), defaultModel, 'model'),
    workflow: defaultWorkflow,
    demoMode: config.getOptionalBoolean('jevOperationsSupport.demoMode') ?? false,
  };
}

const defaultOwnerSuggestionKinds = ['Component', 'API', 'Resource', 'System'];
const defaultMaxOwnerEntities = 20;
const defaultMaxGroups = 20;
const defaultMaxScannedEntities = 2_000;

export type JevOwnerSuggestionSettings = Readonly<{
  enabled: boolean;
  maxEntities: number;
  kinds: string[];
  /** Compared case-insensitively against `spec.owner`, both as written and as a
   * normalised `group:namespace/name` ref (see the shared `isUnownedOwner`). An
   * empty or missing owner is always treated as unowned regardless of this list. */
  unownedValues: string[];
  maxGroups: number;
  /** Upper bound on how many catalog entities of `kinds` are paged through per run
   * while looking for ownerless ones, before giving up for this run. Keeps a very
   * large catalog from turning one scheduled run into an unbounded catalog scan;
   * see `scanOwnerCandidates` below. */
  maxScannedEntities: number;
}>;

/** Read only the `enabled` flag, so a malformed value elsewhere in a *disabled*
 * `ownerSuggestion` block (e.g. an out-of-range `maxEntities`) cannot prevent the
 * always-on readiness retriever from registering — see `buildJevTechInsightsFactRetrievers`. */
export function readOwnerSuggestionEnabled(config: Config): boolean {
  return config.getOptionalConfig('jevOperationsSupport.techInsights.ownerSuggestion')?.getOptionalBoolean('enabled') ?? false;
}

export function readJevOwnerSuggestionSettings(config: Config): JevOwnerSuggestionSettings {
  const section = config.getOptionalConfig('jevOperationsSupport.techInsights.ownerSuggestion');
  const getNumber = (key: string, fallback: number, min: number, max: number) => numberSetting(section, 'jevOperationsSupport.techInsights.ownerSuggestion', key, fallback, min, max);
  const kinds = section?.getOptionalStringArray('kinds') ?? defaultOwnerSuggestionKinds;
  if (kinds.length === 0) throw new Error('jevOperationsSupport.techInsights.ownerSuggestion.kinds must not be empty');
  const unownedValues = section?.getOptionalStringArray('unownedValues') ?? [...defaultUnownedOwnerValues];

  return {
    enabled: section?.getOptionalBoolean('enabled') ?? false,
    maxEntities: getNumber('maxEntities', defaultMaxOwnerEntities, 1, 50),
    kinds,
    unownedValues,
    maxGroups: getNumber('maxGroups', defaultMaxGroups, 1, 20),
    maxScannedEntities: getNumber('maxScannedEntities', defaultMaxScannedEntities, 100, 20_000),
  };
}

/**
 * The entity ref stored on a `TechInsightFact`, lowercased the same way
 * `stringifyEntityRef` canonicalises a ref (kind, namespace, *and* name).
 * `@backstage-community/plugin-tech-insights-backend` is not installed in this
 * repo, so its internal canonicalisation of this field could not be verified
 * from source; lowercasing here removes any dependency on that assumption, and
 * matches the canonical form the entity cards query with (see
 * `plugins/jev-operations-support/src/entityCards.tsx`).
 */
function entityRef(entity: Entity): { namespace: string; kind: string; name: string } {
  return {
    namespace: (entity.metadata.namespace ?? 'default').toLowerCase(),
    kind: entity.kind.toLowerCase(),
    name: entity.metadata.name.toLowerCase(),
  };
}

function entityRefString(entity: Entity): string {
  const ref = entityRef(entity);
  return `${ref.kind}:${ref.namespace}/${ref.name}`;
}

function hasOptIn(entity: Entity): boolean {
  return entity.metadata.annotations?.[defaultOptInAnnotation]?.trim().toLowerCase() === 'true';
}

function sanitizedSource(rawSource: string): { raw: string; safe: string } | { errorCode: string } {
  try {
    const source = new URL(rawSource);
    if (source.protocol !== 'https:') return { errorCode: 'source-must-use-https' };
    source.username = '';
    source.password = '';
    source.search = '';
    source.hash = '';
    return { raw: rawSource, safe: source.toString() };
  } catch {
    return { errorCode: 'invalid-source-url' };
  }
}

function statusForFindings(findings: Finding[]): Pick<FactResult, 'evidenceStatus' | 'passCount' | 'reviewCount' | 'attentionCount'> {
  const passCount = findings.filter(finding => finding.status === 'pass').length;
  const reviewCount = findings.filter(finding => finding.status === 'review').length;
  const attentionCount = findings.filter(finding => finding.status === 'attention').length;
  const evidenceStatus = attentionCount > 0 ? 'attention' : reviewCount > 0 ? 'review' : 'pass';
  return { evidenceStatus, passCount, reviewCount, attentionCount };
}

function nowIso(): string {
  return DateTime.utc().toISO() ?? new Date().toISOString();
}

function factFor(entity: Entity, settings: JevTechInsightsSettings, result: FactResult): TechInsightFact {
  return {
    entity: entityRef(entity),
    timestamp: DateTime.fromISO(result.evaluatedAt),
    facts: result,
  };
}

function unevaluatedFact(
  entity: Entity,
  settings: JevTechInsightsSettings,
  options: {
    source?: string;
    fetchStatus?: FactResult['fetchStatus'];
    evaluationStatus?: FactResult['evaluationStatus'];
    errorCode: string;
  },
): TechInsightFact {
  const evaluatedAt = nowIso();
  return factFor(entity, settings, {
    fetchStatus: options.fetchStatus ?? 'not-evaluated',
    evaluationStatus: options.evaluationStatus ?? 'not-evaluated',
    evidenceStatus: 'not-evaluated',
    passCount: 0,
    reviewCount: 0,
    attentionCount: 0,
    checkCount: 0,
    evaluatedCheckCount: 0,
    coverage: 0,
    workflow: settings.workflow,
    model: settings.model,
    source: options.source ?? '',
    evaluatedAt,
    errorCode: options.errorCode,
  });
}

/** Demo mode is reported as its own code so a fact is never read as a missing key. */
function noEvaluatorCode(settings: JevTechInsightsSettings): string {
  return settings.demoMode ? 'jev-demo-mode' : 'jev-not-configured';
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isProviderBusy(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 503;
}

class DocumentTooLargeError extends Error {
  constructor() {
    super('Document exceeds the configured size limit');
    this.name = 'DocumentTooLargeError';
  }
}

function timeoutError(): Error {
  const error = new Error('Timed out');
  error.name = 'AbortError';
  return error;
}

/**
 * Races work against a deadline, passes the signal to the work so it can cancel
 * itself, and reports the deadline rather than whatever the cancelled work rejected with.
 */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    if (abort) controller.signal.removeEventListener('abort', abort);
  }
}

async function fetchDocument(
  entity: Entity,
  context: Context,
  settings: JevTechInsightsSettings,
  source: { raw: string; safe: string },
): Promise<{ text: string; safeSource: string } | TechInsightFact> {
  try {
    const buffer = await withTimeout(async signal => {
      const response = await context.urlReader.readUrl(source.raw, { signal });
      if (!response.stream) return response.buffer();
      const stream = response.stream();
      // The deadline must also end the stream; racing it alone would leave the read running.
      const destroy = () => stream.destroy();
      if (signal.aborted) destroy();
      else signal.addEventListener('abort', destroy, { once: true });
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of stream) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += part.byteLength;
          if (total > settings.maxDocumentBytes) throw new DocumentTooLargeError();
          chunks.push(part);
        }
        return Buffer.concat(chunks, total);
      } finally {
        signal.removeEventListener('abort', destroy);
        if (!stream.destroyed) stream.destroy();
      }
    }, settings.timeoutMs);
    if (buffer.byteLength > settings.maxDocumentBytes) throw new DocumentTooLargeError();
    return { text: buffer.toString('utf8'), safeSource: source.safe };
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      return unevaluatedFact(entity, settings, {
        source: source.safe,
        fetchStatus: 'error',
        errorCode: 'document-too-large',
      });
    }
    const errorCode = isTimeout(error) ? 'source-timeout' : 'source-unreadable';
    context.logger.warn('Jev Tech Insights source could not be read', { entityRef: entityRefString(entity), errorCode });
    return unevaluatedFact(entity, settings, {
      source: source.safe,
      fetchStatus: 'error',
      errorCode,
    });
  }
}

async function evaluateDocument(
  entity: Entity,
  settings: JevTechInsightsSettings,
  source: string,
  text: string,
  evaluate: Evaluate | undefined,
  logger: LoggerService,
): Promise<TechInsightFact> {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > settings.maxDocumentBytes || text.length > 16_000) {
    return unevaluatedFact(entity, settings, {
      source,
      fetchStatus: 'error',
      errorCode: 'document-too-large',
    });
  }
  if (!evaluate) {
    return unevaluatedFact(entity, settings, { source, errorCode: noEvaluatorCode(settings) });
  }

  const parsedInput = evaluationRequestSchema.safeParse({ workflow: settings.workflow, text, candidates: [] });
  if (!parsedInput.success) {
    return unevaluatedFact(entity, settings, {
      source,
      fetchStatus: 'fetched',
      errorCode: 'invalid-document',
    });
  }
  const input: EvaluationRequest = parsedInput.data;
  const { request, checks } = buildEvaluation(input);
  let response: JevResponse;
  try {
    // The shared client cancels its own request when this deadline aborts.
    response = await withTimeout(signal => evaluate(request, signal), settings.timeoutMs);
  } catch (error) {
    const errorCode = isTimeout(error) ? 'jev-timeout' : isProviderBusy(error) ? 'jev-busy' : 'jev-error';
    logger.warn('Jev Tech Insights evaluation failed', { entityRef: entityRefString(entity), errorCode });
    return unevaluatedFact(entity, settings, {
      source,
      fetchStatus: 'fetched',
      evaluationStatus: 'error',
      errorCode,
    });
  }

  const result = summarize(input, response, checks);
  const counts = statusForFindings(result.findings);
  return factFor(entity, settings, {
    ...counts,
    fetchStatus: 'fetched',
    evaluationStatus: 'evaluated',
    checkCount: checks.length,
    evaluatedCheckCount: result.findings.length,
    coverage: checks.length === 0 ? 0 : result.findings.length / checks.length,
    workflow: settings.workflow,
    model: result.model.slice(0, 200),
    source,
    evaluatedAt: result.evaluatedAt,
    errorCode: '',
  });
}

async function retrieveEntityFact(
  entity: Entity,
  context: Context,
  settings: JevTechInsightsSettings,
  evaluate: Evaluate | undefined,
): Promise<TechInsightFact | undefined> {
  if (!hasOptIn(entity)) return undefined;
  if (!evaluate) return unevaluatedFact(entity, settings, { errorCode: noEvaluatorCode(settings) });
  const rawSource = entity.metadata.annotations?.[defaultSourceAnnotation]?.trim();
  if (!rawSource) return unevaluatedFact(entity, settings, { errorCode: 'source-not-configured' });

  const parsedSource = sanitizedSource(rawSource);
  if ('errorCode' in parsedSource) return unevaluatedFact(entity, settings, { errorCode: parsedSource.errorCode });

  const visibilityValue = entity.metadata.annotations?.[defaultSourceVisibilityAnnotation]?.trim().toLowerCase() ?? 'private';
  if (visibilityValue !== 'public' && visibilityValue !== 'private') {
    return unevaluatedFact(entity, settings, { source: parsedSource.safe, errorCode: 'invalid-source-visibility' });
  }
  if (visibilityValue === 'private' && !settings.allowPrivateDocuments) {
    return unevaluatedFact(entity, settings, { source: parsedSource.safe, errorCode: 'private-source-not-allowed' });
  }

  const fetched = await fetchDocument(entity, context, settings, parsedSource);
  if ('entity' in fetched) return fetched;
  return evaluateDocument(entity, settings, fetched.safeSource, fetched.text, evaluate, context.logger);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function catalogToken(auth: AuthService): Promise<string> {
  const credentials = await auth.getOwnServiceCredentials();
  return (await auth.getPluginRequestToken({ onBehalfOf: credentials, targetPluginId: 'catalog' })).token;
}

async function getEntities(context: Context, settings: JevTechInsightsSettings): Promise<Entity[]> {
  const catalog = new CatalogClient({ discoveryApi: context.discovery });
  const token = await catalogToken(context.auth);
  if (settings.entityRefs.length > 0) {
    const refs = settings.entityRefs.slice(0, settings.maxEntities);
    if (settings.entityRefs.length > refs.length) {
      context.logger.warn('Jev Tech Insights entityRefs were capped by maxEntities', { maxEntities: settings.maxEntities });
    }
    const response = await catalog.getEntitiesByRefs({ entityRefs: refs, fields: ['apiVersion', 'kind', 'metadata'] }, { token });
    return response.items.filter((entity): entity is Entity => Boolean(entity));
  }

  const annotationKey = `metadata.annotations.${defaultOptInAnnotation}`;
  const response = await catalog.getEntities({
    filter: { kind: settings.targetKinds, [annotationKey]: 'true' },
    fields: ['apiVersion', 'kind', 'metadata'],
    limit: settings.maxEntities + 1,
  }, { token });
  if (response.items.length > settings.maxEntities) {
    context.logger.warn('Jev Tech Insights catalog selection reached maxEntities; remaining entities were skipped', {
      maxEntities: settings.maxEntities,
    });
  }
  return response.items.slice(0, settings.maxEntities);
}

export async function retrieveJevTechInsightsFacts(
  context: Context,
  settings: JevTechInsightsSettings,
  evaluate?: Evaluate,
): Promise<TechInsightFact[]> {
  const entities = await getEntities(context, settings);
  const selected = entities.filter(entity => settings.targetKinds.some(kind => kind.toLowerCase() === entity.kind.toLowerCase()));
  const facts = await mapWithConcurrency(selected, settings.concurrency, async entity => {
    try {
      return await retrieveEntityFact(entity, context, settings, evaluate);
    } catch {
      context.logger.warn('Jev Tech Insights entity evaluation failed before a fact could be produced', {
        entityRef: entityRefString(entity),
        errorCode: 'retriever-error',
      });
      return unevaluatedFact(entity, settings, { errorCode: 'retriever-error' });
    }
  });
  return facts.filter((fact): fact is TechInsightFact => Boolean(fact));
}

export function createJevTechInsightsFactRetriever(
  settings: JevTechInsightsSettings,
  evaluate?: Evaluate,
): FactRetriever {
  return {
    id: jevTechInsightsFactRetrieverId,
    version: '0.1.0',
    title: 'Jev Tech Insights evidence',
    description: 'Evaluates explicitly opted-in document sources with Jev and stores evidence state for Tech Insights checks.',
    entityFilter: [{ kind: settings.targetKinds }],
    schema: jevTechInsightsFactSchema,
    handler: async context => retrieveJevTechInsightsFacts(context, settings, evaluate),
  };
}

/**
 * Feature A: an opt-in second fact retriever that suggests an owner for entities
 * with no real owner. It never writes `spec.owner`; it only stores a suggestion
 * as a Tech Insights fact. It costs at most one Jev provider call per selected
 * ownerless entity per scheduled run (never per document — this retriever reads
 * no documentation), so it is off by default (`ownerSuggestion.enabled`), and it
 * never selects more than `maxEntities` entities per run regardless of how many
 * ownerless entities the catalog actually has (see `scanOwnerCandidates` and
 * `rotateWindow` below for how a catalog with more than `maxEntities` ownerless
 * entities gets covered, a rotating window at a time, across runs).
 */

export const jevOwnerSuggestionFactSchema: FactSchema = {
  evaluationStatus: {
    type: 'string',
    description: 'Whether Jev evaluated an owner suggestion for this entity, failed, or was not called.',
  },
  selection: {
    type: 'string',
    description: 'Why the entity was picked up: unowned, or an owner Group that does not exist in the catalog. Always present, evaluated or not.',
  },
  reason: {
    type: 'string',
    description: 'Why evaluation did not produce a suggestion (installation state, catalog outage, or a provider failure). Empty when evaluationStatus is evaluated.',
  },
  checkedOwner: {
    type: 'string',
    description: 'The raw spec.owner value this row was computed for, empty when the entity had no owner set. Lets a reader confirm the row still matches the entity\'s current owner.',
  },
  suggestedOwnerRef: {
    type: 'string',
    description: 'Catalog ref of the suggested owner Group, empty when Jev found no confident match.',
  },
  suggestedOwnerTitle: {
    type: 'string',
    description: 'Display title of the suggested owner Group, empty when suggestedOwnerRef is empty.',
  },
  confidence: {
    type: 'float',
    description: 'Model confidence in the suggested owner, 0 when not evaluated.',
  },
  needsReview: {
    type: 'boolean',
    description: 'True when the suggestion is low-confidence or Jev found no candidate that fits.',
  },
  candidateCount: {
    type: 'integer',
    description: 'Number of catalog Group candidates actually sent to Jev for this entity.',
  },
  shortened: {
    type: 'boolean',
    description: 'True when candidate descriptions were shortened, or candidates dropped, to fit the shared evaluation budget.',
  },
  model: {
    type: 'string',
    description: 'Jev model reported for the evaluation, or the configured model when not evaluated.',
  },
  evaluatedAt: {
    type: 'string',
    description: 'ISO 8601 UTC time at which this retrieval produced its result.',
  },
};

type OwnerFactResult = {
  evaluationStatus: 'evaluated' | 'failed' | 'not-evaluated';
  selection: JevOwnerSuggestionSelection;
  /** Only ever a failure/not-evaluated code; the empty string when evaluationStatus is
   * 'evaluated' (see `jevOwnerSuggestionReasons` in the common package). */
  reason: JevOwnerSuggestionReason | '';
  checkedOwner: string;
  suggestedOwnerRef: string;
  suggestedOwnerTitle: string;
  confidence: number;
  needsReview: boolean;
  candidateCount: number;
  shortened: boolean;
  model: string;
  evaluatedAt: string;
};

type FactEntityRef = { namespace: string; kind: string; name: string };

function ownerFactFor(ref: FactEntityRef, result: OwnerFactResult): TechInsightFact {
  return { entity: ref, timestamp: DateTime.fromISO(result.evaluatedAt), facts: result };
}

function unevaluatedOwnerFact(
  ref: FactEntityRef,
  selection: JevOwnerSuggestionSelection,
  checkedOwner: string,
  reason: JevOwnerSuggestionReason,
  model: string,
): TechInsightFact {
  return ownerFactFor(ref, {
    evaluationStatus: reason === 'jev-busy' || reason === 'jev-error' || reason === 'jev-timeout' || reason === 'retriever-error' ? 'failed' : 'not-evaluated',
    selection,
    reason,
    checkedOwner,
    suggestedOwnerRef: '',
    suggestedOwnerTitle: '',
    confidence: 0,
    needsReview: false,
    candidateCount: 0,
    shortened: false,
    model,
    evaluatedAt: nowIso(),
  });
}

/** Parses a ref built by `stringifyEntityRef` (always already lower-cased) back into the
 * `{namespace, kind, name}` shape a `TechInsightFact.entity` needs, without a full `Entity`
 * object — used for a not-evaluated fact, which needs only the entity's identity, never its
 * title/description/tags/type/lifecycle/system. */
function factEntityFromRef(ref: string): FactEntityRef {
  const parsed = parseEntityRef(ref);
  return { namespace: parsed.namespace, kind: parsed.kind, name: parsed.name };
}

/** The Group ref an owner points at, or `undefined` when the owner is not a Group reference
 * (a real, non-Group owner, or a value that does not parse as an entity ref at all — neither
 * is treated as a dangling Group, since we cannot confidently say so). */
function ownerGroupRef(raw: string): string | undefined {
  try {
    const parsed = parseEntityRef(raw.trim(), { defaultKind: 'group', defaultNamespace: 'default' });
    if (parsed.kind.toLowerCase() !== 'group') return undefined;
    return stringifyEntityRef({ kind: 'group', namespace: parsed.namespace.toLowerCase(), name: parsed.name });
  } catch {
    return undefined;
  }
}

function ownerString(entity: Entity): string {
  const spec = entity.spec as Record<string, unknown> | undefined;
  const owner = spec?.owner;
  return typeof owner === 'string' ? owner : '';
}

/** A lightweight, ref-only candidate produced while scanning the catalog (see
 * `scanOwnerCandidates`): everything needed to select and rotate a window of ownerless
 * entities, without holding a full `Entity` (title, description, tags, ...) for every entity
 * scanned. */
type ScanCandidate = { ref: string; selection: JevOwnerSuggestionSelection; checkedOwner: string; groupRef?: string };

/** One `CatalogClient` and one auth token, reused for every catalog call a single run of the
 * owner-suggestion retriever makes, instead of each step independently constructing its own
 * client and requesting its own token. */
type CatalogSession = { catalog: CatalogClient; token: string };

async function openCatalogSession(context: Context): Promise<CatalogSession> {
  const catalog = new CatalogClient({ discoveryApi: context.discovery });
  const token = await catalogToken(context.auth);
  return { catalog, token };
}

/**
 * Pages through catalog entities of `kinds` (narrow fields only — kind, name, namespace, and
 * `spec.owner`) with cursor-based pagination (`CatalogClient.queryEntities`, which the
 * `pageInfo.nextCursor` it returns lets this loop follow without recomputing an offset —
 * cursors also remain stable under concurrent catalog writes the way an offset-based page does
 * not), classifying each entity locally into a `ScanCandidate` or dropping it (a real owner,
 * Group or User, is never a candidate), until either every entity of `kinds` has been seen or
 * `maxScannedEntities` have been scanned. Deliberately keeps only refs and the raw owner value
 * in memory — never a full entity record — so scanning a catalog with thousands of entities of
 * these kinds does not hold thousands of full entity payloads at once; only the final rotated
 * window (at most `maxEntities` entities, see `rotateWindow`) is ever re-fetched with full
 * fields, in `resolveWindowEntities` below. This is also why `maxEntities` is no longer applied
 * to the initial catalog page (as an earlier version of this retriever did): an ownerless
 * entity that happened to sort after the first `maxEntities` catalog entities of `kinds` was
 * never reached at all. Now every entity of `kinds` (up to the scan budget) is considered for
 * selection; `maxEntities` only bounds how many *selected* candidates are evaluated in one run.
 */
async function scanOwnerCandidates(
  session: CatalogSession,
  ownerSettings: JevOwnerSuggestionSettings,
): Promise<{ candidates: ScanCandidate[]; scanned: number; truncated: boolean }> {
  const pageSize = 500;
  const fields = ['kind', 'metadata.name', 'metadata.namespace', 'spec.owner'];
  const candidates: ScanCandidate[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  while (scanned < ownerSettings.maxScannedEntities) {
    const limit = Math.min(pageSize, ownerSettings.maxScannedEntities - scanned);
    // filter/orderFields are only valid on the initial request; a cursor request encodes them
    // itself and rejects being given them again (see `QueryEntitiesCursorRequest`).
    const response = await session.catalog.queryEntities(
      cursor
        ? { fields, limit, cursor }
        : { filter: { kind: ownerSettings.kinds }, fields, limit, orderFields: catalogCandidateOrderFields, totalItems: 'exclude' },
      { token: session.token },
    );
    if (response.items.length === 0) break;
    for (const entity of response.items) {
      scanned += 1;
      const checkedOwner = ownerString(entity);
      if (isUnownedOwner(checkedOwner, ownerSettings.unownedValues)) {
        candidates.push({ ref: stringifyEntityRef(entity), selection: 'unowned', checkedOwner });
        continue;
      }
      const groupRef = ownerGroupRef(checkedOwner);
      if (groupRef) candidates.push({ ref: stringifyEntityRef(entity), selection: 'owner-not-found', checkedOwner, groupRef });
      // Else: a real, non-Group owner (or an unparseable value) — owned, never a candidate.
    }
    cursor = response.pageInfo.nextCursor;
    if (!cursor) break; // no further pages
  }
  return { candidates, scanned, truncated: scanned >= ownerSettings.maxScannedEntities };
}

/**
 * Rotates which `windowSize`-sized slice of `candidates` is selected this run, so a catalog
 * with more ownerless-looking entities than `windowSize` still eventually reaches every one of
 * them instead of the same first `windowSize` (in scan order) forever. The starting index
 * advances by exactly `windowSize` candidates per calendar day (UTC), tiling the circular
 * candidate list in contiguous, non-overlapping (aside from the final wrap) blocks: day 0
 * covers `[0, windowSize)`, day 1 covers `[windowSize, 2*windowSize)`, and so on. Because each
 * day's window starts exactly where the previous one ended, `ceil(candidates.length /
 * windowSize)` consecutive days' windows together cover every candidate at least once —
 * regardless of `gcd(windowSize, candidates.length)`, unlike advancing the start by a single
 * candidate per day (which needs `candidates.length` days and bills most candidates
 * `windowSize` times over instead of ~once). `now` is injectable for deterministic tests.
 *
 * Rotation itself advances once per UTC calendar day: a scheduled cadence faster than daily
 * re-evaluates the same window until the day rolls over (see the operator-facing note in
 * `docs/tech-insights.md` and `config.d.ts`).
 */
function rotateWindow<T>(candidates: T[], windowSize: number, now: () => number = Date.now): T[] {
  if (candidates.length <= windowSize) return candidates;
  const daysSinceEpoch = Math.floor(now() / 86_400_000);
  const start = (daysSinceEpoch * windowSize) % candidates.length;
  return Array.from({ length: windowSize }, (_, index) => candidates[(start + index) % candidates.length]);
}

/**
 * Resolves Group existence for exactly the `owner-not-found` candidates in the *selected*
 * window, with one batched `getEntitiesByRefs` call for however many distinct Group refs that
 * window references — never for the whole scan, and never one call per entity.
 *
 * On failure, every `owner-not-found` candidate in the window is dropped entirely — no fact is
 * written for any of them — rather than guessed at with a `catalog-unavailable` row. An owner
 * that merely *parses* as a Group ref may still turn out to be a real, existing owner; writing
 * a row for it would record a claim ("this entity is ownerless") that was never actually
 * confirmed, for an entity that may be perfectly owned. `unowned`-by-value candidates in the
 * window are unaffected: their selection never depended on this lookup.
 */
async function resolveWindowSelection(
  session: CatalogSession,
  window: ScanCandidate[],
): Promise<{ selected: ScanCandidate[]; danglingLookupFailed: boolean; danglingSkipped: number }> {
  const unowned = window.filter(item => item.selection === 'unowned');
  const dangling = window.filter((item): item is ScanCandidate & { groupRef: string } => item.selection === 'owner-not-found');
  if (dangling.length === 0) return { selected: window, danglingLookupFailed: false, danglingSkipped: 0 };

  try {
    const refs = [...new Set(dangling.map(item => item.groupRef))];
    const response = await session.catalog.getEntitiesByRefs({ entityRefs: refs, fields: ['kind', 'metadata.name', 'metadata.namespace'] }, { token: session.token });
    const exists = new Map(refs.map((ref, index) => [ref, Boolean(response.items[index])]));
    const confirmedDangling = dangling.filter(item => exists.get(item.groupRef) !== true);
    return { selected: [...unowned, ...confirmedDangling], danglingLookupFailed: false, danglingSkipped: 0 };
  } catch {
    return { selected: unowned, danglingLookupFailed: true, danglingSkipped: dangling.length };
  }
}

/** Re-fetches full entity records (title, description, tags, type, lifecycle, system — the
 * fields `ownerRequestText` needs) for exactly the confirmed selection, one batched
 * `getEntitiesByRefs` call for the whole (at most `maxEntities`-sized) window. */
async function resolveWindowEntities(session: CatalogSession, refs: string[]): Promise<Map<string, Entity>> {
  const response = await session.catalog.getEntitiesByRefs({
    entityRefs: refs,
    fields: ['apiVersion', 'kind', 'metadata', 'spec.type', 'spec.lifecycle', 'spec.system'],
  }, { token: session.token });
  const found = new Map<string, Entity>();
  refs.forEach((ref, index) => {
    const entity = response.items[index];
    if (entity) found.set(ref, entity);
  });
  return found;
}

/** Fixed-format description sent to Jev: identity, title, description, tags, kind, type,
 * lifecycle, and system. Deliberately excludes documentation content — this retriever never
 * reads TechDocs or any other document source. */
function ownerRequestText(entity: Entity): string {
  const spec = entity.spec as Record<string, unknown> | undefined;
  const lines = [
    `Entity: ${stringifyEntityRef(entity)}`,
    `Title: ${entity.metadata.title ?? entity.metadata.name}`,
    entity.metadata.description ? `Description: ${entity.metadata.description}` : undefined,
    entity.metadata.tags?.length ? `Tags: ${entity.metadata.tags.join(', ')}` : undefined,
    `Kind: ${entity.kind}`,
    typeof spec?.type === 'string' ? `Type: ${spec.type}` : undefined,
    typeof spec?.lifecycle === 'string' ? `Lifecycle: ${spec.lifecycle}` : undefined,
    typeof spec?.system === 'string' ? `System: ${spec.system}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return truncateCodePoints(lines.join('\n'), 4_000);
}

async function evaluateOwnerSuggestion(
  entity: Entity,
  selection: JevOwnerSuggestionSelection,
  checkedOwner: string,
  settings: JevTechInsightsSettings,
  groups: Candidate[],
  evaluate: Evaluate,
  confidenceThreshold: number,
  logger: LoggerService,
): Promise<TechInsightFact> {
  const ref = entityRef(entity);
  if (groups.length === 0) return unevaluatedOwnerFact(ref, selection, checkedOwner, 'no-catalog-groups', settings.model);

  const text = ownerRequestText(entity);
  const fitted = fitCandidatesToBudget({ workflow: 'ownership', text, candidates: groups });
  const input = { workflow: 'ownership' as const, text, candidates: fitted.candidates };
  const parsed = evaluationRequestSchema.safeParse(input);
  if (!parsed.success) return unevaluatedOwnerFact(ref, selection, checkedOwner, 'invalid-owner-request', settings.model);

  const { request, checks } = buildEvaluation(parsed.data);
  let response: JevResponse;
  try {
    response = await withTimeout(signal => evaluate(request, signal), settings.timeoutMs);
  } catch (error) {
    const failureReason: JevOwnerSuggestionReason = isTimeout(error) ? 'jev-timeout' : isProviderBusy(error) ? 'jev-busy' : 'jev-error';
    logger.warn('Jev owner suggestion evaluation failed', { entityRef: entityRefString(entity), reason: failureReason });
    return unevaluatedOwnerFact(ref, selection, checkedOwner, failureReason, settings.model);
  }

  const result = summarize(parsed.data, response, checks, confidenceThreshold);
  const recommendation = result.findings.find(finding => finding.id === 'recommendation');
  // A suggestion is only surfaced when Jev was confident enough to pass, not merely "review".
  const suggested = recommendation?.status === 'pass' ? recommendation.candidate : undefined;
  return ownerFactFor(ref, {
    evaluationStatus: 'evaluated',
    selection,
    reason: '',
    checkedOwner,
    suggestedOwnerRef: suggested?.entityRef ?? '',
    suggestedOwnerTitle: suggested?.title ?? '',
    confidence: recommendation?.confidence ?? 0,
    needsReview: recommendation ? recommendation.status !== 'pass' : true,
    candidateCount: fitted.candidates.length,
    shortened: fitted.shortened || fitted.dropped > 0,
    model: result.model.slice(0, 200),
    evaluatedAt: result.evaluatedAt,
  });
}

/** Loads up to `maxGroups` catalog Group entities as validated candidates, the same mapping
 * and ordering the AWS notifications module's owner suggestion uses, so a Group's text sent
 * to Jev is identical whichever module produced it. */
async function getOwnerCandidateGroups(context: Context, session: CatalogSession, maxGroups: number): Promise<Candidate[]> {
  const response = await session.catalog.getEntities({
    filter: { kind: 'Group' },
    fields: ['kind', 'metadata.name', 'metadata.namespace', 'metadata.title', 'metadata.description', 'metadata.tags'],
    limit: maxGroups,
    order: catalogCandidateOrderFields,
  }, { token: session.token });
  const valid: Candidate[] = [];
  let dropped = 0;
  for (const mapped of response.items.map(entityToCandidate)) {
    const result = candidateSchema.safeParse(mapped);
    if (result.success) valid.push(result.data);
    else dropped += 1;
  }
  if (dropped > 0) context.logger.warn(`Dropped ${dropped} catalog Group candidate(s) that failed validation`);
  return valid;
}

/**
 * Selection first, bound after: scans the catalog for every ownerless-looking entity (up to
 * the scan budget), rotates a `maxEntities`-sized window across runs so a large ownerless
 * population is covered a slice at a time instead of stalling on the same first `maxEntities`
 * forever, resolves that window's dangling-Group candidates with one batched call, then
 * evaluates at most `maxEntities` entities — one Jev provider call each — against one shared
 * Group candidate pool loaded once for the run.
 */
export async function retrieveJevOwnerSuggestionFacts(
  context: Context,
  settings: JevTechInsightsSettings,
  ownerSettings: JevOwnerSuggestionSettings,
  confidenceThreshold: number,
  evaluate?: Evaluate,
  now: () => number = Date.now,
): Promise<TechInsightFact[]> {
  // One CatalogClient and one auth token for every catalog call this run makes (the scan, the
  // dangling-Group existence check, the window's full-entity re-fetch, and the Group candidate
  // pool), rather than each step requesting its own token.
  const session = await openCatalogSession(context);

  const scan = await scanOwnerCandidates(session, ownerSettings);
  if (scan.truncated) {
    // Counts only, no entity content: an entity beyond this bound is never reached by any run
    // (see `maxScannedEntities`'s doc comment on `JevOwnerSuggestionSettings`).
    context.logger.warn('Jev owner suggestion catalog scan reached maxScannedEntities; entities beyond it were not considered this run', {
      scanned: scan.scanned,
      maxScannedEntities: ownerSettings.maxScannedEntities,
    });
  }
  const window = rotateWindow(scan.candidates, ownerSettings.maxEntities, now);
  if (window.length === 0) return [];

  const resolved = await resolveWindowSelection(session, window);
  if (resolved.danglingLookupFailed) {
    // No entity content in this log line — only a count — matching the pattern the readiness
    // retriever and the catalog Group loader above already use for this kind of warning.
    context.logger.warn('Jev owner suggestion could not resolve dangling-Group owners this run; those entities were skipped without a fact', {
      skippedCount: resolved.danglingSkipped,
    });
  }
  if (resolved.selected.length === 0) return [];

  if (!evaluate) {
    const reason = noEvaluatorCode(settings) as JevOwnerSuggestionReason;
    return resolved.selected.map(item => unevaluatedOwnerFact(factEntityFromRef(item.ref), item.selection, item.checkedOwner, reason, settings.model));
  }

  // Loaded once per run, after confirming at least one entity needs a suggestion, and shared
  // across every entity evaluated in this run: one catalog read, not one per entity.
  let groups: Candidate[];
  try {
    groups = await getOwnerCandidateGroups(context, session, ownerSettings.maxGroups);
  } catch {
    // The candidate pool itself could not be read: unlike the dangling-owner lookup above,
    // this failure is not specific to a subset of the window, so every selected entity gets an
    // honest not-evaluated fact instead of being silently dropped.
    return resolved.selected.map(item => unevaluatedOwnerFact(factEntityFromRef(item.ref), item.selection, item.checkedOwner, 'catalog-unavailable', settings.model));
  }

  let entities: Map<string, Entity>;
  try {
    entities = await resolveWindowEntities(session, resolved.selected.map(item => item.ref));
  } catch {
    // Same reasoning as the Group candidate pool above: this failure blocks the whole window's
    // evaluation, not a specific subset of it, so every selected entity gets an honest
    // not-evaluated fact instead of silently producing none at all.
    return resolved.selected.map(item => unevaluatedOwnerFact(factEntityFromRef(item.ref), item.selection, item.checkedOwner, 'catalog-unavailable', settings.model));
  }
  const evaluated = await mapWithConcurrency(resolved.selected, settings.concurrency, async item => {
    const entity = entities.get(item.ref);
    if (!entity) {
      // This one entity in the (successfully read) batch was not found — removed from the
      // catalog between the scan and now: no fact, rather than one built from incomplete data.
      return undefined;
    }
    try {
      return await evaluateOwnerSuggestion(entity, item.selection, item.checkedOwner, settings, groups, evaluate, confidenceThreshold, context.logger);
    } catch {
      context.logger.warn('Jev owner suggestion failed before a fact could be produced', { entityRef: entityRefString(entity), reason: 'retriever-error' });
      return unevaluatedOwnerFact(entityRef(entity), item.selection, item.checkedOwner, 'retriever-error', settings.model);
    }
  });
  return evaluated.filter((fact): fact is TechInsightFact => Boolean(fact));
}

export function createJevOwnerSuggestionFactRetriever(
  settings: JevTechInsightsSettings,
  ownerSettings: JevOwnerSuggestionSettings,
  confidenceThreshold: number,
  evaluate?: Evaluate,
  now?: () => number,
): FactRetriever {
  return {
    id: jevOwnerSuggestionFactRetrieverId,
    // Bumped: the `reason` fact's meaning changed (selection reasons moved to the new
    // `selection` fact) and `checkedOwner` was added.
    version: '0.2.0',
    title: 'Jev owner suggestion',
    description: 'Suggests a responsible catalog Group for entities with no real owner. Never changes spec.owner.',
    entityFilter: [{ kind: ownerSettings.kinds }],
    schema: jevOwnerSuggestionFactSchema,
    handler: async context => retrieveJevOwnerSuggestionFacts(context, settings, ownerSettings, confidenceThreshold, evaluate, now),
  };
}

function readConfidenceThreshold(config: Config): number {
  const value = config.getOptionalNumber('jevOperationsSupport.confidenceThreshold') ?? 0.8;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('jevOperationsSupport.confidenceThreshold must be between 0 and 1');
  return value;
}

/**
 * Builds the full set of fact retrievers this module registers. Exported (rather than inlined
 * in `register`/`init` below) so a test can exercise the "malformed but disabled
 * `ownerSuggestion` block must not break the always-on readiness retriever" guarantee directly
 * against a plain `Config`, without standing up the backend module's `registerInit` machinery.
 */
export function buildJevTechInsightsFactRetrievers(
  config: Config,
  settings: JevTechInsightsSettings,
  evaluate?: Evaluate,
): Record<string, FactRetriever> {
  const retrievers: Record<string, FactRetriever> = {
    [jevTechInsightsFactRetrieverId]: createJevTechInsightsFactRetriever(settings, evaluate),
  };
  // Read only `enabled` first: a malformed value elsewhere in an otherwise-disabled
  // `ownerSuggestion` block (e.g. an out-of-range `maxEntities`) must never take down the
  // always-on readiness retriever above. Only once the feature is actually enabled does the
  // rest of its settings get parsed, and can throw on a real misconfiguration.
  if (readOwnerSuggestionEnabled(config)) {
    const ownerSettings = readJevOwnerSuggestionSettings(config);
    retrievers[jevOwnerSuggestionFactRetrieverId] = createJevOwnerSuggestionFactRetriever(
      settings, ownerSettings, readConfidenceThreshold(config), evaluate,
    );
  }
  return retrievers;
}

export const techInsightsModuleJev = createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'jev-operations-support',
  register(reg) {
    reg.registerInit({
      deps: {
        config: coreServices.rootConfig,
        providers: techInsightsFactRetrieversExtensionPoint,
      },
      async init({ config, providers }) {
        const settings = readJevTechInsightsSettings(config);
        const apiKey = config.getOptionalString('jevOperationsSupport.apiKey');
        // Demo mode disables the provider call even when a key exists: a scheduled retriever
        // must not be the one integration that quietly starts billing a "synthetic" install.
        // The retriever still runs and stores honest not-evaluated facts, never demo fixtures.
        const client = apiKey && !settings.demoMode ? createJevClient({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs }) : undefined;
        providers.addFactRetrievers(buildJevTechInsightsFactRetrievers(config, settings, client?.evaluate));
      },
    });
  },
});

export default techInsightsModuleJev;
