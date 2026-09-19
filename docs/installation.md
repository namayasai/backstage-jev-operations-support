# Installation

This release has been exercised on Backstage 1.55.0, Node.js 22.23.2, React 18, and Yarn 4.13.0. The frontend provides both the legacy plugin export and a new frontend `/alpha` export; the complete browser-to-Jev run used the new frontend. Use a non-production Backstage instance first.

## 1. Install packages

The three packages are public on npm. From your Backstage root, add the frontend and backend packages:

```sh
yarn --cwd packages/app add @namayasai/backstage-plugin-jev-operations-support@^0.2.0
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-backend@^0.2.0
```

The shared `@namayasai/backstage-plugin-jev-operations-support-common` package is installed automatically. No custom tarball resolution is required. The host provides React 18, React DOM, and React Router 6.

For an npm-based workspace:

```sh
npm install --workspace packages/app @namayasai/backstage-plugin-jev-operations-support@^0.2.0
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-backend@^0.2.0
```

Source and reproducible tarballs are also available from the [v0.2.0 release](https://github.com/namayasai/backstage-jev-operations-support/releases/tag/v0.2.0).

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

For an explicitly synthetic local demo, omit `apiKey` and set `jevOperationsSupport.demoMode: true`. Responses carry `mode: demo` and the frontend displays a fixture warning. Turn it off for real evaluations.

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

The entity tab seeds the service ref and description. Paste the actual runbook before checking readiness. Moving to another entity clears the previous entity's text and results.

## 4. Permissions and data access

The backend registers the basic permission `jev-operations-support.evaluate`, action `create`. Grant it to appropriate users in your existing permission policy. Conditional decisions for this basic permission are not accepted; only `ALLOW` permits a request. The router additionally requires a user principal, so service tokens are not accepted for evaluations.

Catalog candidates are fetched through the user's frontend Catalog API. The plugin does not use a privileged backend catalog token. Check the host Catalog plugin's permission policy to determine which entities users can read.

Submitting a workflow sends the entered text and the candidate descriptions to TypeSafe. The plugin does not persist them, but the host's request logging and TypeSafe's data handling policies still apply. No automatic fetching of arbitrary source URLs occurs.

## API

`POST /api/jev-operations-support/evaluate`, authenticated via Backstage:

```json
{
  "workflow": "readiness",
  "text": "Start: npm start. Health: GET /health must return 200. Rollback: redeploy the previous image. Escalate to #payments-oncall.",
  "candidates": []
}
```

For `templates`, `ownership`, or `search`, supply 1–20 candidates with `id`, `title`, and `description`; `entityRef` is optional. Candidate IDs must be unique. Context is limited to 16,000 characters and the validated request to 24 KB of UTF-8 JSON. The HTTP body limit is 32 KB.

`GET /api/jev-operations-support/status` reports mode and configuration availability without exposing the API key. Both routes remain behind the host's normal backend authentication policy.

Errors: 400 invalid input; 401 not signed in; 403 permission denied; 413 oversized body; 429 local rate/concurrency limit; 502 invalid/unreachable provider; 503 unconfigured or overloaded provider. Provider errors never echo the provider response body. The client makes no automatic retry; wait before retrying rate-limited requests.
