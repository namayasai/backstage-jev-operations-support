import { describe, expect, it } from 'vitest';
import { demoEvaluation } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { createResponsePlanRefs, maxResponsePlanRefs, maxResponsePlanRefsPerUser, responsePlanRefTtlMs } from './responsePlanRefs';

const text = 'Customers report login failures.';
const result = demoEvaluation({ workflow: 'incident', text, candidates: [] });

describe('response-plan references', () => {
  it('expires a reference after its lifetime', () => {
    let time = 0;
    const refs = createResponsePlanRefs(() => time);
    const { id, expiresAt } = refs.issue('user:default/a', text, result);
    expect(expiresAt).toBe(new Date(responsePlanRefTtlMs).toISOString());
    time = responsePlanRefTtlMs;
    expect(refs.claim('user:default/a', id)).toEqual({ status: 'missing' });
  });

  it('stores the result without any earlier plan or reference', () => {
    const refs = createResponsePlanRefs();
    const { id } = refs.issue('user:default/a', text, { ...result, responsePlan: { status: 'pending', provider: 'demo', model: 'x' }, responsePlanRef: { id: 'old', expiresAt: 'x' } });
    const claim = refs.claim('user:default/a', id);
    expect(claim.status === 'ok' && claim.result).toEqual(result);
  });

  it('bounds references per user and in total, oldest first', () => {
    const refs = createResponsePlanRefs();
    const first = refs.issue('user:default/a', text, result);
    for (let i = 1; i < maxResponsePlanRefsPerUser; i++) refs.issue('user:default/a', text, result);
    refs.issue('user:default/a', text, result);
    expect(refs.claim('user:default/a', first.id)).toEqual({ status: 'missing' });
    for (let i = 0; i < maxResponsePlanRefs + 5; i++) refs.issue(`user:default/u${i}`, text, result);
    expect(refs.size).toBeLessThanOrEqual(maxResponsePlanRefs);
  });

  it('never evicts a reference while its plan is being generated', () => {
    const refs = createResponsePlanRefs();
    const held = refs.issue('user:default/a', text, result);
    const claim = refs.claim('user:default/a', held.id);
    for (let i = 0; i < maxResponsePlanRefsPerUser + 1; i++) refs.issue('user:default/a', text, result);
    expect(refs.claim('user:default/a', held.id)).toEqual({ status: 'busy' });
    if (claim.status === 'ok') claim.release();
    expect(refs.claim('user:default/a', held.id).status).toBe('ok');
  });
});
