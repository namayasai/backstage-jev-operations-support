// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  describe('response suggestions on request', () => {
    const plan = { status: 'generated', provider: 'openai', model: 'planner', mode: 'live', generatedAt: '2026-09-23T00:00:00.000Z', plan: { summary: 'Compare the login failures with the release timeline.', hypotheses: [], checks: ['Check the error rate.'], actions: [], unknowns: ['Scope of impact.'] } };
    let issued = 0;
    const evaluate = vi.fn(async (input: EvaluationRequest) => ({ ...demoEvaluation(input), mode: 'live' as const, responsePlanRef: { id: `ref-${++issued}`, expiresAt: '2026-09-23T00:15:00.000Z' } }));
    beforeEach(() => { issued = 0; evaluate.mockClear(); });
    async function checked(requestResponsePlan: ReturnType<typeof vi.fn>) {
      render(<ReportTriage evaluate={evaluate} requestResponsePlan={requestResponsePlan} />);
      fireEvent.change(screen.getByLabelText('Report'), { target: { value: report } });
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      await screen.findByText('Up to date');
    }

    it('shows the Jev assessment first and generates suggestions only when asked, once at a time', async () => {
      let finish!: (value: unknown) => void;
      const requestResponsePlan = vi.fn((_ref: string) => new Promise(resolve => { finish = resolve; }));
      await checked(requestResponsePlan);
      expect(screen.getAllByText(/Reported impact/).length).toBeGreaterThan(0);
      expect(requestResponsePlan).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Generate response suggestions' }));
      const busy = screen.getByRole('button', { name: 'Generating…' }) as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
      fireEvent.click(busy);
      expect(requestResponsePlan).toHaveBeenCalledTimes(1);
      expect(requestResponsePlan.mock.calls[0][0]).toBe('ref-1');
      await act(async () => { finish(plan); });
      expect(await screen.findByText('Compare the login failures with the release timeline.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Generate again' })).toBeTruthy();
    });

    it('keeps the Jev assessment when suggestions fail', async () => {
      const requestResponsePlan = vi.fn(async () => { throw new Error('This assessment is no longer available for response suggestions. Check the report again.'); });
      await checked(requestResponsePlan);
      fireEvent.click(screen.getByRole('button', { name: 'Generate response suggestions' }));
      expect(await screen.findByText(/no longer available.*The Jev assessment remains available\./)).toBeTruthy();
      expect(screen.getAllByText(/Reported impact/).length).toBeGreaterThan(0);
    });

    it('marks suggestions out of date after an edit and clears them for a new assessment', async () => {
      const requestResponsePlan = vi.fn(async (_ref: string) => plan);
      await checked(requestResponsePlan);
      fireEvent.click(screen.getByRole('button', { name: 'Generate response suggestions' }));
      await screen.findByText('Compare the login failures with the release timeline.');
      fireEvent.change(screen.getByLabelText('Report'), { target: { value: `${report} Payments also fail.` } });
      expect(screen.getByText(/These suggestions refer to the previous input/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Generate again' }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/Check it again before generating/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      await waitFor(() => expect(screen.queryByText('Compare the login failures with the release timeline.')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Generate response suggestions' }));
      await screen.findByText('Compare the login failures with the release timeline.');
      expect(requestResponsePlan.mock.calls.map(call => call[0])).toEqual(['ref-1', 'ref-2']);
    });

    it('cancels an in-flight request when the page is left', async () => {
      const requestResponsePlan = vi.fn((_ref: string, _options?: { signal?: AbortSignal }) => new Promise(() => {}));
      const view = render(<ReportTriage evaluate={evaluate} requestResponsePlan={requestResponsePlan} />);
      fireEvent.change(screen.getByLabelText('Report'), { target: { value: report } });
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      await screen.findByText('Up to date');
      fireEvent.click(screen.getByRole('button', { name: 'Generate response suggestions' }));
      const signal = requestResponsePlan.mock.calls[0][1]!.signal!;
      view.unmount();
      expect(signal.aborted).toBe(true);
    });

    it('offers no generate action when the backend issued no reference', async () => {
      const requestResponsePlan = vi.fn();
      render(<ReportTriage evaluate={async input => demoEvaluation(input)} requestResponsePlan={requestResponsePlan} />);
      fireEvent.change(screen.getByLabelText('Report'), { target: { value: report } });
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      await screen.findByText('Up to date');
      expect(screen.queryByRole('button', { name: 'Generate response suggestions' })).toBeNull();
      expect(screen.getByText(/No response suggestions accompany this assessment/)).toBeTruthy();
    });
  });
});
