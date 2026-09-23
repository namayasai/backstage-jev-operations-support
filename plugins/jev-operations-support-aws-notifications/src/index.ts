import { attachResponsePlan, responsePlannerFromConfig, type ResponsePlanner } from '@namayasai/backstage-plugin-jev-operations-support-backend/response-plan';
import { coreServices, createBackendModule, type AuthService, type LoggerService } from '@backstage/backend-plugin-api';
import type { Config, JsonValue } from '@backstage/config';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { CatalogClient } from '@backstage/catalog-client';
import { eventsServiceRef, type EventParams } from '@backstage/plugin-events-node';
import { notificationService, type NotificationSendOptions } from '@backstage/plugin-notifications-node';
import { z } from 'zod';
import {
  awsAlertOwnerErrorCodes,
  buildEvaluation,
  candidateSchema,
  catalogCandidateOrderFields,
  entityToCandidate,
  evaluationRequestByteLength,
  evaluationRequestSchema,
  fitCandidatesToBudget,
  summarize,
  MAX_EVALUATION_BYTES,
  type AwsAlertOwnerErrorCode,
  type Candidate,
  type EvaluationResult,
  type JevRequest,
  type JevResponse,
} from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createJevClient, ProviderError } from '@namayasai/backstage-plugin-jev-operations-support-backend/client';
import { awsAlertNotificationTopic } from './constants';
import { createAwsAlertsRouter } from './router';
import { createAwsAlertDetailsStore } from './store';
import { readServiceBindings, type ServiceBinding } from './serviceBindings';

export const awsAlertEventSubscriberId = 'jev-aws-cloudwatch-alerts';
export { awsAlertNotificationTopic, awsAlertNotificationOrigin, awsMetadataKey } from './constants';
/**
 * Fixed per-process bound on automatic evaluations. It matches the AWS SQS module's
 * maximum receive batch of 10 so an ordinary batch is evaluated rather than mostly
 * skipped. Saturation is reported on the saved alert, never queued.
 */
export const maxConcurrentAwsEvaluations = 10;

const maxSnsMessageBytes = 128_000;

const snsNotificationSchema = z.object({
  Type: z.literal('Notification'),
  MessageId: z.string().trim().min(1).max(200),
  TopicArn: z.string().trim().min(1).max(512),
  Message: z.string().min(1).max(maxSnsMessageBytes),
}).passthrough();

const cloudWatchAlarmSchema = z.object({
  AlarmName: z.string().trim().min(1).max(256),
  AlarmArn: z.string().trim().min(1).max(512),
  NewStateValue: z.enum(['ALARM', 'OK', 'INSUFFICIENT_DATA']),
  NewStateReason: z.string().trim().min(1).max(10_000),
  StateChangeTime: z.string().trim().min(1).max(128),
  Region: z.string().trim().max(128).optional().transform(value => value ?? ''),
  OldStateValue: z.string().trim().max(64).optional().transform(value => value ?? ''),
  AWSAccountId: z.string().trim().max(64).optional().transform(value => value ?? ''),
}).passthrough();

