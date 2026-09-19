# Jev AWS notifications module

This optional backend module subscribes to an Events topic populated by the
Backstage AWS SQS events module. It validates an SNS envelope and CloudWatch
alarm payload, sends one standard Backstage notification to the configured
group or user entities, and attaches a bounded Jev incident result when a Jev
API key is configured. See [the AWS notifications guide](../../docs/aws-notifications.md).
