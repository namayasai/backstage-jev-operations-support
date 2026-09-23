export interface Config {
  jevOperationsSupport?: {
    awsNotifications?: {
      /** Events topic published by the AWS SQS Events module. @visibility backend */
      eventTopic: string;
      /** Exact SNS TopicArn values accepted from the envelope. @visibility backend */
      allowedTopicArns: string[];
      /** Explicit Backstage User or Group entity refs to notify. @visibility backend */
      recipientEntityRefs: string[];
      /** Jev model override. @visibility backend */
      model?: string;
      /** Jev request deadline in milliseconds. @visibility backend */
      timeoutMs?: number;
      /**
       * Optional owner suggestion made at alarm receipt, alongside incident triage.
       * Off by default: it doubles Jev provider calls per active alarm (one for
       * incident triage, one for the owner suggestion) and sends catalog Group
       * titles, descriptions, and tags to the Jev provider as candidate context.
       * @visibility backend
       */
      ownerSuggestion?: {
        /** Enables the owner suggestion call. @visibility backend */
        enabled?: boolean;
        /** Maximum catalog Group entities loaded as candidates, 1-20. @visibility backend */
        maxGroups?: number;
        /** Seconds the loaded catalog Group list is cached in memory, 30-3600. @visibility backend */
        cacheSeconds?: number;
      };
      /**
       * Exact CloudWatch alarm ARNs mapped to the catalog entity (and optionally the
       * environment) they monitor. Used only to show service context when alerts are
       * read, with each reader's own catalog permissions; never sent to Jev.
       * @visibility backend
       */
      serviceBindings?: Array<{
        /** Full entity ref, e.g. component:default/checkout. @visibility backend */
        entityRef: string;
        /** Environment label shown with the alert, e.g. production. @visibility backend */
        environment?: string;
        /** Exact alarm ARNs, matched case-sensitively. @visibility backend */
        alarmArns: string[];
      }>;
    };
  };
}
