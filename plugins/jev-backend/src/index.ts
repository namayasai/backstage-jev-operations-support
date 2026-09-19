import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { jevEvaluatePermission } from '@namayasai/backstage-plugin-jev-common';
import { createJevClient } from './client';
import { createRouter } from './router';

export const jevPlugin = createBackendPlugin({
  pluginId: 'jev',
  register(env) {
    env.registerInit({
      deps: { config: coreServices.rootConfig, httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth, permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry },
      async init({ config, httpRouter, httpAuth, permissions, permissionsRegistry }) {
        const apiKey = config.getOptionalString('jev.apiKey');
        const demoMode = config.getOptionalBoolean('jev.demoMode') ?? false;
        const threshold = config.getOptionalNumber('jev.confidenceThreshold') ?? 0.8;
        const timeoutMs = config.getOptionalNumber('jev.timeoutMs') ?? 15000;
        const requestsPerMinute = config.getOptionalNumber('jev.requestsPerMinute') ?? 10;
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('jev.confidenceThreshold must be between 0 and 1');
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('jev.timeoutMs must be an integer between 1000 and 60000');
        if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 120) throw new Error('jev.requestsPerMinute must be an integer between 1 and 120');
        const client = apiKey ? createJevClient({ apiKey, model: config.getOptionalString('jev.model') ?? 'jev-1.13.0', timeoutMs }) : undefined;
        permissionsRegistry.addPermissions([jevEvaluatePermission]);
        httpRouter.use(createRouter({ httpAuth, permissions, evaluate: client?.evaluate, demoMode, confidenceThreshold: threshold, requestsPerMinute }));
      },
    });
  },
});
export default jevPlugin;