type SnsEnvelope = z.infer<typeof snsNotificationSchema>;
type CloudWatchAlarm = z.infer<typeof cloudWatchAlarmSchema>;
type Evaluate = (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;

/**
 * Owner suggestion is a second, independent Jev call made only for an active
 * (`ALARM`) alert whose incident evaluation succeeded. It is off by default: it
 * doubles provider calls per active alarm and sends catalog Group descriptions to
 * the provider as candidate context.
 */
export type OwnerSuggestionSettings = Readonly<{
  enabled: boolean;
  maxGroups: number;
  cacheSeconds: number;
}>;

export type AwsAlertSettings = Readonly<{
  eventTopic: string;
  allowedTopicArns: string[];
  recipientEntityRefs: string[];
  model: string;
  timeoutMs: number;
  /** Root `jevOperationsSupport.confidenceThreshold`, so automatic and manual checks agree. */
  confidenceThreshold: number;
  /** Root `jevOperationsSupport.demoMode`; automatic evaluation is disabled while it is on. */
  demoMode: boolean;
  ownerSuggestion: OwnerSuggestionSettings;
  /** Exact alarm ARN → catalog entity bindings, applied when alerts are read (never sent to Jev). */
  serviceBindings: ServiceBinding[];
}>;

export type AwsAlertEvaluationStatus = 'evaluated' | 'failed' | 'not-evaluated';

/** Why an alert was saved without a Jev result. Provider failures use `failed` instead. */
export type AwsAlertNotEvaluatedReason =
  | 'jev-not-configured'
  | 'jev-demo-mode'
  | 'evaluation-pending'
  | 'evaluation-capacity-reached'
  | 'alert-context-too-large'
  | 'invalid-alert-context';

export type AwsAlertOwnerStatus = 'evaluated' | 'failed' | 'not-evaluated';

/**
 * Every code the owner suggestion can be stored with. Defined in the common package
 * (`awsAlertOwnerErrorCodes`) and re-exported here for compatibility, so the frontend
 * can import it without reaching into this backend-only package's source (knex,
 * express, ...) from a jsdom test.
 */
export { awsAlertOwnerErrorCodes, type AwsAlertOwnerErrorCode };

/** Loads up to `maxGroups` catalog Group candidates; the real implementation caches and single-flights this. */
export type LoadOwnerGroups = () => Promise<Candidate[]>;

export type AwsAlertBuildOptions = {
  evaluate?: Evaluate;
  /** Recorded when this build intentionally does not call Jev. */
  notEvaluatedReason?: AwsAlertNotEvaluatedReason;
  /** Supplies catalog Group candidates for the owner suggestion call, when enabled. */
  loadGroups?: LoadOwnerGroups;
  /** Reads the currently stored details for a scope, when available (used to preserve a
   * previously evaluated owner suggestion across a redelivered alarm; see `evaluateAlarm`). */
  readDetails?: (scope: string) => Promise<JevAwsAlertDetails | undefined>;
};

/**
 * The structured alert context kept in this module's own table. The standard
 * Notifications backend stores only its own payload fields and discards
 * `payload.metadata`, so this detail cannot live on the notification itself.
 *
 * `ownerStatus`/`ownerResult`/`ownerErrorCode` are present only when
 * `ownerSuggestion.enabled` is configured and the alarm is currently `ALARM`; a
 * disabled install, an unconfigured install, or a resolved/insufficient-data alarm
 * omits all three so its stored rows are indistinguishable from before this
 * feature existed.
 */
export type JevAwsAlertDetails = {
  source: 'aws-cloudwatch';
  context: string;
  awsState: CloudWatchAlarm['NewStateValue'];
  alarmArn: string;
  region: string;
  evaluationStatus: AwsAlertEvaluationStatus;
  result?: JsonValue;
  errorCode?: string;
  ownerStatus?: AwsAlertOwnerStatus;
  ownerResult?: JsonValue;
  /** The shortlist actually sent (titles only), so the frontend can label runner-up
   * candidates in the result's probability breakdown instead of showing raw `c0`/`c1` keys. */
  ownerCandidates?: { id: string; title: string }[];
  /** Set when `fitCandidatesToBudget` shortened descriptions or dropped candidates to fit. */
  ownerShortened?: boolean;
  ownerErrorCode?: string;
  snsMessageId: string;
  topicArn: string;
};

/** A saved alert: the standard notification plus the detail row keyed by its scope. */
export type AwsAlertRecord = {
  scope: string;
  notification: NotificationSendOptions;
  details: JevAwsAlertDetails;
};

function requiredString(config: Config, key: string): string {
  const value = config.getOptionalString(key)?.trim();
  if (!value) throw new Error(`jevOperationsSupport.awsNotifications.${key} must be configured`);
  return value;
}

/** `config` may be absent entirely: an unset `ownerSuggestion` section still gets its defaults. */
function boundedInteger(config: Config | undefined, key: string, fallback: number, min: number, max: number): number {
  const value = config?.getOptionalNumber(key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`jevOperationsSupport.awsNotifications.${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function canonicalRecipient(ref: string): string {
  const parsed = parseEntityRef(ref);
  const kind = parsed.kind.toLowerCase();
  if (kind !== 'user' && kind !== 'group') throw new Error('AWS notification recipients must be user or group entity refs');
  return stringifyEntityRef({ ...parsed, kind });
}

export function readAwsAlertSettings(config: Config): AwsAlertSettings | undefined {
  const section = config.getOptionalConfig('jevOperationsSupport.awsNotifications');
  if (!section) return undefined;

  const eventTopic = requiredString(section, 'eventTopic');
  const allowedTopicArns = section.getOptionalStringArray('allowedTopicArns') ?? [];
  const recipients = section.getOptionalStringArray('recipientEntityRefs') ?? [];
  if (allowedTopicArns.length === 0) throw new Error('jevOperationsSupport.awsNotifications.allowedTopicArns must not be empty');
  if (recipients.length === 0) throw new Error('jevOperationsSupport.awsNotifications.recipientEntityRefs must not be empty');
  if (allowedTopicArns.some(arn => !arn.trim() || arn.length > 512)) throw new Error('AWS SNS TopicArn allowlist contains an invalid value');
  if (recipients.length > 100) throw new Error('AWS notification recipientEntityRefs must contain at most 100 entries');

  const model = section.getOptionalString('model')?.trim() ?? config.getOptionalString('jevOperationsSupport.model')?.trim() ?? 'jev-1.13.0';
  if (!model || model.length > 200) throw new Error('jevOperationsSupport.awsNotifications.model must be a non-empty model ID of at most 200 characters');

  // The root threshold is reused rather than duplicated: an alert evaluated at receipt and
  // the same context re-checked from the workbench must not disagree on what needs review.
  const confidenceThreshold = config.getOptionalNumber('jevOperationsSupport.confidenceThreshold') ?? 0.8;
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error('jevOperationsSupport.confidenceThreshold must be between 0 and 1');
  }

  const ownerSuggestionSection = section.getOptionalConfig('ownerSuggestion');
  const ownerSuggestion: OwnerSuggestionSettings = {
    enabled: ownerSuggestionSection?.getOptionalBoolean('enabled') ?? false,
    maxGroups: boundedInteger(ownerSuggestionSection, 'maxGroups', 20, 1, 20),
    cacheSeconds: boundedInteger(ownerSuggestionSection, 'cacheSeconds', 300, 30, 3_600),
  };

  return {
    eventTopic,
    allowedTopicArns: [...new Set(allowedTopicArns.map(arn => arn.trim()))],
    recipientEntityRefs: [...new Set(recipients.map(canonicalRecipient))],
    model,
    timeoutMs: boundedInteger(section, 'timeoutMs', config.getOptionalNumber('jevOperationsSupport.timeoutMs') ?? 15_000, 1_000, 60_000),
    confidenceThreshold,
    demoMode: config.getOptionalBoolean('jevOperationsSupport.demoMode') ?? false,
    ownerSuggestion,
    serviceBindings: readServiceBindings(section),
  };
}

/**
 * Why receive-time evaluation is off, or `undefined` when it runs. Demo mode wins over a
 * configured key so an installation that declares itself synthetic never calls the provider.
 */
export function automaticEvaluationDisabledReason(
  settings: AwsAlertSettings,
  hasApiKey: boolean,
): AwsAlertNotEvaluatedReason | undefined {
  if (settings.demoMode) return 'jev-demo-mode';
  return hasApiKey ? undefined : 'jev-not-configured';
}

export function parseAwsCloudWatchEvent(
  eventPayload: unknown,
  allowedTopicArns: readonly string[],
): { envelope: SnsEnvelope; alarm: CloudWatchAlarm } | undefined {
  const envelopeResult = snsNotificationSchema.safeParse(eventPayload);
  if (!envelopeResult.success || Buffer.byteLength(envelopeResult.data.Message, 'utf8') > maxSnsMessageBytes) return undefined;
  if (!allowedTopicArns.includes(envelopeResult.data.TopicArn)) return undefined;
  try {
    const message: unknown = JSON.parse(envelopeResult.data.Message);
    const alarmResult = cloudWatchAlarmSchema.safeParse(message);
    return alarmResult.success ? { envelope: envelopeResult.data, alarm: alarmResult.data } : undefined;
  } catch {
    return undefined;
  }
}

const awsRegionCode = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/**
 * CloudWatch sends a display name such as "Asia Pacific (Tokyo)" in `Region` and
 * omits it entirely in some payloads. The alarm ARN carries the stable code, so it
 * is preferred and the alert always has a region to show.
 */
function alarmRegion(alarm: CloudWatchAlarm): string {
  const fromArn = alarm.AlarmArn.split(':')[3]?.trim() ?? '';
  if (awsRegionCode.test(fromArn)) return fromArn;
  return alarm.Region.trim() || 'unknown';
}

function alarmContext(alarm: CloudWatchAlarm): string {
  return [
    `CloudWatch alarm: ${alarm.AlarmName}`,
    `State: ${alarm.NewStateValue}`,
    `Previous state: ${alarm.OldStateValue || 'unknown'}`,
    `Reason: ${alarm.NewStateReason}`,
    `Region: ${alarmRegion(alarm)}`,
    `State change time: ${alarm.StateChangeTime}`,
    `Alarm ARN: ${alarm.AlarmArn}`,
  ].join('\n');
}

function serializableResult(result: EvaluationResult): JsonValue {
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}

type IncidentEvaluation = { status: AwsAlertEvaluationStatus; result?: JsonValue; errorCode?: string };
type OwnerEvaluation = {
  status: AwsAlertOwnerStatus;
  result?: JsonValue;
  errorCode?: AwsAlertOwnerErrorCode;
  candidates?: { id: string; title: string }[];
  shortened?: boolean;
};
type AlarmEvaluation = IncidentEvaluation & { context: string; owner?: OwnerEvaluation };

async function evaluateIncident(context: string, settings: AwsAlertSettings, options: AwsAlertBuildOptions): Promise<IncidentEvaluation> {
  const input = { workflow: 'incident' as const, text: context, candidates: [] };
  const parsed = evaluationRequestSchema.safeParse(input);
  if (!parsed.success) {
    // The alert stays visible; only the provider call is refused, with an explicit reason.
    const oversized = context.length > 16_000 || evaluationRequestByteLength(input) > MAX_EVALUATION_BYTES;
    return { status: 'not-evaluated', errorCode: oversized ? 'alert-context-too-large' : 'invalid-alert-context' };
  }
  if (!options.evaluate) return { status: 'not-evaluated', errorCode: options.notEvaluatedReason ?? 'jev-not-configured' };

  const { request, checks } = buildEvaluation(parsed.data);
  try {
    const response = await options.evaluate(request);
    const result = summarize(parsed.data, response, checks, settings.confidenceThreshold);
    return { status: 'evaluated', result: serializableResult(result) };
  } catch (error) {
    const errorCode = error instanceof ProviderError && error.status === 503 ? 'jev-busy' : 'jev-error';
    return { status: 'failed', errorCode };
  }
}

/**
 * A second Jev call using catalog Group candidates instead of the empty candidate
 * list incident triage uses. It only ever runs for an alarm that is currently
 * `ALARM` and whose incident evaluation already succeeded (both checked by the
 * caller, `evaluateAlarm`, which skips this function entirely otherwise so a
 * resolved alarm or an alarm the incident call could not evaluate carries no
 * owner fields at all): a suggestion is not useful for a resolved alarm, and
 * there is no reliable context to suggest an owner from when incident triage
 * itself could not run.
 *
 * Deliberately shares the capacity slot the caller already holds for incident
 * evaluation rather than claiming a second one of its own: incident and owner
 * evaluation for one alarm are one logical unit of work, not two independent
 * ones competing for the shared pool.
 *
 * Every branch below returns a `not-evaluated` or `failed` status instead of
 * throwing: a failure here must never fail or delay the notification (which is
 * already saved by the time this runs) or the stored incident result.
 */
async function evaluateOwner(
  settings: AwsAlertSettings,
  context: string,
  incidentStatus: AwsAlertEvaluationStatus,
  options: AwsAlertBuildOptions,
): Promise<OwnerEvaluation> {
  if (!options.evaluate) {
    // Mirrors exactly how incident triage reports "no evaluator" for this installation:
    // demo mode, a missing API key, or exhausted capacity disable both calls for the
    // same reason (the capacity case is why `evaluation-capacity-reached` and
    // `evaluation-pending` are in `awsAlertOwnerErrorCodes` despite the owner call
    // never acquiring a capacity slot of its own).
    // `notEvaluatedReason` is only ever set here to one of the installation/capacity
    // reasons below (never `invalid-alert-context`/incident's own `alert-context-too-large`,
    // which are produced only inside `evaluateIncident` itself), so this narrowing holds.
    return { status: 'not-evaluated', errorCode: (options.notEvaluatedReason as AwsAlertOwnerErrorCode | undefined) ?? 'jev-not-configured' };
  }
  if (incidentStatus !== 'evaluated') return { status: 'not-evaluated', errorCode: 'incident-not-evaluated' };

  let groups: Candidate[];
  try {
    groups = options.loadGroups ? await options.loadGroups() : [];
  } catch {
    return { status: 'not-evaluated', errorCode: 'catalog-unavailable' };
  }
  if (groups.length === 0) return { status: 'not-evaluated', errorCode: 'no-catalog-groups' };

  // Shrink or drop candidates to fit the shared byte budget rather than failing on size
  // outright: `alert-context-too-large` is reserved for when the alarm context alone
  // (candidates aside) cannot fit, which cannot happen here because incident triage
  // already evaluated this same context with an empty candidate list.
  const fitted = fitCandidatesToBudget({ workflow: 'ownership', text: context, candidates: groups });
  const input = { workflow: 'ownership' as const, text: context, candidates: fitted.candidates };
  const parsed = evaluationRequestSchema.safeParse(input);
  if (!parsed.success) {
    const oversized = context.length > 16_000 || evaluationRequestByteLength({ workflow: 'ownership', text: context, candidates: [] }) > MAX_EVALUATION_BYTES;
    // Not oversized: fitting shrank candidates down to none (or the schema's own
    // "needs at least one candidate" rule for the `ownership` workflow), which is a
    // different, milder failure than the alarm context itself being too large.
    return { status: 'not-evaluated', errorCode: oversized ? 'alert-context-too-large' : 'invalid-owner-request' };
  }

  try {
    const { request, checks } = buildEvaluation(parsed.data);
    const response = await options.evaluate(request);
    const result = summarize(parsed.data, response, checks, settings.confidenceThreshold);
    return {
      status: 'evaluated',
      result: serializableResult(result),
      // Titles only, for the frontend to label runner-up candidates in the probability
      // breakdown; never the full descriptions, which are not needed again once Jev
      // has already answered and would otherwise duplicate the sent candidate text at rest.
      candidates: fitted.candidates.map(candidate => ({ id: candidate.id, title: candidate.title })),
      shortened: fitted.shortened || fitted.dropped > 0,
    };
  } catch (error) {
    const errorCode = error instanceof ProviderError && error.status === 503 ? 'jev-busy' : 'jev-error';
    return { status: 'failed', errorCode };
  }
}

/**
 * Evaluates incident triage, then (when applicable) the owner suggestion. `onIncidentEvaluated`,
 * when given, runs after incident triage completes but before the (potentially slow: catalog
 * read plus a second provider call) owner call starts — the caller uses it to publish the
 * incident result early, so a reader is not left waiting up to the owner path's own latency
 * budget to see triage that already finished. `willRunOwnerCall` tells that callback whether an
 * owner call is actually about to run (enabled, `ALARM`, and incident evaluated) — the same
 * condition `evaluateOwner` below is reached under, computed once here rather than twice.
 */
async function evaluateAlarm(
  alarm: CloudWatchAlarm,
  settings: AwsAlertSettings,
  options: AwsAlertBuildOptions,
  onIncidentEvaluated?: (incident: IncidentEvaluation, context: string, willRunOwnerCall: boolean) => void | Promise<void>,
): Promise<AlarmEvaluation> {
  const context = alarmContext(alarm);
  const incident = await evaluateIncident(context, settings, options);
  // Disabled installs and a resolved/insufficient-data alarm must not carry any owner
  // field at all, so old rows, disabled installs, and non-ALARM alerts all look
  // identical; only an alarm in the `ALARM` state with the feature configured on
  // attempts the owner call.
  const ownerEnabledForThisAlarm = settings.ownerSuggestion.enabled && alarm.NewStateValue === 'ALARM';
  if (onIncidentEvaluated) await onIncidentEvaluated(incident, context, ownerEnabledForThisAlarm && incident.status === 'evaluated');
  const owner = ownerEnabledForThisAlarm
    ? await evaluateOwner(settings, context, incident.status, options)
    : undefined;
  return { ...incident, context, owner };
}

/**
 * Inbox presentation only. An AWS alarm state is not a customer-impact judgment, so no
 * CloudWatch state is promoted to the critical notification priority.
 */
function notificationPriority(state: CloudWatchAlarm['NewStateValue']): 'high' | 'normal' | 'low' {
  if (state === 'ALARM') return 'high';
  if (state === 'INSUFFICIENT_DATA') return 'normal';
  return 'low';
}

function alertDetails(
  parsed: { envelope: SnsEnvelope; alarm: CloudWatchAlarm },
  evaluation: AlarmEvaluation,
): JevAwsAlertDetails {
  const { envelope, alarm } = parsed;
  return {
    source: 'aws-cloudwatch',
    context: evaluation.context,
    awsState: alarm.NewStateValue,
    alarmArn: alarm.AlarmArn,
    region: alarmRegion(alarm),
    evaluationStatus: evaluation.status,
    ...(evaluation.result ? { result: evaluation.result } : {}),
    ...(evaluation.errorCode ? { errorCode: evaluation.errorCode } : {}),
    ...(evaluation.owner ? {
      ownerStatus: evaluation.owner.status,
      ...(evaluation.owner.result ? { ownerResult: evaluation.owner.result } : {}),
      ...(evaluation.owner.candidates ? { ownerCandidates: evaluation.owner.candidates } : {}),
      ...(evaluation.owner.shortened ? { ownerShortened: true } : {}),
      ...(evaluation.owner.errorCode ? { ownerErrorCode: evaluation.owner.errorCode } : {}),
    } : {}),
    snsMessageId: envelope.MessageId,
    topicArn: envelope.TopicArn,
  };
}

/**
 * The native notification carries only what the Notifications backend stores and
 * shows: the alarm name, its state, and the human alarm reason. It is written once
 * and is never rewritten with machine-readable evaluation state.
 */
function alertRecord(
  parsed: { envelope: SnsEnvelope; alarm: CloudWatchAlarm },
  settings: AwsAlertSettings,
  evaluation: AlarmEvaluation,
): AwsAlertRecord {
  const { envelope, alarm } = parsed;
  const scope = `${settings.eventTopic}:${envelope.MessageId}`;
  return {
    scope,
    details: alertDetails(parsed, evaluation),
    notification: {
      recipients: { type: 'entity', entityRef: settings.recipientEntityRefs },
      payload: {
        title: `[${alarm.NewStateValue}] ${alarm.AlarmName}`,
        description: alarm.NewStateReason,
        severity: notificationPriority(alarm.NewStateValue),
        topic: awsAlertNotificationTopic,
        scope,
      },
    },
  };
}

export async function buildAwsAlertRecord(
  params: EventParams,
  settings: AwsAlertSettings,
  options: AwsAlertBuildOptions = {},
): Promise<AwsAlertRecord | undefined> {
  const parsed = parseAwsCloudWatchEvent(params.eventPayload, settings.allowedTopicArns);
  if (!parsed) return undefined;
  return alertRecord(parsed, settings, await evaluateAlarm(parsed.alarm, settings, options));
}

function createEvaluationCapacity(limit: number) {
  let active = 0;
  return {
    tryAcquire(): boolean {
      if (active >= limit) return false;
      active += 1;
      return true;
    },
    release(): void {
      if (active > 0) active -= 1;
    },
  };
}

export type AwsAlertEventHandlerOptions = {
  settings: AwsAlertSettings;
  send: (notification: NotificationSendOptions) => Promise<void>;
  /** Writes the structured detail for one notification scope into the plugin table. */
  saveDetails: (scope: string, details: JevAwsAlertDetails) => Promise<void>;
  logger: Pick<LoggerService, 'warn' | 'error'>;
  evaluate?: Evaluate;
  maxConcurrent?: number;
  responsePlanner?: ResponsePlanner;
  /** Recorded when no evaluator was supplied, so the alert states why rather than guessing. */
  notEvaluatedReason?: AwsAlertNotEvaluatedReason;
  /** Supplies catalog Group candidates for the owner suggestion call, when enabled. */
  loadGroups?: LoadOwnerGroups;
  /** Reads the currently stored details for a scope; used only to preserve a previously
   * evaluated owner suggestion across a redelivered SNS message (see below). */
  readDetails?: (scope: string) => Promise<JevAwsAlertDetails | undefined>;
};

/**
 * If this delivery's owner attempt ended `failed` or `not-evaluated` but an earlier
 * delivery for the same scope already stored an `evaluated` owner suggestion, keep
 * that earlier suggestion (result, candidates, and shortened flag) rather than
 * overwrite a good suggestion with a transient failure from a redelivered message.
 * Only the owner fields are ever substituted this way; incident semantics — the
 * notification, and the incident `result`/`errorCode` — are never touched here.
 *
 * `existing` must be read *before* this delivery's own pending detail row is
 * written: that pending write already overwrites the scope with a fresh
 * `not-evaluated`/`evaluation-pending` row, so reading "the current stored row"
 * only after evaluating would just read this delivery's own pending write back,
 * never an earlier delivery's result.
 */
function preserveEvaluatedOwner(details: JevAwsAlertDetails, existing: JevAwsAlertDetails | undefined): JevAwsAlertDetails {
  if (!details.ownerStatus || details.ownerStatus === 'evaluated' || existing?.ownerStatus !== 'evaluated') return details;
  const { ownerErrorCode: _droppedOwnerErrorCode, ...withoutOwnerError } = details;
  return {
    ...withoutOwnerError,
    ownerStatus: existing.ownerStatus,
    ...(existing.ownerResult !== undefined ? { ownerResult: existing.ownerResult } : {}),
    ...(existing.ownerCandidates !== undefined ? { ownerCandidates: existing.ownerCandidates } : {}),
    ...(existing.ownerShortened !== undefined ? { ownerShortened: existing.ownerShortened } : {}),
  };
}

/**
 * Saves the standard notification first, then its initial detail row, then evaluates
 * within a fixed per-process bound. Saturation, a disabled evaluator, and a refused
 * context are all recorded as detail state; none of them removes the saved alert.
 */
export function createAwsAlertEventHandler(options: AwsAlertEventHandlerOptions): (params: EventParams) => Promise<void> {
  const { settings, send, saveDetails, logger } = options;
  // One counter for incident evaluation. The owner call, when it runs, shares the same
  // slot the incident call for that alarm already claimed (see `evaluateOwner`); it
  // never claims a second one, so this pool still bounds concurrent *alarms*, not calls.
  const capacity = createEvaluationCapacity(options.maxConcurrent ?? maxConcurrentAwsEvaluations);
  const ownerOptions = { loadGroups: options.loadGroups };
  return async params => {
    const parsed = parseAwsCloudWatchEvent(params.eventPayload, settings.allowedTopicArns);
    if (!parsed) {
      logger.warn('Ignored an AWS event that failed SNS or CloudWatch validation');
      return;
    }
    // Read whatever is currently stored for this scope, if anything, before this
    // delivery's own pending write can overwrite it — needed only to preserve an
    // earlier delivery's evaluated owner suggestion across a redelivered message.
    const scope = `${settings.eventTopic}:${parsed.envelope.MessageId}`;
    const existingDetails = options.readDetails ? await options.readDetails(scope).catch(() => undefined) : undefined;
    // Capacity is claimed before the first write so the stored detail states whether an
    // evaluation is actually going to run. There is no queue: a saturated process
    // records the reason instead.
    const evaluate = options.evaluate && capacity.tryAcquire() ? options.evaluate : undefined;
    const reason: AwsAlertNotEvaluatedReason = !options.evaluate
      ? options.notEvaluatedReason ?? 'jev-not-configured'
      : evaluate ? 'evaluation-pending' : 'evaluation-capacity-reached';
    const pending = await evaluateAlarm(parsed.alarm, settings, { notEvaluatedReason: reason, ...ownerOptions });
    const record = alertRecord(parsed, settings, pending);
    // Every write of the details row — this first, pending one included — goes through
    // preservation: a redelivery that has not even reached the provider yet must not be
    // the write that erases an earlier delivery's already-evaluated owner suggestion.
    record.details = preserveEvaluatedOwner(record.details, existingDetails);
    try {
      // Persist every valid alert before anything else. A provider timeout, an
      // overloaded process, or a failing detail write therefore cannot erase the alert.
      await send(record.notification);
    } catch {
      if (evaluate) capacity.release();
      logger.error('Failed to save an AWS alert notification');
      return;
    }
    try {
      await saveDetails(record.scope, record.details);
    } catch {
      // The alert is visible in the inbox; only its structured context is missing.
      logger.warn('Saved an AWS alert without its structured details');
    }
    if (!evaluate) {
      if (options.evaluate) logger.warn('Saved an AWS alert without an evaluation because the per-process Jev capacity is full');
      return;
    }
    try {
      // A context the shared evaluation schema refuses is already recorded with its own
      // reason; only a pending alert is sent to the provider.
      if (pending.errorCode === 'evaluation-pending') {
        const evaluated = await evaluateAlarm(parsed.alarm, settings, { evaluate, ...ownerOptions }, async (incident, context, willRunOwnerCall) => {
          // The owner path (a catalog read plus a second provider call) can take up to
          // its own latency budget; a reader must not wait that long to see triage that
          // already finished. Only worth the extra write when that path is actually
          // about to run — otherwise the final write below follows immediately anyway.
          if (!willRunOwnerCall) return;
          const incidentOnly: AlarmEvaluation = { ...incident, context, owner: { status: 'not-evaluated', errorCode: 'evaluation-pending' } };
          const incidentDetails = preserveEvaluatedOwner(alertDetails(parsed, incidentOnly), existingDetails);
          try {
            await saveDetails(record.scope, incidentDetails);
          } catch {
            // The alert already carries its pending detail row; only this early triage
            // publish is missing, and the final write below will still supersede it.
            logger.warn('Saved an AWS alert\'s incident result early without its structured detail row');
          }
        });
        // Provider failures arrive here as a `failed` detail, so the outcome is stored
        // either way and the notification itself is never rewritten.
        const finalDetails = preserveEvaluatedOwner(alertDetails(parsed, evaluated), existingDetails);
        if (!settings.demoMode && parsed.alarm.NewStateValue === 'ALARM' && evaluated.status === 'evaluated' && evaluated.result && options.responsePlanner) {
          const result = evaluated.result as unknown as EvaluationResult;
          finalDetails.result = serializableResult({ ...result, responsePlan: { status: 'pending', provider: options.responsePlanner.provider, model: options.responsePlanner.model } });
          // Persist Jev's result before waiting for the second provider. A planning failure must not hide it.
          try { await saveDetails(record.scope, finalDetails); }
          catch { logger.warn('Could not store the intermediate response-planning state'); }
          finalDetails.result = serializableResult(await attachResponsePlan(evaluated.context, result, options.responsePlanner));
        }
        await saveDetails(record.scope, finalDetails);
      }
    } catch {
      // The saved alert is already present; do not turn a Jev or detail write error
      // into an unhandled subscriber failure.
      logger.error('Failed to store the Jev result for a saved AWS alert');
    } finally {
      capacity.release();
    }
  };
}

export {
  awsAlertDetailsMigrationsDirectory,
  awsAlertDetailsRetentionDays,
  awsAlertDetailsTable,
  createAwsAlertDetailsStore,
  createKnexAwsAlertDetailsStore,
  type AwsAlertDetailsStore,
  type StoredAwsAlertDetails,
} from './store';
export {
  bindingsForAlarm,
  readServiceBindings,
  resolveAlertServices,
  type AlertService,
  type AlertServiceContext,
  type ServiceBinding,
  type ServiceOwner,
} from './serviceBindings';
export {
  createAwsAlertsRouter,
  awsAlertsRoutePath,
  defaultAwsAlertPageLimit,
  maxAwsAlertPageLimit,
  maxAwsAlertPageOffset,
} from './router';

/**
 * Fixed floor for the negative-cache window below. A burst of alarms during a catalog
 * outage would otherwise each retry the catalog (or, without single-flight, pile up
 * concurrent in-flight reads against an already-struggling catalog); a short, fixed
 * window bounds that without introducing a configuration knob or risking a real
 * recovery being masked for as long as the (much longer) positive `cacheSeconds`
 * window would.
 */
export const ownerGroupNegativeCacheSeconds = 15;

/**
 * The negative-cache window actually used: at least `ownerGroupNegativeCacheSeconds`,
 * and at least `2 × timeoutMs` (the worst case a single catalog read can occupy an
 * evaluation capacity slot for — the read itself has no abort signal, so a hanging
 * catalog would otherwise let a fresh read start again almost immediately after the
 * 15-second floor, occupying another slot for up to another `timeoutMs` before that
 * one, too, times out). Each alarm that starts a *fresh* read during a real outage
 * still holds its capacity slot for up to `timeoutMs` before the read itself times
 * out and this window begins — the negative cache only prevents *further* alarms
 * from starting further fresh reads during that window, it does not shorten the
 * one already in flight.
 */
export function ownerGroupNegativeCacheSecondsFor(timeoutMs: number): number {
  return Math.max(ownerGroupNegativeCacheSeconds, (2 * timeoutMs) / 1_000);
}

/**
 * Wraps a catalog read with an in-memory cache and single-flight de-duplication:
 * concurrent alarms share one catalog request rather than each alarm in a burst
 * issuing its own. A successful load is cached for `cacheSeconds`; a failed load is
 * cached too, but only for the much shorter `negativeCacheSeconds`
 * (`ownerGroupNegativeCacheSecondsFor`), so a transient failure does not stick around
 * as long as a real answer would, while a sustained outage still cannot cause a
 * pile-up of concurrent catalog reads.
 */
export function createOwnerGroupCache(load: LoadOwnerGroups, cacheSeconds: number, negativeCacheSeconds: number, now: () => number = Date.now): LoadOwnerGroups {
  let cached: { expiresAt: number; groups: Candidate[] } | undefined;
  let failedUntil: number | undefined;
  let inFlight: Promise<Candidate[]> | undefined;
  return async () => {
    if (cached && cached.expiresAt > now()) return cached.groups;
    if (failedUntil !== undefined && failedUntil > now()) {
      throw new Error('The catalog Group read failed recently; retry after the negative-cache window.');
    }
    if (inFlight) return inFlight;
    const promise = load();
    inFlight = promise;
    // Both branches are handled here so this bookkeeping chain never becomes an
    // unhandled rejection; the actual failure still propagates through `promise`,
    // which every caller (this one and any that joined via `inFlight`) awaits.
    promise.then(
      groups => { cached = { groups, expiresAt: now() + cacheSeconds * 1_000 }; failedUntil = undefined; inFlight = undefined; },
      () => { failedUntil = now() + negativeCacheSeconds * 1_000; inFlight = undefined; },
    );
    return promise;
  };
}

/**
 * Bounds a catalog read to `timeoutMs`, the same deadline the Jev client applies
 * to a provider call. `CatalogClient` accepts no abort signal, so the underlying
 * request keeps running in the background; only this caller's wait is bounded.
 * Together with the incident call and the owner Jev call, each independently
 * bounded by `timeoutMs`, the worst case added latency before the final detail
 * row is written is 3 × `timeoutMs`. That never delays the notification itself,
 * which is already saved before any of these three calls starts.
 */
function withCatalogTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Catalog group lookup timed out')), timeoutMs);
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Loads up to `maxGroups` catalog Group entities, in the shared candidate ordering,
 * as validated `Candidate`s. Requests only the entity fields the mapping in
 * `entityToCandidate` actually reads, rather than the whole entity. Each mapped
 * candidate is re-validated against the shared `candidateSchema`: a catalog entity
 * whose long name or namespace produces an over-length id, for instance, is dropped
 * rather than sent to Jev or allowed to fail the whole request. Only the count of
 * dropped candidates is ever logged, never their content.
 */
export function createOwnerGroupLoader(
  catalog: Pick<CatalogClient, 'getEntities'>,
  auth: Pick<AuthService, 'getOwnServiceCredentials' | 'getPluginRequestToken'>,
  maxGroups: number,
  timeoutMs: number,
  logger?: Pick<LoggerService, 'warn'>,
): LoadOwnerGroups {
  return () => withCatalogTimeout((async () => {
    const credentials = await auth.getOwnServiceCredentials();
    const { token } = await auth.getPluginRequestToken({ onBehalfOf: credentials, targetPluginId: 'catalog' });
    const response = await catalog.getEntities({
      filter: { kind: 'Group' },
      // Only the fields `entityToCandidate` reads: the entity ref (kind/namespace/name)
      // plus the title, description, and tags that become the candidate text.
      fields: ['kind', 'metadata.name', 'metadata.namespace', 'metadata.title', 'metadata.description', 'metadata.tags'],
      limit: maxGroups,
      // CatalogClient.getEntities calls this `order`, unlike the frontend catalogApi's
      // `orderFields`; the shape is identical, so the same shared constant is reused.
      order: catalogCandidateOrderFields,
    }, { token });
    const mapped = response.items.map(entityToCandidate);
    const valid: Candidate[] = [];
    let dropped = 0;
    for (const candidate of mapped) {
      const parsed = candidateSchema.safeParse(candidate);
      if (parsed.success) valid.push(parsed.data);
      else dropped += 1;
    }
    if (dropped > 0) logger?.warn(`Dropped ${dropped} catalog Group candidate(s) that failed validation`);
    return valid;
  })(), timeoutMs);
}

export const awsNotificationsModule = createBackendModule({
  pluginId: 'jev-operations-support',
  moduleId: 'aws-cloudwatch-notifications',
  register(reg) {
    reg.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        events: eventsServiceRef,
        notifications: notificationService,
      },
      async init({ config, logger, database, scheduler, discovery, auth, httpAuth, httpRouter, events, notifications }) {
        const settings = readAwsAlertSettings(config);
        if (!settings) {
          logger.info('Jev AWS notification module is inactive: no awsNotifications configuration was provided');
          return;
        }

        const responsePlanner = responsePlannerFromConfig(config);
        const apiKey = config.getOptionalString('jevOperationsSupport.apiKey');
        // Demo mode is a whole-installation statement that no real evaluation happens. A key
        // that is present anyway must not turn a received alert into a live provider call, and
        // a demo fixture must never be stored as if it were a real receive-time result.
        const disabledReason = automaticEvaluationDisabledReason(settings, Boolean(apiKey));
        const client = apiKey && !disabledReason ? createJevClient({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs }) : undefined;
        if (settings.demoMode) logger.info('Jev AWS notification module saves alerts without evaluation: jevOperationsSupport.demoMode is enabled');
        // One plugin-owned table in the host's existing database, created by a single
        // packaged migration. The notification itself stays with the Notifications backend.
        const store = await createAwsAlertDetailsStore(database, { logger });
        await scheduler.scheduleTask({
          id: 'jev-aws-alert-details-retention',
          scope: 'global',
          frequency: { minutes: 5 },
          timeout: { minutes: 1 },
          initialDelay: { minutes: 1 },
          fn: async () => {
            try {
              await store.pruneExpired();
            } catch {
              // Do not log database error bodies, which can include stored details.
              logger.warn('Failed to apply the AWS alert detail retention policy; the next scheduled run will retry');
            }
          },
        });
        const catalogClient = new CatalogClient({ discoveryApi: discovery });
        httpRouter.use(createAwsAlertsRouter({
          httpAuth, auth, discovery, store, logger,
          // Only consulted when bindings are configured; read on behalf of each reader.
          serviceBindings: settings.serviceBindings,
          catalog: catalogClient,
          // Two sequential reads delay the alert list; keep each short so a slow catalog cannot stall it.
          catalogTimeoutMs: Math.min(settings.timeoutMs, 5_000),
        }));
        // Only built when the owner suggestion is enabled: an unconfigured or disabled
        // install never issues the catalog request that backs it.
        const loadGroups = settings.ownerSuggestion.enabled
          ? createOwnerGroupCache(
            createOwnerGroupLoader(catalogClient, auth, settings.ownerSuggestion.maxGroups, settings.timeoutMs, logger),
            settings.ownerSuggestion.cacheSeconds,
            ownerGroupNegativeCacheSecondsFor(settings.timeoutMs),
          )
          : undefined;
        await events.subscribe({
          id: awsAlertEventSubscriberId,
          topics: [settings.eventTopic],
          onEvent: createAwsAlertEventHandler({
            settings,
            logger,
            send: notification => notifications.send(notification),
            saveDetails: (scope, details) => store.save(scope, details),
            // Only wired when owner suggestion is enabled: an install that never uses it
            // must not pay for an extra read on every single alarm. Used only to preserve
            // a previously evaluated owner suggestion across a redelivered SNS message; a
            // failed read here simply skips that preservation.
            readDetails: settings.ownerSuggestion.enabled ? scope => store.read([scope]).then(rows => rows.get(scope)?.details) : undefined,
            evaluate: client?.evaluate,
            notEvaluatedReason: disabledReason,
            responsePlanner,
            loadGroups,
          }),
        });
        logger.info('Jev AWS notification module subscribed to its configured Events topic');
      },
    });
  },
});

export default awsNotificationsModule;
