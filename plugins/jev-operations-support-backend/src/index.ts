import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { jevEvaluatePermission } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createJevClient } from './client';
import { resolveGitHubWebhookConfig } from './config';
import { responsePlannerFromConfig } from './responsePlan';
import { createRouter } from './router';

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
        const githubWebhook = resolveGitHubWebhookConfig(config);
        const responsePlanner = responsePlannerFromConfig(config);
        permissionsRegistry.addPermissions([jevEvaluatePermission]);
        if (githubWebhook) httpRouter.addAuthPolicy({ path: '/webhooks/github', allow: 'unauthenticated' });
        const baseUrl = config.getOptionalString('app.baseUrl');
        httpRouter.use(createRouter({ httpAuth, permissions, evaluate: client?.evaluate, demoMode, confidenceThreshold: threshold, requestsPerMinute, githubWebhook, baseUrl, responsePlanner }));
      },
    });
  },
});
export default jevPlugin;
