import crypto from 'node:crypto';
import type { EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';

export const responsePlanRefTtlMs = 15 * 60_000;
export const maxResponsePlanRefs = 500;
export const maxResponsePlanRefsPerUser = 20;

type Entry = { user: string; text: string; result: EvaluationResult; expiresAt: number; generating: boolean };

export type ResponsePlanRefLookup =
  | { status: 'ok'; text: string; result: EvaluationResult; release: () => void }
  /** Unknown, expired, or issued to another user: indistinguishable to the caller on purpose. */
  | { status: 'missing' }
  /** A plan for this reference is already being generated. */
  | { status: 'busy' };

/**
 * Short-lived, per-process references to incident assessments this backend itself produced.
 * `/response-plan` accepts only such a reference, never a result supplied by the browser, so
 * the planner is always given the exact report and Jev findings the server returned. Nothing
 * here is persisted: a restart, expiry, or a request routed to another backend instance means
 * the reader checks the report again.
 */
export function createResponsePlanRefs(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  function prune(): void {
    const time = now();
    for (const [id, entry] of entries) if (entry.expiresAt <= time && !entry.generating) entries.delete(id);
  }
  return {
    issue(user: string, text: string, result: EvaluationResult): { id: string; expiresAt: string } {
      prune();
      const own = [...entries].filter(([, entry]) => entry.user === user && !entry.generating);
      // Map iteration is insertion order, so the first entries are the oldest.
      if (own.length >= maxResponsePlanRefsPerUser) entries.delete(own[0][0]);
      if (entries.size >= maxResponsePlanRefs) {
        const oldest = [...entries].find(([, entry]) => !entry.generating);
        if (oldest) entries.delete(oldest[0]);
      }
      const id = crypto.randomUUID();
      const expiresAt = now() + responsePlanRefTtlMs;
      const { responsePlan: _plan, responsePlanRef: _ref, ...stored } = result;
      entries.set(id, { user, text, result: stored, expiresAt, generating: false });
      return { id, expiresAt: new Date(expiresAt).toISOString() };
    },
    claim(user: string, id: string): ResponsePlanRefLookup {
      prune();
      const entry = entries.get(id);
      if (!entry || entry.user !== user || entry.expiresAt <= now()) return { status: 'missing' };
      if (entry.generating) return { status: 'busy' };
      entry.generating = true;
      return { status: 'ok', text: entry.text, result: entry.result, release: () => { entry.generating = false; } };
    },
    get size(): number { return entries.size; },
  };
}

export type ResponsePlanRefs = ReturnType<typeof createResponsePlanRefs>;
