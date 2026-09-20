// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EvaluationRequest, EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { resetLivePreferenceForTests } from './useLiveEvaluation';

const mocks = vi.hoisted(() => { const query = vi.fn(); return { query, catalog: { queryEntities: query } }; });
vi.mock('@backstage/core-plugin-api', async importOriginal => ({
  ...await importOriginal<typeof import('@backstage/core-plugin-api')>(),
  // The same API instance must be returned on every render, like the real hook.
  useApi: () => mocks.catalog,
}));
vi.mock('@backstage/plugin-catalog-react', () => ({ catalogApiRef: 'catalog' }));

import { JevTemplateAdvisor } from './scaffolder';

function template(name: string, title: string, description: string) {
  return { apiVersion: 'scaffolder.backstage.io/v1beta3', kind: 'Template', metadata: { namespace: 'default', name, title, description } };
}

beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function evaluateFor(choice: string) {
  return vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
    workflow: 'templates', model: 'jev-test', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: choice === 'none',
    findings: [{
      id: 'recommendation', title: 'Suggested software template', statement: 's', kind: 'choice', status: choice === 'none' ? 'review' : 'pass',
      value: choice === 'none' ? 'none' : input.candidates.find(c => c.id.endsWith(choice))!.title,
      confidence: 0.9, guidance: 'g',
      candidate: choice === 'none' ? undefined : input.candidates.find(c => c.id.endsWith(choice)),
    }],
  }));
}

describe('JevTemplateAdvisor', () => {
  it('recommends a template and links to its creation page', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    mocks.query.mockResolvedValue({ items: [template('node-service', 'Node service', 'Node.js + Postgres'), template('static-site', 'Static site', 'Static HTML')] });
    const evaluate = evaluateFor('node-service');
    render(<MemoryRouter><JevTemplateAdvisor evaluate={evaluate} liveDelayMs={5} /></MemoryRouter>);
    await screen.findByLabelText('What are you building?');
    // Live is turned on above; typing alone is enough, without an explicit Check now.
    fireEvent.change(screen.getByLabelText('What are you building?'), { target: { value: 'A Node.js service with Postgres and Kubernetes deployment.' } });
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    const link = await screen.findByRole('link', { name: 'Create with Node service →' });
    expect(link.getAttribute('href')).toBe('/create/templates/default/node-service');
  });

  it('says plainly that no template fits, and links nothing, when Jev answers none', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    mocks.query.mockResolvedValue({ items: [template('node-service', 'Node service', 'Node.js + Postgres')] });
    const evaluate = evaluateFor('none');
    render(<MemoryRouter><JevTemplateAdvisor evaluate={evaluate} liveDelayMs={5} /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('What are you building?'), { target: { value: 'A Rust embedded firmware project with no networking.' } });
    await screen.findByText('No listed template fits what you described.');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('sends nothing with untouched storage (Live defaults to off), until Check now', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.query.mockResolvedValue({ items: [template('node-service', 'Node service', 'Node.js + Postgres')] });
    const evaluate = evaluateFor('node-service');
    render(<MemoryRouter><JevTemplateAdvisor evaluate={evaluate} liveDelayMs={5} /></MemoryRouter>);
    const toggle = await screen.findByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.change(await screen.findByLabelText('What are you building?'), { target: { value: 'A Node.js service with Postgres and Kubernetes deployment.' } });
    // `shouldAdvanceTime` lets MUI's own timers (ripple, etc.) keep working under fake timers
    // while this advance stays well past the 5ms quiet period, proving nothing was scheduled.
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    vi.useRealTimers();
  });

  it('sends automatically once Live is turned on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.query.mockResolvedValue({ items: [template('node-service', 'Node service', 'Node.js + Postgres')] });
    const evaluate = evaluateFor('node-service');
    render(<MemoryRouter><JevTemplateAdvisor evaluate={evaluate} liveDelayMs={5} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Live check' }));
    fireEvent.change(await screen.findByLabelText('What are you building?'), { target: { value: 'A Node.js service with Postgres and Kubernetes deployment.' } });
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    vi.useRealTimers();
  });

  it('says plainly that a recommended template could not be resolved, instead of showing nothing', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    mocks.query.mockResolvedValue({ items: [template('node-service', 'Node service', 'Node.js + Postgres')] });
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'templates', model: 'jev-test', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
      findings: [{
        id: 'recommendation', title: 'Suggested software template', statement: 's', kind: 'choice', status: 'pass',
        value: 'Node service', confidence: 0.9, guidance: 'g',
        // A malformed entityRef: Jev chose a candidate, but its reference cannot be parsed.
        candidate: { ...input.candidates[0], entityRef: 'not a valid entity ref' },
      }],
    }));
    render(<MemoryRouter><JevTemplateAdvisor evaluate={evaluate} liveDelayMs={5} /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('What are you building?'), { target: { value: 'A Node.js service with Postgres and Kubernetes deployment.' } });
    await screen.findByText('Jev suggested Node service, but its catalog reference could not be resolved.');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('forces the Live switch off and disabled when `live={false}`, regardless of the reader\'s stored preference', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    mocks.query.mockResolvedValue({ items: [template('node-service', 'Node service', 'Node.js + Postgres')] });
    render(<MemoryRouter><JevTemplateAdvisor evaluate={vi.fn()} liveDelayMs={5} live={false} /></MemoryRouter>);
    const toggle = await screen.findByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    // The explanation must be reachable by keyboard/screen reader, not just a `title` attribute.
    const describedById = toggle.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)?.textContent).toMatch(/Automatic checks are turned off for this view/);
  });

  it('shows an empty catalog honestly', async () => {
    mocks.query.mockResolvedValue({ items: [] });
    render(<MemoryRouter><JevTemplateAdvisor evaluate={vi.fn()} liveDelayMs={5} /></MemoryRouter>);
    await screen.findByText('No templates are registered in the catalog.');
    expect(screen.queryByLabelText('What are you building?')).toBeNull();
  });
});
