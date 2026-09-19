import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import type { Config, JsonValue } from '@backstage/config';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { eventsServiceRef, type EventParams } from '@backstage/plugin-events-node';
import { notificationService, type NotificationSendOptions } from '@backstage/plugin-notifications-node';
import { z } from 'zod';
import {
  buildEvaluation,
  evaluationRequestSchema,
  summarize,
  type EvaluationResult,
  type JevRequest,
  type JevResponse,
} from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createJevClient, ProviderError } from '@namayasai/backstage-plugin-jev-operations-support-backend/client';

export const awsAlertEventSubscriberId = 'jev-aws-cloudwatch-alerts';
export const defaultAwsNotificationTopic = 'jev-aws-alerts';
export const awsMetadataKey = 'jevOperationsSupport';

const maxSnsMessageBytes = 128_000;
const maxContextCharacters = 12_000;

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

type CloudWatchAlarm = z.infer<typeof cloudWatchAlarmSchema>;
type Evaluate = (request: JevRequest) => Promise<JevResponse>;

export type AwsAlertSettings = Readonly<{
  eventTopic: string;
  allowedTopicArns: string[];
  recipientEntityRefs: string[];
  notificationTopic: string;
  model: string;
  timeoutMs: number;
}>;

export type AwsAlertEvaluationStatus = 'evaluated' | 'failed' | 'not-evaluated';

export type JevAwsAlertMetadata = {
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

  return {
    eventTopic,
    allowedTopicArns: [...new Set(allowedTopicArns.map(arn => arn.trim()))],
    recipientEntityRefs: [...new Set(recipients.map(canonicalRecipient))],
    notificationTopic: section.getOptionalString('notificationTopic')?.trim() || defaultAwsNotificationTopic,
    model,
    timeoutMs: boundedInteger(section, 'timeoutMs', config.getOptionalNumber('jevOperationsSupport.timeoutMs') ?? 15_000, 1_000, 60_000),
  };
}

export function parseAwsCloudWatchEvent(
  eventPayload: unknown,
  allowedTopicArns: readonly string[],
): { envelope: z.infer<typeof snsNotificationSchema>; alarm: CloudWatchAlarm } | undefined {
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

function alarmContext(alarm: CloudWatchAlarm): string {
  return [
    `CloudWatch alarm: ${alarm.AlarmName}`,
    `State: ${alarm.NewStateValue}`,
    `Previous state: ${alarm.OldStateValue || 'unknown'}`,
    `Reason: ${alarm.NewStateReason}`,
    `Region: ${alarm.Region || 'unknown'}`,
    `State change time: ${alarm.StateChangeTime}`,
    `Alarm ARN: ${alarm.AlarmArn}`,
  ].join('\n').slice(0, maxContextCharacters);
}

function serializableResult(result: EvaluationResult): JsonValue {
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}

async function evaluateAlarm(
  alarm: CloudWatchAlarm,
  settings: AwsAlertSettings,
  evaluate: Evaluate | undefined,
): Promise<{ status: AwsAlertEvaluationStatus; result?: JsonValue; errorCode?: string; context: string }> {
  const context = alarmContext(alarm);
  if (!evaluate) return { status: 'not-evaluated', errorCode: 'jev-not-configured', context };
  const parsed = evaluationRequestSchema.safeParse({ workflow: 'incident', text: context, candidates: [] });
  if (!parsed.success) return { status: 'not-evaluated', errorCode: 'invalid-alert-context', context };

  const { request, checks } = buildEvaluation(parsed.data);
  try {
    const response = await evaluate(request);
    const result = summarize(parsed.data, response, checks);
    return { status: 'evaluated', result: serializableResult(result), context };
  } catch (error) {
    const errorCode = error instanceof ProviderError && error.status === 503 ? 'jev-busy' : 'jev-error';
    return { status: 'failed', errorCode, context };
  }
}

function severityForState(state: CloudWatchAlarm['NewStateValue']): 'critical' | 'high' | 'normal' {
  if (state === 'ALARM') return 'critical';
  if (state === 'INSUFFICIENT_DATA') return 'high';
  return 'normal';
}

export async function buildAwsAlertNotification(
  params: EventParams,
  settings: AwsAlertSettings,
  evaluate?: Evaluate,
): Promise<NotificationSendOptions | undefined> {
  const parsed = parseAwsCloudWatchEvent(params.eventPayload, settings.allowedTopicArns);
  if (!parsed) return undefined;

  const { envelope, alarm } = parsed;
  const evaluation = await evaluateAlarm(alarm, settings, evaluate);
  const metadata: JevAwsAlertMetadata = {
    source: 'aws-cloudwatch',
    context: evaluation.context,
    awsState: alarm.NewStateValue,
    alarmArn: alarm.AlarmArn,
    region: alarm.Region,
    evaluationStatus: evaluation.status,
    ...(evaluation.result ? { result: evaluation.result } : {}),
    ...(evaluation.errorCode ? { errorCode: evaluation.errorCode } : {}),
    snsMessageId: envelope.MessageId,
    topicArn: envelope.TopicArn,
  };
  const jevLabel = evaluation.status === 'evaluated' ? 'Jev evaluated' : evaluation.status === 'failed' ? 'Jev evaluation failed' : 'Jev not evaluated';
  return {
    recipients: { type: 'entity', entityRef: settings.recipientEntityRefs },
    payload: {
      title: `[${alarm.NewStateValue}] ${alarm.AlarmName}`,
      description: `${alarm.NewStateReason}\n${jevLabel}`,
      severity: severityForState(alarm.NewStateValue),
      topic: settings.notificationTopic,
      scope: `${settings.eventTopic}:${envelope.MessageId}`,
      metadata: { [awsMetadataKey]: metadata as unknown as JsonValue },
    },
  };
}

export const awsNotificationsModule = createBackendModule({
  pluginId: 'jev-operations-support',
  moduleId: 'aws-cloudwatch-notifications',
  register(reg) {
    reg.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        events: eventsServiceRef,
        notifications: notificationService,
      },
      async init({ config, logger, events, notifications }) {
        const settings = readAwsAlertSettings(config);
        if (!settings) {
          logger.info('Jev AWS notification module is inactive: no awsNotifications configuration was provided');
          return;
        }

        const apiKey = config.getOptionalString('jevOperationsSupport.apiKey');
        const client = apiKey ? createJevClient({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs }) : undefined;
        await events.subscribe({
          id: awsAlertEventSubscriberId,
          topics: [settings.eventTopic],
          onEvent: async params => {
            const initialNotification = await buildAwsAlertNotification(params, settings);
            if (!initialNotification) {
              logger.warn('Ignored an AWS event that failed SNS or CloudWatch validation');
              return;
            }
            try {
              // Persist an unassessed notification before calling Jev. A provider
              // timeout or a process restart therefore cannot erase the alert.
              await notifications.send(initialNotification);
            } catch {
              logger.error('Failed to save an AWS alert notification');
              return;
            }
            if (!client) return;
            try {
              // The same scope lets the standard Notifications backend update the
              // row with the eventual Jev result when it supports scope restore.
              const evaluatedNotification = await buildAwsAlertNotification(params, settings, client.evaluate);
              if (evaluatedNotification) await notifications.send(evaluatedNotification);
            } catch {
              // The initial row is already present; do not turn a Jev/update error
              // into an unhandled subscriber failure.
              logger.error('Failed to update an AWS alert with the Jev result');
            }
          },
        });
        logger.info('Jev AWS notification module subscribed to its configured Events topic');
      },
    });
  },
});

export default awsNotificationsModule;
