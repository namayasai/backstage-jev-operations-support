// @vitest-environment jsdom
import { act, cleanup, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@backstage/plugin-search-common';
import { demoEvaluation, evaluationRequestSchema, MAX_EVALUATION_BYTES, type EvaluationRequest, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import type { EvaluateOptions } from './useLiveEvaluation';
import { resetLivePreferenceForTests } from './useLiveEvaluation';

const search = vi.hoisted(() => ({ term: '', result: { loading: false, value: undefined as { results: SearchResult[] } | undefined, error: undefined as Error | undefined } }));
vi.mock('@backstage/plugin-search-react', () => ({ useSearch: () => search }));
// `useJevEvaluate` is not exercised by these tests: every test supplies its own `evaluate`.
vi.mock('@backstage/core-plugin-api', () => ({ useApi: () => ({ getBaseUrl: vi.fn(), fetch: vi.fn() }), discoveryApiRef: 'discovery', fetchApiRef: 'fetch' }));

import { fitShortlist, JevRerankedResults, reorderedCaption } from './search';

function fakeResult(overrides: Partial<SearchResult> = {}, id = 'r'): SearchResult {
  return { type: 'demo', document: { title: `Title ${id}`, text: `Body ${id} sufficiently long`, location: `/docs/${id}` }, ...overrides };
}

function renderList(props: Partial<React.ComponentProps<typeof JevRerankedResults>> = {}) {
  const seen: string[][] = [];
  const view = render(<JevRerankedResults liveDelayMs={5} {...props}>{results => {
    seen.push(results.map(r => r.document.location));
    return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
  }}</JevRerankedResults>);
  return { view, seen };
}

beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); search.term = ''; search.result = { loading: false, value: undefined, error: undefined }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('JevRerankedResults', () => {
  it('renders engine order immediately, then reorders once scores arrive', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b'), fakeResult({}, 'c')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'jev-test', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
      findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: c.id.endsWith('b') ? 3 : c.id.endsWith('c') ? 2 : 0, guidance: 'g', candidate: c })),
    }));
    const { seen } = renderList({ evaluate });
    expect(seen[0]).toEqual(['/docs/a', '/docs/b', '/docs/c']);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual(['/docs/b', '/docs/c', '/docs/a']);
  });

  it('sends nothing with untouched storage, since Live defaults to off', async () => {
    vi.useFakeTimers();
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest) => ({ workflow: 'search' as const, model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live' as const, needsReview: false, findings: [] }));
    const { seen } = renderList({ evaluate });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(evaluate).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual(['/docs/a', '/docs/b']);
  });

  it('sends nothing and leaves the order untouched while Live is off', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'off');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest) => ({ workflow: 'search' as const, model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live' as const, needsReview: false, findings: [] }));
    const { seen } = renderList({ evaluate });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(evaluate).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual(['/docs/a', '/docs/b']);
  });

  it('does not evaluate a question shorter than 10 characters, and explains why', async () => {
    search.term = 'payments';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a')] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    expect(view.getByText(/too short|10\+ characters/i)).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('never applies scores computed for an earlier query to a newer result set', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    let release: ((result: EvaluationResult) => void) | undefined;
    const evaluate = vi.fn((request: EvaluationRequest, _options?: EvaluateOptions) => new Promise<EvaluationResult>(resolve => { release = resolve; }));
    const { view, seen } = renderList({ evaluate });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    // The query changes before the first evaluation resolves; a new candidate set is now shown.
    search.term = 'Where can I find the identity service instead?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'x'), fakeResult({}, 'y')] } };
    view.rerender(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => {
      seen.push(results.map(r => r.document.location));
      return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
    }}</JevRerankedResults>);
    expect(seen.at(-1)).toEqual(['/docs/x', '/docs/y']);
    // Now the stale evaluation for the old ("a"/"b") candidates resolves.
    await act(async () => { release!({ workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false, findings: [{ id: 'candidate_0', title: 't', statement: 's', kind: 'score', status: 'pass', value: 3, guidance: 'g', candidate: { id: '/docs/a', title: 'a', description: '' } }] } as EvaluationResult); });
    // The stale result must not reorder the current ("x"/"y") result set.
    expect(seen.at(-1)).toEqual(['/docs/x', '/docs/y']);
  });

  it('keeps engine order for the same result ids after only the term changes, until the new scores land', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    let firstScores: EvaluationResult | undefined;
    let release: ((result: EvaluationResult) => void) | undefined;
    const evaluate = vi.fn((input: EvaluationRequest) => new Promise<EvaluationResult>(resolve => {
      const scores: EvaluationResult = { workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
        findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: c.id.endsWith('b') ? 3 : 0, guidance: 'g', candidate: c })) };
      if (!firstScores) { firstScores = scores; release = resolve; } else resolve(scores);
    }));
    const { view, seen } = renderList({ evaluate });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    // Same two result ids, but a new question: the shortlist's content key changes, and the
    // still-in-flight scores for the old question must not be applied to it.
    search.term = 'Where can I find the identity service instead?';
    view.rerender(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => {
      seen.push(results.map(r => r.document.location));
      return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
    }}</JevRerankedResults>);
    expect(seen.at(-1)).toEqual(['/docs/a', '/docs/b']);
    await act(async () => { release!(firstScores!); });
    // The stale scores landed, but for a question that is no longer current: still engine order.
    expect(seen.at(-1)).toEqual(['/docs/a', '/docs/b']);
    // Now the second (current) evaluation is sent and resolves; only then does the order change.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual(['/docs/b', '/docs/a']);
  });

  it('never reorders while Live is off, even after the term changes', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'off');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
      findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: c.id.endsWith('b') ? 3 : 0, guidance: 'g', candidate: c })),
    }));
    const { view, seen } = renderList({ evaluate });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(evaluate).not.toHaveBeenCalled();
    search.term = 'Where can I find the identity service instead?';
    view.rerender(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => {
      seen.push(results.map(r => r.document.location));
      return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
    }}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(evaluate).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual(['/docs/a', '/docs/b']);
  });

  it('says plainly that Live is off, with a Rank now button, instead of claiming a reorder', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'off');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a')] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    expect(view.getByText(/Live check is off/i)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Rank now' })).toBeTruthy();
  });

  it('says a term over the 16,000-character limit is too long to rank against, in search wording rather than the workbench\'s generic blocker text', async () => {
    vi.useFakeTimers();
    // A search term over the shared 16,000 character limit cannot be sent; the schema itself
    // rejects it. Plain ASCII keeps this comfortably under the byte budget on its own, so this
    // hits the character-cap check directly rather than `fitShortlist`'s own too-long path
    // (covered separately, with CJK text, below) — both must read the same to the reader.
    search.term = 'q'.repeat(16001);
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a')] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    expect(view.getByText('This question is too long to rank results against.')).toBeTruthy();
    expect(view.queryByText(/Context exceeds/i)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('flags low-confidence scores instead of presenting the reorder as fully confident', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: true,
      findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: c.id.endsWith('b') ? 'review' as const : 'pass' as const, value: c.id.endsWith('b') ? 3 : 0, guidance: 'g', candidate: c })),
    }));
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(view.getByText(/low confidence/i)).toBeTruthy();
  });

  it('a forced-off `live` prop disables the switch even when another mounted consumer turns the shared preference on', async () => {
    // Fake timers make this deterministic: the other consumer's 5ms quiet-period timer, armed the
    // instant its Live switch is turned on below, must never actually fire during this test, since
    // nothing here advances the clock. Without this, that timer could fire for real (under load) and
    // call `evaluate`; with a valid `demoEvaluation` response either way, that call could never
    // produce an unreadable result even if it did land (see useLiveEvaluation's contract guard).
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'off');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const forced = render(<JevRerankedResults liveDelayMs={5} live={false} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    // Another co-mounted consumer that follows the shared (currently off) preference.
    const other = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    const forcedSwitch = within(forced.container).getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    const otherSwitch = within(other.container).getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    expect(forcedSwitch.disabled).toBe(true);
    expect(forcedSwitch.checked).toBe(false);
    expect(otherSwitch.checked).toBe(false);
    // The other consumer turns the shared preference on for everyone reading it...
    await act(async () => { otherSwitch.click(); });
    expect(otherSwitch.checked).toBe(true);
    // ...but the component with `live={false}` must stay forced off regardless.
    expect(forcedSwitch.disabled).toBe(true);
    expect(forcedSwitch.checked).toBe(false);
  });

  it('memoizes the shortlist on content, so repeated re-renders faster than the quiet period still send exactly one evaluation, and keeps reordering (and the "Reordered" caption) after later re-renders hand back fresh content-equal result objects', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    // Distinguishable scores (b scores higher) so a real reorder is observable.
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
      findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: c.id.endsWith('b') ? 3 : 1, guidance: 'g', candidate: c })),
    }));
    const seen: string[][] = [];
    const view = render(<JevRerankedResults liveDelayMs={20} evaluate={evaluate}>{results => {
      seen.push(results.map(r => r.document.location));
      return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
    }}</JevRerankedResults>);
    // Re-render with fresh (but content-equal) result objects faster than the 20ms quiet period,
    // the way a parent re-rendering for unrelated reasons would.
    for (let i = 0; i < 5; i++) {
      search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
      view.rerender(<JevRerankedResults liveDelayMs={20} evaluate={evaluate}>{results => {
        seen.push(results.map(r => r.document.location));
        return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
      }}</JevRerankedResults>);
      await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual(['/docs/b', '/docs/a']);
    expect(view.getByText(/Reordered by Jev/)).toBeTruthy();
    // Regression for F1: scores were previously looked up through a `Map<SearchResult, id>`
    // keyed on the result object's identity, but the shortlist is memoized on content. Handing
    // back fresh-but-content-equal `SearchResult` objects on a later render (exactly what a host
    // re-rendering for unrelated reasons commonly does) made every map entry dead: nothing
    // reordered, even though the caption kept claiming "Reordered by Jev…". Looking scores up by
    // index into the current head instead must survive that. On the old identity-Map code, the
    // assertions below fail: `idOf`/`candidateIdByResult.get(item)` returns `undefined` for
    // these fresh objects, so `scored` ends up empty and `seen.at(-1)` stays in engine order
    // (`['/docs/a', '/docs/b']`) — while the caption text assertion would still pass, which is
    // exactly the dishonesty this fix removes.
    for (let i = 0; i < 3; i++) {
      search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
      view.rerender(<JevRerankedResults liveDelayMs={20} evaluate={evaluate}>{results => {
        seen.push(results.map(r => r.document.location));
        return <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>;
      }}</JevRerankedResults>);
      expect(seen.at(-1)).toEqual(['/docs/b', '/docs/a']);
      expect(view.getByText(/Reordered by Jev/)).toBeTruthy();
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('sends a new evaluation with the new excerpt when a reindexed body changes content but not length', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    // Same location, title, and length as the body swapped in below — only the content differs.
    const original: SearchResult = { type: 'demo', document: { title: 'Title a', text: 'A'.repeat(200), location: '/docs/a' } };
    const reindexed: SearchResult = { type: 'demo', document: { title: 'Title a', text: 'B'.repeat(200), location: '/docs/a' } };
    search.result = { loading: false, error: undefined, value: { results: [original] } };
    const bodies: string[] = [];
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => {
      bodies.push(input.candidates[0]!.description);
      return { workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
        findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: 1, guidance: 'g', candidate: c })) };
    });
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toBe('A'.repeat(200));
    search.result = { loading: false, error: undefined, value: { results: [reindexed] } };
    view.rerender(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // A stale content key (keyed only on length) would have kept the shortlist — and the stale
    // "A" excerpt — memoized, and never sent a second evaluation at all.
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe('B'.repeat(200));
  });

  it('renders zero results with no caption and no Live switch, even for an untouched (empty) search box', async () => {
    search.term = '';
    search.result = { loading: false, error: undefined, value: { results: [] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    expect(view.queryByRole('checkbox', { name: 'Live check' })).toBeNull();
    expect(view.queryByText(/candidate/i)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('renders zero results with no caption for a long term that simply had no hits', async () => {
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    expect(view.queryByRole('checkbox', { name: 'Live check' })).toBeNull();
    expect(view.queryByText(/candidate/i)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('says a question that is too long to rank against anything, distinctly from a normal blocker', async () => {
    search.term = '問'.repeat(16000);
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a')] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    expect(view.getByText(/too long to rank/i)).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('exposes the "off" explanation to assistive tech, not just a title attribute', () => {
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a')] } };
    const evaluate = vi.fn();
    const view = render(<JevRerankedResults liveDelayMs={5} live={false} evaluate={evaluate as never}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    const input = view.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    const describedById = input.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)?.textContent).toMatch(/Automatic checks are turned off for this view/);
  });

  it('says scores could not be matched to these results, distinctly from still waiting on a check', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b')] } };
    // A valid `search` result whose findings carry no `candidate` at all: nothing can be
    // matched back to the current head, even though scores plainly landed for this question.
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
      findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: i, guidance: 'g' })),
    }));
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(view.getByText(/could not be matched/i)).toBeTruthy();
    expect(view.queryByText(/Asking Jev to rank/)).toBeNull();
  });

  it('combines the low-confidence and shortened-excerpts notes into one caption when both apply', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    // 20 results with 1,500-character bodies do not fit the shared byte budget unshortened
    // (see the `fitShortlist` tests below), so `shortened` is reliably true here.
    const results: SearchResult[] = Array.from({ length: 20 }, (_, i) => ({ type: 'demo', document: { title: `Title ${i}`, text: 'a'.repeat(1500), location: `/docs/${i}` } }));
    search.result = { loading: false, error: undefined, value: { results } };
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: true,
      findings: input.candidates.map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: i === 0 ? 'review' as const : 'pass' as const, value: 20 - i, guidance: 'g', candidate: c })),
    }));
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(view.getByText('Reordered by Jev — low confidence for some results; shortened excerpts were used')).toBeTruthy();
  });

  it('says how many of the head results were ranked when fewer were scored than are in the head', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    search.result = { loading: false, error: undefined, value: { results: [fakeResult({}, 'a'), fakeResult({}, 'b'), fakeResult({}, 'c')] } };
    const evaluate = vi.fn(async (input: EvaluationRequest): Promise<EvaluationResult> => ({
      workflow: 'search', model: 'x', evaluatedAt: new Date().toISOString(), mode: 'live', needsReview: false,
      // Only 2 of the 3 head candidates receive a finding with a `candidate` to match against.
      findings: input.candidates.slice(0, 2).map((c, i) => ({ id: `candidate_${i}`, title: c.title, statement: 's', kind: 'score' as const, status: 'pass' as const, value: 2 - i, guidance: 'g', candidate: c })),
    }));
    const view = render(<JevRerankedResults liveDelayMs={5} evaluate={evaluate}>{results => <ul>{results.map(r => <li key={r.document.location}>{r.document.title}</li>)}</ul>}</JevRerankedResults>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(view.getByText('Reordered by Jev — 2 of 3 results ranked')).toBeTruthy();
  });

  it('orders results by real demoEvaluation scores end to end, independent of summarize\'s own sort', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('jev-operations-support.live', 'on');
    search.term = 'Where can I find the payments service?';
    const results = [fakeResult({}, '0'), fakeResult({}, '1'), fakeResult({}, '2'), fakeResult({}, '3'), fakeResult({}, '4')];
    search.result = { loading: false, error: undefined, value: { results } };
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const { seen } = renderList({ evaluate });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    // demoEvaluation's search score for candidate index i is max(0, 3 - i % 4): indices 0 and 4
    // tie at 3, then 1 (2), 2 (1), 3 (0). A stable sort keeps 0 before the later tie at 4, so
    // the rendered order is a genuine reorder away from engine order, pinned end to end rather
    // than through `summarize`'s own (irrelevant, since search.tsx re-sorts by index lookup) sort.
    expect(seen.at(-1)).toEqual(['/docs/0', '/docs/4', '/docs/1', '/docs/2', '/docs/3']);
  });
});

