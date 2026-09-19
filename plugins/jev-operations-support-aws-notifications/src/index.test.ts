import { describe, expect, it, vi } from 'vitest';
import { ConfigReader } from '@backstage/config';
import type { NotificationSendOptions } from '@backstage/plugin-notifications-node';
import type { EvaluationResult, JevRequest, JevResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';
import {
  automaticEvaluationDisabledReason,
  awsAlertNotificationTopic,
  buildAwsAlertRecord,
  createAwsAlertEventHandler,
  maxConcurrentAwsEvaluations,
  parseAwsCloudWatchEvent,
  readAwsAlertSettings,
  type AwsAlertRecord,
  type AwsAlertSettings,
  type JevAwsAlertDetails,
} from './index';

const topicArn = 'arn:aws:sns:ap-northeast-1:123456789012:alerts';
const alarmArn = 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:Checkout5xx';

function settings(overrides: Partial<AwsAlertSettings> = {}): AwsAlertSettings {
  return {
    eventTopic: 'aws-cloudwatch',
    allowedTopicArns: [topicArn],
    recipientEntityRefs: ['group:default/sre'],
    model: 'jev-1.13.0',
    timeoutMs: 2_000,
    confidenceThreshold: 0.8,
    demoMode: false,
    ...overrides,
  };
}

function event(state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA' = 'ALARM', alarmOverrides: Record<string, unknown> = {}, messageId = 'message-001') {
  return {
    topic: 'aws-cloudwatch',
    eventPayload: {
      Type: 'Notification',
      MessageId: messageId,
      TopicArn: topicArn,
      Message: JSON.stringify({
        AlarmName: 'Checkout5xx',
        AlarmArn: alarmArn,
        NewStateValue: state,
        OldStateValue: 'OK',
        NewStateReason: 'The threshold was crossed',
        StateChangeTime: '2026-09-19T10:00:00.000+0000',
        Region: 'ap-northeast-1',
        AWSAccountId: '123456789012',
        ...alarmOverrides,
      }),
    },
  };
}

function detailsOf(record: AwsAlertRecord | undefined): JevAwsAlertDetails {
  return record!.details;
}

/** Collects the two writes the handler makes: the native alert and its detail row. */
function writes() {
  const notifications: NotificationSendOptions[] = [];
  const details: Array<{ scope: string; details: JevAwsAlertDetails }> = [];
  const order: string[] = [];
  return {
    notifications,
    details,
    order,
    send: async (notification: NotificationSendOptions) => { order.push('send'); notifications.push(notification); },
    saveDetails: async (scope: string, value: JevAwsAlertDetails) => { order.push('saveDetails'); details.push({ scope, details: value }); },
  };
}

function evaluate(request: JevRequest): JevResponse {
  return {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      const selected = keys[1] ?? keys[0];
      const probabilities = Object.fromEntries(keys.map((key, index) => [key, index === 1 ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]));
      return [id, { type: 'choice', choice: selected, confidence: 0.9, probabilities }];
    })),
  } as JevResponse;
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('Jev AWS notifications module', () => {
  it('requires an exact TopicArn and validates CloudWatch state fields', () => {
    expect(parseAwsCloudWatchEvent(event().eventPayload, [topicArn])).toBeDefined();
    expect(parseAwsCloudWatchEvent(event().eventPayload, ['arn:aws:sns:other'])).toBeUndefined();
    expect(parseAwsCloudWatchEvent({ ...event().eventPayload, TopicArn: topicArn, Message: '{"NewStateValue":"MAYBE"}' }, [topicArn])).toBeUndefined();
  });

  it('supports explicit group recipients and rejects other entity kinds', () => {
    const value = readAwsAlertSettings(new ConfigReader({
      jevOperationsSupport: {
        awsNotifications: {
          eventTopic: 'aws-cloudwatch',
          allowedTopicArns: [topicArn],
          recipientEntityRefs: ['Group:default/SRE', 'user:default/on-call'],
        },
      },
    }));
    expect(value?.recipientEntityRefs).toEqual(['group:default/sre', 'user:default/on-call']);
    expect(() => readAwsAlertSettings(new ConfigReader({
      jevOperationsSupport: {
        awsNotifications: {
          eventTopic: 'aws-cloudwatch',
          allowedTopicArns: [topicArn],
          recipientEntityRefs: ['component:default/payments'],
        },
      },
    }))).toThrow('user or group');
  });

  it('documents why the SQS topic key must not contain a dot', () => {
    // The AWS SQS Events module reads its topics as `topics.keys().map(key => topics.getConfig(key))`.
    // A dotted key is a config path there, so `aws.cloudwatch` looks up `topics.aws.cloudwatch`.
    const topicsOf = (key: string) => new ConfigReader({
      events: { modules: { awsSqs: { awsSqsConsumingEventPublisher: { topics: {
        [key]: { queue: { url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/alerts', region: 'ap-northeast-1' } },
      } } } } },
    }).getConfig('events.modules.awsSqs.awsSqsConsumingEventPublisher.topics');

    const documented = topicsOf('aws-cloudwatch');
    expect(documented.keys().map(key => documented.getConfig(key).getString('queue.region'))).toEqual(['ap-northeast-1']);
    const dotted = topicsOf('aws.cloudwatch');
    expect(() => dotted.keys().map(key => dotted.getConfig(key))).toThrow(/aws\.cloudwatch/);
  });

  it('keeps machine-readable state out of the standard notification', async () => {
    const initial = await buildAwsAlertRecord(event(), settings(), { notEvaluatedReason: 'evaluation-pending' });
    const evaluated = await buildAwsAlertRecord(event(), settings(), { evaluate: async request => evaluate(request) });

    expect(initial?.notification.payload.metadata).toBeUndefined();
    expect(initial?.notification.payload).toEqual({
      title: '[ALARM] Checkout5xx',
      // The Notifications backend does not persist payload.metadata, so the native row
      // carries only the human alarm reason and is never rewritten with Jev state.
      description: 'The threshold was crossed',
      severity: 'high',
      topic: awsAlertNotificationTopic,
      scope: 'aws-cloudwatch:message-001',
    });
    expect(initial?.scope).toBe('aws-cloudwatch:message-001');
    expect(evaluated?.notification.payload).toEqual(initial?.notification.payload);
    expect(detailsOf(initial)).toMatchObject({
      awsState: 'ALARM',
      evaluationStatus: 'not-evaluated',
      errorCode: 'evaluation-pending',
    });
    expect(detailsOf(evaluated)).toMatchObject({ awsState: 'ALARM', evaluationStatus: 'evaluated' });
    expect(detailsOf(evaluated).result).toBeDefined();
  });

  it('keeps notification priority modest and separate from Jev impact', async () => {
    const states = { ALARM: 'high', INSUFFICIENT_DATA: 'normal', OK: 'low' } as const;
    for (const [state, severity] of Object.entries(states)) {
      const record = await buildAwsAlertRecord(event(state as keyof typeof states), settings());
      expect(record?.notification.payload.severity).toBe(severity);
    }
  });

  it('keeps the alert with an explicit Jev failure state', async () => {
    const record = await buildAwsAlertRecord(event('INSUFFICIENT_DATA'), settings(), {
      evaluate: async () => { throw new Error('provider details stay out of the stored alert'); },
    });
    expect(detailsOf(record)).toMatchObject({
      awsState: 'INSUFFICIENT_DATA',
      evaluationStatus: 'failed',
      errorCode: 'jev-error',
    });
  });

  it('reports a pending evaluation instead of a missing key when a client exists', async () => {
    const withoutClient = await buildAwsAlertRecord(event(), settings());
    const pending = await buildAwsAlertRecord(event(), settings(), { notEvaluatedReason: 'evaluation-pending' });
    expect(detailsOf(withoutClient).errorCode).toBe('jev-not-configured');
    expect(detailsOf(pending).errorCode).toBe('evaluation-pending');
  });

  it('keeps a stable region from the alarm ARN when the Region field is absent or a display name', async () => {
    const absent = await buildAwsAlertRecord(event('ALARM', { Region: undefined }), settings());
    const displayName = await buildAwsAlertRecord(event('ALARM', { Region: 'Asia Pacific (Tokyo)' }), settings());
    const noRegionInArn = await buildAwsAlertRecord(event('ALARM', { Region: '', AlarmArn: 'arn:aws:cloudwatch:::alarm:Checkout5xx' }), settings());

    expect(detailsOf(absent).region).toBe('ap-northeast-1');
    expect(detailsOf(displayName).region).toBe('ap-northeast-1');
    expect(detailsOf(noRegionInArn)).toMatchObject({ region: 'unknown', alarmArn: 'arn:aws:cloudwatch:::alarm:Checkout5xx', source: 'aws-cloudwatch' });
    expect(detailsOf(absent).context).toContain('Region: ap-northeast-1');
  });

  it('uses the root confidenceThreshold for the receive-time result, like the manual endpoint', async () => {
    const strict = await buildAwsAlertRecord(event(), settings({ confidenceThreshold: 0.95 }), { evaluate: async request => evaluate(request) });
    const lenient = await buildAwsAlertRecord(event(), settings({ confidenceThreshold: 0.8 }), { evaluate: async request => evaluate(request) });

    // The stub answers with confidence 0.9: above the default threshold, below a stricter one.
    const statuses = (record: AwsAlertRecord | undefined) =>
      ((detailsOf(record).result as unknown as EvaluationResult).findings).map(finding => finding.status);
    expect(statuses(strict).every(status => status === 'review')).toBe(true);
    expect(statuses(lenient).some(status => status !== 'review')).toBe(true);
  });

  it('refuses an oversized alarm context explicitly and still shows the alert', async () => {
    const evaluateSpy = vi.fn(async (request: JevRequest) => evaluate(request));
    const record = await buildAwsAlertRecord(event('ALARM', { NewStateReason: '日'.repeat(9_000) }), settings(), { evaluate: evaluateSpy });

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(detailsOf(record)).toMatchObject({
      evaluationStatus: 'not-evaluated',
      errorCode: 'alert-context-too-large',
      awsState: 'ALARM',
    });
    expect(detailsOf(record).context).toContain('日'.repeat(100));
  });
});

describe('AWS alert event handler', () => {
  it('saves the notification, then its pending detail, then stores the Jev result', async () => {
    const calls: string[] = [];
    const written = writes();
    const handler = createAwsAlertEventHandler({
      settings: settings(),
      logger: logger(),
      send: async notification => { calls.push('send'); await written.send(notification); },
      saveDetails: async (scope, details) => { calls.push('saveDetails'); await written.saveDetails(scope, details); },
      evaluate: async request => { calls.push('evaluate'); return evaluate(request); },
    });

    await handler(event());

    expect(calls).toEqual(['send', 'saveDetails', 'evaluate', 'saveDetails']);
    // The notification is written once and is not rewritten with the result.
    expect(written.notifications).toHaveLength(1);
    expect(written.details.map(write => write.scope)).toEqual(['aws-cloudwatch:message-001', 'aws-cloudwatch:message-001']);
    expect(written.notifications[0].payload.scope).toBe(written.details[0].scope);
    expect(written.details[0].details).toMatchObject({ evaluationStatus: 'not-evaluated', errorCode: 'evaluation-pending' });
    expect(written.details[1].details).toMatchObject({ evaluationStatus: 'evaluated' });
    expect(written.details[1].details.result).toBeDefined();
  });

  it('keeps the saved alert when the detail write fails', async () => {
    const written = writes();
    const log = logger();
    const saveDetails = vi.fn(async (scope: string, details: JevAwsAlertDetails) => {
      if (saveDetails.mock.calls.length === 1) throw new Error('database unavailable');
      await written.saveDetails(scope, details);
    });
    const handler = createAwsAlertEventHandler({
      settings: settings(),
      logger: log,
      send: written.send,
      saveDetails,
      evaluate: async request => evaluate(request),
    });

    await handler(event());

    // The native alert stays, the evaluation still runs, and the result is still stored.
    expect(written.notifications).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('Saved an AWS alert without its structured details');
    expect(written.details).toHaveLength(1);
    expect(written.details[0].details).toMatchObject({ evaluationStatus: 'evaluated' });
  });

  it('stores a provider failure as detail state without touching the saved alert', async () => {
    const written = writes();
    const log = logger();
    const handler = createAwsAlertEventHandler({
      settings: settings(),
      logger: log,
      send: written.send,
      saveDetails: written.saveDetails,
      evaluate: async () => { throw new Error('provider failure'); },
    });

    await handler(event());

    expect(written.notifications).toHaveLength(1);
    expect(written.details[1].details).toMatchObject({ evaluationStatus: 'failed', errorCode: 'jev-error' });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('bounds concurrent evaluations and records the capacity reason on the stored detail', async () => {
    const written = writes();
    let active = 0;
    let maximum = 0;
    const release: Array<() => void> = [];
    const handler = createAwsAlertEventHandler({
      settings: settings(),
      logger: logger(),
      send: written.send,
      saveDetails: written.saveDetails,
      maxConcurrent: 2,
      evaluate: async request => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>(resolve => release.push(resolve));
        active -= 1;
        return evaluate(request);
      },
    });

    const running = [handler(event('ALARM', {}, 'message-1')), handler(event('ALARM', {}, 'message-2')), handler(event('ALARM', {}, 'message-3'))];
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach(resolve => resolve());
    await Promise.all(running);

    expect(maximum).toBe(2);
    const saturated = written.details.filter(write => write.details.errorCode === 'evaluation-capacity-reached');
    expect(saturated).toHaveLength(1);
    expect(saturated[0].details).toMatchObject({ evaluationStatus: 'not-evaluated', awsState: 'ALARM' });
    // Every alert is still saved as a standard notification; only its evaluation is skipped.
    expect(written.notifications).toHaveLength(3);
    expect(written.details.filter(write => write.details.evaluationStatus === 'evaluated')).toHaveLength(2);
  });

  it('releases capacity after a failed save and after a provider failure', async () => {
    const written = writes();
    const log = logger();
    let failNextSend = true;
    const evaluateSpy = vi.fn(async (request: JevRequest) => {
      if (evaluateSpy.mock.calls.length === 1) throw new Error('provider failure');
      return evaluate(request);
    });
    const handler = createAwsAlertEventHandler({
      settings: settings(),
      logger: log,
      maxConcurrent: 1,
      send: async notification => {
        if (failNextSend) { failNextSend = false; throw new Error('notifications unavailable'); }
        await written.send(notification);
      },
      saveDetails: written.saveDetails,
      evaluate: evaluateSpy,
    });

    await handler(event('ALARM', {}, 'message-1'));
    await handler(event('ALARM', {}, 'message-2'));
    await handler(event('ALARM', {}, 'message-3'));

    // Only the unsaved alert is an error; a provider failure is a visible alert state.
    expect(log.error).toHaveBeenCalledTimes(1);
    // The unsaved alert has no detail row either; nothing is stored for a lost alert.
    expect(written.notifications).toHaveLength(2);
    expect(written.details.map(write => write.details.errorCode)).toEqual(['evaluation-pending', 'jev-error', 'evaluation-pending', undefined]);
    expect(written.details[1].details).toMatchObject({ evaluationStatus: 'failed' });
    expect(written.details[3].details).toMatchObject({ evaluationStatus: 'evaluated' });
  });

  it('saves the alert without an evaluation when no Jev key is configured', async () => {
    const written = writes();
    const handler = createAwsAlertEventHandler({ settings: settings(), logger: logger(), send: written.send, saveDetails: written.saveDetails });

    await handler(event());

    expect(written.notifications).toHaveLength(1);
    expect(written.details).toHaveLength(1);
    expect(written.details[0].details).toMatchObject({ evaluationStatus: 'not-evaluated', errorCode: 'jev-not-configured' });
  });

  it('makes no provider call in demo mode even when an API key is configured', async () => {
    const config = new ConfigReader({
      jevOperationsSupport: {
        apiKey: 'not-used-in-demo-mode',
        demoMode: true,
        awsNotifications: { eventTopic: 'aws-cloudwatch', allowedTopicArns: [topicArn], recipientEntityRefs: ['group:default/sre'] },
      },
    });
    const value = readAwsAlertSettings(config);
    expect(value?.demoMode).toBe(true);
    // This is the exact decision the module registration makes before it builds a client.
    expect(automaticEvaluationDisabledReason(value!, true)).toBe('jev-demo-mode');
    expect(automaticEvaluationDisabledReason(settings(), true)).toBeUndefined();
    expect(automaticEvaluationDisabledReason(settings(), false)).toBe('jev-not-configured');

    const written = writes();
    const evaluateSpy = vi.fn();
    const handler = createAwsAlertEventHandler({
      settings: settings({ demoMode: true }),
      logger: logger(),
      send: written.send,
      saveDetails: written.saveDetails,
      notEvaluatedReason: 'jev-demo-mode',
    });

    await handler(event());

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(written.notifications).toHaveLength(1);
    // The alert is still saved, and it says demo mode rather than pretending a key is missing.
    expect(written.details[0].details).toMatchObject({ evaluationStatus: 'not-evaluated', errorCode: 'jev-demo-mode', awsState: 'ALARM' });
    expect(written.details[0].details.result).toBeUndefined();
  });

  it('evaluates a full SQS receive batch instead of skipping most of it', async () => {
    const written = writes();
    const evaluateSpy = vi.fn(async (request: JevRequest) => evaluate(request));
    const handler = createAwsAlertEventHandler({
      settings: settings(),
      logger: logger(),
      send: written.send,
      saveDetails: written.saveDetails,
      evaluate: evaluateSpy,
    });

    // 10 is the AWS SQS maximum receive batch size, so an ordinary batch must fit the bound.
    expect(maxConcurrentAwsEvaluations).toBe(10);
    const batch = Array.from({ length: maxConcurrentAwsEvaluations }, (_unused, index) => event('ALARM', {}, `message-${index}`));
    await Promise.all(batch.map(params => handler(params)));

    expect(evaluateSpy).toHaveBeenCalledTimes(maxConcurrentAwsEvaluations);
    expect(written.details.filter(write => write.details.evaluationStatus === 'evaluated')).toHaveLength(maxConcurrentAwsEvaluations);
    expect(written.details.some(write => write.details.errorCode === 'evaluation-capacity-reached')).toBe(false);
  });

  it('ignores an event from an unlisted topic without saving or evaluating', async () => {
    const send = vi.fn();
    const saveDetails = vi.fn();
    const evaluateSpy = vi.fn();
    const log = logger();
    const handler = createAwsAlertEventHandler({ settings: settings({ allowedTopicArns: ['arn:aws:sns:ap-northeast-1:123456789012:other'] }), logger: log, send, saveDetails, evaluate: evaluateSpy });

    await handler(event());

    expect(send).not.toHaveBeenCalled();
    expect(saveDetails).not.toHaveBeenCalled();
    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
