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
    };
  };
}
