# AWS CloudWatch notifications

The optional
`@namayasai/backstage-plugin-jev-operations-support-aws-notifications` module
connects an existing Backstage Events subscription to standard Backstage
Notifications. The intended path is CloudWatch alarm → SNS topic → SQS queue →
`@backstage/plugin-events-backend-module-aws-sqs` → this module. The module does
not implement SNS HTTP verification, an SQS consumer, a queue, or a separate
notification database.

It does own **one table** in the Backstage database the host already provides to
the `jev-operations-support` plugin. See
[Where the alert details are stored](#where-the-alert-details-are-stored) for why
that table is necessary and what it holds.

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
// This module extends the jev-operations-support backend plugin, so the parent
// plugin must be installed as well; the module is never initialized without it.
backend.add(import('@namayasai/backstage-plugin-jev-operations-support-backend'));
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
          aws-cloudwatch:
            queue:
              url: https://sqs.ap-northeast-1.amazonaws.com/123456789012/backstage-alerts
              region: ap-northeast-1

jevOperationsSupport:
  apiKey: ${TYPESAFE_JEV_API_KEY}
  model: jev-1.13.0
  awsNotifications:
    eventTopic: aws-cloudwatch
    allowedTopicArns:
      - arn:aws:sns:ap-northeast-1:123456789012:alerts
    recipientEntityRefs:
      - group:default/sre
      - user:default/on-call
    timeoutMs: 15000
```

The topic name is an arbitrary string, but it must not contain a dot. The AWS SQS
module reads its topics as `topics.keys().map(topic => topics.getConfig(topic))`,
and `getConfig` treats a dot as a config path separator: a key such as
`aws.cloudwatch` is looked up as `topics.aws.cloudwatch` and the backend fails to
start with `Missing required config value at 'topics.aws.cloudwatch'`. Keep the
same simple name in both blocks, as above; `eventTopic` must match the SQS topic
key exactly.

The Backstage Notifications topic is the fixed value `jev-aws-alerts`. It is not
configurable because the optional frontend inbox filters on exactly that value;
a second setting could only make the two disagree.

The module is inactive when `jevOperationsSupport.awsNotifications` is absent.
This keeps ordinary plugin installations independent of AWS. The SQS module
uses the AWS SDK credential chain and existing queue configuration. The SNS
subscription should use `RawMessageDelivery=false`, and the SQS queue policy
should restrict `aws:SourceArn` to the same SNS TopicArn allowlist. No AWS key
is read from or written to a notification or to the module's table.

The SQS Events module passes the parsed SNS envelope as the event payload. The
module accepts only a `Type: Notification` envelope whose `TopicArn` exactly
matches the configured allowlist, then validates the CloudWatch alarm fields
`AlarmName`, `AlarmArn`, `NewStateValue`, `NewStateReason`, and
`StateChangeTime`. An envelope or alarm that fails that validation, including
its field size limits, is logged and ignored without creating a notification.
`ALARM`, `OK`, and `INSUFFICIENT_DATA` remain the AWS state and stay separate
from Jev's impact and investigation predictions. The alarm
text sent to Jev is a summary of those validated fields and is treated as
untrusted evidence; it is never truncated silently. A summary that does not fit
the shared evaluation limits is saved with `alert-context-too-large` and is not
sent to the provider, so the full alert stays visible in the inbox.

CloudWatch reports `Region` inconsistently — a display name such as
`Asia Pacific (Tokyo)`, or nothing at all. The region shown on the alert is
therefore taken from the alarm ARN when that ARN contains a region code, then
from `Region`, and finally `unknown`. The ARN itself and the AWS state are
always preserved exactly as received.

The notification severity is presentation only: `ALARM` uses `high`, `OK` uses
`low`, and `INSUFFICIENT_DATA` uses `normal`. A CloudWatch state is not a
customer-impact judgment, so no alarm is raised to the `critical` priority; only
an operator, with Jev's incident result as one input, decides incident severity.

The module first saves the standard notification, then writes a pending detail
row, then runs the existing Jev client with the common `incident` workflow and
overwrites that detail row with `evaluated` or `failed`. The notification itself
is written once and is never rewritten with machine-readable state. The scope is
`<eventTopic>:<SNS MessageId>`; it identifies both the notification and its
detail row, and it lets the standard Notifications backend restore a duplicate
delivery. A state transition normally has a new SNS MessageId and therefore
remains a distinct alert. A backend restart between the two writes leaves the
alert at `evaluation-pending`, because there is no worker that resumes it.

If the detail write fails, the alert is still in the inbox: it appears without
its stored context and says so. If the notification write fails, nothing is
stored for that alert at all — the module never keeps a detail row for an alert
that does not exist.

Automatic evaluation is bounded to ten concurrent Jev requests per backend
process. Ten is the AWS SQS maximum receive batch size, so an ordinary batch is
evaluated rather than mostly skipped, while a sustained alarm storm is still
bounded. The guard is a counter inside one process: it is not shared between
backend instances and does not survive a restart, so N instances can run up to
N × 10 concurrent requests.

There is no queue and no retry worker. When all slots are busy, the alert is
still saved and its stored detail carries `errorCode: evaluation-capacity-reached`,
which the inbox shows as a not-evaluated alert. Use the frontend's
**Re-check with Jev** action for those alerts. That re-check is a preview for the
current view only — it is not written back to the notification — while the
receive-time result is what is persisted. A bounded per-process limit is why an
alarm burst can still produce more saved alerts than evaluations.

Receive-time evaluation uses the root `jevOperationsSupport.confidenceThreshold`,
the same value as the manual `/evaluate` endpoint and the workbench, so the same
alarm text does not get one verdict at receipt and a different one on re-check.
There is no separate AWS threshold setting.

When the root `jevOperationsSupport.demoMode` is `true`, this module saves alerts
but makes no provider call, even if `apiKey` is set. Those alerts record
`errorCode: jev-demo-mode`. Demo fixtures are never stored, so an alert is never
labelled evaluated on the strength of a fixture.

SNS-to-SQS delivery is at-least-once. A redelivered MessageId is evaluated
again and rewrites the detail row for the same scope instead of creating a second
alert. The module deliberately keeps no in-process "recently seen message" set:
it would not survive a restart, it would not be shared between backend
instances, and a suppressed duplicate could otherwise overwrite an evaluated
alert with a stale not-evaluated one.

## Where the alert details are stored

`@backstage/plugin-notifications-backend` (checked against 0.6.9) does not
persist `payload.metadata`. Its database store maps only the columns it owns, so
a `GET /api/notifications` response carries `title`, `description`, `link`,
`topic`, `severity`, `scope`, and `icon` and no `metadata` at all — `metadata` is
intended for notification processors, not for storage. Writing the alarm context
and the Jev result into notification metadata therefore loses them, and encoding
them into the description or the link would be both unreadable and a privacy
problem.

The module keeps that structured part in one plugin-owned table,
`jev_aws_alert_details`, inside the Backstage database the host already provides
to the `jev-operations-support` plugin. There is no second database, no separate
engine, no queue, and no persistence framework: the table is created by one
packaged migration through the standard `coreServices.database` service and works
on the host's SQLite or PostgreSQL.

| Column | Purpose |
| --- | --- |
| `scope` | Primary key; the same `<eventTopic>:<SNS MessageId>` scope as the notification. |
| `details` | The JSON document below. |
| `updated_at` | Indexed ISO-8601 UTC time of the last write, used for retention. |

Everything else stays with Backstage Notifications: recipient authorization,
inbox identity, the title, the alarm reason, the AWS state summary, and each
user's read/saved preferences. The module never reads or writes the notifications
database itself, and it never touches notification origin or permissions.

Detail rows are kept for **30 days**. Cleanup is a bounded delete on the indexed
`updated_at` column performed during ordinary writes; there is no background
worker and no configuration knob. Cleanup only ever removes rows from this table
— it never deletes a notification. An alert whose detail row has expired, was
never written, or cannot be read stays visible in the inbox with its title,
alarm reason, and receipt time, and says that its details are unavailable; no
AWS state is invented for it and no re-check is offered.

## Reading alerts

The module adds one user-authenticated route to the parent plugin:

```text
GET /api/jev-operations-support/aws-alerts?limit=20&offset=0
```

- `limit` is 1–50 (default 20) and `offset` is 0–10000 (default 0). Anything else
  is rejected with 400; values are never silently clamped.
- The route requires a signed-in **user** principal. There is no unauthenticated
  exemption, and a service token is refused with 403.
- It fetches the **current user's own** notifications from the standard
  Notifications backend through `discovery('notifications')` and a plugin token
  issued with `getPluginRequestToken({ onBehalfOf: <user credentials>, targetPluginId: 'notifications' })`,
  filtered to the fixed `jev-aws-alerts` topic. Recipient isolation is therefore
  the Notifications backend's own, unchanged.
- Only rows with that topic **and** origin `plugin:jev-operations-support` are
  returned, and only their scopes are used to look up detail rows. A caller
  cannot pass a scope or a notification id: those parameters are ignored, so one
  user's alert details can never be read through another user's request, and
  another plugin cannot have its rows enriched from this table.
- The response is the same page shape as the Notifications API,
  `{ totalCount, notifications }`, with `payload.metadata.jevOperationsSupport`
  restored from the table plus an `updatedAt` field for when that detail was last
  written. `totalCount` is the count the Notifications backend reported for the
  topic query.
- If the detail table cannot be read, the alerts are still returned — without
  their details — rather than failing the page.

The optional frontend inbox calls this endpoint instead of the standard
Notifications list. If the module is not installed or not configured, the route
does not exist and the inbox reports the 404 as a setup hint rather than an error.

The stored detail document is intentionally small and is what the optional
frontend uses:

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
    "topicArn": "arn:aws:sns:...",
    "updatedAt": "2026-09-19T10:00:05.000Z"
  }
}
```

`evaluationStatus` is `evaluated`, `failed` when the provider rejects or times
out, or `not-evaluated` with one of these stable `errorCode` values:

| `errorCode` | Meaning |
| --- | --- |
| `evaluation-pending` | The alert was saved and its evaluation is about to run. |
| `evaluation-capacity-reached` | The per-process evaluation bound was full; no Jev request was made. |
| `jev-not-configured` | No `jevOperationsSupport.apiKey` is configured. |
| `jev-demo-mode` | `jevOperationsSupport.demoMode` is enabled, so no provider call was made. |
| `alert-context-too-large` | The alarm summary exceeds the shared evaluation limits. |
| `invalid-alert-context` | The alarm summary was rejected by the shared request schema. |

A `failed` alert uses `jev-busy` or `jev-error`. Every code is stable and
contains no provider response body, and no failure removes the saved alert.

`updatedAt` is added by the read endpoint from the detail row, not stored inside
the document; it is when the automatic assessment was last recorded.

The optional frontend inbox reads this document plus the standard Notifications
fields. The receipt time comes from the API's own `created` field, shown as a
concise UTC instant, with `updated` shown as well when Notifications itself
rewrote the row (a duplicate delivery restored to the same scope). An alert with
a missing or unparseable timestamp is still listed, as "Received time not
reported". An alert whose stored `result` does not match the evaluation contract
is also still listed: the result is hidden with an explanation, and the AWS state
remains the authoritative signal. An alert with no readable details at all is
still listed too, with its notification text and an explicit "details
unavailable" message instead of an invented state.

Delivery is best effort, not transactional, and this integration cannot make it
otherwise. Two properties of the standard packages decide that:

- The AWS SQS consuming publisher calls `events.publish` for each message in a
  `forEach` without awaiting it, then deletes the received batch. Message
  deletion therefore does not wait for this subscriber to finish.
- The standard Events service catches subscriber errors. A `send` that throws is
  logged, not propagated, so it neither fails the publish nor causes a redelivery.

Together this means that if the Notifications storage is unavailable at the
moment an alert arrives, the alert can be lost: SQS has already deleted the
message and nothing retries it. The module does not add its own consumer, queue,
or retry worker to paper over this — a private in-process queue would not survive
a restart, would not be shared across instances, and would silently promise a
durability it cannot provide. An alert that was never saved has to arrive again
from a new alarm state change or a redelivered SQS message.

What the module does guarantee is narrower and holds within one delivery: the
notification is saved before the detail row and before Jev is called, so a
provider timeout, a provider error, a saturated evaluation bound, a failing
detail write, or an unavailable plugin database leaves the already saved
notification in place. Only the structured detail or the Jev result is lost, and
the alert says so through its `evaluationStatus` and `errorCode`, or through the
"details unavailable" message when the row itself is missing.

Scope restore is useful for duplicate deliveries but is not a queue and not a
guarantee against concurrent duplicate inserts.

The Events service may log full event payloads at debug level. Keep debug
logging and its retention policy in mind when alarms contain sensitive details;
module logs contain only validation and stable failure information.

Each alarm causes at most one Jev request when a key is configured and
evaluation capacity is available, one standard Notifications write, and two small
writes to the plugin's own table. A manual re-check in the frontend is one more
user-initiated request through the authenticated `/evaluate` endpoint. Provider
usage, SQS polling, and Notifications storage costs follow the selected
Backstage and AWS plans. Start with one test alarm and an exact TopicArn allowlist before
expanding recipients or alarm volume. The module does not estimate AWS or Jev
pricing.
