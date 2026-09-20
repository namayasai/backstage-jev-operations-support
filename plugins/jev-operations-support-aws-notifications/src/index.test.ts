import { describe, expect, it, vi } from 'vitest';
import { ConfigReader } from '@backstage/config';
import type { AuthService } from '@backstage/backend-plugin-api';
import type { CatalogClient } from '@backstage/catalog-client';
import type { NotificationSendOptions } from '@backstage/plugin-notifications-node';
import type { Candidate, EvaluationResult, JevRequest, JevResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { ProviderError } from '@namayasai/backstage-plugin-jev-operations-support-backend/client';
import {
  automaticEvaluationDisabledReason,
  awsAlertNotificationTopic,
  awsAlertOwnerErrorCodes,
  buildAwsAlertRecord,
  createAwsAlertEventHandler,
  createOwnerGroupCache,
  createOwnerGroupLoader,
  maxConcurrentAwsEvaluations,
  ownerGroupNegativeCacheSeconds,
  ownerGroupNegativeCacheSecondsFor,
  parseAwsCloudWatchEvent,
  readAwsAlertSettings,
  type AwsAlertRecord,
  type AwsAlertSettings,
  type JevAwsAlertDetails,
  type LoadOwnerGroups,
} from './index';

// `vi.waitFor` polls on real timers with a hardcoded 1000ms/50ms default budget that vitest's own
// `testTimeout` config does not affect. These waits are for real concurrent-evaluation background
// work; under full-suite or concurrent-suite parallel load this file's worker thread can be
// starved of CPU by everything else running at once, so give these real headroom instead of the
// library default. No assertion is weakened by this.
function waitForReal<T>(callback: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(callback, { timeout: 10_000, interval: 25 });
}

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
    ownerSuggestion: { enabled: false, maxGroups: 20, cacheSeconds: 300 },
    ...overrides,
  };
}

const groupCandidate: Candidate = { id: 'group:default/sre', entityRef: 'group:default/sre', title: 'SRE', description: 'Site reliability team · Group' };

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
    await waitForReal(() => expect(release).toHaveLength(2));
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

