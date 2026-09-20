import { z } from 'zod';

const text = z.string().trim().min(1).max(1200);
export const responsePlanSchema = z.object({
  summary: text,
  hypotheses: z.array(z.object({ cause: text, evidence: text, verification: text }).strict()).max(4),
  checks: z.array(text).max(6),
  actions: z.array(z.object({ action: text, preconditions: text, risk: text, verification: text }).strict()).max(5),
  unknowns: z.array(text).max(6),
}).strict();
export type ResponsePlan = z.infer<typeof responsePlanSchema>;
const identity = { provider: z.enum(['openai', 'anthropic', 'openai-compatible', 'demo']), model: z.string().min(1).max(200) };
export const responsePlanOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('generated'), ...identity, mode: z.enum(['live', 'demo']), generatedAt: z.string().datetime(), plan: responsePlanSchema }).strict(),
  z.object({ status: z.literal('pending'), ...identity }).strict(),
  z.object({ status: z.literal('failed'), ...identity, code: z.enum(['unavailable', 'invalid-response', 'timeout', 'busy', 'cancelled']) }).strict(),
]);
export type ResponsePlanOutcome = z.infer<typeof responsePlanOutcomeSchema>;

// API schemas omit length constraints for providers with a smaller JSON Schema subset.
// The bounded schema above is always enforced locally before displaying or storing output.
const string = { type: 'string' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const responsePlanJsonSchema = object({
  summary: string,
  hypotheses: { type: 'array', items: object({ cause: string, evidence: string, verification: string }) },
  checks: { type: 'array', items: string },
  actions: { type: 'array', items: object({ action: string, preconditions: string, risk: string, verification: string }) },
  unknowns: { type: 'array', items: string },
});
