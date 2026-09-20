// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { demoEvaluation } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { JevWorkbench } from './Workbench';
import { resetLivePreferenceForTests } from './useLiveEvaluation';

beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); });
afterEach(cleanup);
describe('decision workbench', () => {
  it('checks settled input on its own once Live is turned on', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async input => demoEvaluation(input));
    render(<JevWorkbench evaluate={evaluate} liveDelayMs={5} />);
    expect(screen.getByText('Rollback procedure')).toBeTruthy();
    expect(screen.getAllByText('Not checked yet')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Runbook or operating procedure'), { target: { value: 'A sufficiently detailed runbook' } });
    await screen.findByText(/Up to date/);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 attention')).toBeTruthy();
  });
  it('sends nothing with untouched storage (Live defaults to off); turning the switch on sends and remembers the choice', async () => {
    const evaluate = vi.fn(async input => demoEvaluation(input));
    const view = render(<JevWorkbench evaluate={evaluate} liveDelayMs={5} />);
    expect((screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Runbook or operating procedure'), { target: { value: 'A sufficiently detailed runbook' } });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Live check' }));
    await screen.findByText(/Up to date/);
    expect(evaluate).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<JevWorkbench evaluate={evaluate} liveDelayMs={5} />);
    expect((screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement).checked).toBe(true);
  });
  it('validates empty context without calling the provider', () => {
    const evaluate = vi.fn(); render(<JevWorkbench evaluate={evaluate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    expect(screen.getByRole('alert').textContent).toContain('10 characters');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('keeps the previous result, marked out of date, until the new one lands', async () => {
    render(<JevWorkbench demo live={false} evaluate={async input => demoEvaluation(input)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    await screen.findByText(/Up to date/);
    expect(screen.getByText('ILLUSTRATIVE RESULT')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Runbook or operating procedure'), { target: { value: 'A different document' } });
    expect(screen.getByText(/Out of date/)).toBeTruthy();
    expect(screen.getByText('Rollback procedure')).toBeTruthy();
  });
  it('drops a result when the workflow changes', async () => {
    render(<JevWorkbench live={false} initialText="A sufficiently detailed document" evaluate={async input => demoEvaluation(input)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    await screen.findByText(/Up to date/);
    fireEvent.click(screen.getByRole('tab', { name: /Incident triage/ }));
    expect(screen.queryByText(/Up to date|Out of date/)).toBeNull();
    expect(screen.getByText('Investigation area')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Incident triage', selected: true })).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: 'Incident triage' })).toBeTruthy();
  });
  it('loads and evaluates a template shortlist', async () => {
    const evaluate = vi.fn(async input => demoEvaluation(input));
    render(<JevWorkbench demo live={false} evaluate={evaluate} />);
    fireEvent.click(screen.getByRole('tab', { name: /Template selection/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    await screen.findByText(/Up to date/);
    expect(evaluate.mock.calls[0][0].candidates).toHaveLength(2);
    expect(screen.getByText('Node.js + PostgreSQL', { selector: '.jev-value' })).toBeTruthy();
  });
  it('loads the catalog shortlist on entering a candidate workflow', async () => {
    const loadCandidates = vi.fn(async () => [{ id: 'team-a', title: 'Team A', description: 'Payments' }]);
    render(<JevWorkbench live={false} workflowIds={['ownership', 'search']} loadCandidates={loadCandidates} evaluate={vi.fn()} />);
    await screen.findByDisplayValue('Team A');
    expect(loadCandidates).toHaveBeenCalledWith('ownership', '');
  });
  it('presents backend errors once and offers another check', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async () => { throw new Error('Jev is busy'); });
    render(<JevWorkbench initialText="A sufficiently detailed document" liveDelayMs={5} evaluate={evaluate} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Jev is busy');
    await new Promise(resolve => setTimeout(resolve, 40));
    // A failed request is not retried on its own.
    expect(evaluate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run pre-check' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('loads the entity TechDocs on its own and stays quiet when there is none', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async input => demoEvaluation(input));
    const view = render(<JevWorkbench liveDelayMs={5} techDocs={{ entityRef: 'component:default/checkout', load: async () => 'Runbook: start with npm start and check /health.' }} evaluate={evaluate} />);
    await waitFor(() => expect((screen.getByLabelText('Runbook or operating procedure') as HTMLTextAreaElement).value).toContain('npm start'));
    await screen.findByText(/Up to date/);
    view.unmount();
    render(<JevWorkbench liveDelayMs={5} techDocs={{ entityRef: 'component:default/checkout', load: async () => { throw new Error('Not found'); } }} evaluate={evaluate} />);
    await screen.findByText(/No TechDocs page was loaded automatically/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not resend reader-written text on switching workflow, but sends it once edited', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async input => demoEvaluation(input));
    render(<JevWorkbench liveDelayMs={5} evaluate={evaluate} />);
    fireEvent.change(screen.getByLabelText('Runbook or operating procedure'), { target: { value: 'A sufficiently detailed runbook' } });
    await screen.findByText(/Up to date/);
    expect(evaluate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: /Change review/ }));
    expect(screen.getByText(/Not checked for this workflow yet/)).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 40));
    // Switching workflow kept the text, but must not have resent it.
    expect(evaluate).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Proposed change and rollout plan'), { target: { value: 'A sufficiently detailed runbook, edited' } });
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(2));
  });

  it('sends nothing while inactive', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async input => demoEvaluation(input));
    render(<JevWorkbench liveDelayMs={5} active={false} evaluate={evaluate} />);
    fireEvent.change(screen.getByLabelText('Runbook or operating procedure'), { target: { value: 'A sufficiently detailed runbook' } });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('forces the Live switch off and disabled when `live={false}`, regardless of the reader\'s stored preference', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    render(<JevWorkbench live={false} evaluate={vi.fn()} />);
    const toggle = screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    // The explanation must be reachable by keyboard/screen reader, not just a `title` attribute.
    const describedById = toggle.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)?.textContent).toMatch(/Automatic checks are turned off for this view/);
  });

  it('keeps the current document and result when a requested TechDocs page fails', async () => {
    const text = 'A sufficiently detailed document';
    render(<JevWorkbench live={false} initialText={text} techDocs={{ entityRef: 'component:default/checkout', load: async () => { throw new Error('TechDocs unavailable'); } }} evaluate={async input => demoEvaluation(input)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    await screen.findByText(/Up to date/);
    fireEvent.click(screen.getByRole('button', { name: 'Load page' }));
    expect((await screen.findByRole('alert')).textContent).toContain('TechDocs unavailable');
    expect((screen.getByLabelText('Runbook or operating procedure') as HTMLTextAreaElement).value).toBe(text);
    expect(screen.getByText(/Up to date/)).toBeTruthy();
  });
});
