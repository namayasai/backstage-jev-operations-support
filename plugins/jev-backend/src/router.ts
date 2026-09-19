import express from 'express';
import type { HttpAuthService, PermissionsService } from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { evaluationRequestSchema, buildEvaluation, summarize, demoEvaluation, jevEvaluatePermission, type JevRequest, type JevResponse } from '@namayasai/backstage-plugin-jev-common';
import { ProviderError } from './client';

export interface RouterOptions {
  httpAuth: Pick<HttpAuthService, 'credentials'>;
  permissions: Pick<PermissionsService, 'authorize'>;
  evaluate?: (request: JevRequest) => Promise<JevResponse>;
  demoMode?: boolean;
  confidenceThreshold?: number;
  requestsPerMinute?: number;
}

export function createRouter(options: RouterOptions): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  const buckets = new Map<string, { count: number; reset: number }>();
  let inFlight = 0;
  router.get('/status', (_req, res) => res.json({ mode: options.demoMode ? 'demo' : 'live', configured: Boolean(options.demoMode || options.evaluate) }));
  router.post('/evaluate', async (req, res, next) => {
    try {
      const credentials = await options.httpAuth.credentials(req, { allow: ['user'] });
      const [decision] = await options.permissions.authorize([{ permission: jevEvaluatePermission }], { credentials });
      if (decision.result !== AuthorizeResult.ALLOW) { res.status(403).json({ error: 'You do not have permission to evaluate with Jev.' }); return; }
      const parsed = evaluationRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(' ') }); return; }
      const now = Date.now();
      for (const [key, value] of buckets) if (value.reset <= now) buckets.delete(key);
      const principal = credentials.principal;
      if (principal.type !== 'user') { res.status(403).json({ error: 'A user identity is required.' }); return; }
      const key = principal.userEntityRef;
      if (!buckets.has(key) && buckets.size >= 1000) { res.status(429).json({ error: 'Evaluation capacity reached. Try again later.' }); return; }
      const bucket = buckets.get(key) ?? { count: 0, reset: now + 60000 };
      if (bucket.count >= (options.requestsPerMinute ?? 10) || inFlight >= 4) {
        res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Too many evaluations. Wait a minute before retrying.' }); return;
      }
      bucket.count++; buckets.set(key, bucket);
      if (options.demoMode) { res.json(demoEvaluation(parsed.data)); return; }
      if (!options.evaluate) { res.status(503).json({ error: 'Jev is not configured. Set jev.apiKey in the backend.' }); return; }
      inFlight++;
      try {
        const { request, checks } = buildEvaluation(parsed.data);
        const response = await options.evaluate(request);
        res.json(summarize(parsed.data, response, checks, options.confidenceThreshold));
      } finally { inFlight--; }
    } catch (error) {
      if (error instanceof ProviderError) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    }
  });
  // Keep validation/parser errors readable without exposing request bodies.
  router.use((err: { status?: number; name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status === 413 ? 413 : err.status === 400 ? 400 : err.name === 'AuthenticationError' ? 401 : err.name === 'NotAllowedError' ? 403 : 500;
    res.status(status).json({ error: status === 413 ? 'Request exceeds the 32 KB limit.' : status === 401 ? 'Sign in to use Jev.' : status === 400 ? 'Malformed JSON request.' : 'Evaluation could not be completed.' });
  });
  return router;
}
