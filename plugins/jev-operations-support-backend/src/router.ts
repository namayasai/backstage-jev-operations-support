import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import express from 'express';
import type { HttpAuthService, PermissionsService } from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { evaluationRequestSchema, buildEvaluation, summarize, demoEvaluation, jevEvaluatePermission, type JevRequest, type JevResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { GitHubClientError, GitHubLimitError, ProviderError, type GitHubClient } from './client';
import { evaluatePullRequestMarkdown, parsePullRequestEvent, PartialGitHubEvaluationError, supportedPullRequestActions } from './github';

export type GitHubWebhookRouterOptions = {
  secret: string;
  client: GitHubClient;
  repositories: string[];
  documentationPaths: string[];
  allowForks: boolean;
  timeoutMs?: number;
  maxDocuments?: number;
};

type ResolvedGitHubWebhookRouterOptions = GitHubWebhookRouterOptions & {
  timeoutMs: number;
  bodyLimitBytes: number;
  maxConcurrent: number;
  maxDocuments: number;
  maxChangedFiles: number;
  maxPages: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  dedupeTtlMs: number;
  dedupeMaxEntries: number;
};

const githubWebhookDefaults = {
  timeoutMs: 8000,
  bodyLimitBytes: 256 * 1024,
  maxConcurrent: 1,
  maxDocuments: 3,
  maxChangedFiles: 300,
  maxPages: 3,
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 16000,
  dedupeTtlMs: 10 * 60 * 1000,
  dedupeMaxEntries: 1000,
} as const;

export interface RouterOptions {
  httpAuth: Pick<HttpAuthService, 'credentials'>;
  permissions: Pick<PermissionsService, 'authorize'>;
  evaluate?: (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
  demoMode?: boolean;
  confidenceThreshold?: number;
  requestsPerMinute?: number;
  githubWebhook?: GitHubWebhookRouterOptions;
}

type DeliveryEntry = { state: 'pending' | 'completed'; expiresAt: number };

class WebhookTimeoutError extends Error {
  constructor() {
    super('GitHub webhook exceeded its processing deadline.');
    this.name = 'WebhookTimeoutError';
  }
}

export function createRouter(options: RouterOptions): express.Router {
  const router = express.Router();
  const buckets = new Map<string, { count: number; reset: number }>();
  const deliveries = new Map<string, DeliveryEntry>();
  let inFlight = 0;
  let webhookInFlight = 0;
  const githubWebhook = options.githubWebhook ? { ...githubWebhookDefaults, ...options.githubWebhook } as ResolvedGitHubWebhookRouterOptions : undefined;

  if (githubWebhook) {
    router.post('/webhooks/github', express.raw({ type: 'application/json', limit: githubWebhook.bodyLimitBytes }), async (req, res) => {
      await handleGitHubWebhook(options, req, res, deliveries, () => webhookInFlight++, () => webhookInFlight--, () => webhookInFlight, githubWebhook);
    });
  } else {
    router.post('/webhooks/github', (_req, res) => res.status(404).json({ error: 'GitHub webhook is not configured.' }));
  }

  router.use(express.json({ limit: '32kb' }));
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
      if (!options.evaluate) { res.status(503).json({ error: 'Jev is not configured. Set jevOperationsSupport.apiKey in the backend.' }); return; }
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
  router.use((err: { status?: number; type?: string; name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : err.status === 400 ? 400 : err.name === 'AuthenticationError' ? 401 : err.name === 'NotAllowedError' ? 403 : 500;
    res.status(status).json({ error: status === 413 ? 'Request exceeds the configured body limit.' : status === 401 ? 'Sign in to use Jev.' : status === 400 ? 'Malformed JSON request.' : 'Evaluation could not be completed.' });
  });
  return router;
}

async function handleGitHubWebhook(
  options: RouterOptions,
  req: express.Request,
  res: express.Response,
  deliveries: Map<string, DeliveryEntry>,
  increment: () => void,
  decrement: () => void,
  currentInFlight: () => number,
  webhook: ResolvedGitHubWebhookRouterOptions,
): Promise<void> {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) { res.status(400).json({ error: 'GitHub webhook requires an application/json body.' }); return; }
  if (!verifyGitHubSignature(rawBody, req.header('x-hub-signature-256'), webhook.secret)) { res.status(401).json({ error: 'Invalid GitHub webhook signature.' }); return; }
  const deliveryId = req.header('x-github-delivery')?.trim();
  if (!deliveryId || deliveryId.length > 200) { res.status(400).json({ error: 'GitHub webhook delivery ID is required.' }); return; }
  const eventName = req.header('x-github-event')?.trim().toLowerCase();
  if (eventName !== 'pull_request') { res.status(202).json({ status: 'ignored', reason: 'event_not_supported', deliveryId }); return; }
  let raw: unknown;
  try { raw = JSON.parse(rawBody.toString('utf8')) as unknown; }
  catch { res.status(400).json({ error: 'Malformed GitHub webhook JSON.' }); return; }
  const action = raw && typeof raw === 'object' && typeof (raw as { action?: unknown }).action === 'string' ? (raw as { action: string }).action : undefined;
  if (action && !supportedPullRequestActions.has(action)) { res.status(202).json({ status: 'ignored', reason: 'action_not_supported', deliveryId }); return; }
  const event = parsePullRequestEvent(raw);
  if (!event) { res.status(400).json({ error: 'Malformed GitHub pull_request webhook.' }); return; }
  if (!webhook.repositories.some(value => normalizeRepository(value) === normalizeRepository(event.repository))) {
    res.status(202).json({ status: 'ignored', reason: 'repository_not_allowed', deliveryId }); return;
  }
  if (!options.evaluate || options.demoMode) { res.status(503).json({ error: 'Jev is not configured for GitHub webhook evaluation.', retry: 'manual', deliveryId }); return; }
  const now = Date.now();
  pruneDeliveries(deliveries, now);
  const prior = deliveries.get(deliveryId);
  if (prior) {
    if (prior.state === 'pending') {
      res.setHeader('Retry-After', '2');
      res.status(503).json({ error: 'The GitHub webhook delivery is already being processed.', retry: 'manual', deliveryId });
    } else res.status(200).json({ status: 'duplicate', deliveryId });
    return;
  }
  if (currentInFlight() >= webhook.maxConcurrent || deliveries.size >= webhook.dedupeMaxEntries) {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: 'GitHub webhook capacity is temporarily full.', retry: 'manual', deliveryId });
    return;
  }
  deliveries.set(deliveryId, { state: 'pending', expiresAt: now + webhook.dedupeTtlMs });
  increment();
  const controller = new AbortController();
  let timeoutReject: ((error: Error) => void) | undefined;
  const timer = setTimeout(() => { controller.abort(); timeoutReject?.(new WebhookTimeoutError()); }, webhook.timeoutMs);
  const deadline = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
  try {
    const outcome = await Promise.race([
      evaluatePullRequestMarkdown({
        client: webhook.client,
        evaluate: options.evaluate,
        repositories: webhook.repositories,
        documentationPaths: webhook.documentationPaths,
        allowForks: webhook.allowForks,
        maxDocuments: webhook.maxDocuments,
        maxChangedFiles: webhook.maxChangedFiles,
        maxPages: webhook.maxPages,
        maxFileBytes: webhook.maxFileBytes,
        maxTotalBytes: webhook.maxTotalBytes,
        confidenceThreshold: options.confidenceThreshold ?? 0.8,
      }, event, controller.signal),
      deadline,
    ]);
    deliveries.set(deliveryId, { state: 'completed', expiresAt: Date.now() + webhook.dedupeTtlMs });
    if (outcome.status === 'ignored') { res.status(202).json({ status: 'ignored', reason: outcome.reason, deliveryId }); return; }
    res.status(200).json({ status: 'evaluated', deliveryId, repository: outcome.repository, pullRequest: outcome.pullRequest, documents: outcome.documents });
  } catch (error) {
    // A failed delivery is never marked successful. This permits a manual redelivery
    // after fixing permissions, limits, or provider configuration.
    deliveries.delete(deliveryId);
    if (error instanceof WebhookTimeoutError || controller.signal.aborted) { res.status(503).json({ error: 'GitHub webhook exceeded its processing deadline.', retry: 'manual', deliveryId }); return; }
    if (error instanceof PartialGitHubEvaluationError) { res.status(503).json({ error: error.message, retry: 'manual', partial: true, documents: error.documents, deliveryId }); return; }
    if (error instanceof GitHubLimitError) { res.status(422).json({ error: error.message, retry: 'manual', deliveryId }); return; }
    if (error instanceof GitHubClientError) { res.status(error.retryable ? 503 : 422).json({ error: error.message, retry: 'manual', deliveryId }); return; }
    if (error instanceof ProviderError) { res.status(error.status === 429 ? 503 : error.status).json({ error: error.message, retry: 'manual', deliveryId }); return; }
    res.status(503).json({ error: 'GitHub webhook evaluation failed.', retry: 'manual', deliveryId });
  } finally {
    clearTimeout(timer);
    decrement();
  }
}

export function verifyGitHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function pruneDeliveries(deliveries: Map<string, DeliveryEntry>, now: number): void {
  for (const [deliveryId, entry] of deliveries) if (entry.expiresAt <= now) deliveries.delete(deliveryId);
}

function normalizeRepository(value: string): string { return value.trim().toLowerCase(); }
