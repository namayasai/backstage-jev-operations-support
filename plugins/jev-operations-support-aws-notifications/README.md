# Jev AWS notifications module

This optional backend module subscribes to an Events topic populated by the
Backstage AWS SQS events module. It validates an SNS envelope and CloudWatch
alarm payload, saves one standard Backstage notification to the configured
group or user entities under the fixed `jev-aws-alerts` topic, and then records
a Jev incident result when a Jev API key is configured and the per-process
evaluation bound has capacity.

Because `@backstage/plugin-notifications-backend` does not persist
`payload.metadata`, the alarm context and the Jev result are kept in one
plugin-owned table (`jev_aws_alert_details`) in the Backstage database the host
already provides to the `jev-operations-support` plugin, created by the packaged
migration in `migrations/`. The module also adds the user-authenticated route
`GET /api/jev-operations-support/aws-alerts`, which returns the signed-in user's
own alert notifications with those details restored. Detail rows are kept for 30
days; an alert without them stays visible.

It requires the parent
`@namayasai/backstage-plugin-jev-operations-support-backend` plugin. See
[the AWS notifications guide](../../docs/aws-notifications.md).
