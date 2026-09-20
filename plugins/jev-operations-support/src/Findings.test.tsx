// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { FindingList } from './Findings';

afterEach(cleanup);

function passFinding(): Finding {
  return { id: 'startup', title: 'Startup procedure', statement: 'Does the document describe how to start the service?', status: 'pass', value: 0.95, kind: 'noul', guidance: 'Keep the procedure documented.' };
}
function reviewFinding(overrides: Partial<Finding> = {}): Finding {
  return { id: 'startup', title: 'Startup procedure', statement: 'Does the document describe how to start the service?', status: 'review', value: 0.5, kind: 'noul', guidance: 'Clarify the startup procedure.', ...overrides };
}

describe('finding rows', () => {
  it('collapses a passing finding by default, with the question and answer visible without expanding', () => {
    render(<FindingList findings={[passFinding()]} />);
    const toggle = screen.getByRole('button', { name: 'Show details for Startup procedure' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The header text is not swallowed by the expand control: it is readable without expanding.
    expect(screen.getByText('Does the document describe how to start the service?')).toBeTruthy();
    expect(screen.getByText(/Yes — found in the text/)).toBeTruthy();
  });

  it('the icon button is a labelled, independent accessible control', () => {
    render(<FindingList findings={[reviewFinding()]} />);
    const toggle = screen.getByRole('button', { name: 'Hide details for Startup procedure' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show details for Startup procedure' })).toBeTruthy();
  });

  it('reopens a finding whose status changed from pass to review in a later result, without the reader touching it', () => {
    const view = render(<FindingList findings={[passFinding()]} />);
    expect(screen.getByRole('button', { name: 'Show details for Startup procedure' })).toBeTruthy();
    // A later evaluation of the same check now needs review; the row must follow it.
    view.rerender(<FindingList findings={[reviewFinding()]} />);
    expect(screen.getByRole('button', { name: 'Hide details for Startup procedure' })).toBeTruthy();
  });

  it('keeps a reader override for as long as the status does not change', () => {
    const view = render(<FindingList findings={[reviewFinding()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide details for Startup procedure' }));
    expect(screen.getByRole('button', { name: 'Show details for Startup procedure' })).toBeTruthy();
    // Same status, a different value (e.g. a re-run producing the same verdict): the override sticks.
    view.rerender(<FindingList findings={[reviewFinding({ value: 0.6 })]} />);
    expect(screen.getByRole('button', { name: 'Show details for Startup procedure' })).toBeTruthy();
  });

  it('gives every finding row a unique details id, even when two lists render the same finding ids at once', () => {
    // The alert detail pane can render two incident results side by side (e.g. a manual
    // re-check and the stored result), each with an `impact` and `area` finding.
    const findings: Finding[] = [
      { id: 'impact', title: 'Reported impact', statement: 'What is the reported customer impact?', status: 'attention', value: 'limited', kind: 'choice', guidance: 'Confirm scope with the on-call.' },
      { id: 'area', title: 'Investigation area', statement: 'Where should the on-call look first?', status: 'review', value: 'unknown', kind: 'choice', guidance: 'Gather more evidence before assigning an area.' },
    ];
    render(<div>
      <FindingList findings={findings} />
      <FindingList findings={findings} />
    </div>);
    const toggles = screen.getAllByRole('button', { name: /^(Show|Hide) details for/ });
    expect(toggles).toHaveLength(4);
    const ids = toggles.map(toggle => toggle.getAttribute('aria-controls'));
    expect(new Set(ids).size).toBe(4);
    ids.forEach(id => {
      expect(id).toBeTruthy();
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    });
  });
});
