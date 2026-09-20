# Tech Insights and Jev

The optional `@namayasai/backstage-plugin-jev-operations-support-tech-insights`
package registers one Backstage Community Tech Insights fact retriever. It uses
the Tech Insights scheduler and store, and reuses the existing Jev client and
`readiness` workflow. It does not add an evaluation endpoint, database, queue,
or score engine.

**Upgrade note:** readiness facts written by 0.3.0 were keyed with the
entity's original casing; after this release they are keyed canonically
(lower-cased), which is what every Tech Insights read path already sends.
Facts written before the upgrade are not read back — the next scheduled run
repopulates them.

Install the Tech Insights backend and this module in the Backstage backend:

```bash
yarn --cwd packages/backend add \
  @backstage-community/plugin-tech-insights-backend \
  @backstage-community/plugin-tech-insights-backend-module-jsonfc \
  @namayasai/backstage-plugin-jev-operations-support-backend \
  @namayasai/backstage-plugin-jev-operations-support-tech-insights
```

```ts
// packages/backend/src/index.ts
backend.add(import('@backstage-community/plugin-tech-insights-backend'));
backend.add(import('@backstage-community/plugin-tech-insights-backend-module-jsonfc'));
backend.add(import('@namayasai/backstage-plugin-jev-operations-support-tech-insights'));
```

The module is inactive until its retriever is registered under Tech Insights.
The entity annotation is also an explicit opt-in, so an entire catalog is never
sent to Jev by default:

```yaml
jevOperationsSupport:
  apiKey: ${TYPESAFE_JEV_API_KEY}
  model: jev-1.13.0
  techInsights:
    maxEntities: 50
    maxDocumentBytes: 12000
    timeoutMs: 15000
    concurrency: 4
    # Private sources are blocked unless this is explicitly true.
    allowPrivateDocuments: false

techInsights:
  factRetrievers:
    jevTechInsightsFactRetriever:
      cadence: '0 * * * *'
      timeout: { seconds: 90 }
      lifecycle: { timeToLive: { days: 7 } }
```

Opt a component in with a source URL and a visibility declaration. The source
is fetched through Backstage's `UrlReaderService`, so the configured
integration and host allowlist remain in charge of access:

```yaml
metadata:
  annotations:
    jev.backstage.io/tech-insights: 'true'
    jev.backstage.io/tech-insights-source: https://docs.example.com/services/payments.md
    jev.backstage.io/tech-insights-source-visibility: public
```

When the root `jevOperationsSupport.demoMode` is `true`, the retriever still runs
on its schedule but makes no provider call, even if `apiKey` is set, and no
document is read. Every opted-in entity gets an honest not-evaluated fact with
`errorCode: jev-demo-mode`. Demo fixture scores are never stored as facts, so a
demo installation cannot produce Tech Insights rows that look like real
evaluations. Turn demo mode off to collect live evidence.

Use `private` for a document that requires credentials. It is skipped with
`private-source-not-allowed` unless `allowPrivateDocuments: true` is set by the
Backstage operator. URLs are restricted to HTTPS, query strings and fragments
are removed before the source is stored, and document contents are never
stored in a fact or logged. `entityRefs` can be configured when a fixed list of
entities is preferred; otherwise one bounded catalog page is queried for
components with the opt-in annotation.

The fact deliberately carries independent state fields. A successful result
has `fetchStatus: fetched`, `evaluationStatus: evaluated`, and an
`evidenceStatus` of `pass`, `review`, or `attention`. Missing source, blocked
private source, size or timeout failure, missing API key, demo mode, and provider
errors use `evidenceStatus: not-evaluated`; their `errorCode` explains the stable
failure class. The retriever never turns an unavailable document into a zero
score or a passing result. `coverage` is the fraction of defined checks that
produced findings, not a confidence score. The row timestamp, `evaluatedAt`,
model, and sanitized source identify when and what was evaluated.

For JSON rules checks, inspect the state before evidence. For example, a check
can require an evaluated pass without treating a fetch failure as a failed
service-health check:

```yaml
techInsights:
  factChecker:
    checks:
      jevReadinessEvidence:
        type: json-rules-engine
        name: Jev readiness evidence
        description: Marks the evidence check true only when a readiness result was evaluated and passed.
        factIds: [jevTechInsightsFactRetriever]
        rule:
          conditions:
            all:
              - fact: evaluationStatus
                operator: equal
                value: evaluated
              - fact: evidenceStatus
                operator: equal
                value: pass
```

This boolean check is an evidence condition; it is not a health score. A
consumer that aggregates service health should exclude facts whose
`evaluationStatus` is `not-evaluated` or `error` instead of treating the
condition's false result as a service failure.

