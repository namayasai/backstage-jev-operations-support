import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter, type RouterOptions } from './router';
import { ProviderError, type GitHubClient } from './client';

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
    getPullRequest: vi.fn().mockResolvedValue({ number: 42, headSha, baseSha, headRepoFullName: 'acme/service' }),
    listChangedFiles: vi.fn().mockResolvedValue([{ filename: 'docs/runbook.md', status: 'modified' }]),
    getFile: vi.fn().mockResolvedValue({ path: 'docs/runbook.md', content: 'Start with npm ci. Health: GET /health. Escalate to on-call.', size: 58 }),
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
    const request = supertest(app).post('/webhooks/github').set('content-type', 'application/json').set('x-github-event', 'pull_request').set('x-github-delivery', 'delivery-replay').set('x-hub-signature-256', sign(raw)).send(raw);
    await request.expect(200).expect(({ body }) => { expect(body.status).toBe('evaluated'); expect(body.documents[0].result.workflow).toBe('readiness'); });
    await request.expect(200).expect(({ body }) => expect(body.status).toBe('duplicate'));
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
