import { describe, expect, it } from 'vitest';
import { demoEvaluation, sampleCandidates, sampleText, workflowIds, type EvaluationRequest } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { isEvaluationResult } from './evaluationResult';

function requestFor(workflow: EvaluationRequest['workflow']): EvaluationRequest {
  const candidates = ['templates', 'ownership', 'search'].includes(workflow) ? sampleCandidates : [];
  return { workflow, text: sampleText[workflow], candidates };
}

function validFinding() {
  return demoEvaluation(requestFor('readiness')).findings[0];
}

describe('isEvaluationResult', () => {
  it('accepts real demoEvaluation output for all six workflows', () => {
    for (const workflow of workflowIds) {
      const result = demoEvaluation(requestFor(workflow));
      expect(isEvaluationResult(result)).toBe(true);
    }
  });

  it('rejects a finding missing `value`', () => {
    const finding: Record<string, unknown> = { ...validFinding() };
    delete finding.value;
    const result = { ...demoEvaluation(requestFor('readiness')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });

  it('rejects a finding whose value is NaN', () => {
    const finding = { ...validFinding(), value: NaN };
    const result = { ...demoEvaluation(requestFor('readiness')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });

  it('rejects a finding whose value is Infinity', () => {
    const finding = { ...validFinding(), value: Infinity };
    const result = { ...demoEvaluation(requestFor('readiness')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });

  it('rejects a finding with an unknown `kind`', () => {
    const finding = { ...validFinding(), kind: 'bogus' };
    const result = { ...demoEvaluation(requestFor('readiness')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });

  it('rejects a `choice` finding whose value is not a string', () => {
    const choiceFinding = demoEvaluation(requestFor('templates')).findings[0];
    expect(choiceFinding.kind).toBe('choice');
    const finding = { ...choiceFinding, value: 3 };
    const result = { ...demoEvaluation(requestFor('templates')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });

  it('rejects a finding missing `guidance`', () => {
    const finding: Record<string, unknown> = { ...validFinding() };
    delete finding.guidance;
    const result = { ...demoEvaluation(requestFor('readiness')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });

  it('rejects a finding whose `guidance` is not a string', () => {
    const finding = { ...validFinding(), guidance: 42 };
    const result = { ...demoEvaluation(requestFor('readiness')), findings: [finding] };
    expect(isEvaluationResult(result)).toBe(false);
  });
});
