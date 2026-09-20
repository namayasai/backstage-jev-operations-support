// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEvaluation, type EvaluationRequest } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { ReportTriage } from './ReportTriage';
import { resetLivePreferenceForTests } from './useLiveEvaluation';
beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const report = 'Customers cannot log in since the latest deployment.';
describe('Standalone report triage', () => {
  it('requires an explicit check by default and identifies demo results', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<ReportTriage evaluate={evaluate} />);
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: report } });
    expect((screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement).checked).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await screen.findByText('Up to date');
    expect(evaluate.mock.calls[0][0]).toEqual({ workflow: 'incident', text: report, candidates: [] });
    expect(screen.getByText(/fixed results do not evaluate your report/)).toBeTruthy();
    expect(screen.getByText(/assessment is not stored and creates no alert/)).toBeTruthy();
  });
  it('uses the shared opt-in Live setting for incident reports', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<ReportTriage evaluate={evaluate} liveDelayMs={5} />);
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: report } });
    await screen.findByText('Up to date');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it('cancels a pending automatic send when leaving the page', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn();
    const view = render(<ReportTriage evaluate={evaluate} liveDelayMs={900} />);
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: report } });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('keeps the forced-off explanation accessible', () => {
    render(<ReportTriage evaluate={vi.fn()} live={false} />);
    const toggle = screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toMatch(/Automatic checks are turned off for this view/);
  });
});
