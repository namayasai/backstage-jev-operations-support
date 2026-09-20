// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResponsePlanPanel } from './ResponsePlan';
afterEach(cleanup);
const plan = { status: 'generated', provider: 'openai', model: 'configured', mode: 'live', generatedAt: '2026-09-20T00:00:00Z', plan: {
  summary: '<script>untrusted text</script>', hypotheses: [{ cause: 'Possible deployment issue', evidence: 'Reported after deploy', verification: 'Compare timestamps' }], checks: ['Inspect error metrics'], actions: [], unknowns: ['Affected customer count'],
} };
describe('Response plan display', () => {
  it('renders provider output as text with hypotheses, checks and missing information', () => {
    const view = render(<ResponsePlanPanel value={plan} />);
    expect(screen.getByText('<script>untrusted text</script>')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Response suggestions (LLM)' })).toBeTruthy();
    expect(screen.getByText(/No intervention is proposed yet/)).toBeTruthy();
    expect(screen.getByText('Affected customer count')).toBeTruthy();
  });
  it('marks stale and demo output instead of presenting it as current advice', () => {
    render(<ResponsePlanPanel value={{ ...plan, mode: 'demo' }} stale />);
    expect(screen.getByText(/previous input/)).toBeTruthy();
    expect(screen.getByText(/Fixed demo suggestions/)).toBeTruthy();
  });
  it.each([undefined, { status: 'generated' }, { status: 'failed', provider: 'openai', model: 'configured', code: 'timeout' }, { status: 'pending', provider: 'openai', model: 'configured' }])('handles unavailable, invalid, failed and pending plans without crashing', value => {
    render(<ResponsePlanPanel value={value} />);
    expect(screen.queryByRole('region', { name: 'LLM response suggestions' })).toBeNull();
    expect(document.body.textContent).toMatch(/No response suggestions|could not be validated|No response suggestions were generated|preparing response suggestions/);
  });
});
