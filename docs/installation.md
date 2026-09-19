# Installation

This release has been exercised on Backstage 1.55.0, Node.js 22.23.2, React 18, and Yarn 4.13.0. The frontend provides both the legacy plugin export and a new frontend `/alpha` export; the complete browser-to-Jev run used the new frontend. Use a non-production Backstage instance first.

## Versions

The current release is **0.3.0**, covering all five packages: the frontend, backend, and shared packages in section 1, and the two optional backend modules in section 5. Keep all installed packages on the same 0.3.0 line, because the optional modules import the backend's `/client` export.

## 1. Install packages

The core packages are public on npm. From your Backstage root, add the frontend and backend packages:

```sh
yarn --cwd packages/app add @namayasai/backstage-plugin-jev-operations-support@^0.3.0
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-backend@^0.3.0
```

The shared `@namayasai/backstage-plugin-jev-operations-support-common` package is installed automatically. No custom tarball resolution is required. The host provides React 18, React DOM, and React Router 6.

For an npm-based workspace:

```sh
npm install --workspace packages/app @namayasai/backstage-plugin-jev-operations-support@^0.3.0
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-backend@^0.3.0
```

Source and reproducible tarballs are also available from the [v0.3.0 release](https://github.com/namayasai/backstage-jev-operations-support/releases/tag/v0.3.0).

## 2. Register the backend

In `packages/backend/src/index.ts`:

```ts
backend.add(import('@namayasai/backstage-plugin-jev-operations-support-backend'));
```

In backend configuration:

```yaml
jevOperationsSupport:
  apiKey: ${TYPESAFE_API_KEY}
  model: jev-1.13.0
  confidenceThreshold: 0.8
  timeoutMs: 15000
  requestsPerMinute: 10
```

Supply `TYPESAFE_API_KEY` through your existing secret-management mechanism. Do not put the key in frontend configuration. When the key is absent, evaluations return 503 rather than silently switching to fixtures.

For an explicitly synthetic local demo, omit `apiKey` and set `jevOperationsSupport.demoMode: true`. Responses carry `mode: demo` and the frontend displays a fixture warning. Turn it off for real evaluations. Demo mode also disables the automatic integrations in section 5, even if a key is present. The GitHub webhook refuses evaluation with 503; the Tech Insights retriever and the AWS alert module keep running but record their results as not evaluated. Neither stores demo fixtures as if they were real results.

`confidenceThreshold` is a single setting for the whole installation. The workbench, the GitHub webhook, and the AWS receive-time assessment all summarize with it, so the same text does not get different verdicts on different paths.

## 3. Register the frontend

### New frontend system

Add the plugin explicitly in your app's existing feature list:

```tsx
import jevPlugin from '@namayasai/backstage-plugin-jev-operations-support/alpha';

const app = createApp({
  features: [
    // Existing features, including catalog
    jevPlugin,
  ],
});
```

This adds `/jev-operations-support` and an **Operations Support** entity tab. Preserve the app's existing catalog frontend feature, Catalog API, and route bindings. If your feature discovery already installs this plugin, use one registration mechanism rather than installing it twice.

### Legacy frontend system

In `packages/app/src/App.tsx`, add the page inside your existing `FlatRoutes`:

```tsx
import { JevPage } from '@namayasai/backstage-plugin-jev-operations-support';

<Route path="/jev-operations-support" element={<JevPage />} />
```

Add a navigation item to your existing sidebar using your preferred icon:

```tsx
<SidebarItem icon={YourIcon} to="jev-operations-support" text="Operations Support" />
```

Optionally add an entity tab in `EntityPage.tsx`:

```tsx
import { EntityJevContent } from '@namayasai/backstage-plugin-jev-operations-support';

<EntityLayout.Route path="/jev-operations-support" title="Operations Support">
  <EntityJevContent />
</EntityLayout.Route>
```

The entity tab shows the service ref and description separately from the editable document, which starts empty. Use the TechDocs page path field to load a page through the host `fetchApi` (so the current user's authentication and permissions apply), review or edit the extracted text, and click **Evaluate with Jev** explicitly. Loading a page never evaluates or sends it automatically. The loader removes navigation, headers, scripts, and styles from the HTML; it does not execute or render fetched HTML. It uses the entity's generated TechDocs storage path, or the host's optional `techdocs.storageUrl` when configured. A `backstage.io/techdocs-ref` annotation is shown for context but is not interpreted as a source path. A `backstage.io/techdocs-entity` annotation that points at another entity disables loading until that case is supported. If TechDocs is not installed, the entity workbench still works for pasted text.

## 4. Permissions and data access

The backend registers the basic permission `jev-operations-support.evaluate`, action `create`. Grant it to appropriate users in your existing permission policy. Conditional decisions for this basic permission are not accepted; only `ALLOW` permits a request. The router additionally requires a user principal, so service tokens are not accepted for evaluations.

Catalog candidates are fetched through the user's frontend Catalog API. The plugin does not use a privileged backend catalog token. Check the host Catalog plugin's permission policy to determine which entities users can read.

Submitting a workflow sends the entered text and the candidate descriptions to TypeSafe. The plugin does not persist them, but the host's request logging and TypeSafe's data handling policies still apply. No automatic fetching of arbitrary source URLs occurs.

## 5. Optional modules

All of these are opt-in and inactive until configured. Each has its own guide:

| Integration | Guide |
| --- | --- |
| Tech Insights facts and an example check | [tech-insights.md](tech-insights.md) |
| Signed GitHub pull request Markdown webhook | [github-webhook.md](github-webhook.md) |
| CloudWatch → SNS → SQS → Events → Notifications alerts, with an inbox | [aws-notifications.md](aws-notifications.md) |

The AWS module is the only optional module that stores data. On start-up it runs
one packaged migration against the Backstage database the host already provides
to the `jev-operations-support` plugin, creating the table
`jev_aws_alert_details` (SQLite or PostgreSQL, whichever the host uses). This is
required because `@backstage/plugin-notifications-backend` does not persist
`payload.metadata`. It also adds the user-authenticated route
`GET /api/jev-operations-support/aws-alerts`, which the frontend inbox calls
instead of the standard Notifications list. Both appear only when
`jevOperationsSupport.awsNotifications` is configured; there is no extra setting
for the table or its 30-day retention.

The GitHub webhook is part of the backend package you already installed and needs only configuration. The Tech Insights and AWS modules are separate packages, published on npm at 0.3.0. Install the one you need by name, next to the 0.3.0 backend whose `/client` export it imports:

```sh
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-tech-insights@^0.3.0
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-aws-notifications@^0.3.0
```

For an npm-based workspace:

```sh
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-tech-insights@^0.3.0
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-aws-notifications@^0.3.0
```

The AWS alert inbox comes from the frontend package in section 1, so no extra frontend install is needed.

Local tarballs remain an alternative if you prefer to build from source rather than install from the registry:

```sh
git clone https://github.com/namayasai/backstage-jev-operations-support.git
cd backstage-jev-operations-support
npm ci
npm run pack:plugins
```

That writes five `0.3.0` tarballs to `dist/packages`, which can be installed with `file:` paths. Whichever method you use, keep the modules, the backend, and the common package on the same 0.3.0 version.

## API

`POST /api/jev-operations-support/evaluate`, authenticated via Backstage:

```json
{
  "workflow": "readiness",
  "text": "Start: npm start. Health: GET /health must return 200. Rollback: redeploy the previous image. Escalate to #payments-oncall.",
  "candidates": []
}
```

For `templates`, `ownership`, or `search`, supply 1–20 candidates with `id`, `title`, and `description`; `entityRef` is optional. Candidate IDs must be unique. Context is limited to 16,000 characters and the validated request to 24 KB of UTF-8 JSON, including candidates. The workbench shows the exact UTF-8 byte usage and disables evaluation while over either limit; it never silently truncates loaded or edited text. The HTTP body limit is 32 KB.

`GET /api/jev-operations-support/status` reports mode and configuration availability without exposing the API key. Both routes remain behind the host's normal backend authentication policy.

`GET /api/jev-operations-support/aws-alerts?limit=20&offset=0` exists only when the optional AWS module is installed and configured. It requires a signed-in user (service tokens are refused), returns that user's own `jev-aws-alerts` notifications read from the Notifications backend on their behalf, and restores the stored alarm context and Jev result into `payload.metadata.jevOperationsSupport`. `limit` is 1–50 and `offset` is 0–10000; out-of-range values return 400. When the module is absent the route returns 404 and the inbox shows a setup hint. See [aws-notifications.md](aws-notifications.md).

Errors: 400 invalid input; 401 not signed in; 403 permission denied; 413 oversized body; 429 local rate/concurrency limit; 502 invalid/unreachable provider; 503 unconfigured or overloaded provider. Provider errors never echo the provider response body. The client makes no automatic retry; wait before retrying rate-limited requests.
