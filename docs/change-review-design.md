# Change review (design note — superseded)

This note described the pure core (`plugins/jev-operations-support-backend/src/changeReview.ts`) before it was wired into the GitHub webhook. It has been folded into the real documentation now that the wiring landed:

- Configuration, exactly what is sent and never sent, status semantics, comment contents, and privacy/cost notes: see the "Change review" section of [`docs/github-webhook.md`](github-webhook.md).
- The content-assembly and privacy rules themselves (the path allowlist, the sensitive-path heuristic, budget/truncation, Unicode/bidi handling) are documented in full in `changeReview.ts`'s own module doc comment, which remains the authoritative source — this file no longer duplicates it.

This file is kept only as a pointer for anyone who still has the old path bookmarked.