describe('owner suggestion', () => {
  function ownerSettings(overrides: Partial<AwsAlertSettings['ownerSuggestion']> = {}, rest: Partial<AwsAlertSettings> = {}): AwsAlertSettings {
    return settings({ ownerSuggestion: { enabled: true, maxGroups: 20, cacheSeconds: 300, ...overrides }, ...rest });
  }

  const loadGroups = async (): Promise<Candidate[]> => [groupCandidate];

  it('parses config bounds and defaults maxGroups to 20 and cacheSeconds to 300', () => {
    const value = readAwsAlertSettings(new ConfigReader({
      jevOperationsSupport: { awsNotifications: {
        eventTopic: 'aws-cloudwatch', allowedTopicArns: [topicArn], recipientEntityRefs: ['group:default/sre'],
      } },
    }));
    expect(value?.ownerSuggestion).toEqual({ enabled: false, maxGroups: 20, cacheSeconds: 300 });

    const configured = readAwsAlertSettings(new ConfigReader({
      jevOperationsSupport: { awsNotifications: {
        eventTopic: 'aws-cloudwatch', allowedTopicArns: [topicArn], recipientEntityRefs: ['group:default/sre'],
        ownerSuggestion: { enabled: true, maxGroups: 5, cacheSeconds: 60 },
      } },
    }));
    expect(configured?.ownerSuggestion).toEqual({ enabled: true, maxGroups: 5, cacheSeconds: 60 });

    for (const badMaxGroups of [0, 21, 1.5]) {
      expect(() => readAwsAlertSettings(new ConfigReader({
        jevOperationsSupport: { awsNotifications: {
          eventTopic: 'aws-cloudwatch', allowedTopicArns: [topicArn], recipientEntityRefs: ['group:default/sre'],
          ownerSuggestion: { maxGroups: badMaxGroups },
        } },
      }))).toThrow(/maxGroups/);
    }
    for (const badCacheSeconds of [29, 3_601]) {
      expect(() => readAwsAlertSettings(new ConfigReader({
        jevOperationsSupport: { awsNotifications: {
          eventTopic: 'aws-cloudwatch', allowedTopicArns: [topicArn], recipientEntityRefs: ['group:default/sre'],
          ownerSuggestion: { cacheSeconds: badCacheSeconds },
        } },
      }))).toThrow(/cacheSeconds/);
    }
  });

  it('never includes alarm-not-active: a non-ALARM alert carries no owner fields at all, not a stored reason', () => {
    expect(awsAlertOwnerErrorCodes).not.toContain('alarm-not-active');
  });

  it('omits all three owner fields when the feature is disabled, so disabled installs and old rows look identical', async () => {
    const record = await buildAwsAlertRecord(event(), settings(), { evaluate: async request => evaluate(request), loadGroups });
    const details = record!.details;
    expect(details.ownerStatus).toBeUndefined();
    expect(details.ownerResult).toBeUndefined();
    expect(details.ownerErrorCode).toBeUndefined();
    expect('ownerStatus' in details).toBe(false);
  });

  it('suggests an owner for an active alarm once incident triage succeeds, storing the sent shortlist', async () => {
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), { evaluate: async request => evaluate(request), loadGroups });
    const details = record!.details;
    expect(details.evaluationStatus).toBe('evaluated');
    expect(details.ownerStatus).toBe('evaluated');
    expect(details.ownerResult).toBeDefined();
    expect(details.ownerCandidates).toEqual([{ id: groupCandidate.id, title: groupCandidate.title }]);
    expect(details.ownerShortened).toBeUndefined();
  });

  it('stores no owner fields at all for a resolved or insufficient-data alarm, not a stored reason', async () => {
    for (const state of ['OK', 'INSUFFICIENT_DATA'] as const) {
      const record = await buildAwsAlertRecord(event(state), ownerSettings(), { evaluate: async request => evaluate(request), loadGroups });
      const details = record!.details;
      expect('ownerStatus' in details).toBe(false);
      expect('ownerResult' in details).toBe(false);
      expect('ownerErrorCode' in details).toBe(false);
    }
  });

  it('does not suggest an owner when incident triage itself was not evaluated', async () => {
    const record = await buildAwsAlertRecord(event('ALARM', { NewStateReason: '日'.repeat(9_000) }), ownerSettings(), {
      evaluate: async request => evaluate(request),
      loadGroups,
    });
    expect(record!.details).toMatchObject({ evaluationStatus: 'not-evaluated', errorCode: 'alert-context-too-large' });
    expect(record!.details).toMatchObject({ ownerStatus: 'not-evaluated', ownerErrorCode: 'incident-not-evaluated' });
  });

  it('does not suggest an owner when incident triage failed', async () => {
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async () => { throw new Error('provider failure'); },
      loadGroups,
    });
    expect(record!.details).toMatchObject({ evaluationStatus: 'failed', ownerStatus: 'not-evaluated', ownerErrorCode: 'incident-not-evaluated' });
  });

  it('reports no-catalog-groups when the catalog has no Group entities', async () => {
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async request => evaluate(request),
      loadGroups: async () => [],
    });
    expect(record!.details).toMatchObject({ ownerStatus: 'not-evaluated', ownerErrorCode: 'no-catalog-groups' });
  });

  it('reports catalog-unavailable when the catalog read fails, without failing the alert', async () => {
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async request => evaluate(request),
      loadGroups: async () => { throw new Error('catalog is down'); },
    });
    expect(record!.details).toMatchObject({ evaluationStatus: 'evaluated', ownerStatus: 'not-evaluated', ownerErrorCode: 'catalog-unavailable' });
  });

  it('shortens candidate descriptions to fit the budget instead of failing on size', async () => {
    const hugeGroups: Candidate[] = Array.from({ length: 20 }, (_unused, i) => ({
      id: `group:default/team-${i}`, entityRef: `group:default/team-${i}`, title: `Team ${i}`, description: '長'.repeat(1_500),
    }));
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async request => evaluate(request),
      loadGroups: async () => hugeGroups,
    });
    expect(record!.details).toMatchObject({ ownerStatus: 'evaluated', ownerShortened: true });
    expect(record!.details.ownerCandidates).toHaveLength(20);
  });

  it('reports invalid-owner-request for a schema refusal that is not about raw size, distinct from alert-context-too-large', async () => {
    // Duplicate candidate ids: `fitCandidatesToBudget` only ever shrinks or drops
    // descriptions/candidates for size, so it cannot fix this, and the alarm context
    // itself is small — this is not the "context alone is too large" case.
    const duplicateIdGroups: Candidate[] = [
      { id: 'group:default/sre', title: 'SRE', description: 'a' },
      { id: 'group:default/sre', title: 'SRE (duplicate)', description: 'b' },
    ];
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async request => evaluate(request),
      loadGroups: async () => duplicateIdGroups,
    });
    expect(record!.details).toMatchObject({ ownerStatus: 'not-evaluated', ownerErrorCode: 'invalid-owner-request' });
  });

  it('reports jev-busy and jev-error from the owner call without touching the stored incident result', async () => {
    const busy = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async request => (request.state.candidates.length ? Promise.reject(new ProviderError(503, 'busy')) : evaluate(request)),
      loadGroups,
    });
    expect(busy!.details).toMatchObject({ evaluationStatus: 'evaluated', ownerStatus: 'failed', ownerErrorCode: 'jev-busy' });

    const failing = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), {
      evaluate: async request => (request.state.candidates.length ? Promise.reject(new Error('boom')) : evaluate(request)),
      loadGroups,
    });
    expect(failing!.details).toMatchObject({ evaluationStatus: 'evaluated', ownerStatus: 'failed', ownerErrorCode: 'jev-error' });
  });

  it('mirrors the incident "no evaluator" reason exactly, rather than a generic owner reason', async () => {
    const notConfigured = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), { loadGroups });
    expect(notConfigured!.details).toMatchObject({ evaluationStatus: 'not-evaluated', errorCode: 'jev-not-configured', ownerStatus: 'not-evaluated', ownerErrorCode: 'jev-not-configured' });

    const demoMode = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), { notEvaluatedReason: 'jev-demo-mode', loadGroups });
    expect(demoMode!.details).toMatchObject({ evaluationStatus: 'not-evaluated', errorCode: 'jev-demo-mode', ownerStatus: 'not-evaluated', ownerErrorCode: 'jev-demo-mode' });
    // Demo mode never stores a fixture result for either call.
    expect(demoMode!.details.result).toBeUndefined();
    expect(demoMode!.details.ownerResult).toBeUndefined();
  });

  it('does not claim a second capacity slot for the owner call: a single-slot process still evaluates both for one alarm', async () => {
    const written = writes();
    const handler = createAwsAlertEventHandler({
      settings: ownerSettings(),
      logger: logger(),
      send: written.send,
      saveDetails: written.saveDetails,
      maxConcurrent: 1,
      evaluate: async request => evaluate(request),
      loadGroups,
    });

    await handler(event());

    const final = written.details.at(-1)!.details;
    // Under the old (removed) design, a single slot meant the owner call could never
    // acquire a second one and always reported evaluation-capacity-reached. Incident
    // and owner evaluation for one alarm are now one logical unit sharing one slot, so
    // a single-slot process still evaluates both.
    expect(final).toMatchObject({ evaluationStatus: 'evaluated', ownerStatus: 'evaluated' });
  });

  it('shares the limiter across concurrently active alarms by alarm, not by provider call: two alarms with two slots both get owner results', async () => {
    let active = 0;
    let maximum = 0;
    const release: Array<() => void> = [];
    const trackedEvaluate = async (request: JevRequest) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => release.push(resolve));
      active -= 1;
      return evaluate(request);
    };
    const written = writes();
    const handler = createAwsAlertEventHandler({
      settings: ownerSettings(),
      logger: logger(),
      send: written.send,
      saveDetails: written.saveDetails,
      maxConcurrent: 2,
      evaluate: trackedEvaluate,
      loadGroups,
    });

    const running = Promise.all([handler(event('ALARM', {}, 'message-1')), handler(event('ALARM', {}, 'message-2'))]);
    // Both alarms' incident calls run concurrently first (2 slots, 2 alarms).
    await waitForReal(() => expect(release).toHaveLength(2));
    release.forEach(resolve => resolve());
    // Each alarm's owner call then runs (still sharing that same alarm's already-held
    // slot), so a second wave of two more trackedEvaluate calls follows.
    await waitForReal(() => expect(release).toHaveLength(4));
    release.slice(2).forEach(resolve => resolve());
    await running;

    // Never more than 2 concurrent provider calls at once: capacity still bounds
    // concurrent *alarms*, one incident-call wave at a time.
    expect(maximum).toBe(2);
    const evaluatedOwners = written.details.filter(write => write.details.ownerStatus === 'evaluated');
    expect(evaluatedOwners).toHaveLength(2);
    expect(written.details.some(write => write.details.ownerErrorCode === 'evaluation-capacity-reached')).toBe(false);
  });

  it('makes calls in order: send, saveDetails(pending), incident evaluate, saveDetails(incident), loadGroups, owner evaluate, saveDetails(final)', async () => {
    const order: string[] = [];
    const written = writes();
    const saveCalls: JevAwsAlertDetails[] = [];
    const handler = createAwsAlertEventHandler({
      settings: ownerSettings(),
      logger: logger(),
      send: async notification => { order.push('send'); await written.send(notification); },
      saveDetails: async (scope, details) => { order.push('saveDetails'); saveCalls.push(details); await written.saveDetails(scope, details); },
      evaluate: async request => {
        order.push(request.state.candidates.length ? 'owner evaluate' : 'incident evaluate');
        return evaluate(request);
      },
      loadGroups: async () => { order.push('loadGroups'); return loadGroups(); },
    });

    // `loadGroups` must not have been touched by the time the notification is sent —
    // it is only reached after incident evaluation succeeds, well after `send`.
    const running = handler(event());
    await running;

    expect(order).toEqual(['send', 'saveDetails', 'incident evaluate', 'saveDetails', 'loadGroups', 'owner evaluate', 'saveDetails']);
    // The three saved rows are: the initial pending row, the incident result published
    // early (owner still pending), and the final row with the owner result.
    expect(saveCalls.map(details => [details.evaluationStatus, details.ownerStatus, details.ownerErrorCode])).toEqual([
      ['not-evaluated', 'not-evaluated', 'evaluation-pending'],
      ['evaluated', 'not-evaluated', 'evaluation-pending'],
      ['evaluated', 'evaluated', undefined],
    ]);
  });

  it('does not publish an early incident-only row when owner suggestion is disabled', async () => {
    const written = writes();
    const saveCalls: JevAwsAlertDetails[] = [];
    const handler = createAwsAlertEventHandler({
      settings: settings(), // ownerSuggestion disabled
      logger: logger(),
      send: written.send,
      saveDetails: async (scope, details) => { saveCalls.push(details); await written.saveDetails(scope, details); },
      evaluate: async request => evaluate(request),
      loadGroups,
    });
    // Nothing slow follows incident evaluation, so the ordinary two writes (pending,
    // final) suffice; there is no mid-flight publish to test for.
    await handler(event());
    expect(saveCalls).toHaveLength(2);
  });

  it('does not publish an early incident-only row for a non-ALARM alert, even with owner suggestion enabled', async () => {
    const written = writes();
    const saveCalls: JevAwsAlertDetails[] = [];
    const handler = createAwsAlertEventHandler({
      settings: ownerSettings(),
      logger: logger(),
      send: written.send,
      saveDetails: async (scope, details) => { saveCalls.push(details); await written.saveDetails(scope, details); },
      evaluate: async request => evaluate(request),
      loadGroups,
    });
    await handler(event('OK'));
    expect(saveCalls).toHaveLength(2);
    expect('ownerStatus' in saveCalls[1]).toBe(false);
  });

  it('keeps a previously evaluated owner suggestion when a redelivered message\'s owner attempt fails, without changing incident semantics', async () => {
    const store = new Map<string, JevAwsAlertDetails>();
    let ownerShouldFail = false;
    const handler = createAwsAlertEventHandler({
      settings: ownerSettings(),
      logger: logger(),
      send: async () => {},
      saveDetails: async (scope, details) => { store.set(scope, details); },
      readDetails: async scope => store.get(scope),
      evaluate: async request => {
        if (request.state.candidates.length && ownerShouldFail) throw new Error('owner call failed on redelivery');
        return evaluate(request);
      },
      loadGroups,
    });

    await handler(event('ALARM', {}, 'message-1'));
    const first = store.get('aws-cloudwatch:message-1');
    expect(first).toMatchObject({ ownerStatus: 'evaluated' });
    const firstOwnerResult = first!.ownerResult;
    const firstOwnerCandidates = first!.ownerCandidates;

    // A redelivery of the same SNS message (same MessageId, hence the same scope) whose
    // owner attempt now fails must not overwrite the earlier, good suggestion.
    ownerShouldFail = true;
    await handler(event('ALARM', {}, 'message-1'));
    const second = store.get('aws-cloudwatch:message-1')!;
    expect(second.ownerStatus).toBe('evaluated');
    expect(second.ownerResult).toEqual(firstOwnerResult);
    expect(second.ownerCandidates).toEqual(firstOwnerCandidates);
    expect(second.ownerErrorCode).toBeUndefined();
    // Incident semantics are untouched: the incident result is freshly (re-)evaluated.
    expect(second.evaluationStatus).toBe('evaluated');
  });

  it('does not preserve a stored owner suggestion across a redelivery when the new attempt also succeeds', async () => {
    const store = new Map<string, JevAwsAlertDetails>();
    const handler = createAwsAlertEventHandler({
      settings: ownerSettings(),
      logger: logger(),
      send: async () => {},
      saveDetails: async (scope, details) => { store.set(scope, details); },
      readDetails: async scope => store.get(scope),
      evaluate: async request => evaluate(request),
      loadGroups,
    });

    await handler(event('ALARM', {}, 'message-1'));
    await handler(event('ALARM', {}, 'message-1'));
    const final = store.get('aws-cloudwatch:message-1')!;
    expect(final.ownerStatus).toBe('evaluated');
    expect(final.ownerResult).toBeDefined();
  });

  it('preserves an evaluated owner suggestion across a redelivery even when capacity is exhausted and no provider call is ever made', async () => {
    const store = new Map<string, JevAwsAlertDetails>();
    const saveDetails = async (scope: string, details: JevAwsAlertDetails) => { store.set(scope, details); };
    const readDetails = async (scope: string) => store.get(scope);

    // First delivery: capacity is available, both incident and owner evaluate.
    const firstHandler = createAwsAlertEventHandler({
      settings: ownerSettings(), logger: logger(), send: async () => {}, saveDetails, readDetails,
      evaluate: async request => evaluate(request), loadGroups,
    });
    await firstHandler(event('ALARM', {}, 'message-1'));
    const firstOwnerResult = store.get('aws-cloudwatch:message-1')!.ownerResult;
    expect(store.get('aws-cloudwatch:message-1')).toMatchObject({ ownerStatus: 'evaluated' });

    // A redelivery of the same message with capacity 0: `tryAcquire` always fails, so
    // this delivery never calls `evaluate` at all — only its own pending write happens,
    // and that write alone must not be the one that erases the earlier suggestion.
    const redeliveryHandler = createAwsAlertEventHandler({
      settings: ownerSettings(), logger: logger(), send: async () => {}, saveDetails, readDetails,
      maxConcurrent: 0, evaluate: async request => evaluate(request), loadGroups,
    });
    await redeliveryHandler(event('ALARM', {}, 'message-1'));

    const afterRedelivery = store.get('aws-cloudwatch:message-1')!;
    expect(afterRedelivery.evaluationStatus).toBe('not-evaluated');
    expect(afterRedelivery.errorCode).toBe('evaluation-capacity-reached');
    expect(afterRedelivery.ownerStatus).toBe('evaluated');
    expect(afterRedelivery.ownerResult).toEqual(firstOwnerResult);
  });

  it('preserves an evaluated owner suggestion across a redelivery with no evaluator at all (demo mode or a missing key)', async () => {
    const store = new Map<string, JevAwsAlertDetails>();
    const saveDetails = async (scope: string, details: JevAwsAlertDetails) => { store.set(scope, details); };
    const readDetails = async (scope: string) => store.get(scope);

    const firstHandler = createAwsAlertEventHandler({
      settings: ownerSettings(), logger: logger(), send: async () => {}, saveDetails, readDetails,
      evaluate: async request => evaluate(request), loadGroups,
    });
    await firstHandler(event('ALARM', {}, 'message-1'));
    const firstOwnerResult = store.get('aws-cloudwatch:message-1')!.ownerResult;
    expect(store.get('aws-cloudwatch:message-1')).toMatchObject({ ownerStatus: 'evaluated' });

    // Redelivered with no evaluator supplied at all (demo mode turned on, or the API key
    // removed, between the first delivery and this one). No `evaluate` means this
    // delivery makes only its own pending write, exactly as in the capacity-0 case above.
    const demoHandler = createAwsAlertEventHandler({
      settings: ownerSettings(), logger: logger(), send: async () => {}, saveDetails, readDetails,
      notEvaluatedReason: 'jev-demo-mode', loadGroups,
    });
    await demoHandler(event('ALARM', {}, 'message-1'));

    const afterRedelivery = store.get('aws-cloudwatch:message-1')!;
    expect(afterRedelivery.evaluationStatus).toBe('not-evaluated');
    expect(afterRedelivery.errorCode).toBe('jev-demo-mode');
    expect(afterRedelivery.result).toBeUndefined();
    expect(afterRedelivery.ownerStatus).toBe('evaluated');
    expect(afterRedelivery.ownerResult).toEqual(firstOwnerResult);
  });

  it('preserves an evaluated owner suggestion across a redelivery even when that redelivery\'s own final save throws', async () => {
    const store = new Map<string, JevAwsAlertDetails>();
    const readDetails = async (scope: string) => store.get(scope);
    let saveCount = 0;
    const saveDetails = async (scope: string, details: JevAwsAlertDetails) => {
      saveCount += 1;
      // The first delivery writes 3 rows (pending, incident published early, final); the
      // redelivery's own final (6th) write is the one made to fail here, isolating
      // exactly the failure mode the earlier suggestion must survive: a process crash or
      // a database error on the very last write of a delivery.
      if (saveCount === 6) throw new Error('database unavailable');
      store.set(scope, details);
    };
    const log = logger();

    const firstHandler = createAwsAlertEventHandler({
      settings: ownerSettings(), logger: log, send: async () => {}, saveDetails, readDetails,
      evaluate: async request => evaluate(request), loadGroups,
    });
    await firstHandler(event('ALARM', {}, 'message-1'));
    expect(saveCount).toBe(3);
    const firstOwnerResult = store.get('aws-cloudwatch:message-1')!.ownerResult;
    expect(store.get('aws-cloudwatch:message-1')).toMatchObject({ ownerStatus: 'evaluated' });

    const redeliveryHandler = createAwsAlertEventHandler({
      settings: ownerSettings(), logger: log, send: async () => {}, saveDetails, readDetails,
      evaluate: async request => evaluate(request), loadGroups,
    });
    await redeliveryHandler(event('ALARM', {}, 'message-1'));
    expect(saveCount).toBe(6);
    expect(log.error).toHaveBeenCalled();

    // The store keeps whatever the last *successful* write left behind — the
    // redelivery's own early incident publish (write 5), which itself already carried
    // the preserved owner suggestion — never the failed final write's fresh state.
    const afterFailedFinalWrite = store.get('aws-cloudwatch:message-1')!;
    expect(afterFailedFinalWrite.evaluationStatus).toBe('evaluated');
    expect(afterFailedFinalWrite.ownerStatus).toBe('evaluated');
    expect(afterFailedFinalWrite.ownerResult).toEqual(firstOwnerResult);
  });

  it('caches loaded groups and negative-caches a failure for a fixed 15 seconds; still single-flight', async () => {
    let calls = 0;
    let clock = 0;
    let succeed = true;
    const load: LoadOwnerGroups = () => {
      calls += 1;
      return succeed ? Promise.resolve([groupCandidate]) : Promise.reject(new Error('catalog is down'));
    };
    const cached = createOwnerGroupCache(load, 300, ownerGroupNegativeCacheSeconds, () => clock);

    expect(ownerGroupNegativeCacheSeconds).toBe(15);

    succeed = false;
    await expect(cached()).rejects.toThrow('catalog is down');
    expect(calls).toBe(1);

    // Within the negative-cache window, a burst of calls does not re-hit the catalog at all.
    await expect(cached()).rejects.toThrow(/negative-cache/);
    await expect(Promise.all([cached(), cached()])).rejects.toThrow();
    expect(calls).toBe(1);

    clock += 14_000;
    await expect(cached()).rejects.toThrow();
    expect(calls).toBe(1);

    // Once the 15-second window elapses, the next call retries the catalog.
    clock += 2_000;
    succeed = true;
    const [a, b] = await Promise.all([cached(), cached()]);
    expect(calls).toBe(2);
    expect(a).toEqual([groupCandidate]);
    expect(b).toEqual([groupCandidate]);

    // A call within the (much longer) positive cache window reuses the cached list.
    clock += 299_000;
    await cached();
    expect(calls).toBe(2);

    clock += 2_000;
    await cached();
    expect(calls).toBe(3);
  });

  it('single-flights concurrent loads: overlapping calls before the first resolves share one request', async () => {
    let calls = 0;
    let resolve: (groups: Candidate[]) => void = () => {};
    const load: LoadOwnerGroups = () => { calls += 1; return new Promise(r => { resolve = r; }); };
    const cached = createOwnerGroupCache(load, 300, ownerGroupNegativeCacheSeconds);

    const first = cached();
    const second = cached();
    resolve([groupCandidate]);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it('uses a negative-cache window floor of 2x timeoutMs when that is larger than the fixed 15-second floor', () => {
    expect(ownerGroupNegativeCacheSecondsFor(1_000)).toBe(15); // 2x1s=2s < 15s floor
    expect(ownerGroupNegativeCacheSecondsFor(10_000)).toBe(20); // 2x10s=20s > 15s floor
    expect(ownerGroupNegativeCacheSecondsFor(60_000)).toBe(120);
  });

  it('router-visible detail includes the owner fields alongside the incident result', async () => {
    const record = await buildAwsAlertRecord(event('ALARM'), ownerSettings(), { evaluate: async request => evaluate(request), loadGroups });
    const details: JevAwsAlertDetails = record!.details;
    // The router restores `details` verbatim into `payload.metadata.jevOperationsSupport`,
    // so any field present here is what the frontend inbox receives.
    expect(Object.keys(details)).toEqual(expect.arrayContaining(['ownerStatus', 'ownerResult', 'ownerCandidates']));
  });
});