`timeoutMs` is one deadline per entity for both stages. It cancels the
`UrlReaderService` read and destroys a stalled document stream, and it is passed
to the shared Jev client so the provider request is cancelled too instead of
being left running. Each entity keeps its own result: a missing, empty,
malformed, or oversized document produces an error fact for that entity only and
never ends the retrieval for the others.

If a source cannot be read, inspect the retriever logs and the latest fact's
`fetchStatus` and `errorCode`. If Jev rejects or times out, the fact records an
evaluation error and retains no provider response body. A catalog or scheduler
failure can leave the previous Tech Insights row in place until the next
successful retriever run, so consumers should check the fact timestamp and
coverage as well as the evidence state.

Each scheduled evaluation sends the selected document to the configured Jev
provider and therefore consumes the provider plan's request and token budget.
The retriever has bounded entity count, document bytes, timeout, and
concurrency controls, but it cannot estimate provider pricing or guarantee a
fixed bill. Start with a small opt-in set and a slow cadence; review the
provider's current pricing and retention terms before enabling private
documents.

## Ownerless-entity owner suggestion

The module also registers a second, independent fact retriever,
`jevOwnerSuggestionFactRetriever`, that suggests a responsible catalog Group
for entities that appear to have no real owner. It is off by default:

```yaml
jevOperationsSupport:
  techInsights:
    ownerSuggestion:
      enabled: true
      maxEntities: 20
      kinds: [Component, API, Resource, System]
      unownedValues: ['unknown', 'guests', 'group:default/guests', '']
      maxGroups: 20
      maxScannedEntities: 2000

techInsights:
  factRetrievers:
    jevOwnerSuggestionFactRetriever:
      cadence: '0 3 * * *'
      timeout: { seconds: 120 }
      lifecycle: { timeToLive: { days: 7 } }
```

**It never writes `spec.owner`.** It reads it to decide whether
an entity qualifies, and it only ever writes a suggestion into a Tech Insights
fact row; the catalog entity itself is never modified.

**Every Tech Insights fact — this retriever's rows included — is readable by
anyone with the Tech Insights `read` permission, independent of catalog entity
permissions.** A suggestion names a Group (its ref and title) purely from this
retriever's own read of the catalog; a viewer with Tech Insights read access
can see that name even for a Group they could not otherwise read through the
catalog. Scope the Tech Insights `read` permission accordingly if that matters
for your installation.

### Selection: scanning, then a rotating window

Selection happens in two stages, deliberately in this order, so a large
catalog cannot silently starve entities that happen to sort late:

1. **Scan.** Every run pages through up to `maxScannedEntities` catalog
   entities of the configured `kinds` — cursor-paginated (`CatalogClient.queryEntities`,
   which stays stable page to page even under concurrent catalog writes, unlike
   an offset that can skip or repeat rows), in ascending kind/namespace/name
   order, one auth token for the whole scan — and classifies each one locally
   (no catalog call per entity) into one of:
   - **unowned**: `spec.owner` missing, empty, or matching one of
     `unownedValues` case-insensitively — compared both as written and as a
     normalised `group:namespace/name` ref, so `unknown`, `Unknown`, and
     `group:default/unknown` (if listed) are all recognised the same way. A
     missing or empty owner is always treated as unowned, regardless of
     `unownedValues`.
   - **a candidate dangling Group ref**: `spec.owner` parses as a Group
     reference, but its existence has not been checked yet.
   - **owned**: a real, non-Group owner (User, or anything else), or a value
     that does not parse as an entity ref at all — never a candidate.

   Because `maxEntities` is *not* applied to this scan, an ownerless entity
   is reached regardless of where it sorts among the catalog's `kinds` — up
   to the `maxScannedEntities` bound, past which no run of this retriever
   reaches it at all (raise `maxScannedEntities` above your catalog's total
   count of `kinds` to guarantee full coverage). When a run's scan is cut off
   by this bound, a single count-only log line records it (`scanned` and
   `maxScannedEntities`, no entity content).

2. **Select a rotating window.** From everything the scan found (unowned and
   candidate-dangling together), at most `maxEntities` are actually selected
   for this run. When there are more candidates than `maxEntities`, which
   slice is selected rotates by a full `maxEntities`-sized step per calendar
   day (UTC) — day 0 covers candidates `[0, maxEntities)`, day 1 covers
   `[maxEntities, 2*maxEntities)`, and so on around the (circular) list — so
   `ceil(candidates / maxEntities)` consecutive days' runs together cover
   every candidate, each evaluated close to once per cycle, instead of the
   same first `maxEntities` (in scan order) forever. **Rotation advances once
   per UTC day**, so a scheduled cadence faster than daily re-evaluates the
   same window until the day rolls over — pair this retriever with a
   daily-or-slower cadence.

