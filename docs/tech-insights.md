# Tech Insights and Jev

The optional `@namayasai/backstage-plugin-jev-operations-support-tech-insights`
package registers one Backstage Community Tech Insights fact retriever. It uses
the Tech Insights scheduler and store, and reuses the existing Jev client and
`readiness` workflow. It does not add an evaluation endpoint, database, queue,
or score engine.

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
