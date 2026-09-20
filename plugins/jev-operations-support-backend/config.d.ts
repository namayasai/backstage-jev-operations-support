export interface Config {
  jevOperationsSupport?: {
    /** TypeSafe API key. @visibility secret */
    apiKey?: string;
    /** Exact model ID. Defaults to jev-1.13.0. @visibility backend */
    model?: string;
    /** Explicit synthetic responses; never calls Jev. @visibility backend */
    demoMode?: boolean;
    /** Choice/Score review threshold; separate from Noul probability. @visibility backend */
    confidenceThreshold?: number;
    /** Request timeout, 1000–60000 ms. @visibility backend */
    timeoutMs?: number;
    /** Per-user rate limit per process, 1–120. @visibility backend */
    requestsPerMinute?: number;
    /** Pull request webhook integration. Both secrets and explicit filters are required; omitted means disabled. */
    githubWebhook?: {
      /** GitHub webhook HMAC secret. @visibility secret */
      secret?: string;
      /** GitHub token used only against the fixed `api.github.com` origin: for reads always, and additionally for
       * writing commit statuses (`report: status`) or pull request/issue comments (`report: status+comment`) once
       * reporting is enabled below. @visibility secret */
      token?: string;
      /** Exact case-insensitive owner/name repository allowlist. */
      repositories?: string[];
      /** Markdown path globs such as docs/** or runbooks/*.md. */
      documentationPaths?: string[];
      /** Permit pull requests whose head repository differs from the base repository. Defaults to false. */
      allowForks?: boolean;
      /** Total per-delivery evaluation budget: 1000–8000 ms with `report: none` (this route holds GitHub's webhook
       * connection open the whole time), or 1000–60000 ms once reporting runs in the background. @visibility backend */
      timeoutMs?: number;
      /** Maximum matching Markdown files per delivery, 1–10. @visibility backend */
      maxDocuments?: number;
      /** Where the evaluated result is reported back to GitHub. `none` (the default) matches every guarantee this
       * integration made before this option existed: the result only ever appears in the HTTP response to the
       * webhook itself, and nothing is written to GitHub. `status` additionally writes a commit status on the pull
       * request's head SHA. `status+comment` also creates or updates a single PR comment. This never changes what
       * is read from GitHub or sent to Jev for evaluation — only where the already-computed result is reported.
       * @visibility backend */
      report?: 'none' | 'status' | 'status+comment';
      /** Whether an `attention` finding fails the commit status (`failure` instead of `success`). A `review`
       * (low-confidence) finding never fails it by itself, matching the workbench UI's own advisory-by-default
       * posture. Only meaningful when `report` is `status` or `status+comment`. Defaults to `never`, meaning
       * findings never block a merge — but this is about findings only: a `pending` status while queued, or an
       * `error` status when the check itself could not be completed, are still merge-blocking if this context is
       * marked required in GitHub's own branch protection, regardless of `blockOn`. Do not mark `jev/readiness`
       * required in branch protection unless that is the intended behaviour.
       *
       * **Known limitation:** a commit status is keyed only by (repository, SHA, context) — never by pull request
       * number. Two open pull requests that happen to share a commit (for example a stacked branch, or a
       * fast-forwarded/rebased one) overwrite each other's `jev/readiness` status with no built-in reconciliation:
       * a `failure` from one PR under `blockOn: attention` can be silently replaced by a `success`, an `error`, or
       * the neutral resolution written for the other. Every status description names the originating PR number
       * (e.g. "PR #12 · ...") so this is at least visible rather than silent, but it is not prevented. @visibility backend */
      blockOn?: 'never' | 'attention';
      /** Maximum number of accepted deliveries waiting to be processed in the background, 1–200. Only used when
       * `report` is not `none`; the queue is in-process memory only and is lost on restart, which can also leave a
       * `pending` status on GitHub with no worker left to resolve it. Reporting mode always answers the webhook
       * itself with `202 Accepted`, so GitHub never automatically redelivers a failed report the way it would a
       * `5xx` synchronous response — recovery is a new commit (which starts its own `pending`/final cycle) or a
       * manual Redeliver from GitHub's own delivery UI. @visibility backend */
      queueLength?: number;
      /** Opt-in, off by default: assembles a bounded pull-request summary (title, description, changed-file
       * list, and diff excerpts for allow-listed, non-sensitive paths only) and runs the existing `change-risk`
       * workflow against it once per accepted delivery, alongside readiness. Requires the same repository
       * allowlist and the same `secret`/`token` as the rest of this webhook -- there is no separate opt-in for
       * those. `changeReview.enabled: true` with `report: none` is a startup error: the result would never be
       * visible anywhere, so it is refused rather than silently spending a provider call for nothing.
       *
       * **This whole block is validated strictly at startup, even while `enabled` is left at its default `false`
       * (deliberately, since it is security-relevant -- an operator who mistypes a key here should find out
       * immediately, not have the typo silently ignored):** a non-object value, an unknown key, or an
       * out-of-range `maxFiles`/`maxPatchBytes` all fail the backend at startup, exactly like a malformed
       * `report`/`blockOn`/`queueLength` above does. */
      changeReview?: {
        /** Must be explicitly `true`. Defaults to `false`. @visibility backend */
        enabled?: boolean;
        /** Path globs (same dialect as `documentationPaths`) a changed file's CURRENT AND, for a rename, PREVIOUS
         * name must both match for its diff to be sent. Required, non-empty, when `enabled` is `true` -- a missing
         * filter never means "all files". @visibility backend */
        paths?: string[];
        /** Maximum number of files that get an actual diff excerpt (as opposed to being merely named), 1-50.
         * Defaults to 20. @visibility backend */
        maxFiles?: number;
        /** Total UTF-8 byte budget for the diff-excerpts section, 1000-16000. Defaults to 12000.
         * @visibility backend */
        maxPatchBytes?: number;
      };
    };
  };
}
