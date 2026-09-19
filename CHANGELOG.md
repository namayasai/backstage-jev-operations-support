# Changelog

## 0.3.0 — unreleased

Development version. Not published to npm; 0.2.0 remains the public release.

- Added a `/client` export to the backend package so optional modules reuse the same Jev transport, key, and model.
- Added two optional backend module packages: `-tech-insights` (an opt-in Tech Insights fact retriever) and `-aws-notifications` (CloudWatch → SNS → SQS → Events → Notifications alerts with a receive-time Jev assessment). Both depend on the new `/client` export, so they cannot be installed against the released 0.2.0 backend.
- Added a signature-verified GitHub pull request webhook that evaluates changed Markdown documents.
- Added an AWS alert inbox to the frontend, with a local manual re-check that is not written back to the notification.
- The AWS module stores its structured alert context and receive-time Jev result in one plugin-owned table, `jev_aws_alert_details`, in the Backstage database the host already provides to this plugin. `@backstage/plugin-notifications-backend` (0.6.9) does not persist `payload.metadata`, so structured details require this table. Recipients, inbox identity, titles, alarm reasons, and read/saved state stay with standard Notifications; detail rows are cleaned up after 30 days during ordinary writes, and an alert without them stays visible.
- Added the user-authenticated `GET /api/jev-operations-support/aws-alerts` route in the same optional module. It reads the signed-in user's own notifications from the Notifications backend on their behalf and restores the stored details; the frontend inbox now calls it instead of the standard Notifications list.
- `jevOperationsSupport.demoMode` now also suppresses provider calls from the automatic integrations, which record honest not-evaluated results instead of storing fixtures.
- The AWS receive-time assessment uses the root `jevOperationsSupport.confidenceThreshold`, matching the manual endpoint.

## 0.2.0

Renamed the project to **Jev Operations Support** to make its purpose clear in a Backstage plugin directory and navigation menu.

- Repository: `namayasai/backstage-jev-operations-support`.
- Packages: `@namayasai/backstage-plugin-jev-operations-support`, plus `-backend` and `-common`.
- Backend plugin ID and page route: `jev-operations-support`.
- Configuration section: `jevOperationsSupport`.
- Evaluation permission: `jev-operations-support.evaluate`.
- Verified all six workflows against live Jev from a Backstage 1.55.0 development host, including catalog candidate loading, entity links, and the entity tab.
- Added an explicit route reference and page icon so the new frontend's default sidebar can discover the navigation item.

Users of the 0.1.0 GitHub tarballs must update the package imports, config section, permission policy, and route. The six workflow IDs and request formats are unchanged. Version 0.1.0 was not published to npm.

## 0.1.0

Initial experimental GitHub release with six workflows, authenticated backend, legacy/new frontend extensions, a fixture playground, and live Jev smoke tests.
