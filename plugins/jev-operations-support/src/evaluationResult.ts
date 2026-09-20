import { workflowIds, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates that a value matches the evaluation contract's shape. This is the only thing
 * standing between a backend/provider that answers something malformed (`undefined`, `null`,
 * a truncated object, ...) and a render that dereferences it and crashes. Shared by every
 * consumer that receives an `EvaluationResult` from an `evaluate` call: nothing may trust its
 * shape without going through this check first.
 */
const FINDING_KINDS = ['noul', 'choice', 'score'];

/**
 * A finding's `kind` decides what `value` is honest to render: `noul`/`score` are a finite
 * number (a probability or a score level), `choice` is a string (the chosen label). Anything
 * else — a missing `value`, `NaN`/`Infinity`, or a string where a number belongs — would render
 * as "undefined" or sort a `search` result on `NaN`, so it is rejected here rather than trusted.
 */
function hasValidValue(finding: Record<string, unknown>): boolean {
  if (finding.kind === 'choice') return typeof finding.value === 'string';
  return typeof finding.value === 'number' && Number.isFinite(finding.value);
}

export function isEvaluationResult(value: unknown): value is EvaluationResult {
  if (!isRecord(value) || typeof value.model !== 'string' || typeof value.evaluatedAt !== 'string' || !['live', 'demo'].includes(String(value.mode)) || typeof value.needsReview !== 'boolean' || !Array.isArray(value.findings)) return false;
  if (!workflowIds.includes(value.workflow as EvaluationResult['workflow'])) return false;
  return value.findings.every(finding =>
    isRecord(finding) && typeof finding.id === 'string' && typeof finding.title === 'string' && typeof finding.statement === 'string'
    && ['pass', 'attention', 'review'].includes(String(finding.status))
    && FINDING_KINDS.includes(String(finding.kind)) && hasValidValue(finding) && typeof finding.guidance === 'string',
  );
}