Only *within that selected window* does the retriever do the two remaining
catalog reads: a **single batched lookup** to resolve every candidate
dangling Group ref in the window (one call total, for however many distinct
Group refs the window references — never one call per entity), and a second
batched read of the window's own full entity records (title, description,
tags, type, lifecycle, system) to build the Jev request. If the dangling-ref
lookup itself fails, the affected window entities are **not** guessed to be
either owned or unowned — and, because an owner that merely *parses* as a
Group ref may still be a real, existing owner, **no fact row is written for
them at all** (a single log line records how many were skipped, with no
entity content in it). Unowned-by-value entities in the same window are
unaffected, since their selection never depended on that lookup.

An entity whose owner is a real, existing Group — or a real User, or any
other non-Group reference — gets **no fact row at all** from this retriever,
not a "not needed" row. Only entities that actually need a suggestion produce
one, so the fact table only ever grows with the retriever's real cost, not
with every entity it looked at.

### What is sent, and the cost per run

For each selected entity, the request sent to Jev is:

- **Context text**: the entity's own name, title, description, tags, kind,
  type, lifecycle, and system, in a fixed format. **Never documentation
  content** — this retriever does not read TechDocs, a runbook, or any other
  document source; it is a separate call from the readiness retriever above.
- **Candidates**: up to `maxGroups` catalog Group entities, mapped to Jev
  candidates the same way the optional AWS notifications module's owner
  suggestion does (their title, description, and tags), shortened or
  dropped from the tail to fit the shared evaluation budget when necessary.

This costs **at most `maxEntities` additional Jev provider calls per
scheduled run** (never more, and fewer whenever the scan finds fewer
ownerless candidates than that), on top of whatever the readiness retriever
above costs. Catalog reads per run are bounded by `maxScannedEntities` for
the scan itself, plus at most two further batched calls (dangling-ref
resolution, full entity re-fetch) scoped to the selected window, plus one for
the Group candidate pool. Start with a small `maxEntities` and a slow cadence
for the same reason as above.

### Facts

The fact stores, per entity:

| Fact | Meaning |
| --- | --- |
| `evaluationStatus` | `evaluated`, `failed`, or `not-evaluated`. |
| `selection` | `unowned` or `owner-not-found` — *why the entity was selected*. Always present, evaluated or not, since selection happens before the Jev call. |
| `reason` | Closed set of failure/not-evaluated codes (`jev-not-configured`, `jev-demo-mode`, `catalog-unavailable`, `no-catalog-groups`, `invalid-owner-request`, `jev-busy`, `jev-timeout`, `jev-error`, `retriever-error`) explaining why no suggestion was produced. The empty string when `evaluationStatus` is `evaluated`. |
| `checkedOwner` | The raw `spec.owner` value this row was actually computed for, empty when the entity had no owner set. Lets a consumer (including `EntityJevOwnerSuggestionCard`, see [installation.md](installation.md)) detect a row that no longer matches the entity's *current* owner. |
| `suggestedOwnerRef` / `suggestedOwnerTitle` | The suggested Group's catalog ref and title. Both empty when Jev found no confident match ("none", or below the confidence threshold). |
| `confidence` | Model confidence in the suggestion, `0` when not evaluated. |
| `needsReview` | `true` when the suggestion is low-confidence or absent. |
| `candidateCount` | How many Group candidates were actually sent for this entity. |
| `shortened` | `true` when candidate descriptions were shortened, or candidates dropped, to fit the evaluation budget. |
| `model` / `evaluatedAt` | Same meaning as the readiness retriever's fields. |

`selection` and `reason` used to be a single combined field; they are now
separate so a boolean check can tell "why was this entity picked up" apart
from "did evaluation actually produce a suggestion" without string-matching
one field for two different meanings:

This example checks specifically use `selection`, not just `evaluationStatus`/
`suggestedOwnerRef`, so it only fires for entities with **no owner set at all**
— not for an owner that merely points at a dangling Group reference, which
usually calls for a different remediation (fix the ref, or create the Group)
rather than "assign this to the suggested team":

```yaml
techInsights:
  factChecker:
    checks:
      jevOwnerSuggestionForUnownedEntity:
        type: json-rules-engine
        name: Confident suggestion for an entity with no owner at all
        description: Marks true only for entities with spec.owner missing or empty (not a dangling Group reference) where Jev produced a confident suggestion.
        factIds: [jevOwnerSuggestionFactRetriever]
        rule:
          conditions:
            all:
              - fact: selection
                operator: equal
                value: unowned
              - fact: evaluationStatus
                operator: equal
                value: evaluated
              - fact: suggestedOwnerRef
                operator: notEqual
                value: ''
```

Demo mode and a missing API key behave exactly as they do for the readiness
retriever: every selected entity gets an honest not-evaluated fact
(`reason: jev-demo-mode` or `jev-not-configured`) instead of a real
evaluation, and no demo fixture is ever stored as a fact.
