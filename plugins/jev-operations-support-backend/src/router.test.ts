import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter, type RouterOptions } from './router';
import { createGitHubClient, GitHubClientError, GitHubLimitError, ProviderError, type GitHubClient } from './client';
import { NEUTRAL_DESCRIPTION } from './reporting';
import type { JevRequest, JevResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';

// One listening server per test. Each app gets an isolated dispatch key, including
// tests that compare differently configured routers. Requests never rebind a port.
let server: Server;
let apps: Map<express.Express, string>;
beforeEach(async () => {
  apps = new Map();
  server = createServer((req, res) => {
    const app = [...apps].find(([, id]) => id === req.headers['x-test-app'])?.[0];
    if (!app) { res.writeHead(404); res.end(); return; }
    delete req.headers['x-test-app'];
    app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});
function supertest(app: express.Express) {
  if (!apps.has(app)) apps.set(app, String(apps.size));
  return request.agent(server).set('x-test-app', apps.get(app)!);
}
afterEach(async () => {
  try {
    await waitForReal(async () => {
      for (const app of apps.keys()) {
        const status = await supertest(app).get('/status');
        expect(status.body.githubWebhook?.queueLength ?? 0).toBe(0);
        expect(status.body.githubWebhook?.inFlight ?? 0).toBe(0);
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// `vi.waitFor` polls on real timers with a hardcoded 1000ms/50ms default budget that vitest's own
// `testTimeout` config does not affect. Every wait below is for real background work (a queued job,
// a webhook's async report) driven through real supertest requests; under full-suite parallel load
// the worker thread here can be starved of CPU by other files running concurrently, so give these
// real headroom instead of the library default. No assertion is weakened by this.
function waitForReal<T>(callback: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(callback, { timeout: 15_000, interval: 25 });
}

function setup(overrides: Partial<RouterOptions> = {}) {
  const options: RouterOptions = {
    httpAuth: { credentials: vi.fn().mockResolvedValue({ principal: { type: 'user', userEntityRef: 'user:default/test' } }) },
    permissions: { authorize: vi.fn().mockResolvedValue([{ result: AuthorizeResult.ALLOW }]) },
    demoMode: true, ...overrides,
  };
  return { options, app: express().use(createRouter(options)) };
}
const body = { workflow: 'readiness', text: 'Run npm start. Check /health. Contact payments-oncall.', candidates: [] };

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const webhookSecret = 'webhook-test-secret';
function githubPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'opened', number: 42, repository: { full_name: 'acme/service' },
    pull_request: { number: 42, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } },
    ...overrides,
  });
}
function sign(raw: string): string { return `sha256=${crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex')}`; }
function readinessResponse() {
  return { model: 'test', answers: {
    startup: { type: 'noul', noul: 0.9 }, health: { type: 'noul', noul: 0.9 },
    rollback: { type: 'noul', noul: 0.9 }, escalation: { type: 'noul', noul: 0.9 },
  } } as const;
}
function githubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service', title: 'Update runbook', body: 'Some description.' }),
    listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'docs/runbook.md', status: 'modified' }]),
    listChangedFilesTolerant: vi.fn().mockResolvedValue({ files: [{ filename: 'docs/runbook.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' }], truncated: false }),
    getFile: vi.fn().mockResolvedValue({ path: 'docs/runbook.md', content: 'Start with npm ci. Health: GET /health. Escalate to on-call.', size: 58 }),
    getAuthenticatedLogin: vi.fn().mockResolvedValue('jev-bot'),
    createCommitStatus: vi.fn().mockResolvedValue(undefined),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function withWebhook(overrides: Partial<RouterOptions> = {}) {
  const client = githubClient();
  const options: RouterOptions = {
    httpAuth: { credentials: vi.fn().mockResolvedValue({ principal: { type: 'user', userEntityRef: 'user:default/test' } }) },
    permissions: { authorize: vi.fn().mockResolvedValue([{ result: AuthorizeResult.ALLOW }]) },
    evaluate: vi.fn().mockResolvedValue(readinessResponse()),
    githubWebhook: {
      secret: webhookSecret, client, repositories: ['acme/service'], documentationPaths: ['docs/**'], allowForks: false,
      timeoutMs: 8000, maxDocuments: 3,
    },
    ...overrides,
  };
  return { options, client, app: express().use(createRouter(options)) };
}

describe('authenticated evaluation router', () => {
  it('checks identity and permission and returns explicit fixture results', async () => {
    const { app, options } = setup();
    const result = await supertest(app).post('/evaluate').send(body).expect(200);
    expect(result.body.mode).toBe('demo');
    expect(options.httpAuth.credentials).toHaveBeenCalledWith(expect.anything(), { allow: ['user'] });
    expect(options.permissions.authorize).toHaveBeenCalled();
  });
  it('rejects unauthenticated requests', async () => {
    const { app } = setup({ httpAuth: { credentials: vi.fn().mockRejectedValue(Object.assign(new Error(), { name: 'AuthenticationError' })) } });
    await supertest(app).post('/evaluate').send(body).expect(401);
  });
  it('rejects denied users before invoking the provider', async () => {
    const evaluate = vi.fn();
    const { app } = setup({ evaluate, permissions: { authorize: vi.fn().mockResolvedValue([{ result: AuthorizeResult.DENY }]) } });
    await supertest(app).post('/evaluate').send(body).expect(403);
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('rejects service principals', async () => {
    const { app } = setup({ httpAuth: { credentials: vi.fn().mockResolvedValue({ principal: { type: 'service', subject: 'test' } }) } });
    await supertest(app).post('/evaluate').send(body).expect(403);
  });
  it('validates before consuming quota and bounds the request body', async () => {
    const { app } = setup({ requestsPerMinute: 1 });
    await supertest(app).post('/evaluate').send({ ...body, text: '' }).expect(400);
    await supertest(app).post('/evaluate').send({ ...body, text: 'a'.repeat(40000) }).expect(413);
    await supertest(app).post('/evaluate').send(body).expect(200);
    const limited = await supertest(app).post('/evaluate').send(body).expect(429);
    expect(limited.headers['retry-after']).toBe('60');
  });
  it('keeps per-user quotas separate', async () => {
    const credentials = vi.fn().mockResolvedValueOnce({ principal: { type: 'user', userEntityRef: 'user:default/a' } }).mockResolvedValueOnce({ principal: { type: 'user', userEntityRef: 'user:default/b' } });
    const { app } = setup({ requestsPerMinute: 1, httpAuth: { credentials } });
    await supertest(app).post('/evaluate').send(body).expect(200);
    await supertest(app).post('/evaluate').send(body).expect(200);
  });
  it('does not silently use demo mode when no key is configured', async () => {
    const { app } = setup({ demoMode: false });
    await supertest(app).post('/evaluate').send(body).expect(503);
  });
  it('releases concurrency capacity on provider errors', async () => {
    const { app } = setup({ demoMode: false, evaluate: vi.fn().mockRejectedValue(new ProviderError(502, 'Provider unavailable')) });
    for (let i = 0; i < 5; i++) await supertest(app).post('/evaluate').send(body).expect(502);
  });
});

describe('signed GitHub pull request webhook', () => {
  it('requires a valid SHA-256 signature and never uses Backstage user auth', async () => {
    const { app, options } = withWebhook();
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-invalid').set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`).send(raw).expect(401);
    expect(options.httpAuth.credentials).not.toHaveBeenCalled();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-valid').set('x-hub-signature-256', sign(raw)).send(raw).expect(200);
    expect(options.httpAuth.credentials).not.toHaveBeenCalled();
  });

  it('rejects an oversized raw webhook body before parsing or evaluating it', async () => {
    const { app, options } = withWebhook({ githubWebhook: { ...withWebhook().options.githubWebhook! } });
    const raw = 'x'.repeat(260 * 1024);
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-large').set('x-hub-signature-256', sign(raw)).send(raw).expect(413);
    expect(options.httpAuth.credentials).not.toHaveBeenCalled();
    expect(options.evaluate).not.toHaveBeenCalled();
  });

  it('ignores unrelated events and unsupported actions after signature verification', async () => {
    const { app, client } = withWebhook();
    const push = githubPayload({ action: 'opened' });
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'push').set('x-github-delivery', 'delivery-push').set('x-hub-signature-256', sign(push)).send(push).expect(202).expect(({ body }) => expect(body.reason).toBe('event_not_supported'));
    const ignored = githubPayload({ action: 'closed' });
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-closed').set('x-hub-signature-256', sign(ignored)).send(ignored).expect(202).expect(({ body }) => expect(body.reason).toBe('action_not_supported'));
    expect(client.getPullRequest).not.toHaveBeenCalled();
  });

  it('deduplicates a completed delivery while retaining the evaluated result for the first response', async () => {
    const { app, options } = withWebhook();
    const raw = githubPayload();
    const request = () => supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-replay').set('x-hub-signature-256', sign(raw)).send(raw);
    await request().expect(200).expect(({ body }) => { expect(body.status).toBe('evaluated'); expect(body.documents[0].result.workflow).toBe('readiness'); });
    await request().expect(200).expect(({ body }) => expect(body.status).toBe('duplicate'));
    expect(options.evaluate).toHaveBeenCalledTimes(1);
  });

  it('evaluates each matching document separately and returns per-document results', async () => {
    const client = githubClient({
      listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/b.md', status: 'modified' }]),
      getFile: vi.fn(async (_repository, path) => ({ path, content: path.endsWith('a.md') ? 'Document A startup and health details.' : 'Document B rollback and escalation details.', size: 40 })),
    });
    const evaluate = vi.fn().mockResolvedValue(readinessResponse());
    const { app } = withWebhook({ evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, maxDocuments: 2 } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-docs').set('x-hub-signature-256', sign(raw)).send(raw).expect(200).expect(({ body }) => {
      expect(body.documents).toHaveLength(2);
      expect(body.documents.map((document: { path: string }) => document.path)).toEqual(['docs/a.md', 'docs/b.md']);
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0][0].state.context).toContain('Document A');
    expect(evaluate.mock.calls[0][0].state.context).not.toContain('Document B');
  });

  it('returns an explicit partial failure when a later document cannot be evaluated', async () => {
    const client = githubClient({
      listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/b.md', status: 'modified' }]),
      getFile: vi.fn(async (_repository, path) => ({ path, content: `Document ${path} has enough operational context.`, size: 40 })),
    });
    const evaluate = vi.fn().mockResolvedValueOnce(readinessResponse()).mockRejectedValueOnce(new ProviderError(503, 'Jev is busy. Wait before retrying.'));
    const { app } = withWebhook({ evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, maxDocuments: 2 } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-partial').set('x-hub-signature-256', sign(raw)).send(raw).expect(503).expect(({ body }) => {
      expect(body.partial).toBe(true);
      expect(body.documents).toHaveLength(1);
      expect(body.retry).toBe('manual');
    });
  });

  it('refuses the delivery before any Jev call when a later document cannot be evaluated', async () => {
    const client = githubClient({
      listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/empty.md', status: 'modified' }]),
      getFile: vi.fn(async (_repository, path) => ({ path, content: path.endsWith('empty.md') ? '' : 'Document A startup and health details.', size: 40 })),
    });
    const evaluate = vi.fn().mockResolvedValue(readinessResponse());
    const { app } = withWebhook({ evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, maxDocuments: 2 } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-empty').set('x-hub-signature-256', sign(raw)).send(raw).expect(422).expect(({ body }) => {
      expect(body.error).toContain('docs/empty.md');
      expect(body.retry).toBe('manual');
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('removes failed deliveries so manual redelivery can retry Jev', async () => {
    const evaluate = vi.fn().mockRejectedValueOnce(new ProviderError(503, 'Jev is busy. Wait before retrying.')).mockResolvedValueOnce(readinessResponse());
    const { app } = withWebhook({ evaluate });
    const raw = githubPayload();
    const request = () => supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-retry').set('x-hub-signature-256', sign(raw)).send(raw);
    await request().expect(503).expect(({ body }) => expect(body.retry).toBe('manual'));
    await request().expect(200).expect(({ body }) => expect(body.status).toBe('evaluated'));
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('enforces the repository allowlist and refuses forks by default', async () => {
    const allowlist = withWebhook();
    const outside = githubPayload({ repository: { full_name: 'other/service' } });
    await supertest(allowlist.app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-repo').set('x-hub-signature-256', sign(outside)).send(outside).expect(202).expect(({ body }) => expect(body.reason).toBe('repository_not_allowed'));
    const fork = withWebhook();
    const forkBody = githubPayload({ pull_request: { number: 42, head: { sha: headSha, repo: { full_name: 'attacker/service' } }, base: { sha: baseSha } } });
    await supertest(fork.app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-fork').set('x-hub-signature-256', sign(forkBody)).send(forkBody).expect(202).expect(({ body }) => expect(body.reason).toBe('fork_not_allowed'));
    expect(fork.options.evaluate).not.toHaveBeenCalled();
    expect(fork.client.getPullRequest).not.toHaveBeenCalled();
  });

  it('skips a delivery when the PR head changes while files are being read', async () => {
    const client = githubClient({ getPullRequest: vi.fn()
      .mockResolvedValueOnce({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service' })
      .mockResolvedValueOnce({ number: 42, headSha: 'c'.repeat(40), baseSha, headRepoFullName: 'acme/service' }) });
    const { app, options } = withWebhook({ githubWebhook: { ...withWebhook().options.githubWebhook!, client } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-stale').set('x-hub-signature-256', sign(raw)).send(raw).expect(202).expect(({ body }) => expect(body.reason).toBe('stale_delivery'));
    expect(options.evaluate).not.toHaveBeenCalled();
  });

  it('reports matching-document limits without invoking Jev', async () => {
    const client = githubClient({ listChangedFiles: vi.fn().mockResolvedValue([
      { filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/b.md', status: 'modified' },
      { filename: 'docs/c.md', status: 'modified' }, { filename: 'docs/d.md', status: 'modified' },
    ]) });
    const { app, options } = withWebhook({ githubWebhook: { ...withWebhook().options.githubWebhook!, client } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-limit').set('x-hub-signature-256', sign(raw)).send(raw).expect(422).expect(({ body }) => expect(body.error).toContain('configured limit'));
    expect(options.evaluate).not.toHaveBeenCalled();
  });

  it('aborts the whole synchronous workload at the configured deadline', async () => {
    const evaluate = vi.fn((_request, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted by webhook')), { once: true });
    }));
    const { app } = withWebhook({ evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, timeoutMs: 20 } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-timeout').set('x-hub-signature-256', sign(raw)).send(raw).expect(503).expect(({ body }) => expect(body.error).toContain('deadline'));
  });
});

describe('GitHub webhook background reporting', () => {
  function send(app: express.Express, raw: string, deliveryId: string) {
    return supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', deliveryId).set('x-hub-signature-256', sign(raw)).send(raw);
  }
  /** A real, non-vacuous completion signal for the background job: the `/status` route's own `lastOutcome`, which
   * only changes once `processQueueJob` has actually finished. Used instead of `vi.waitFor(() => expect(x).not...)`
   * (which is vacuously true before the job even starts) or a fixed sleep (which is a race against the job). */
  async function waitForOutcome(app: express.Express, code: string): Promise<void> {
    await waitForReal(async () => {
      const status = await supertest(app).get('/status');
      expect(status.body.githubWebhook?.lastOutcome?.code).toBe(code);
    });
  }
  function withReporting(reportOverrides: Record<string, unknown> = {}, overrides: Partial<RouterOptions> = {}) {
    const client = (overrides.githubWebhook?.client as GitHubClient | undefined) ?? githubClient();
    const { githubWebhook: webhookOverrides, ...rest } = overrides;
    const options: RouterOptions = {
      httpAuth: { credentials: vi.fn().mockResolvedValue({ principal: { type: 'user', userEntityRef: 'user:default/test' } }) },
      permissions: { authorize: vi.fn().mockResolvedValue([{ result: AuthorizeResult.ALLOW }]) },
      evaluate: vi.fn().mockResolvedValue(readinessResponse()),
      ...rest,
      githubWebhook: {
        secret: webhookSecret, repositories: ['acme/service'], documentationPaths: ['docs/**'], allowForks: false, maxDocuments: 3,
        ...webhookOverrides, client, report: 'status', ...reportOverrides,
      },
    };
    return { options, client, app: express().use(createRouter(options)) };
  }

  it('does not widen what report: none does: unset report behaves byte-for-byte as the synchronous path', async () => {
    const { app, client } = withWebhook();
    const raw = githubPayload();
    await send(app, raw, 'delivery-none').expect(200).expect(({ body }) => expect(body.status).toBe('evaluated'));
    expect(client.createCommitStatus).not.toHaveBeenCalled();
  });

  it('accepts the delivery immediately and evaluates it in the background, ending in a success status', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const { app, options } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient({ createCommitStatus }), report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-async').expect(202).expect(({ body }) => expect(body).toEqual({ accepted: true, deliveryId: 'delivery-async' }));
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));
    expect(createCommitStatus.mock.calls[0][2]).toMatchObject({ state: 'pending' });
    expect(createCommitStatus.mock.calls[1][2]).toMatchObject({ state: 'success' });
    expect(options.evaluate).toHaveBeenCalledTimes(1);
  });

  it('also writes a PR comment once in status+comment mode', async () => {
    const createIssueComment = vi.fn().mockResolvedValue(undefined);
    const { app } = withReporting({ report: 'status+comment' }, { githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient({ createIssueComment }), report: 'status+comment' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-comment').expect(202);
    await waitForReal(() => expect(createIssueComment).toHaveBeenCalledTimes(1));
  });

  it('writes a failure status only when blockOn is attention and an attention finding is present', async () => {
    const attentionResponse = { model: 'test', answers: {
      startup: { type: 'noul', noul: 0.05 }, health: { type: 'noul', noul: 0.9 },
      rollback: { type: 'noul', noul: 0.9 }, escalation: { type: 'noul', noul: 0.9 },
    } } as const;
    const evaluate = vi.fn().mockResolvedValue(attentionResponse);
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const { app } = withReporting({ blockOn: 'attention' }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient({ createCommitStatus }), report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-blocking').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));
    expect(createCommitStatus.mock.calls[1][2]).toMatchObject({ state: 'failure' });
  });

  it('writes an error status, never a success or pending one, when Jev fails', async () => {
    const evaluate = vi.fn().mockRejectedValue(new ProviderError(502, 'Jev rejected the evaluation'));
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient({ createCommitStatus }), report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-provider-error').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));
    expect(createCommitStatus.mock.calls[1][2]).toMatchObject({ state: 'error' });
    expect(createCommitStatus.mock.calls[1][2].description).not.toContain('docs/');
  });

  it('writes an error status when GitHub cannot be read AFTER a matching document was confirmed, without ever calling Jev', async () => {
    // getFile (fetching document content) only runs after a matching document is already confirmed, so a
    // `pending` was already written and this delivery is owed a final report.
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const failingClient = githubClient({ createCommitStatus, getFile: vi.fn().mockRejectedValue(new GitHubClientError(true, 'GitHub could not be reached.')) });
    const { app, options } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client: failingClient, report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-github-error').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));
    expect(createCommitStatus.mock.calls[0][2]).toMatchObject({ state: 'pending' });
    expect(createCommitStatus.mock.calls[1][2]).toMatchObject({ state: 'error' });
    expect(options.evaluate).not.toHaveBeenCalled();
  });

  it('writes nothing at all when GitHub cannot be read BEFORE any matching document is confirmed, and forgets the delivery so redelivery can retry', async () => {
    // listChangedFiles runs before any document is known to match; failing here means matching was never
    // confirmed, so nothing was ever owed to GitHub for this delivery — not even a `pending`.
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const failingClient = githubClient({ createCommitStatus, listChangedFilesTolerant: vi.fn().mockRejectedValue(new GitHubClientError(true, 'GitHub could not be reached.')) });
    const { app, options } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client: failingClient, report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-github-error-early').expect(202);
    await waitForOutcome(app, 'error:github');
    expect(createCommitStatus).not.toHaveBeenCalled();
    expect(options.evaluate).not.toHaveBeenCalled();
    // Not remembered: a redelivery of the same id is reprocessed rather than bounced as a duplicate.
    await send(app, raw, 'delivery-github-error-early').expect(202);
  });

  it('writes an error status when the per-delivery deadline is exceeded', async () => {
    const evaluate = vi.fn((_request, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const { app } = withReporting({ timeoutMs: 20 }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient({ createCommitStatus }), report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-deadline').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));
    expect(createCommitStatus.mock.calls[1][2]).toMatchObject({ state: 'error' });
  });

  it('writes nothing at all when no changed document matches the path filter', async () => {
    const client = githubClient({ listChangedFilesTolerant: vi.fn().mockResolvedValue({ files: [{ filename: 'src/index.ts', status: 'modified' }], truncated: false }) });
    const { app } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status+comment' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-no-match').expect(202);
    await waitForOutcome(app, 'ignored:no_documentation_changes');
    expect(client.createCommitStatus).not.toHaveBeenCalled();
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it('resolves a dangling pending with a neutral status — never the real result, never nothing — when the head moved after matching was confirmed', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({
      createCommitStatus,
      // Call 1 ("current"): matches the accepted event. Call 2 (the staleness recheck right after `onMatched`
      // fires, before any document content is fetched): the head has since moved. Jev is never reached.
      getPullRequest: vi.fn()
        .mockResolvedValueOnce({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service' })
        .mockResolvedValue({ number: 42, headSha: 'c'.repeat(40), baseSha, headRepoFullName: 'acme/service' }),
    });
    const { app, options } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-moved').expect(202);
    await waitForOutcome(app, 'ignored:stale_delivery');
    expect(options.evaluate).not.toHaveBeenCalled();
    // Pending was written once matching was confirmed against the original SHA; the dangling pending is then
    // resolved neutrally (not left forever, and not claiming a readiness judgment that never completed).
    expect(createCommitStatus).toHaveBeenCalledTimes(2);
    expect(createCommitStatus.mock.calls[0][2]).toMatchObject({ state: 'pending' });
    expect(createCommitStatus.mock.calls[1][2]).toMatchObject({ state: 'success', description: expect.stringContaining(NEUTRAL_DESCRIPTION) });
    expect(createCommitStatus.mock.calls[1][1]).toBe(headSha); // resolves the OLD sha, not a new one
  });

  it('rejects a delivery with 503 once the bounded queue is full, without remembering it for dedupe', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const evaluate = vi.fn(async () => { await gate; return readinessResponse(); });
    const { app, options } = withReporting({ queueLength: 1 }, { evaluate });
    // First delivery is dequeued immediately (queue goes back to empty while it processes).
    await send(app, githubPayload({ number: 1, pull_request: { number: 1, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } }), 'delivery-q1').expect(202);
    // Second delivery fills the one queue slot.
    await send(app, githubPayload({ number: 2, pull_request: { number: 2, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } }), 'delivery-q2').expect(202);
    // Third delivery finds the queue full.
    const full = await send(app, githubPayload({ number: 3, pull_request: { number: 3, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } }), 'delivery-q3').expect(503);
    expect(full.headers['retry-after']).toBeDefined();
    release?.();
    // The rejected delivery was never remembered, so GitHub's redelivery of the same ID is reprocessed, not bounced as a duplicate.
    await waitForReal(() => expect(options.evaluate).toHaveBeenCalledTimes(2));
    await send(app, githubPayload({ number: 3, pull_request: { number: 3, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } }), 'delivery-q3').expect(202);
  });

  it('supersedes a queued, not-yet-started delivery for the same pull request with a newer one', async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const evaluate = vi.fn(async (request: unknown) => { await gate; return readinessResponse(); });
    const busyClient = githubClient({ getPullRequest: vi.fn().mockResolvedValue({ number: 1, headSha, baseSha, headRepoFullName: 'acme/service' }) });
    const { app, client, options } = withReporting({ queueLength: 5 }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client: busyClient, report: 'status', queueLength: 5 } });
    const busyPayload = githubPayload({ number: 1, pull_request: { number: 1, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } });
    // Occupies the single worker so the next two deliveries (for a different PR) sit in the queue.
    await send(app, busyPayload, 'delivery-busy').expect(202);
    const target = githubPayload({ number: 2, pull_request: { number: 2, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } });
    await send(app, target, 'delivery-old').expect(202);
    await send(app, target, 'delivery-new').expect(202);
    releaseFirst?.();
    await waitForReal(() => expect(options.evaluate).toHaveBeenCalledTimes(2)); // the busy job, then only the superseding job for PR 2
    // The superseded delivery is already resolved, so redelivering it comes back as a harmless duplicate.
    await send(app, target, 'delivery-old').expect(200).expect(({ body }) => expect(body.status).toBe('duplicate'));
  });

  it('reports non-secret queue facts on the status route', async () => {
    const { app } = withReporting();
    const status = await supertest(app).get('/status').expect(200);
    expect(status.body.githubWebhook).toMatchObject({ report: 'status', queueLength: 0 });
    expect(JSON.stringify(status.body)).not.toContain('acme/service');
  });

  it('refuses a fork before it ever occupies a queue slot, and never touches GitHub', async () => {
    const client = githubClient();
    const { app } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', allowForks: false } });
    const raw = githubPayload({ pull_request: { number: 42, head: { sha: headSha, repo: { full_name: 'attacker/service' } }, base: { sha: baseSha } } });
    await send(app, raw, 'delivery-fork').expect(202).expect(({ body }) => expect(body.reason).toBe('fork_not_allowed'));
    expect(client.getPullRequest).not.toHaveBeenCalled();
    const status = await supertest(app).get('/status').expect(200);
    expect(status.body.githubWebhook.queueLength).toBe(0);
  });

  it('does no work at all for a delivery with a bad signature: the queue and every client method stay untouched', async () => {
    const client = githubClient();
    const { app } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-bad-sig').set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`).send(raw).expect(401);
    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(client.createCommitStatus).not.toHaveBeenCalled();
    const status = await supertest(app).get('/status').expect(200);
    expect(status.body.githubWebhook.queueLength).toBe(0);
  });

  it('does no work at all for a delivery from a repository outside the allowlist', async () => {
    const client = githubClient();
    const { app } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload({ repository: { full_name: 'other/service' } });
    await send(app, raw, 'delivery-other-repo').expect(202).expect(({ body }) => expect(body.reason).toBe('repository_not_allowed'));
    expect(client.getPullRequest).not.toHaveBeenCalled();
    const status = await supertest(app).get('/status').expect(200);
    expect(status.body.githubWebhook.queueLength).toBe(0);
  });

  it('does no work at all for an unsupported action', async () => {
    const client = githubClient();
    const { app } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload({ action: 'closed' });
    await send(app, raw, 'delivery-closed-action').expect(202).expect(({ body }) => expect(body.reason).toBe('action_not_supported'));
    expect(client.getPullRequest).not.toHaveBeenCalled();
    const status = await supertest(app).get('/status').expect(200);
    expect(status.body.githubWebhook.queueLength).toBe(0);
  });

  it('rejects a delivery with 503 once the shared dedupe map capacity is full, same as the synchronous path', async () => {
    // The dedupe entry is written synchronously the instant a delivery is accepted (before the 202 response is
    // even sent — see `handleGitHubWebhook`), so the capacity check below does not, strictly, need the first
    // delivery's background processing to still be in flight. But it stays in the map as `completed` (not
    // deleted) either way, and holding it open with a gate — rather than letting it race to completion under
    // full-suite parallel load — removes any dependency on that timing entirely: the assertion is about the one
    // dedupe SLOT being occupied, not about the job's own progress, so this makes that the only thing under test.
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const evaluate = vi.fn(async () => { await gate; return readinessResponse(); });
    const { app } = withReporting({ dedupeMaxEntries: 1 }, { evaluate });
    const filler = githubPayload({ number: 1, pull_request: { number: 1, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } });
    await send(app, filler, 'delivery-fill').expect(202);
    const full = await send(app, githubPayload({ number: 2, pull_request: { number: 2, head: { sha: headSha, repo: { full_name: 'acme/service' } }, base: { sha: baseSha } } }), 'delivery-capacity').expect(503);
    expect(full.headers['retry-after']).toBeDefined();
    release?.();
    await waitForReal(() => expect(evaluate).toHaveBeenCalledTimes(1));
  });

  it('forgets the delivery — allowing redelivery — when the final write cannot itself be posted to GitHub, even though pending succeeded', async () => {
    // `pending` succeeds, but the write that would resolve it (the `error` status, since Jev fails) itself fails.
    // Nothing was actually written for this SHA's final state, so — unlike every other "completed" outcome above
    // — the delivery id must not be remembered, or a legitimate GitHub redelivery would be bounced as a duplicate
    // despite nothing having actually been resolved.
    const createCommitStatus = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('GitHub is down'));
    const evaluate = vi.fn().mockRejectedValue(new ProviderError(502, 'Jev rejected the evaluation'));
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient({ createCommitStatus }), report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-unwritable-error').expect(202);
    await waitForOutcome(app, 'error:provider');
    expect(createCommitStatus).toHaveBeenCalledTimes(2);
    // Not remembered: redelivering the same id is reprocessed rather than bounced as a duplicate.
    await send(app, raw, 'delivery-unwritable-error').expect(202);
  });

  it('still resolves the dangling pending, and never becomes an unhandled rejection, for a wholly unrecognized thrown error', async () => {
    // `classifyWebhookError`'s default branch (`error:unknown`) is what a genuine bug elsewhere in this code path
    // would hit if it ever threw past the classified GitHub/Jev/deadline error types; a plain `RangeError` stands
    // in for that. The queue's own `.catch()` on `pump`'s chain and `processQueueJob`'s outer catch-all are the
    // deeper, White-box-only safety net for a throw from within the reporting/write code itself (already proven
    // exception-safe path by path in `reporting.test.ts`'s `guarded()` coverage); this test instead proves the
    // ordinary, reachable case: an unrecognized error still resolves the invariant rather than leaving it dangling
    // or crashing the process.
    const client = githubClient({ getFile: vi.fn().mockImplementation(() => { throw new RangeError('an unrecognized failure'); }) });
    const { app } = withReporting({}, { githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-unrecognized-error').expect(202);
    await waitForOutcome(app, 'error:unknown');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.once('unhandledRejection', onUnhandled);
    await new Promise(resolve => setTimeout(resolve, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

describe('GitHub webhook change review (opt-in, requires report != none)', () => {
  function send(app: express.Express, raw: string, deliveryId: string) {
    return supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', deliveryId).set('x-hub-signature-256', sign(raw)).send(raw);
  }
  async function waitForOutcome(app: express.Express, code: string): Promise<void> {
    await waitForReal(async () => {
      const status = await supertest(app).get('/status');
      expect(status.body.githubWebhook?.lastOutcome?.code).toBe(code);
    });
  }
  async function waitForChangeReviewOutcome(app: express.Express, code: string): Promise<void> {
    await waitForReal(async () => {
      const status = await supertest(app).get('/status');
      expect(status.body.githubWebhook?.lastChangeReviewOutcome?.code).toBe(code);
    });
  }
  /** Answers whichever workflow's checks the request actually carries: readiness ids or change-risk ids. A single
   * shared `evaluate` function is realistic — both workflows go through the same provider call in production. */
  function combinedEvaluate(changeRiskAnswers: JevResponse['answers'] = {
    breaking: { type: 'noul', noul: 0.1 }, migration: { type: 'noul', noul: 0.1 }, access: { type: 'noul', noul: 0.1 }, rollback: { type: 'noul', noul: 0.9 },
  }) {
    return vi.fn(async (request: JevRequest): Promise<JevResponse> => {
      if ('breaking' in request.questions) return { model: 'test', answers: changeRiskAnswers };
      return readinessResponse();
    });
  }
  const changeReviewSettings = { enabled: true, paths: ['src/**'], maxFiles: 20, maxPatchBytes: 12000 };

  it('runs two independent status sequences (jev/readiness and jev/change-review) when both apply', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({ createCommitStatus });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-both').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(4));
    const contexts = createCommitStatus.mock.calls.map(call => (call[2] as { context: string }).context);
    expect(contexts.filter(c => c === 'jev/readiness')).toHaveLength(2);
    expect(contexts.filter(c => c === 'jev/change-review')).toHaveLength(2);
    const readinessCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/readiness');
    const changeReviewCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review');
    expect(readinessCalls[0][2]).toMatchObject({ state: 'pending' });
    expect(readinessCalls[1][2]).toMatchObject({ state: 'success' });
    expect(changeReviewCalls[0][2]).toMatchObject({ state: 'pending' });
    expect(changeReviewCalls[1][2]).toMatchObject({ state: 'success' });
    expect(evaluate).toHaveBeenCalledTimes(2); // 1 readiness document + 1 change-risk call, the bound
  });

  it('runs change review even when readiness has no matching document (readiness writes nothing)', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({ createCommitStatus, listChangedFilesTolerant: vi.fn().mockResolvedValue({ files: [{ filename: 'src/index.ts', status: 'modified' }], truncated: false }) });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-only').expect(202);
    await waitForChangeReviewOutcome(app, 'evaluated');
    const contexts = createCommitStatus.mock.calls.map(call => (call[2] as { context: string }).context);
    expect(contexts).toEqual(['jev/change-review', 'jev/change-review']);
  });

  it('isolates failures both ways: a change-review Jev failure does not affect the readiness result, and vice versa', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({ createCommitStatus });
    const evaluate = vi.fn(async (request: { questions: Record<string, unknown> }) => {
      if ('breaking' in request.questions) throw new ProviderError(502, 'Jev rejected the change-risk evaluation');
      return readinessResponse();
    });
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-fails').expect(202);
    await waitForOutcome(app, 'evaluated'); // readiness still succeeds
    await waitForChangeReviewOutcome(app, 'error:provider');
    const readinessCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/readiness');
    const changeReviewCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review');
    expect(readinessCalls[1][2]).toMatchObject({ state: 'success' });
    expect(changeReviewCalls[1][2]).toMatchObject({ state: 'error' });
  });

  it('writes a fixed, content-free error status and calls the provider zero times for change review when the content budget cannot be met', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const hugeTitle = 'x'.repeat(20000);
    const client = githubClient({ createCommitStatus, getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service', title: hugeTitle, body: null }) });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-content-error').expect(202);
    await waitForChangeReviewOutcome(app, 'error:content');
    const changeReviewCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review');
    expect(changeReviewCalls[1][2]).toMatchObject({ state: 'error' });
    expect((changeReviewCalls[1][2] as { description: string }).description).not.toContain('x'.repeat(50));
    expect(evaluate).toHaveBeenCalledTimes(1); // readiness only; change review never reached the provider
  });

  it('blocks the change-review status only when blockOn is attention and a concern finding is at attention', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({ createCommitStatus });
    const evaluate = combinedEvaluate({ breaking: { type: 'noul', noul: 0.9 }, migration: { type: 'noul', noul: 0.1 }, access: { type: 'noul', noul: 0.1 }, rollback: { type: 'noul', noul: 0.9 } });
    const { app } = withReporting({ blockOn: 'attention' }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-block').expect(202);
    await waitForChangeReviewOutcome(app, 'evaluated');
    const changeReviewCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review');
    expect(changeReviewCalls[1][2]).toMatchObject({ state: 'failure' });
    expect((changeReviewCalls[1][2] as { description: string }).description).toContain('blocking');
  });

  it('writes one combined marker comment with both sections in status+comment mode', async () => {
    const createIssueComment = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({ createIssueComment });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({ report: 'status+comment' }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status+comment', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-comment').expect(202);
    await waitForReal(() => expect(createIssueComment).toHaveBeenCalledTimes(1));
    const body = createIssueComment.mock.calls[0][2] as string;
    expect(body).toContain('### Change review');
    expect(body).toContain('docs/runbook.md'); // the readiness table
  });

  it('discloses a truncated listing instead of throwing, in the comment', async () => {
    const createIssueComment = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({
      createIssueComment,
      listChangedFilesTolerant: vi.fn().mockResolvedValue({ files: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' }], truncated: true }),
    });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({ report: 'status+comment' }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status+comment', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-truncated').expect(202);
    await waitForReal(() => expect(createIssueComment).toHaveBeenCalledTimes(1));
    const body = createIssueComment.mock.calls[0][2] as string;
    expect(body).toContain('shortened');
  });

  it('does no work at all for a bad signature: no listing fetch, no provider call, no writes', async () => {
    const client = githubClient();
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-cr-bad-sig').set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`).send(raw).expect(401);
    expect(client.listChangedFilesTolerant).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(client.createCommitStatus).not.toHaveBeenCalled();
  });

  it('does no work at all for a repository outside the allowlist', async () => {
    const client = githubClient();
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload({ repository: { full_name: 'other/service' } });
    await send(app, raw, 'delivery-cr-other-repo').expect(202).expect(({ body }) => expect(body.reason).toBe('repository_not_allowed'));
    expect(client.listChangedFilesTolerant).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('refuses a fork before ever fetching the listing or calling the provider', async () => {
    const client = githubClient();
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', allowForks: false, changeReview: changeReviewSettings } });
    const raw = githubPayload({ pull_request: { number: 42, head: { sha: headSha, repo: { full_name: 'attacker/service' } }, base: { sha: baseSha } } });
    await send(app, raw, 'delivery-cr-fork').expect(202).expect(({ body }) => expect(body.reason).toBe('fork_not_allowed'));
    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('/status reports changeReview enabled/disabled and the last change-review outcome, and leaks no content', async () => {
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client: githubClient(), report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-status').expect(202);
    await waitForChangeReviewOutcome(app, 'evaluated');
    const status = await supertest(app).get('/status').expect(200);
    expect(status.body.githubWebhook.changeReview).toBe('enabled');
    expect(status.body.githubWebhook.lastChangeReviewOutcome).toMatchObject({ code: 'evaluated' });
    expect(JSON.stringify(status.body)).not.toContain('acme/service');

    const { app: disabledApp } = withReporting();
    const disabledStatus = await supertest(disabledApp).get('/status').expect(200);
    expect(disabledStatus.body.githubWebhook.changeReview).toBe('disabled');
    expect(disabledStatus.body.githubWebhook.lastChangeReviewOutcome).toBeUndefined();
  });

  it('is outwardly unaffected when changeReview is left unset: no extra provider calls, no jev/change-review status, and no patch fields retained (F7)', async () => {
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({ createCommitStatus });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-cr-disabled').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));
    // F3: the queue worker's shared listing (`listChangedFilesTolerant`) is used regardless of whether change
    // review is enabled -- the old throwing `listChangedFiles` is only ever used by the synchronous `report:
    // none` path now. `includePatchFields: false` here is what actually keeps readiness's own outward behaviour,
    // messages, and outcomes unaffected (see the config-matrix and F7 tests) even though the INTERNAL call changed.
    expect(client.listChangedFiles).not.toHaveBeenCalled();
    expect(client.listChangedFilesTolerant).toHaveBeenCalledWith('acme/service', 42, expect.objectContaining({ includePatchFields: false }), expect.anything());
    expect(evaluate).toHaveBeenCalledTimes(1);
    const contexts = createCommitStatus.mock.calls.map(call => (call[2] as { context: string }).context);
    expect(contexts).toEqual(['jev/readiness', 'jev/readiness']);
  });

  it('end-to-end: canaries from a sensitive file, a non-allow-listed file, and the PR description reach exactly where the core dictates -- never a GitHub write, console output, or /status, with the description reaching the provider by design', async () => {
    const SENSITIVE_CANARY = 'CANARY_SENSITIVE_PATCH_CONTENT';
    const UNLISTED_CANARY = 'CANARY_UNLISTED_PATCH_CONTENT';
    const BODY_CANARY = 'CANARY_PR_DESCRIPTION_TEXT';
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const createIssueComment = vi.fn().mockResolvedValue(undefined);
    const updateIssueComment = vi.fn().mockResolvedValue(undefined);
    const client = githubClient({
      createCommitStatus, createIssueComment, updateIssueComment,
      getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service', title: 'Replace endpoint', body: `Rollout notes: ${BODY_CANARY}` }),
      listChangedFilesTolerant: vi.fn().mockResolvedValue({
        files: [
          { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' },
          { filename: 'src/.env', status: 'modified', additions: 1, deletions: 1, patch: SENSITIVE_CANARY },
          { filename: 'other/notes.md', status: 'added', additions: 1, deletions: 0, patch: UNLISTED_CANARY },
        ],
        truncated: false,
      }),
    });
    const captured: string[] = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); });
    const evaluate = vi.fn(async (request: JevRequest): Promise<JevResponse> => {
      if ('breaking' in request.questions) {
        // The provider request IS where the core sends allow-listed diff content and the PR description --
        // asserting BOTH directions here documents that the description is sent by design, not an oversight.
        expect(request.state.context).toContain('src/a.ts');
        expect(request.state.context).toContain(BODY_CANARY);
        expect(request.state.context).not.toContain(SENSITIVE_CANARY);
        expect(request.state.context).not.toContain(UNLISTED_CANARY);
        return { model: 'test', answers: { breaking: { type: 'noul', noul: 0.1 }, migration: { type: 'noul', noul: 0.1 }, access: { type: 'noul', noul: 0.1 }, rollback: { type: 'noul', noul: 0.9 } } };
      }
      return readinessResponse();
    });
    const { app } = withReporting({ report: 'status+comment' }, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status+comment', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-canary-e2e').expect(202);
    await waitForReal(() => expect(createIssueComment).toHaveBeenCalledTimes(1));

    const allStatusDescriptions = createCommitStatus.mock.calls.map(call => JSON.stringify(call[2]));
    const allCommentBodies = [...createIssueComment.mock.calls, ...updateIssueComment.mock.calls].map(call => String(call[2]));
    const status = await supertest(app).get('/status').expect(200);

    for (const canary of [SENSITIVE_CANARY, UNLISTED_CANARY]) {
      for (const description of allStatusDescriptions) expect(description).not.toContain(canary);
      for (const body of allCommentBodies) expect(body).not.toContain(canary);
      expect(JSON.stringify(status.body)).not.toContain(canary);
      for (const line of captured) expect(line).not.toContain(canary);
    }
    // The PR description is never written to GitHub either -- only sent to the provider (asserted above).
    for (const description of allStatusDescriptions) expect(description).not.toContain(BODY_CANARY);
    for (const body of allCommentBodies) expect(body).not.toContain(BODY_CANARY);
    expect(JSON.stringify(status.body)).not.toContain(BODY_CANARY);

    consoleSpy.mockRestore();
  });

  it('disabled-mode canary: with changeReview unset, canaries reach neither the provider nor any GitHub write, no patch fields are retained on the parsed listing, and no extra GitHub read happens', async () => {
    const SENSITIVE_CANARY = 'CANARY_DISABLED_PATCH_CONTENT';
    const createCommitStatus = vi.fn().mockResolvedValue(undefined);
    const listChangedFilesTolerant = vi.fn().mockResolvedValue({
      files: [
        { filename: 'docs/runbook.md', status: 'modified', additions: 1, deletions: 0, patch: SENSITIVE_CANARY },
      ],
      truncated: false,
    });
    const getPullRequest = vi.fn().mockResolvedValue({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service', title: 'Update runbook', body: `See also: ${SENSITIVE_CANARY}` });
    const client = githubClient({ createCommitStatus, listChangedFilesTolerant, getPullRequest });
    const evaluate = vi.fn().mockResolvedValue(readinessResponse());
    // changeReview intentionally left unset -- withReporting()'s default.
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status' } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-canary-disabled').expect(202);
    await waitForReal(() => expect(createCommitStatus).toHaveBeenCalledTimes(2));

    // Three GitHub PR reads for a readiness-only delivery (see docs/github-webhook.md's "Reads per delivery"):
    // the shared `prepareDelivery` read, the ONE shared pre-evaluate recheck, and `reportFinal`'s own
    // final-write staleness recheck -- never an extra read for a change-review path that never runs.
    expect(getPullRequest).toHaveBeenCalledTimes(3);
    expect(listChangedFilesTolerant).toHaveBeenCalledTimes(1);
    expect(listChangedFilesTolerant.mock.calls[0][2]).toMatchObject({ includePatchFields: false });
    // The parsed listing objects this delivery actually worked with never carried a `patch` field at all -- not
    // merely an unused one -- since readiness's own client call asked for none (see client.ts's own F7 test for
    // the client-level guarantee this exercises end-to-end).
    evaluate.mock.calls.forEach(call => { expect(JSON.stringify(call[0])).not.toContain(SENSITIVE_CANARY); });
    expect(createCommitStatus.mock.calls.map(call => JSON.stringify(call[2])).join('')).not.toContain(SENSITIVE_CANARY);
    const status = await supertest(app).get('/status').expect(200);
    expect(JSON.stringify(status.body)).not.toContain(SENSITIVE_CANARY);
    expect(status.body.githubWebhook.changeReview).toBe('disabled');
  });

  describe('F4: change-review error wording never echoes readiness wording', () => {
    it('a GitHub listing-limit failure before either onMatched fires classifies each context with its OWN wording', async () => {
      const createCommitStatus = vi.fn().mockResolvedValue(undefined);
      const client = githubClient({ createCommitStatus, listChangedFilesTolerant: vi.fn().mockRejectedValue(new GitHubLimitError('GitHub response exceeded the configured response size limit.')) });
      const evaluate = combinedEvaluate();
      const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
      const raw = githubPayload();
      await send(app, raw, 'delivery-f4-limit').expect(202);
      await waitForOutcome(app, 'error:limit');
      await waitForChangeReviewOutcome(app, 'error:limit');
      expect(createCommitStatus).not.toHaveBeenCalled(); // neither onMatched fired -- nothing was ever owed
      const status = await supertest(app).get('/status').expect(200);
      expect(status.body.githubWebhook.lastOutcome.code).toBe('error:limit');
      expect(status.body.githubWebhook.lastChangeReviewOutcome.code).toBe('error:limit');
    });

    it('a deadline failure during change review\'s own evaluation writes "Change review exceeded its processing deadline.", never the readiness wording', async () => {
      let releaseReadiness: (() => void) | undefined;
      const readinessGate = new Promise<void>(resolve => { releaseReadiness = resolve; });
      const createCommitStatus = vi.fn().mockResolvedValue(undefined);
      const evaluate = vi.fn(async (request: JevRequest, signal?: AbortSignal): Promise<JevResponse> => {
        if ('breaking' in request.questions) {
          return new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted by change review deadline'))); });
        }
        await readinessGate;
        return readinessResponse();
      });
      const client = githubClient({ createCommitStatus });
      const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings, timeoutMs: 1000 } });
      const raw = githubPayload();
      await send(app, raw, 'delivery-f4-deadline').expect(202);
      await waitForReal(async () => {
        const status = await supertest(app).get('/status');
        expect(status.body.githubWebhook?.lastChangeReviewOutcome?.code).toBe('error:deadline');
      });
      const changeReviewCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review');
      const errorCall = changeReviewCalls.find(call => (call[2] as { state: string }).state === 'error');
      expect(errorCall?.[2]).toMatchObject({ description: expect.stringContaining('Change review exceeded its processing deadline.') });
      expect(errorCall?.[2]).not.toMatchObject({ description: expect.stringContaining('Jev readiness check') });
      releaseReadiness?.();
    });
  });

  describe('F5(a): change review is guaranteed a share of the job deadline', () => {
    it('readiness alone cannot consume the whole timeout when change review is also enabled', async () => {
      // Readiness hangs forever (never resolves); change review resolves quickly. With a 1000ms total timeout and
      // change review guaranteed min(15000, timeoutMs/2) = 500ms, readiness's OWN sub-deadline is capped at
      // timeoutMs - 500 = 500ms, so it fails well before the full 1000ms, and change review still gets to run.
      const createCommitStatus = vi.fn().mockResolvedValue(undefined);
      const evaluate = vi.fn(async (request: JevRequest, signal?: AbortSignal): Promise<JevResponse> => {
        if ('breaking' in request.questions) return { model: 'test', answers: { breaking: { type: 'noul', noul: 0.1 }, migration: { type: 'noul', noul: 0.1 }, access: { type: 'noul', noul: 0.1 }, rollback: { type: 'noul', noul: 0.9 } } };
        return new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('readiness aborted by its own shortened sub-deadline'))); });
      });
      const client = githubClient({ createCommitStatus });
      const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings, timeoutMs: 1000 } });
      const raw = githubPayload();
      await send(app, raw, 'delivery-f5a-split').expect(202);
      await waitForReal(async () => {
        const status = await supertest(app).get('/status');
        expect(status.body.githubWebhook?.lastChangeReviewOutcome?.code).toBe('evaluated');
        expect(status.body.githubWebhook?.lastOutcome?.code).toBe('error:deadline');
      });
      const changeReviewCalls = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review');
      expect(changeReviewCalls.some(call => (call[2] as { state: string }).state === 'success' || (call[2] as { state: string }).state === 'failure')).toBe(true);
    });
  });

  describe('F5(b): per-context completion tracking and redelivery', () => {
    it('a redelivery of a partially-completed delivery skips the already-done context and only retries the unfinished one', async () => {
      const createCommitStatus = vi.fn().mockResolvedValue(undefined);
      // Change review always succeeds; readiness's final write fails once (so readiness is left un-done) then
      // succeeds on the retried redelivery.
      let readinessWriteAttempt = 0;
      createCommitStatus.mockImplementation(async (_repo: string, _sha: string, status: { context: string; state: string }) => {
        if (status.context === 'jev/readiness' && status.state !== 'pending') {
          readinessWriteAttempt++;
          if (readinessWriteAttempt === 1) throw new Error('GitHub is down for the first attempt');
        }
      });
      const evaluate = combinedEvaluate();
      const client = githubClient({ createCommitStatus });
      const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
      const raw = githubPayload();
      await send(app, raw, 'delivery-f5b-partial').expect(202);
      await waitForReal(async () => {
        const status = await supertest(app).get('/status');
        expect(status.body.githubWebhook?.lastChangeReviewOutcome?.code).toBe('evaluated');
      });
      const changeReviewCallsAfterFirst = createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review').length;
      const evaluateCallsAfterFirst = evaluate.mock.calls.length;

      // Redeliver the SAME delivery id: it is neither a busy-503 nor a bounced duplicate, since readiness never
      // finished -- it re-queues, and only readiness runs this time (no second change-review provider call, no
      // pending flip on the already-`evaluated` jev/change-review status).
      await send(app, raw, 'delivery-f5b-partial').expect(202).expect(({ body }) => expect(body).toEqual({ accepted: true, deliveryId: 'delivery-f5b-partial' }));
      await waitForReal(() => expect(readinessWriteAttempt).toBe(2));
      expect(createCommitStatus.mock.calls.filter(call => (call[2] as { context: string }).context === 'jev/change-review').length).toBe(changeReviewCallsAfterFirst); // no more change-review writes
      expect(evaluate.mock.calls.length).toBe(evaluateCallsAfterFirst + 1); // exactly one more provider call (readiness's retried document), not two
    });

    it('a fully-completed delivery still bounces as an ordinary duplicate, not a partial redelivery', async () => {
      const createCommitStatus = vi.fn().mockResolvedValue(undefined);
      const evaluate = combinedEvaluate();
      const client = githubClient({ createCommitStatus });
      const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
      const raw = githubPayload();
      await send(app, raw, 'delivery-f5b-full').expect(202);
      await waitForReal(async () => {
        const status = await supertest(app).get('/status');
        expect(status.body.githubWebhook?.lastChangeReviewOutcome?.code).toBe('evaluated');
        expect(status.body.githubWebhook?.lastOutcome?.code).toBe('evaluated');
      });
      const evaluateCallsAfterFirst = evaluate.mock.calls.length;
      await send(app, raw, 'delivery-f5b-full').expect(200).expect(({ body }) => expect(body.status).toBe('duplicate'));
      expect(evaluate.mock.calls.length).toBe(evaluateCallsAfterFirst); // nothing re-ran
    });
  });

  it('F6: an unrecognized thrown error still resolves a still-open context\'s pending rather than leaving it dangling, and never becomes an unhandled rejection', async () => {
    // Every GitHub-touching write in this codebase already runs through `guarded()` (reporting.ts), which by
    // design never rethrows -- so a client mock rejection cannot itself reach `processQueueJob`'s outermost
    // catch; it is always classified first (see `classifyWebhookError`'s `error:unknown` default branch, which
    // IS reachable this way and is what this test exercises). The outermost catch above that remains as defense
    // in depth for a genuine bug in this module's own orchestration; it is covered by the `finalizeDelivery`
    // correctness this test also protects (see the F6 comment on `readinessFinalized`/`changeReviewFinalized`
    // in `router.ts`, which specifically stops that catch from ever overwriting an already-finished context's
    // real result with a spurious `error:worker`).
    const client = githubClient({ getFile: vi.fn().mockImplementation(() => { throw new RangeError('an unrecognized failure'); }) });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, report: 'status', changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'delivery-f6-unrecognized').expect(202);
    await waitForReal(async () => {
      const status = await supertest(app).get('/status');
      expect(status.body.githubWebhook?.lastOutcome?.code).toBe('error:unknown');
      // Change review does not touch getFile at all, so it is unaffected by readiness's own unrecognized failure
      // -- proving isolation holds even for an error type neither context's classifier specifically recognizes.
      expect(status.body.githubWebhook?.lastChangeReviewOutcome?.code).toBe('evaluated');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.once('unhandledRejection', onUnhandled);
    await new Promise(resolve => setTimeout(resolve, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
  it.each([false, true].flatMap(enabled => [89, 90, 91, 150, 299, 300, 301].map(count => ({ enabled, count }))))(
    'keeps the 300-file readiness bound at $count files with change review=$enabled', async ({ enabled, count }) => {
      const files = Array.from({ length: count }, (_, index) => ({ filename: index === 0 ? 'docs/runbook.md' : `src/file${index}.ts`, status: 'modified', patch: '+synthetic change' }));
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
        const url = new URL(String(input));
        const perPage = Number(url.searchParams.get('per_page'));
        const page = Number(url.searchParams.get('page'));
        expect(perPage).toBe(enabled ? 30 : 100);
        const hasNext = page * perPage < files.length;
        return new Response(JSON.stringify(files.slice((page - 1) * perPage, page * perPage)), {
          headers: { link: `<https://api.github.test/files?page=${hasNext ? page + 1 : page - 1}>; rel="${hasNext ? 'next' : 'prev'}"` },
        });
      });
      const transport = createGitHubClient({ token: 'synthetic', fetch: fetcher });
      const client = githubClient({ listChangedFilesTolerant: transport.listChangedFilesTolerant });
      const evaluate = combinedEvaluate();
      const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, changeReview: { ...changeReviewSettings, enabled } } });
      await send(app, githubPayload(), `boundary-${enabled}-${count}`).expect(202);
      await waitForOutcome(app, count > 300 ? 'error:limit' : 'evaluated');
      const readinessCalls = evaluate.mock.calls.filter(([request]) => !('breaking' in request.questions));
      expect(readinessCalls).toHaveLength(count > 300 ? 0 : 1);
      expect(fetcher).toHaveBeenCalledTimes(Math.min(Math.ceil(count / (enabled ? 30 : 100)), enabled ? 10 : 3));
      if (!enabled) expect(JSON.stringify(evaluate.mock.calls)).not.toContain('synthetic change');
    },
  );

  it.each([false, true])('reports too many documents after pending, with change review=%s', async enabled => {
    const client = githubClient({ listChangedFilesTolerant: vi.fn().mockResolvedValue({
      files: ['a', 'b', 'c', 'd'].map(name => ({ filename: `docs/${name}.md`, status: 'modified' })), truncated: false,
    }) });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, changeReview: { ...changeReviewSettings, enabled } } });
    const raw = githubPayload();
    await send(app, raw, 'document-limit').expect(202);
    await waitForOutcome(app, 'error:limit');
    const statuses = vi.mocked(client.createCommitStatus).mock.calls.map(call => call[2]);
    expect(statuses.filter(status => status.context === 'jev/readiness').map(status => status.state)).toEqual(['pending', 'error']);
    expect(evaluate.mock.calls.filter(([request]) => !('breaking' in request.questions))).toHaveLength(0);
    expect(client.getFile).not.toHaveBeenCalled();
    if (enabled) expect(statuses.filter(status => status.context === 'jev/change-review').map(status => status.state)).toEqual(['pending', 'success']);
    await send(app, raw, 'document-limit').expect(200).expect(({ body }) => expect(body.status).toBe('duplicate'));
  });

  it.each(['jev/readiness', 'jev/change-review', 'both'])('resolves old pending on a moved head without rewriting finished contexts: %s', async unfinished => {
    let fail = true;
    const createCommitStatus = vi.fn(async (_repo: string, _sha: string, status: { context: string; state: string }) => {
      if (fail && status.state !== 'pending' && (unfinished === 'both' || status.context === unfinished)) throw new GitHubClientError(false, 'Synthetic write rejection', 401);
    });
    const client = githubClient({ createCommitStatus });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, changeReview: changeReviewSettings } });
    await send(app, githubPayload(), 'moved-partial').expect(202);
    await waitForOutcome(app, 'evaluated');
    const calls = createCommitStatus.mock.calls.length;
    const evaluations = evaluate.mock.calls.length;
    fail = false;
    vi.mocked(client.getPullRequest).mockResolvedValue({ number: 42, headSha: 'c'.repeat(40), baseSha, headRepoFullName: 'acme/service', title: '', body: '' });
    await send(app, githubPayload(), 'moved-partial').expect(202);
    await waitForOutcome(app, unfinished === 'jev/change-review' ? 'skipped:already_done' : 'ignored:stale_delivery');
    const final = createCommitStatus.mock.calls.slice(calls);
    expect(final.map(call => call[2].context)).toEqual(unfinished === 'both' ? ['jev/readiness', 'jev/change-review'] : [unfinished]);
    for (const call of final) {
      expect(call[1]).toBe(headSha);
      expect(call[2]).toMatchObject({ state: 'success', description: expect.stringContaining('Not evaluated -- the pull request changed') });
    }
    expect(evaluate).toHaveBeenCalledTimes(evaluations);
    await send(app, githubPayload(), 'moved-partial').expect(200);
  });

  it('preserves partial progress when a queued retry is superseded', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let block = false;
    let failFinal = true;
    const getPullRequest = vi.fn(async (_repo: string, number: number) => {
      if (number === 43 && block) await gate;
      return { number, headSha, baseSha, headRepoFullName: 'acme/service', title: '', body: '' };
    });
    const createCommitStatus = vi.fn(async (_repo: string, _sha: string, status: { context: string; state: string }) => {
      if (failFinal && status.context === 'jev/readiness' && status.state !== 'pending') throw new GitHubClientError(false, 'Synthetic write rejection', 401);
    });
    const evaluate = combinedEvaluate();
    const client = githubClient({ getPullRequest, createCommitStatus });
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, changeReview: changeReviewSettings } });
    const raw = githubPayload();
    await send(app, raw, 'partial-queued').expect(202);
    await waitForOutcome(app, 'evaluated');
    failFinal = false;
    block = true;
    const other = JSON.parse(raw);
    other.number = 43; other.pull_request.number = 43;
    try {
      await send(app, JSON.stringify(other), 'blocker').expect(202);
      await waitForReal(() => expect(getPullRequest.mock.calls.some(call => call[1] === 43)).toBe(true));
      await send(app, raw, 'partial-queued').expect(202);
      await send(app, raw, 'newer-delivery').expect(202);
      await waitForOutcome(app, 'superseded');
    } finally { release(); }
    await waitForReal(async () => {
      const response = await supertest(app).get('/status');
      expect(response.body.githubWebhook.inFlight).toBe(0);
      expect(response.body.githubWebhook.queueLength).toBe(0);
    });
    const priorCalls = createCommitStatus.mock.calls.length;
    const priorEvaluations = evaluate.mock.calls.length;
    await send(app, raw, 'partial-queued').expect(202);
    await waitForOutcome(app, 'evaluated');
    await waitForReal(() => expect(evaluate).toHaveBeenCalledTimes(priorEvaluations + 1));
    expect(createCommitStatus.mock.calls.slice(priorCalls).map(call => call[2].context)).toEqual(['jev/readiness']);
  });

  it.each(['read-error', 'truncated', 'no-match'])('resolves earlier pending even when retry preparation yields %s', async retry => {
    let fail = true;
    const createCommitStatus = vi.fn(async (_repo: string, _sha: string, status: { context: string; state: string }) => {
      if (fail && status.context === 'jev/readiness' && status.state !== 'pending') throw new GitHubClientError(false, 'Synthetic rejection', 401);
    });
    const client = githubClient({ createCommitStatus });
    const evaluate = combinedEvaluate();
    const { app } = withReporting({}, { evaluate, githubWebhook: { ...withWebhook().options.githubWebhook!, client, changeReview: changeReviewSettings } });
    await send(app, githubPayload(), 'retry-preparation').expect(202);
    await waitForOutcome(app, 'evaluated');
    const evaluations = evaluate.mock.calls.length;
    const writes = createCommitStatus.mock.calls.length;
    fail = false;
    if (retry === 'read-error') vi.mocked(client.listChangedFilesTolerant).mockRejectedValue(new GitHubClientError(false, 'Synthetic rejection', 401));
    else vi.mocked(client.listChangedFilesTolerant).mockResolvedValue({ files: [], truncated: retry === 'truncated' });
    await send(app, githubPayload(), 'retry-preparation').expect(202);
    await waitForReal(async () => {
      const status = await supertest(app).get('/status');
      expect(status.body.githubWebhook.inFlight).toBe(0);
    });
    const final = createCommitStatus.mock.calls.slice(writes);
    expect(final).toHaveLength(1);
    expect(final[0][1]).toBe(headSha);
    expect(final[0][2]).toMatchObject({ context: 'jev/readiness', state: retry === 'no-match' ? 'success' : 'error' });
    expect(evaluate).toHaveBeenCalledTimes(evaluations);
    await send(app, githubPayload(), 'retry-preparation').expect(200);
  });

});
});

describe('incident response suggestions', () => {
  const incident = { workflow: 'incident', text: 'Customers report login failures after release.', candidates: [] };
  const evaluate = async (request: JevRequest): Promise<JevResponse> => ({ model: 'test', answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria);
    return [id, { type: 'choice', choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((key, i) => [key, i ? 0 : 1])) }];
  })) as JevResponse['answers'] });
  const generated = { status: 'generated', provider: 'openai', model: 'configured', mode: 'live', generatedAt: '2026-09-23T00:00:00.000Z', plan: { summary: 'Check the release.', hypotheses: [], checks: ['Compare the timeline.'], actions: [], unknowns: ['Scope.'] } } as const;
  it('returns Jev findings without waiting on the planner, with a reference for a separate plan request', async () => {
    const generate = vi.fn().mockResolvedValue(generated);
    const { app } = setup({ demoMode: false, evaluate, responsePlanner: { provider: 'openai', model: 'configured', generate } });
    const result = await supertest(app).post('/evaluate').send(incident).expect(200);
    expect(result.body.findings).toHaveLength(2);
    expect(result.body.responsePlan).toBeUndefined();
    expect(result.body.responsePlanRef).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), expiresAt: expect.any(String) });
    expect(generate).not.toHaveBeenCalled();

    const plan = await supertest(app).post('/response-plan').send({ ref: result.body.responsePlanRef.id }).expect(200);
    expect(plan.body).toEqual(generated);
    // The planner gets the server's own report and findings, never anything the browser sent back.
    expect(generate).toHaveBeenCalledWith(incident.text, expect.objectContaining({ workflow: 'incident', mode: 'live', findings: result.body.findings }), expect.any(AbortSignal));
    expect(generate.mock.calls[0][1].responsePlanRef).toBeUndefined();
  });
  it('accepts only a reference, and only for the user it was issued to', async () => {
    const generate = vi.fn().mockResolvedValue(generated);
    const users = ['user:default/test', 'user:default/other'];
    const credentials = vi.fn().mockImplementation(async () => ({ principal: { type: 'user', userEntityRef: users[0] } }));
    const { app } = setup({ demoMode: false, evaluate, responsePlanner: { provider: 'openai', model: 'configured', generate }, httpAuth: { credentials } });
    const { body: result } = await supertest(app).post('/evaluate').send(incident).expect(200);
    await supertest(app).post('/response-plan').send({ ref: result.responsePlanRef.id, result }).expect(400);
    await supertest(app).post('/response-plan').send({ result }).expect(400);
    await supertest(app).post('/response-plan').send({ ref: crypto.randomUUID() }).expect(404);
    users.reverse();
    const foreign = await supertest(app).post('/response-plan').send({ ref: result.responsePlanRef.id }).expect(404);
    expect(foreign.body.error).toMatch(/no longer available/);
    expect(generate).not.toHaveBeenCalled();
  });
  it('refuses a concurrent request for the same reference and allows a retry afterwards', async () => {
    let finish!: (value: typeof generated) => void;
    const generate = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(generated);
    const { app } = setup({ demoMode: false, evaluate, responsePlanner: { provider: 'openai', model: 'configured', generate } });
    const { body: result } = await supertest(app).post('/evaluate').send(incident).expect(200);
    const first = supertest(app).post('/response-plan').send({ ref: result.responsePlanRef.id }).then(response => response);
    await waitForReal(() => expect(generate).toHaveBeenCalledTimes(1));
    await supertest(app).post('/response-plan').send({ ref: result.responsePlanRef.id }).expect(409);
    finish(generated);
    expect((await first).status).toBe(200);
    await supertest(app).post('/response-plan').send({ ref: result.responsePlanRef.id }).expect(200);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('reports a planner failure as a failed outcome without exposing provider errors', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('PRIVATE PROVIDER ERROR'));
    const { app } = setup({ demoMode: false, evaluate, responsePlanner: { provider: 'openai', model: 'configured', generate } });
    const { body: result } = await supertest(app).post('/evaluate').send(incident).expect(200);
    const plan = await supertest(app).post('/response-plan').send({ ref: result.responsePlanRef.id }).expect(200);
    expect(plan.body).toEqual({ status: 'failed', provider: 'openai', model: 'configured', code: 'unavailable' });
    expect(JSON.stringify(plan.body)).not.toContain('PRIVATE');
  });
  it('issues no reference without a planner, and refuses plan requests then', async () => {
    const { app } = setup({ demoMode: false, evaluate });
    const { body: result } = await supertest(app).post('/evaluate').send(incident).expect(200);
    expect(result.responsePlanRef).toBeUndefined();
    await supertest(app).post('/response-plan').send({ ref: crypto.randomUUID() }).expect(503);
  });
  it('does not send to a live planner in demo mode', async () => {
    const generate = vi.fn();
    const { app } = setup({ responsePlanner: { provider: 'anthropic', model: 'configured', generate } });
    const { body: result } = await supertest(app).post('/evaluate').send(incident).expect(200);
    expect(result.responsePlanRef).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
  it('does not invoke the planner for other workflows or unauthorized input', async () => {
    const generate = vi.fn();
    const planner = { provider: 'openai' as const, model: 'configured', generate };
    const { app } = setup({ demoMode: false, evaluate: async () => readinessResponse(), responsePlanner: planner });
    await supertest(app).post('/evaluate').send(body).expect(200);
    await supertest(app).post('/evaluate').send({ ...incident, text: '' }).expect(400);
    const denied = setup({ demoMode: false, evaluate, responsePlanner: planner, permissions: { authorize: vi.fn().mockResolvedValue([{ result: AuthorizeResult.DENY }]) } });
    await supertest(denied.app).post('/evaluate').send(incident).expect(403);
    await supertest(denied.app).post('/response-plan').send({ ref: crypto.randomUUID() }).expect(403);
    expect(generate).not.toHaveBeenCalled();
  });
});
