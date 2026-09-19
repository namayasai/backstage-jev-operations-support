# AWS CloudWatch notifications

The optional
`@namayasai/backstage-plugin-jev-operations-support-aws-notifications` module
connects an existing Backstage Events subscription to standard Backstage
Notifications. The intended path is CloudWatch alarm → SNS topic → SQS queue →
`@backstage/plugin-events-backend-module-aws-sqs` → this module. The module does
not implement SNS HTTP verification, an SQS consumer, a queue, or a separate
notification database.

Install the existing Backstage Events, AWS SQS, and Notifications packages plus
the optional Jev module:

```bash
yarn --cwd packages/backend add \
  @backstage/plugin-events-backend \
  @backstage/plugin-events-backend-module-aws-sqs \
  @backstage/plugin-notifications-backend \
  @namayasai/backstage-plugin-jev-operations-support-backend \
  @namayasai/backstage-plugin-jev-operations-support-aws-notifications
```

```ts
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-events-backend'));
backend.add(import('@backstage/plugin-events-backend-module-aws-sqs'));
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@namayasai/backstage-plugin-jev-operations-support-aws-notifications'));
```

Configure the SQS module with the topic that this subscriber will receive, and
configure the Jev module with an exact SNS TopicArn allowlist and explicit user
or group recipients:

```yaml
events:
  modules:
    awsSqs:
      awsSqsConsumingEventPublisher:
        topics:
          aws.cloudwatch:
            queue:
              url: https://sqs.ap-northeast-1.amazonaws.com/123456789012/backstage-alerts
              region: ap-northeast-1

jevOperationsSupport:
  apiKey: ${TYPESAFE_JEV_API_KEY}
  model: jev-1.13.0
  awsNotifications:
    eventTopic: aws.cloudwatch
    allowedTopicArns:
      - arn:aws:sns:ap-northeast-1:123456789012:alerts
    recipientEntityRefs:
      - group:default/sre
      - user:default/on-call
    notificationTopic: jev-aws-alerts
    timeoutMs: 15000
```

The module is inactive when `jevOperationsSupport.awsNotifications` is absent.
This keeps ordinary plugin installations independent of AWS. The SQS module
uses the AWS SDK credential chain and existing queue configuration. The SNS
subscription should use `RawMessageDelivery=false`, and the SQS queue policy
should restrict `aws:SourceArn` to the same SNS TopicArn allowlist. No AWS key
is read from or written to notification metadata.

The SQS Events module passes the parsed SNS envelope as the event payload. The
module accepts only a `Type: Notification` envelope whose `TopicArn` exactly
matches the configured allowlist, then validates the CloudWatch alarm fields
`AlarmName`, `AlarmArn`, `NewStateValue`, `NewStateReason`, and
`StateChangeTime`. `ALARM`, `OK`, and `INSUFFICIENT_DATA` remain the AWS state;
the notification severity is derived from it. The alarm text sent to Jev is a
bounded summary of those validated fields and is treated as untrusted evidence.

The module first saves a standard notification as `not-evaluated`, then runs
the existing Jev client with the common `incident` workflow and sends the same
notification scope again with `evaluated` or `failed` metadata. The scope is
`<eventTopic>:<SNS MessageId>`, so the standard Notifications backend can
restore/update a duplicate delivery. A state transition normally has a new SNS
MessageId and therefore remains a distinct alert.

The metadata contract is intentionally small and is what the optional frontend
uses:

```json
{
  "jevOperationsSupport": {
    "source": "aws-cloudwatch",
    "context": "CloudWatch alarm: Checkout5xx\nState: ALARM\n...",
    "awsState": "ALARM",
    "alarmArn": "arn:aws:cloudwatch:...",
    "region": "ap-northeast-1",
    "evaluationStatus": "evaluated",
    "result": { "workflow": "incident", "findings": [] },
    "snsMessageId": "message-001",
    "topicArn": "arn:aws:sns:..."
  }
}
```

`evaluationStatus` is `not-evaluated` when the Jev key is absent or the
initial row is being saved, and `failed` when the provider rejects or times
out. An error code is stable and contains no provider response body. A Jev
failure therefore does not remove the initial alert. If the Notifications
database itself is unavailable, no module can guarantee persistence; the
standard Events service also catches subscriber errors and the SQS module may
delete the message after publishing. Scope restore is useful for duplicate
deliveries but is not a transactional queue or a guarantee against concurrent
duplicate inserts. These limits are why the module has no private retry queue.

The Events service may log full event payloads at debug level. Keep debug
logging and its retention policy in mind when alarms contain sensitive details;
module logs contain only validation and stable failure information.

Each alarm causes one Jev request when a key is configured and may cause a
second standard Notifications write to update the initial row. Provider usage,
SQS polling, and Notifications storage costs follow the selected Backstage and
AWS plans. Start with one test alarm and an exact TopicArn allowlist before
expanding recipients or alarm volume. The module does not estimate AWS or Jev
pricing.
