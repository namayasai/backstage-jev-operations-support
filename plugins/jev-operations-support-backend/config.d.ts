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
  };
}
