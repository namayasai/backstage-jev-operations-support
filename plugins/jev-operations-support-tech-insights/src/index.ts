import { CatalogClient } from '@backstage/catalog-client';
import type { Entity } from '@backstage/catalog-model';
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
  evaluationRequestSchema,
  summarize,
  type EvaluationRequest,
  type Finding,
  type JevRequest,
  type JevResponse,
} from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createJevClient, ProviderError } from '@namayasai/backstage-plugin-jev-operations-support-backend/client';

export const jevTechInsightsFactRetrieverId = 'jevTechInsightsFactRetriever';
export const defaultOptInAnnotation = 'jev.backstage.io/tech-insights';
export const defaultSourceAnnotation = 'jev.backstage.io/tech-insights-source';
export const defaultSourceVisibilityAnnotation = 'jev.backstage.io/tech-insights-source-visibility';

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
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = config?.getOptionalNumber(key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`jevOperationsSupport.techInsights.${key} must be an integer between ${min} and ${max}`);
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
  const getNumber = (key: string, fallback: number, min: number, max: number) => numberSetting(section, key, fallback, min, max);
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

function entityRef(entity: Entity): { namespace: string; kind: string; name: string } {
  return {
    namespace: entity.metadata.namespace ?? 'default',
    kind: entity.kind,
    name: entity.metadata.name,
  };
}

function entityRefString(entity: Entity): string {
  const ref = entityRef(entity);
  return `${ref.kind.toLowerCase()}:${ref.namespace.toLowerCase()}/${ref.name.toLowerCase()}`;
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
        providers.addFactRetrievers({
          [jevTechInsightsFactRetrieverId]: createJevTechInsightsFactRetriever(settings, client?.evaluate),
        });
      },
    });
  },
});

export default techInsightsModuleJev;
