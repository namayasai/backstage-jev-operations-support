# Installation

This release has been exercised on Backstage 1.55.0, Node.js 22.23.2, React 18, and Yarn 4.13.0. The frontend provides both the legacy plugin export and a new frontend `/alpha` export; the complete browser-to-Jev run used the new frontend. Use a non-production Backstage instance first.

## Versions

The current release is **0.4.0**, covering all five packages: the frontend, backend, and shared packages in section 1, and the two optional backend modules in section 5. Keep all installed packages on the same 0.4.0 line, because the optional modules import the backend's `/client` export.

## 1. Install packages

The core packages are public on npm. From your Backstage root, add the frontend and backend packages:

```sh
yarn --cwd packages/app add @namayasai/backstage-plugin-jev-operations-support@^0.4.0
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-backend@^0.4.0
```

The shared `@namayasai/backstage-plugin-jev-operations-support-common` package is installed automatically. No custom tarball resolution is required. The host provides React 18, React DOM, and React Router 6.

For an npm-based workspace:

```sh
npm install --workspace packages/app @namayasai/backstage-plugin-jev-operations-support@^0.4.0
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-backend@^0.4.0
```

Source and reproducible tarballs are also available from the [v0.4.0 release](https://github.com/namayasai/backstage-jev-operations-support/releases/tag/v0.4.0).

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

This adds separate **Alerts** (`/jev-alerts`), **Triage** (`/jev-triage`), and **Pre-check** (`/jev-operations-support`) sidebar pages, plus an **Operations Support** entity tab. Preserve the app's existing catalog frontend feature, Catalog API, and route bindings. If your feature discovery already installs this plugin, use one registration mechanism rather than installing it twice.

`jevPlugin` also registers two read-only entity cards, `EntityCardBlueprint` extensions with the full ids `entity-card:jev-operations-support/readiness` and `entity-card:jev-operations-support/owner-suggestion` (each with its own `filter`: the readiness card to `Component`, matching its default `targetKinds`; the owner card to `Component`/`API`/`Resource`/`System`, matching the owner-suggestion retriever's default `kinds`). If your app disables or reconfigures them, use these full ids. They read the latest result the optional Tech Insights module (section 5) already computed on its own schedule; they never call `/evaluate` themselves. Both are silent (no error styling) when the Tech Insights module is not installed.

**Limitation on this frontend system:** `EntityJevOwnerSuggestionCard`'s `unownedValues` prop (see the legacy section below for what it is for) cannot currently be supplied through app-config on the new frontend system. Wiring it through would need the blueprint's `configSchema` option, which the installed `@backstage/frontend-plugin-api` requires to be a Zod v4 schema — this repository (and its common package) is on Zod v3, and mixing Zod major versions in one frontend package for a single optional prop was judged not worth it. If your backend's `ownerSuggestion.unownedValues` is customised, override this extension yourself with `EntityCardBlueprint.makeWithOverrides` (once your app is on Zod v4), or render `EntityJevOwnerSuggestionCard` directly with the prop from a custom card of your own instead of using the packaged `/alpha` extension.

### Legacy frontend system

In `packages/app/src/App.tsx`, add the page inside your existing `FlatRoutes`:

```tsx
import { JevPage, JevAlertsPage, JevTriagePage } from '@namayasai/backstage-plugin-jev-operations-support';

<Route path="/jev-operations-support" element={<JevPage />} />
<Route path="/jev-alerts" element={<JevAlertsPage />} />
<Route path="/jev-triage" element={<JevTriagePage />} />
```

Add a navigation item to your existing sidebar using your preferred icon:

```tsx
<SidebarItem icon={YourAlertIcon} to="jev-alerts" text="Alerts" />
<SidebarItem icon={YourReportIcon} to="jev-triage" text="Triage" />
<SidebarItem icon={YourIcon} to="jev-operations-support" text="Pre-check" />
```

Optionally add an entity tab in `EntityPage.tsx`:

```tsx
import { EntityJevContent } from '@namayasai/backstage-plugin-jev-operations-support';

<EntityLayout.Route path="/jev-operations-support" title="Operations Support">
  <EntityJevContent />
</EntityLayout.Route>
```

The entity tab shows the service ref and description separately from the editable document, which starts empty. Use the TechDocs page path field to load a page through the host `fetchApi` (so the current user's authentication and permissions apply), review or edit the extracted text, and click **Run pre-check** explicitly. Loading a page never evaluates or sends it automatically. The loader removes navigation, headers, scripts, and styles from the HTML; it does not execute or render fetched HTML. It uses the entity's generated TechDocs storage path, or the host's optional `techdocs.storageUrl` when configured. A `backstage.io/techdocs-ref` annotation is shown for context but is not interpreted as a source path. A `backstage.io/techdocs-entity` annotation that points at another entity disables loading until that case is supported. If TechDocs is not installed, the entity workbench still works for pasted text.

Two read-only cards, `EntityJevReadinessCard` and `EntityJevOwnerSuggestionCard`, are also exported for `EntityPage.tsx`. Unlike the entity tab above, neither triggers an evaluation — there is no Live switch and no "Check now" — they only show the *latest scheduled* result from the optional Tech Insights module (section 5):

```tsx
import { EntityJevReadinessCard, EntityJevOwnerSuggestionCard } from '@namayasai/backstage-plugin-jev-operations-support';

<EntitySwitch>
  <EntitySwitch.Case>
    <Grid item md={6}>
      <EntityJevReadinessCard />
    </Grid>
    <Grid item md={6}>
      <EntityJevOwnerSuggestionCard />
    </Grid>
  </EntitySwitch.Case>
</EntitySwitch>
```

`EntityJevOwnerSuggestionCard` renders nothing when the entity has no owner-suggestion fact row (the common case: an entity with a real, existing owner never gets one), and also nothing for a row that no longer matches the entity's *current* `spec.owner` (a stale row from before the owner was set or changed) — it always re-derives "why was this entity picked up" from the live catalog entity, never from the stored row alone. For the one case that would otherwise assert a catalog fact that could have gone stale between scheduled runs (an unchanged dangling-Group row), it additionally confirms live, through the Catalog API, that the Group still does not exist before saying so. If your backend's `jevOperationsSupport.techInsights.ownerSuggestion.unownedValues` is customised, pass the identical list as this card's `unownedValues` prop — the card has no way to read backend configuration, and it must apply the exact same "is this owner real" rule the retriever used, or it can mislabel a row. Both cards are silent, not an error, when the Tech Insights backend or the Jev Tech Insights module is not installed. Every Tech Insights fact, including a suggested Group's ref and title, is readable by anyone with the Tech Insights `read` permission regardless of catalog entity permissions; see [tech-insights.md](tech-insights.md).

## Search and Scaffolder integrations

These two components live in the frontend package you already installed in section 1, as
separate subpath exports so a host that uses neither never loads `@backstage/plugin-search-react`.
Both use the same shared Live preference (and `/evaluate` call) as the rest of the plugin.

### Reranked search results (`/search` subpath)

`JevRerankedResults` reorders the top of a search result list by how directly each result
answers the query, using the `search` workflow. It needs
`@backstage/plugin-search-react` — an **optional peer dependency** of this package — so add it
alongside the host's own search frontend if it is not already installed:

```sh
yarn --cwd packages/app add @backstage/plugin-search-react
```

It is used inside the host's `SearchContextProvider` (its own search page), in place of
`<SearchResult>`. The host keeps its own item rendering; a common choice is
`SearchResultListItemExtensions`, which renders each result through the search result list
item extensions the host has installed:

```tsx
import { JevRerankedResults } from '@namayasai/backstage-plugin-jev-operations-support/search';
import { SearchResultListItemExtensions } from '@backstage/plugin-search-react';

// In place of:
//   <SearchResult>{({ results }) => <SearchResultListItemExtensions results={results} />}</SearchResult>
<JevRerankedResults>
  {results => <SearchResultListItemExtensions results={results} />}
</JevRerankedResults>
```

**Disclosure: with this component installed, choosing "Rank now" — or turning on Live, which is
off by default and opt-in per reader — sends the query, and the indexed title and an excerpt of
the body text of the top results, to TypeSafe through your Backstage backend.** Search indexes
commonly include content from documentation the reader would not otherwise be able to read
directly (private TechDocs, restricted catalog entries indexed for search); when a reader does
turn Live on, or chooses "Rank now", this component sends an excerpt of that indexed content off
to TypeSafe for that search. A host that wants to rule this out entirely can pass `live={false}`
to force automatic sends off for this component regardless of the reader's preference, leaving
only an explicit "Rank now"; otherwise each reader's own Live switch decides for themselves,
remembered per browser. The `jev-operations-support.evaluate` permission and the backend's
evaluation rate limit still apply to every one of these calls, the same as any other workflow.

Results render in the search engine's own order immediately, and only reorder once Jev's
scores for that exact query and that exact shortlist have been applied to at least one of the
current results. Every other state says so plainly in a caption next to the Live switch instead
of claiming a reorder that did not happen:

- A question shorter than 10 characters, or one over the schema's 16,000-character limit or so
  long that even a title-only candidate cannot fit alongside it — both over-long cases read as
  "This question is too long to rank results against." The shared 24,000-byte evaluation budget
  is otherwise never reachable as a blocker here: the shortlist is always fitted under it first
  (see below), so a request that fails to build for search fails only for one of these two
  length reasons.
- Waiting for the quiet period to elapse, or Live turned off (with its own "Rank now" button).
- A failed check ("Jev will retry automatically" once a retry is scheduled).
- Scores landed for the current question and shortlist but did not match a reorder to apply —
  "Jev's scores could not be matched to these results.", distinct from still waiting on a check.
- A reorder that did apply, captioned "Reordered by Jev for relevance to your question", with any
  of the following folded in when they apply, combined rather than one hiding another: shortened
  excerpts ("…, using shortened excerpts", or "Reordered by Jev — low confidence for some
  results; shortened excerpts were used" once low confidence applies too), low confidence for
  some results ("Reordered by Jev — low confidence for some results"), and fewer of the head
  results scored than are in the head ("Reordered by Jev — N of M results ranked").

The caption and Live switch are shown in every one of those states; the only states with **no**
caption and **no** Live switch are while the underlying Backstage search itself is still loading
or has errored, or while it has returned zero results (including an untouched search box) — in
all three, the host's own result rendering is shown untouched, with nothing to say about ranking.
`limit` (default and maximum 20) caps how many of the top engine results Jev is asked to rank;
when there are enough results and long enough descriptions to exceed the shared 24,000-byte
evaluation budget, descriptions are shortened first to stay under it, and the caption says so
briefly when that shortlist was the one actually used to reorder. Only if even title-only
candidates do not fit are results dropped from the tail; and if even a single title-only
candidate does not fit alongside the query itself, nothing is sent and the caption says the
question is too long to rank results against.

### Template advisor (`/scaffolder` subpath)

`JevTemplateAdvisor` is a self-contained card — "Which template fits?" — that loads up to 20
catalog `Template` entities and recommends one for what the reader describes, using the
`templates` workflow. It has no dependency on Scaffolder packages: it only needs the catalog
(already required by this plugin) and a link to the chosen template's own creation page. Place
it wherever it is useful to the reader — a custom "Create" landing page, or the app's home
page — since this release does not inject it into the stock `/create` page:

```tsx
import { JevTemplateAdvisor } from '@namayasai/backstage-plugin-jev-operations-support/scaffolder';

<JevTemplateAdvisor />
```

By default, a recommended template links to `/create/templates/${namespace}/${name}`, which
assumes the stock Scaffolder route is mounted at `/create`; pass `templateHref` to point
elsewhere if your Scaffolder route differs, or if you have not mounted the stock route at all.
When Jev's answer is "none", the card says plainly that no listed template fits and links
nothing; when Jev recommends a candidate whose catalog reference cannot be parsed, the card
says that plainly too instead of silently showing nothing.

Like `JevRerankedResults`, this card shares the reader's Live preference; pass `live={false}`
to force automatic sends off for this component regardless of that preference.

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

The GitHub webhook is part of the backend package you already installed and needs only configuration. The Tech Insights and AWS modules are separate packages, published on npm at 0.4.0. Install the one you need by name, next to the 0.4.0 backend whose `/client` export it imports:

```sh
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-tech-insights@^0.4.0
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-aws-notifications@^0.4.0
```

For an npm-based workspace:

```sh
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-tech-insights@^0.4.0
npm install --workspace packages/backend @namayasai/backstage-plugin-jev-operations-support-aws-notifications@^0.4.0
```

The AWS alert inbox comes from the frontend package in section 1, so no extra frontend install is needed.

Local tarballs remain an alternative if you prefer to build from source rather than install from the registry:

```sh
git clone https://github.com/namayasai/backstage-jev-operations-support.git
cd backstage-jev-operations-support
npm ci
npm run pack:plugins
```

That writes five `0.4.0` tarballs to `dist/packages`, which can be installed with `file:` paths. Whichever method you use, keep the modules, the backend, and the common package on the same 0.4.0 version.

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

## Optional response-planning LLM

After incident triage, generate response options with OpenAI, Claude, or an OpenAI-compatible API. Configure the separate server-side key and model as described in [Incident response suggestions](response-planning.md).