describe('reorderedCaption', () => {
  it('is plain when every head result was ranked, nothing was low-confidence, and nothing was shortened', () => {
    expect(reorderedCaption({ scored: 2, total: 2, anyReview: false, shortened: false })).toBe('Reordered by Jev for relevance to your question');
  });

  it('notes shortened excerpts alone', () => {
    expect(reorderedCaption({ scored: 2, total: 2, anyReview: false, shortened: true })).toBe('Reordered by Jev for relevance to your question, using shortened excerpts');
  });

  it('notes low confidence alone', () => {
    expect(reorderedCaption({ scored: 2, total: 2, anyReview: true, shortened: false })).toBe('Reordered by Jev — low confidence for some results');
  });

  it('combines low confidence and shortened excerpts', () => {
    expect(reorderedCaption({ scored: 2, total: 2, anyReview: true, shortened: true })).toBe('Reordered by Jev — low confidence for some results; shortened excerpts were used');
  });

  it('notes a partial ranking alone', () => {
    expect(reorderedCaption({ scored: 1, total: 3, anyReview: false, shortened: false })).toBe('Reordered by Jev — 1 of 3 results ranked');
  });

  it('combines a partial ranking with low confidence and shortened excerpts', () => {
    expect(reorderedCaption({ scored: 1, total: 3, anyReview: true, shortened: true })).toBe('Reordered by Jev — 1 of 3 results ranked; low confidence for some results; shortened excerpts were used');
  });
});

function hasDanglingSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

function longResult(id: string, text: string, title = `Title ${id}`): SearchResult {
  return { type: 'demo', document: { title, text, location: `/docs/${id}` } };
}

describe('fitShortlist', () => {
  it('fits 20 candidates of 1500 ASCII characters under the shared byte budget', () => {
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), 'a'.repeat(1500)));
    const { candidates, shortened } = fitShortlist('Where can I find the payments service?', results, 20);
    expect(candidates).toHaveLength(20);
    const request = { workflow: 'search' as const, text: 'Where can I find the payments service?', candidates };
    const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_EVALUATION_BYTES);
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
    expect(shortened).toBe(true); // 20 x 1500 ASCII chars (~31KB naturally) does not fit unshortened.
    // eslint-disable-next-line no-console
    console.log(`fitShortlist ASCII case: ${bytes} bytes (budget ${MAX_EVALUATION_BYTES})`);
  });

  it('fits 20 candidates of 1500 CJK characters under the shared byte budget', () => {
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), '文'.repeat(1500)));
    const { candidates, shortened } = fitShortlist('Where can I find the payments service?', results, 20);
    expect(candidates).toHaveLength(20);
    const request = { workflow: 'search' as const, text: 'Where can I find the payments service?', candidates };
    const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_EVALUATION_BYTES);
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
    expect(shortened).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`fitShortlist CJK case: ${bytes} bytes (budget ${MAX_EVALUATION_BYTES})`);
  });

  it('never splits a surrogate pair when the cut point lands inside an emoji, in either the description or a title over 200 units', () => {
    // An odd-offset emoji run: 'a' (1 unit) then two-unit emoji repeated, so every even byte/unit
    // cut candidate lands mid-surrogate-pair unless the code backs off correctly.
    const body = `a${'😀'.repeat(2000)}`;
    // A genuinely emoji-packed title longer than the 200-unit cap, same odd-offset shape.
    const packedTitle = `a${'😀'.repeat(150)}`; // 301 UTF-16 units, well over 200.
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), body, packedTitle));
    const { candidates } = fitShortlist('Where can I find the payments service?', results, 20);
    for (const candidate of candidates) {
      expect(hasDanglingSurrogate(candidate.description)).toBe(false);
      expect(hasDanglingSurrogate(candidate.title)).toBe(false);
      expect(candidate.title.length).toBeLessThanOrEqual(200);
      expect(candidate.description.length).toBeLessThanOrEqual(1500);
    }
    const request = { workflow: 'search' as const, text: 'Where can I find the payments service?', candidates };
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
  });

  it('fits results whose text is full of control characters, quotes, and backslashes, using a substantial share of the budget', () => {
    // JSON-escaping this text expands it well beyond its raw UTF-8 byte size (e.g. a control
    // character becomes a 6-byte `\u00XX` escape), which previously made the per-candidate
    // allowance overshoot the budget and collapse to almost nothing after one correction.
    const nasty = Array.from({ length: 300 }, (_, i) => String.fromCharCode(i % 32) + '"\\' + String.fromCharCode(0x20 + (i % 90))).join('');
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), nasty));
    const { candidates, shortened } = fitShortlist('Where can I find the payments service?', results, 20);
    expect(candidates).toHaveLength(20);
    expect(shortened).toBe(true);
    const request = { workflow: 'search' as const, text: 'Where can I find the payments service?', candidates };
    const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_EVALUATION_BYTES);
    expect(bytes).toBeGreaterThan(MAX_EVALUATION_BYTES * 0.6);
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`fitShortlist escape-heavy case: ${bytes} bytes (budget ${MAX_EVALUATION_BYTES}, ${((bytes / MAX_EVALUATION_BYTES) * 100).toFixed(1)}%)`);
  });

  it('returns an empty shortlist with reason "question-too-long" when even one title-only candidate does not fit alongside the query', () => {
    // A 16,000-character CJK term (the schema's own character cap) is already ~48KB of UTF-8 —
    // more than the entire 24,000-byte evaluation budget — before any candidate is added.
    const hugeTerm = '問'.repeat(16000);
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), 'Body text.'));
    const shortlist = fitShortlist(hugeTerm, results, 20);
    expect(shortlist.candidates).toEqual([]);
    expect(shortlist.reason).toBe('question-too-long');
    expect(shortlist.candidateIds).toEqual(results.map(() => undefined));
  });

  it('caps long titles at 200 characters and keeps the request valid', () => {
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), 'Body text.', `${'T'.repeat(300)}-${i}`));
    const { candidates } = fitShortlist('Where can I find the payments service?', results, 20);
    for (const candidate of candidates) expect(candidate.title.length).toBeLessThanOrEqual(200);
    const request = { workflow: 'search' as const, text: 'Where can I find the payments service?', candidates };
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
  });

  it('drops candidates from the tail when even title-only candidates do not fit the budget', () => {
    // An oversized (but schema-legal) term inflates the fixed overhead past the budget on its own.
    const hugeTerm = '問'.repeat(7900); // ~23.7KB alone; well under the 16,000-character cap.
    const results = Array.from({ length: 20 }, (_, i) => longResult(String(i), 'Body text.'));
    const { candidates } = fitShortlist(hugeTerm, results, 20);
    expect(candidates.length).toBeLessThan(20);
    const request = { workflow: 'search' as const, text: hugeTerm.trim(), candidates };
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
  });

  it('gives unique, deterministic ids to two results whose locations share a 200-character prefix, and falls back an empty title to the location', () => {
    const sharedPrefix = '/docs/'.padEnd(250, 'x');
    const a: SearchResult = { type: 'demo', document: { title: 'First', text: 'Body a', location: `${sharedPrefix}/a` } };
    const b: SearchResult = { type: 'demo', document: { title: '   ', text: 'Body b', location: `${sharedPrefix}/b` } };
    const { candidates, candidateIds } = fitShortlist('Where can I find the payments service?', [a, b], 20);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map(c => c.id)).size).toBe(2);
    expect(candidateIds).toHaveLength(2);
    expect(candidateIds[0]).not.toBe(candidateIds[1]);
    // `b` has a blank title; it falls back to its location, capped at 200 characters.
    const bCandidate = candidates.find(c => c.id === candidateIds[1])!;
    expect(bCandidate.title).toBe(b.document.location!.slice(0, 200));
    const request = { workflow: 'search' as const, text: 'Where can I find the payments service?', candidates };
    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
  });
});
