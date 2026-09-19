import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter, type RouterOptions } from './router';
import { ProviderError } from './client';

function setup(overrides: Partial<RouterOptions> = {}) {
  const options: RouterOptions = {
    httpAuth: { credentials: vi.fn().mockResolvedValue({ principal: { type: 'user', userEntityRef: 'user:default/test' } }) },
    permissions: { authorize: vi.fn().mockResolvedValue([{ result: AuthorizeResult.ALLOW }]) },
    demoMode: true, ...overrides,
  };
  return { options, app: express().use(createRouter(options)) };
}
const body = { workflow: 'readiness', text: 'Run npm start. Check /health. Contact payments-oncall.', candidates: [] };
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
