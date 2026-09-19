# GitHub pull request webhook

The backend can synchronously evaluate changed Markdown documents from selected GitHub pull requests with the readiness workflow. The endpoint is disabled unless both the webhook HMAC secret and GitHub API token are configured, and it also requires an explicit repository allowlist and Markdown path filter.

```yaml
jevOperationsSupport:
  apiKey: ${TYPESAFE_API_KEY}
  githubWebhook:
    secret: ${JEV_GITHUB_WEBHOOK_SECRET}
    token: ${JEV_GITHUB_READ_TOKEN}
    repositories:
      - acme/payments
    documentationPaths:
      - docs/**/*.md
      - runbooks/*.md
    # Forks are refused unless this is explicitly true.
    allowForks: false
```

Configure GitHub to send `pull_request` events to `/api/jev-operations-support/webhooks/github` with the same secret. Only `opened`, `reopened`, `synchronize`, and `ready_for_review` actions are evaluated. The handler verifies `X-Hub-Signature-256` over the raw request bytes before parsing JSON. It does not use Backstage user authentication for this route; the configured signature is the authentication boundary. The existing `/evaluate` endpoint continues to require a signed-in user and the Jev permission.

The handler accepts only an exact, case-insensitive repository allowlist entry. `documentationPaths` uses simple glob patterns: `*` matches characters within one path segment, `**` matches nested path segments, and `?` matches one character. Only `.md`, `.mdx`, and `.markdown` files matching one of these patterns are read. A missing filter never means “all files.” Fork heads are refused by default. If forks are explicitly enabled, the contents are read from the event's head repository at the pinned head SHA.

For an accepted delivery, the backend reads the pull request metadata, checks that the event head and base SHAs still match, lists changed files through the paginated GitHub pull request files API, and reads matching contents from the GitHub contents API at that head SHA. It checks the pull request head and base again before evaluation. Payload URLs are never fetched. Each matching Markdown file is evaluated separately with the existing `buildEvaluation` and `summarize` functions using the `readiness` workflow, and the response contains a result for each path. `change-risk` is not inferred from a pull request and no change is marked safe. The backend does not post comments or write Checks.

The default limits are deliberately small: an 8-second end-to-end deadline, one concurrent webhook evaluation, 256 KiB raw body, 3 matching documents, 300 changed files, 3 GitHub file-list pages, 128 KiB per document, and 16,000 decoded bytes across one readiness context. The deadline and matching-document count can be adjusted in backend config; the other workload limits are fixed in this integration. Limit violations return `422` with an explicit limit error and do not invoke Jev. GitHub API, Jev, and deadline failures return `503` (or a sanitized provider status) with `retry: manual`. If a later document fails after an earlier document succeeds, the response is `503` with `partial: true`; the delivery remains eligible for manual redelivery.

Delivery IDs are deduplicated in process memory with a bounded map and a ten-minute default TTL. A successful or intentionally ignored delivery is remembered; failed deliveries are removed so a manual redelivery can run after a configuration or provider fix. A duplicate already in progress receives `503` with `Retry-After`. The dedupe map is lost when the backend restarts, and there is no persistent queue or scheduler. Because this synchronous route has no durable retry worker, operators should use GitHub's delivery redelivery action after a `503` response.

Logs and HTTP errors do not include webhook secrets, GitHub tokens, request bodies, or Markdown contents. The GitHub token needs read access to the configured repositories and is used only for the fixed `api.github.com` origin.
