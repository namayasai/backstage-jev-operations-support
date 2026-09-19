// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { demoEvaluation } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { JevWorkbench } from './Workbench';

afterEach(cleanup);
describe('decision workbench', () => {
  it('validates empty context without calling the provider', () => {
    const evaluate = vi.fn(); render(<JevWorkbench evaluate={evaluate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Jev →' }));
    expect(screen.getByRole('alert').textContent).toContain('10 characters');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('shows fixture status and clears stale results when context changes', async () => {
    render(<JevWorkbench demo evaluate={async input => demoEvaluation(input)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load example input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show example result →' }));
    await screen.findByText('Decision details');
    expect(screen.getByText('ILLUSTRATIVE RESULT')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'A different document' } });
    expect(screen.queryByText('Decision details')).toBeNull();
  });
  it('loads and evaluates a template shortlist', async () => {
    const evaluate = vi.fn(async input => demoEvaluation(input));
    render(<JevWorkbench demo evaluate={evaluate} />);
    fireEvent.click(screen.getByRole('button', { name: /Template advisor/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load example input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show example result →' }));
    await screen.findByText('Decision details');
    expect(evaluate.mock.calls[0][0].candidates).toHaveLength(2);
    expect(screen.getByText('Node.js + PostgreSQL', { selector: '.jev-value' })).toBeTruthy();
  });
  it('presents backend errors and re-enables evaluation', async () => {
    render(<JevWorkbench initialText="A sufficiently detailed document" evaluate={async () => { throw new Error('Jev is busy'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Jev →' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('Jev is busy');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Evaluate with Jev →' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('keeps the current document and result when TechDocs loading fails', async () => {
    const text = 'A sufficiently detailed document';
    render(<JevWorkbench initialText={text} techDocs={{ entityRef: 'component:default/checkout', load: async () => { throw new Error('TechDocs unavailable'); } }} evaluate={async input => demoEvaluation(input)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Jev →' }));
    await screen.findByText('Decision details');
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
    expect((await screen.findByRole('alert')).textContent).toContain('TechDocs unavailable');
    expect((screen.getByLabelText('Context') as HTMLTextAreaElement).value).toBe(text);
    expect(screen.getByText('Decision details')).toBeTruthy();
  });
});
