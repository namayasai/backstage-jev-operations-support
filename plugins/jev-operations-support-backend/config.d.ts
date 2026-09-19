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
      /** GitHub token used only for fixed-origin API reads. @visibility secret */
      token?: string;
      /** Exact case-insensitive owner/name repository allowlist. */
      repositories?: string[];
      /** Markdown path globs such as docs/** or runbooks/*.md. */
      documentationPaths?: string[];
      /** Permit pull requests whose head repository differs from the base repository. Defaults to false. */
      allowForks?: boolean;
      /** Total synchronous webhook budget, 1000–8000 ms. @visibility backend */
      timeoutMs?: number;
      /** Maximum matching Markdown files per delivery, 1–10. @visibility backend */
      maxDocuments?: number;
    };
  };
}
