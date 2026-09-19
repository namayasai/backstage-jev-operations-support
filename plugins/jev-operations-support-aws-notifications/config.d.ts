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
    };
  };
}