describe('createOwnerGroupLoader', () => {
  function catalogClient(items: unknown[]) {
    return { getEntities: vi.fn(async () => ({ items })) } as unknown as Pick<CatalogClient, 'getEntities'>;
  }

  function authService(token = 'catalog-token') {
    return {
      getOwnServiceCredentials: vi.fn(async () => ({ principal: { type: 'service' } })),
      getPluginRequestToken: vi.fn(async () => ({ token })),
    } as unknown as Pick<AuthService, 'getOwnServiceCredentials' | 'getPluginRequestToken'>;
  }

  const groupEntity = {
    apiVersion: 'backstage.io/v1alpha1', kind: 'Group',
    metadata: { name: 'sre', namespace: 'default', title: 'SRE', description: 'Site reliability', tags: ['oncall'] },
  };

  it('requests a plugin token scoped to the catalog, and the documented filter/fields/limit/order', async () => {
    const catalog = catalogClient([groupEntity]);
    const auth = authService('catalog-token-value');
    const loader = createOwnerGroupLoader(catalog, auth, 7, 2_000);

    const candidates = await loader();

    expect(auth.getPluginRequestToken).toHaveBeenCalledWith(expect.objectContaining({ targetPluginId: 'catalog' }));
    expect(catalog.getEntities).toHaveBeenCalledWith(
      {
        filter: { kind: 'Group' },
        fields: ['kind', 'metadata.name', 'metadata.namespace', 'metadata.title', 'metadata.description', 'metadata.tags'],
        limit: 7,
        order: [
          { field: 'kind', order: 'asc' },
          { field: 'metadata.namespace', order: 'asc' },
          { field: 'metadata.name', order: 'asc' },
        ],
      },
      { token: 'catalog-token-value' },
    );
    expect(candidates).toEqual([{ id: 'group:default/sre', entityRef: 'group:default/sre', title: 'SRE', description: 'Site reliability · Group · oncall' }]);
  });

  it('drops a candidate that fails validation and logs only the count, never its content', async () => {
    // An entity ref long enough that `stringifyEntityRef` produces an over-200-character
    // id, which `candidateSchema` rejects.
    const overlongName = 'x'.repeat(250);
    const catalog = catalogClient([groupEntity, { ...groupEntity, metadata: { ...groupEntity.metadata, name: overlongName } }]);
    const auth = authService();
    const log = { warn: vi.fn() };
    const loader = createOwnerGroupLoader(catalog, auth, 20, 2_000, log);

    const candidates = await loader();

    expect(candidates).toEqual([{ id: 'group:default/sre', entityRef: 'group:default/sre', title: 'SRE', description: 'Site reliability · Group · oncall' }]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('1'));
    // Never the dropped entity's own name or any other content.
    expect(log.warn.mock.calls[0][0]).not.toContain(overlongName);
  });

  it('reports no-catalog-groups (via an empty list) when every candidate fails validation', async () => {
    const overlongName = 'y'.repeat(250);
    const catalog = catalogClient([{ ...groupEntity, metadata: { ...groupEntity.metadata, name: overlongName } }]);
    const loader = createOwnerGroupLoader(catalog, authService(), 20, 2_000);

    expect(await loader()).toEqual([]);
  });

  it('times out at the configured deadline, which the owner call reports as catalog-unavailable', async () => {
    const neverResolves: Pick<CatalogClient, 'getEntities'> = { getEntities: () => new Promise(() => {}) } as unknown as Pick<CatalogClient, 'getEntities'>;
    const loader = createOwnerGroupLoader(neverResolves, authService(), 20, 20);

    await expect(loader()).rejects.toThrow(/timed out/);
  });
});
