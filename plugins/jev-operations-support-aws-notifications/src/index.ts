import { coreServices, createBackendModule, type LoggerService } from '@backstage/backend-plugin-api';
import type { Config, JsonValue } from '@backstage/config';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { eventsServiceRef, type EventParams } from '@backstage/plugin-events-node';
import { notificationService, type NotificationSendOptions } from '@backstage/plugin-notifications-node';
import { z } from 'zod';
import {
  buildEvaluation,
  evaluationRequestByteLength,
  evaluationRequestSchema,
  summarize,
  MAX_EVALUATION_BYTES,
  type EvaluationResult,
  type JevRequest,
  type JevResponse,
} from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createJevClient, ProviderError } from '@namayasai/backstage-plugin-jev-operations-support-backend/client';
import { awsAlertNotificationTopic } from './constants';
import { createAwsAlertsRouter } from './router';
import { createAwsAlertDetailsStore } from './store';

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

export type AwsAlertBuildOptions = {
  evaluate?: Evaluate;
  /** Recorded when this build intentionally does not call Jev. */
  notEvaluatedReason?: AwsAlertNotEvaluatedReason;
};

/**
 * The structured alert context kept in this module's own table. The standard
 * Notifications backend stores only its own payload fields and discards
 * `payload.metadata`, so this detail cannot live on the notification itself.
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

function boundedInteger(config: Config, key: string, fallback: number, min: number, max: number): number {
  const value = config.getOptionalNumber(key) ?? fallback;
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

  return {
    eventTopic,
    allowedTopicArns: [...new Set(allowedTopicArns.map(arn => arn.trim()))],
    recipientEntityRefs: [...new Set(recipients.map(canonicalRecipient))],
    model,
    timeoutMs: boundedInteger(section, 'timeoutMs', config.getOptionalNumber('jevOperationsSupport.timeoutMs') ?? 15_000, 1_000, 60_000),
    confidenceThreshold,
    demoMode: config.getOptionalBoolean('jevOperationsSupport.demoMode') ?? false,
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

type AlarmEvaluation = { status: AwsAlertEvaluationStatus; result?: JsonValue; errorCode?: string; context: string };

async function evaluateAlarm(alarm: CloudWatchAlarm, settings: AwsAlertSettings, options: AwsAlertBuildOptions): Promise<AlarmEvaluation> {
  const context = alarmContext(alarm);
  const input = { workflow: 'incident' as const, text: context, candidates: [] };
  const parsed = evaluationRequestSchema.safeParse(input);
  if (!parsed.success) {
    // The alert stays visible; only the provider call is refused, with an explicit reason.
    const oversized = context.length > 16_000 || evaluationRequestByteLength(input) > MAX_EVALUATION_BYTES;
    return { status: 'not-evaluated', errorCode: oversized ? 'alert-context-too-large' : 'invalid-alert-context', context };
  }
  if (!options.evaluate) return { status: 'not-evaluated', errorCode: options.notEvaluatedReason ?? 'jev-not-configured', context };

  const { request, checks } = buildEvaluation(parsed.data);
  try {
    const response = await options.evaluate(request);
    const result = summarize(parsed.data, response, checks, settings.confidenceThreshold);
    return { status: 'evaluated', result: serializableResult(result), context };
  } catch (error) {
    const errorCode = error instanceof ProviderError && error.status === 503 ? 'jev-busy' : 'jev-error';
    return { status: 'failed', errorCode, context };
  }
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
  /** Recorded when no evaluator was supplied, so the alert states why rather than guessing. */
  notEvaluatedReason?: AwsAlertNotEvaluatedReason;
};

/**
 * Saves the standard notification first, then its initial detail row, then evaluates
 * within a fixed per-process bound. Saturation, a disabled evaluator, and a refused
 * context are all recorded as detail state; none of them removes the saved alert.
 */
export function createAwsAlertEventHandler(options: AwsAlertEventHandlerOptions): (params: EventParams) => Promise<void> {
  const { settings, send, saveDetails, logger } = options;
  const capacity = createEvaluationCapacity(options.maxConcurrent ?? maxConcurrentAwsEvaluations);
  return async params => {
    const parsed = parseAwsCloudWatchEvent(params.eventPayload, settings.allowedTopicArns);
    if (!parsed) {
      logger.warn('Ignored an AWS event that failed SNS or CloudWatch validation');
      return;
    }
    // Capacity is claimed before the first write so the stored detail states whether an
    // evaluation is actually going to run. There is no queue: a saturated process
    // records the reason instead.
    const evaluate = options.evaluate && capacity.tryAcquire() ? options.evaluate : undefined;
    const reason: AwsAlertNotEvaluatedReason = !options.evaluate
      ? options.notEvaluatedReason ?? 'jev-not-configured'
      : evaluate ? 'evaluation-pending' : 'evaluation-capacity-reached';
    const pending = await evaluateAlarm(parsed.alarm, settings, { notEvaluatedReason: reason });
    const record = alertRecord(parsed, settings, pending);
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
        const evaluated = await evaluateAlarm(parsed.alarm, settings, { evaluate });
        // Provider failures arrive here as a `failed` detail, so the outcome is stored
        // either way and the notification itself is never rewritten.
        await saveDetails(record.scope, alertDetails(parsed, evaluated));
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
  createAwsAlertsRouter,
  awsAlertsRoutePath,
  defaultAwsAlertPageLimit,
  maxAwsAlertPageLimit,
  maxAwsAlertPageOffset,
} from './router';

export const awsNotificationsModule = createBackendModule({
  pluginId: 'jev-operations-support',
  moduleId: 'aws-cloudwatch-notifications',
  register(reg) {
    reg.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        events: eventsServiceRef,
        notifications: notificationService,
      },
      async init({ config, logger, database, discovery, auth, httpAuth, httpRouter, events, notifications }) {
        const settings = readAwsAlertSettings(config);
        if (!settings) {
          logger.info('Jev AWS notification module is inactive: no awsNotifications configuration was provided');
          return;
        }

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
        httpRouter.use(createAwsAlertsRouter({ httpAuth, auth, discovery, store, logger }));
        await events.subscribe({
          id: awsAlertEventSubscriberId,
          topics: [settings.eventTopic],
          onEvent: createAwsAlertEventHandler({
            settings,
            logger,
            send: notification => notifications.send(notification),
            saveDetails: (scope, details) => store.save(scope, details),
            evaluate: client?.evaluate,
            notEvaluatedReason: disabledReason,
          }),
        });
        logger.info('Jev AWS notification module subscribed to its configured Events topic');
      },
    });
  },
});

export default awsNotificationsModule;
