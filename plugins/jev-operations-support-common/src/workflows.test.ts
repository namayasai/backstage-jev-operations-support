import { describe, it, expect } from 'vitest';
import { buildEvaluation, evaluationRequestSchema, evaluationRequestByteLength, MAX_EVALUATION_BYTES, validateResponse, summarize, demoEvaluation, sampleText, sampleCandidates, workflowIds, type EvaluationRequest, type JevResponse } from './index';

function input(workflow: EvaluationRequest['workflow']): EvaluationRequest { return { workflow, text: sampleText[workflow], candidates: ['templates', 'ownership', 'search'].includes(workflow) ? sampleCandidates : [] }; }
describe('workflow contracts', () => {
  it.each(workflowIds)('%s yields inspectable fixture results with an explicit demo marker', workflow => {
    const result = demoEvaluation(input(workflow));
    expect(result.mode).toBe('demo');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.model).toContain('not Jev');
  });
  it('requires a shortlist and rejects duplicate IDs', () => {
    expect(evaluationRequestSchema.safeParse({ ...input('templates'), candidates: [] }).success).toBe(false);
    expect(evaluationRequestSchema.safeParse({ ...input('search'), candidates: [sampleCandidates[0], sampleCandidates[0]] }).success).toBe(false);
  });
  it('rejects excessive Unicode payloads, unknown fields and empty context', () => {
    expect(evaluationRequestSchema.safeParse({ ...input('readiness'), text: '語'.repeat(9000) }).success).toBe(false);
    expect(evaluationRequestSchema.safeParse({ ...input('readiness'), apiKey: 'not-allowed' }).success).toBe(false);
    expect(evaluationRequestSchema.safeParse({ ...input('readiness'), text: '          ' }).success).toBe(false);
  });
  it('exposes the exact UTF-8 request budget used by validation', () => {
    const value = input('readiness');
    expect(evaluationRequestByteLength(value)).toBeLessThanOrEqual(MAX_EVALUATION_BYTES);
    expect(evaluationRequestByteLength({ ...value, text: '語'.repeat(9000) })).toBeGreaterThan(MAX_EVALUATION_BYTES);
  });
  it('includes a no-match option when selecting from closed candidates', () => {
    const { request } = buildEvaluation(input('ownership'));
    expect(request.questions.recommendation.type).toBe('choice');
    expect(request.questions.recommendation.criteria).toHaveProperty('none');
  });
  it('does not treat Noul as a confidence score or uncertain input as pass', () => {
    const value = input('readiness'); const { checks } = buildEvaluation(value);
    const response: JevResponse = { model: 'test', answers: Object.fromEntries(checks.map((c, i) => [c.id, { type: 'noul', noul: [0.99, 0.01, 0.5, 0.8][i] }])) };
    const result = summarize(value, response, checks);
    expect(result.findings.map(f => f.status)).toEqual(['pass', 'attention', 'review', 'pass']);
    expect(result.findings[0].confidence).toBeUndefined();
  });
  it('reverses polarity for risk flags but not rollback coverage', () => {
    const value = input('change-risk'); const { checks } = buildEvaluation(value);
    const response: JevResponse = { model: 'test', answers: Object.fromEntries(checks.map(c => [c.id, { type: 'noul', noul: 0.95 }])) };
    expect(summarize(value, response, checks).findings.map(f => f.status)).toEqual(['attention', 'attention', 'attention', 'pass']);
  });
  it('keeps low risk probabilities in review because missing evidence is not safety', () => {
    const value = input('change-risk'); const { checks } = buildEvaluation(value);
    const response: JevResponse = { model: 'test', answers: Object.fromEntries(checks.map(c => [c.id, { type: 'noul', noul: c.id === 'rollback' ? 0.95 : 0.05 }])) };
    const result = summarize(value, response, checks);
    expect(result.findings.map(f => f.status)).toEqual(['review', 'review', 'review', 'pass']);
    expect(result.findings[0].guidance).toContain('not evidence that the change is safe');
    expect(result.needsReview).toBe(true);
  });
  it('marks confident no-match decisions for human review', () => {
    const value = input('templates'); const { checks, request } = buildEvaluation(value);
    const answer = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1, c0: 0, c1: 0, c2: 0 } };
    const response = validateResponse({ model: 'test', answers: { recommendation: answer } }, request);
    expect(summarize(value, response, checks).findings[0].status).toBe('review');
  });
  it('rejects missing, mismatched, unbounded and invented answers', () => {
    const { request } = buildEvaluation(input('templates'));
    const answer = { type: 'choice', choice: 'c0', confidence: 0.9, probabilities: { none: 0.1, c0: 0.7, c1: 0.1, c2: 0.1 } };
    expect(() => validateResponse({ model: 'test', answers: {} }, request)).toThrow();
    for (const mutation of [{ ...answer, type: 'noul', noul: 0.9 }, { ...answer, confidence: 2 }, { ...answer, choice: 'invented' }, { ...answer, probabilities: { c0: 1 } }, { ...answer, probabilities: { none: 1, c0: 1, c1: 1, c2: 1 } }]) {
      expect(() => validateResponse({ model: 'test', answers: { recommendation: mutation } }, request)).toThrow();
    }
  });
  it('ranks search matches while preserving candidate identity', () => {
    const value = input('search'); const { checks } = buildEvaluation(value);
    const response: JevResponse = { model: 'test', answers: Object.fromEntries(checks.map((c, i) => [c.id, { type: 'score', score: i, confidence: i === 2 ? 0.2 : 0.9, probabilities: {}, legend: {} }])) };
    const result = summarize(value, response, checks);
    expect(result.findings[0].candidate?.id).toBe(sampleCandidates[2].id);
    expect(result.findings[0].status).toBe('review');
  });
  it('rejects a choice or score that contradicts its probability distribution', () => {
    const selection = buildEvaluation(input('templates')).request;
    expect(() => validateResponse({ model: 'test', answers: { recommendation: { type: 'choice', choice: 'c0', confidence: 1, probabilities: { none: 1, c0: 0, c1: 0, c2: 0 } } } }, selection)).toThrow('contradicts');
    const ranking = buildEvaluation({ ...input('search'), candidates: [sampleCandidates[0]] }).request;
    expect(() => validateResponse({ model: 'test', answers: { candidate_0: { type: 'score', score: 3, confidence: 1, probabilities: { '0': 1, '1': 0, '2': 0, '3': 0 }, legend: {} } } }, ranking)).toThrow('contradicts');
  });
  it('accepts bounded two-decimal rounding error without dropping consistency validation', () => {
    const request = buildEvaluation({ ...input('search'), candidates: [sampleCandidates[0]] }).request;
    const answer = { type: 'score', score: 2.71, confidence: 0.8, probabilities: { '0': 0.02, '1': 0.04, '2': 0.15, '3': 0.8 }, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd' } };
    expect(() => validateResponse({ model: 'test', answers: { candidate_0: answer } }, request)).not.toThrow();
    expect(() => validateResponse({ model: 'test', answers: { candidate_0: { ...answer, score: 2 } } }, request)).toThrow('contradicts');
  });
});
