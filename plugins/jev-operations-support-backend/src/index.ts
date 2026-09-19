import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { jevEvaluatePermission } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createGitHubClient, createJevClient } from './client';
import { createRouter, type GitHubWebhookRouterOptions } from './router';

export const jevPlugin = createBackendPlugin({
  pluginId: 'jev-operations-support',
  register(env) {
    env.registerInit({
      deps: { config: coreServices.rootConfig, httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth, permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry },
      async init({ config, httpRouter, httpAuth, permissions, permissionsRegistry }) {
        const apiKey = config.getOptionalString('jevOperationsSupport.apiKey');
        const demoMode = config.getOptionalBoolean('jevOperationsSupport.demoMode') ?? false;
        const threshold = config.getOptionalNumber('jevOperationsSupport.confidenceThreshold') ?? 0.8;
        const timeoutMs = config.getOptionalNumber('jevOperationsSupport.timeoutMs') ?? 15000;
        const requestsPerMinute = config.getOptionalNumber('jevOperationsSupport.requestsPerMinute') ?? 10;
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('jevOperationsSupport.confidenceThreshold must be between 0 and 1');
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('jevOperationsSupport.timeoutMs must be an integer between 1000 and 60000');
        if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 120) throw new Error('jevOperationsSupport.requestsPerMinute must be an integer between 1 and 120');
        const client = apiKey ? createJevClient({ apiKey, model: config.getOptionalString('jevOperationsSupport.model') ?? 'jev-1.13.0', timeoutMs }) : undefined;
        const githubSecret = config.getOptionalString('jevOperationsSupport.githubWebhook.secret');
        const githubToken = config.getOptionalString('jevOperationsSupport.githubWebhook.token');
        if (Boolean(githubSecret) !== Boolean(githubToken)) throw new Error('jevOperationsSupport.githubWebhook.secret and token must be configured together');
        let githubWebhook: GitHubWebhookRouterOptions | undefined;
        if (githubSecret && githubToken) {
          const repositories = config.getOptionalStringArray('jevOperationsSupport.githubWebhook.repositories') ?? [];
          const documentationPaths = config.getOptionalStringArray('jevOperationsSupport.githubWebhook.documentationPaths') ?? [];
          if (!repositories.length) throw new Error('jevOperationsSupport.githubWebhook.repositories must contain at least one repository');
          if (!documentationPaths.length) throw new Error('jevOperationsSupport.githubWebhook.documentationPaths must contain at least one Markdown path pattern');
          if (repositories.some(repository => !/^[^/\s]+\/[^/\s]+$/.test(repository))) throw new Error('jevOperationsSupport.githubWebhook.repositories must use owner/name entries');
          if (documentationPaths.some(path => !path.trim() || path.includes('..'))) throw new Error('jevOperationsSupport.githubWebhook.documentationPaths contains an invalid path pattern');
          const webhookTimeoutMs = config.getOptionalNumber('jevOperationsSupport.githubWebhook.timeoutMs') ?? 8000;
          const maxDocuments = config.getOptionalNumber('jevOperationsSupport.githubWebhook.maxDocuments') ?? 3;
          if (!Number.isInteger(webhookTimeoutMs) || webhookTimeoutMs < 1000 || webhookTimeoutMs > 8000) throw new Error('jevOperationsSupport.githubWebhook.timeoutMs must be an integer between 1000 and 8000');
          if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 10) throw new Error('jevOperationsSupport.githubWebhook.maxDocuments must be an integer between 1 and 10');
          githubWebhook = {
            secret: githubSecret,
            client: createGitHubClient({ token: githubToken }),
            repositories,
            documentationPaths,
            allowForks: config.getOptionalBoolean('jevOperationsSupport.githubWebhook.allowForks') ?? false,
            timeoutMs: webhookTimeoutMs,
            maxDocuments,
          };
        }
        permissionsRegistry.addPermissions([jevEvaluatePermission]);
        if (githubWebhook) httpRouter.addAuthPolicy({ path: '/webhooks/github', allow: 'unauthenticated' });
        httpRouter.use(createRouter({ httpAuth, permissions, evaluate: client?.evaluate, demoMode, confidenceThreshold: threshold, requestsPerMinute, githubWebhook }));
      },
    });
  },
});
export default jevPlugin;
