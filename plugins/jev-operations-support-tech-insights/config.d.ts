export interface Config {
  jevOperationsSupport?: {
    techInsights?: {
      /** Maximum number of explicitly opted-in entities evaluated per run. @visibility backend */
      maxEntities?: number;
      /** Maximum UTF-8 bytes read from each source document. @visibility backend */
      maxDocumentBytes?: number;
      /** Per-source read and Jev request deadline in milliseconds. @visibility backend */
      timeoutMs?: number;
      /** Maximum number of source documents evaluated at once. @visibility backend */
      concurrency?: number;
      /** Explicitly permit sources declared private by the entity annotation. @visibility backend */
      allowPrivateDocuments?: boolean;
      /** Optional fixed list of catalog entity refs. @visibility backend */
      entityRefs?: string[];
      /** Catalog kinds considered when entityRefs is not set. @visibility backend */
      targetKinds?: string[];
      /** Optional model override. @visibility backend */
      model?: string;
      ownerSuggestion?: {
        /**
         * Turns on the second fact retriever that suggests an owner Group for
         * entities with no real owner. Off by default. When on, it costs at most
         * one Jev provider call per selected ownerless entity per scheduled run
         * (never more than maxEntities calls per run). The suggestion is sent
         * only the entity's name, title, description, tags, kind, type,
         * lifecycle, and system — never documentation content — plus up to
         * `maxGroups` catalog Group titles, descriptions, and tags as candidates.
         * It never reads or writes `spec.owner`; the result is stored only as a
         * Tech Insights fact.
         * @visibility backend
         */
        enabled?: boolean;
        /**
         * Maximum number of ownerless entities evaluated per run (also the
         * number of Jev provider calls this feature costs per run, at most).
         * When the catalog has more ownerless entities of `kinds` than this,
         * which entities are selected rotates by a full maxEntities-sized step
         * once per UTC calendar day, so a large ownerless population is fully
         * covered within ceil(ownerlessCount / maxEntities) days instead of
         * stalling on the same entities forever. Rotation advances once per
         * UTC day, so a cadence faster than daily re-evaluates the same
         * window; pair this retriever with a daily-or-slower cadence.
         * @visibility backend
         */
        maxEntities?: number;
        /** Catalog kinds considered for an owner suggestion. @visibility backend */
        kinds?: string[];
        /**
         * Values of `spec.owner` treated as "no real owner", compared
         * case-insensitively both as written and as a normalised
         * `group:namespace/name` ref. An empty or missing owner is always treated
         * as unowned regardless of this list. A host that sets this must pass the
         * same list to the frontend's `EntityJevOwnerSuggestionCard`'s
         * `unownedValues` prop, which has no way to read this backend setting.
         * @visibility backend
         */
        unownedValues?: string[];
        /** Maximum number of catalog Group candidates sent to Jev per entity. @visibility backend */
        maxGroups?: number;
        /**
         * Upper bound on how many catalog entities of `kinds` are paged through
         * per run while looking for ownerless ones. Every run scans in the same
         * deterministic (kind, namespace, name) order starting from the
         * beginning, so an entity that sorts beyond this many entities of
         * `kinds` is never reached by any run, regardless of `maxEntities`'s own
         * rotation (which only rotates *which already-scanned* ownerless
         * entities are selected — it does not extend how far the scan itself
         * reaches). Set this above the catalog's total count of `kinds` to
         * guarantee every entity is eventually scanned. Default 2000, range
         * 100–20000.
         * @visibility backend
         */
        maxScannedEntities?: number;
      };
    };
  };
}
