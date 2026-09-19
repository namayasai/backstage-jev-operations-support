import { describe, expect, it } from 'vitest';
import { ConfigReader } from '@backstage/config';
import type { JevRequest, JevResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';
import {
  buildAwsAlertNotification,
  parseAwsCloudWatchEvent,
  readAwsAlertSettings,
  type AwsAlertSettings,
} from './index';

const topicArn = 'arn:aws:sns:ap-northeast-1:123456789012:alerts';

function settings(overrides: Partial<AwsAlertSettings> = {}): AwsAlertSettings {
  return {
    eventTopic: 'aws.cloudwatch',
    allowedTopicArns: [topicArn],
    recipientEntityRefs: ['group:default/sre'],
    notificationTopic: 'jev-aws-alerts',
    model: 'jev-1.13.0',
    timeoutMs: 2_000,
    ...overrides,
  };
}

function event(state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA' = 'ALARM') {
  return {
    topic: 'aws.cloudwatch',
    eventPayload: {
      Type: 'Notification',
      MessageId: 'message-001',
      TopicArn: topicArn,
      Message: JSON.stringify({
        AlarmName: 'Checkout5xx',
        AlarmArn: 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:Checkout5xx',
        NewStateValue: state,
        OldStateValue: 'OK',
        NewStateReason: 'The threshold was crossed',
        StateChangeTime: '2026-09-19T10:00:00.000+0000',
        Region: 'ap-northeast-1',
        AWSAccountId: '123456789012',
      }),
    },
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
          eventTopic: 'aws.cloudwatch',
          allowedTopicArns: [topicArn],
          recipientEntityRefs: ['Group:default/SRE', 'user:default/on-call'],
        },
      },
    }));
    expect(value?.recipientEntityRefs).toEqual(['group:default/sre', 'user:default/on-call']);
    expect(() => readAwsAlertSettings(new ConfigReader({
      jevOperationsSupport: {
        awsNotifications: {
          eventTopic: 'aws.cloudwatch',
          allowedTopicArns: [topicArn],
          recipientEntityRefs: ['component:default/payments'],
        },
      },
    }))).toThrow('user or group');
  });

  it('writes an unassessed notification before a Jev update with the same scope', async () => {
    const initial = await buildAwsAlertNotification(event(), settings());
    const evaluated = await buildAwsAlertNotification(event(), settings(), async request => evaluate(request));

    expect(initial?.payload).toMatchObject({
      topic: 'jev-aws-alerts',
      scope: 'aws.cloudwatch:message-001',
      severity: 'critical',
    });
    expect((initial?.payload.metadata as any).jevOperationsSupport).toMatchObject({
      awsState: 'ALARM',
      evaluationStatus: 'not-evaluated',
    });
    expect((evaluated?.payload.metadata as any).jevOperationsSupport).toMatchObject({
      awsState: 'ALARM',
      evaluationStatus: 'evaluated',
    });
    expect((evaluated?.payload.metadata as any).jevOperationsSupport.result).toBeDefined();
  });

  it('keeps the alert with an explicit Jev failure state', async () => {
    const notification = await buildAwsAlertNotification(event('INSUFFICIENT_DATA'), settings(), async () => {
      throw new Error('provider details stay out of metadata');
    });
    expect(notification?.payload.severity).toBe('high');
    expect((notification?.payload.metadata as any).jevOperationsSupport).toMatchObject({
      awsState: 'INSUFFICIENT_DATA',
      evaluationStatus: 'failed',
      errorCode: 'jev-error',
    });
  });
});
