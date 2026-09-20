// @vitest-environment jsdom
import { act, cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationRequest, EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { useLiveEvaluation, useLivePreference, resetLivePreferenceForTests, type EvaluateOptions, type LiveEvaluation } from './useLiveEvaluation';

beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function fakeResult(): EvaluationResult {
  return { workflow: 'incident', model: 'jev-test', evaluatedAt: new Date().toISOString(), mode: 'live', findings: [], needsReview: false };
}

/** A thin harness so the hook can be exercised with fake timers and a controllable `evaluate`. */
function Harness({ evaluate, text, live = true, delayMs = 10, onReady }: {
  evaluate: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  text: string; live?: boolean; delayMs?: number; onReady: (check: LiveEvaluation) => void;
}) {
  const check = useLiveEvaluation({ evaluate, workflow: 'incident', text, candidates: [], live, delayMs });
  onReady(check);
  return null;
}

describe('useLiveEvaluation backoff and cancellation', () => {
  it('suspends automatic sends after a failure until the backoff elapses, then sends the changed input', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const evaluate = vi.fn(async () => { calls++; if (calls === 1) throw new Error('boom'); return fakeResult(); });
    const box: { check?: LiveEvaluation } = {};
    const view = render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    // The input changes; the quiet period alone is not enough while the backoff is still suspended.
    view.rerender(<Harness evaluate={evaluate} text="Changed sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4990); });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('honours a retryAfterMs carried on the failure instead of the default backoff', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const evaluate = vi.fn(async () => {
      calls++;
      if (calls === 1) { const err = new Error('slow down') as Error & { retryAfterMs?: number }; err.retryAfterMs = 2000; throw err; }
      return fakeResult();
    });
    const box: { check?: LiveEvaluation } = {};
    const view = render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    view.rerender(<Harness evaluate={evaluate} text="Changed sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('checkNow bypasses the backoff suspension', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const evaluate = vi.fn(async () => { calls++; if (calls === 1) throw new Error('boom'); return fakeResult(); });
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await act(async () => { box.check!.checkNow(); });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('aborts a superseded in-flight request rather than reporting it as a failure', async () => {
    const signals: AbortSignal[] = [];
    const releases: ((result: EvaluationResult) => void)[] = [];
    const evaluate = vi.fn((_request: EvaluationRequest, options?: EvaluateOptions) => new Promise<EvaluationResult>(resolve => {
      signals.push(options!.signal!);
      releases.push(resolve);
    }));
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={5} onReady={c => { box.check = c; }} />);
    await act(async () => { box.check!.checkNow(); });
    await act(async () => { box.check!.checkNow(); });
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    // Resolving the aborted call must not surface as a failure.
    await act(async () => { releases[0](fakeResult()); });
    expect(box.check!.error).toBe('');
  });

  it('exposes retryAt while automatic sends are suspended after a failure', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => { throw new Error('boom'); });
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    expect(box.check!.retryAt).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.retryAt).toBeGreaterThan(Date.now());
  });

  it('aborts an in-flight automatic run when the hook becomes paused, without reporting a failure', async () => {
    let signal: AbortSignal | undefined;
    const evaluate = vi.fn((_request: EvaluationRequest, options?: EvaluateOptions) => { signal = options!.signal; return new Promise<EvaluationResult>(() => {}); });
    const box: { check?: LiveEvaluation } = {};
    const view = render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={5} onReady={c => { box.check = c; }} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(signal?.aborted).toBe(false);
    // A paused source (e.g. a still-loading catalog) must cancel the send already under way.
    function PausedHarness() {
      const check = useLiveEvaluation({ evaluate, workflow: 'incident', text: 'Initial sufficiently long context', candidates: [], live: true, delayMs: 5, paused: true });
      box.check = check;
      return null;
    }
    view.rerender(<PausedHarness />);
    expect(signal?.aborted).toBe(true);
    expect(box.check!.error).toBe('');
  });

  it('aborts an in-flight automatic run when live turns off', async () => {
    let signal: AbortSignal | undefined;
    const evaluate = vi.fn((_request: EvaluationRequest, options?: EvaluateOptions) => { signal = options!.signal; return new Promise<EvaluationResult>(() => {}); });
    const box: { check?: LiveEvaluation } = {};
    const view = render(<Harness evaluate={evaluate} text="Initial sufficiently long context" live delayMs={5} onReady={c => { box.check = c; }} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(signal?.aborted).toBe(false);
    view.rerender(<Harness evaluate={evaluate} text="Initial sufficiently long context" live={false} delayMs={5} onReady={c => { box.check = c; }} />);
    expect(signal?.aborted).toBe(true);
    expect(box.check!.error).toBe('');
  });
});

describe('useLiveEvaluation staleness', () => {
  it('exposes `stale` as exactly "the evaluated result does not match the current draft key" — true once the text changes, false again once a matching result lands', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => fakeResult());
    const box: { check?: LiveEvaluation } = {};
    const view = render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    expect(box.check!.result).toBeUndefined();
    expect(box.check!.stale).toBe(false); // nothing evaluated yet: not "stale", just absent.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.result).toBeDefined();
    expect(box.check!.stale).toBe(false); // the result matches the current (unchanged) input.
    view.rerender(<Harness evaluate={evaluate} text="Changed sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    // The result still describes the old text; it must not be presented as current.
    expect(box.check!.result).toBeDefined();
    expect(box.check!.stale).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.stale).toBe(false);
  });

  it('treats a result as stale, not applicable, when the current input no longer produces a valid request at all', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => fakeResult());
    const box: { check?: LiveEvaluation } = {};
    const view = render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.result).toBeDefined();
    expect(box.check!.stale).toBe(false);
    // The input shrinks below the 10-character minimum: there is no current draft key at all.
    view.rerender(<Harness evaluate={evaluate} text="short" delayMs={10} onReady={c => { box.check = c; }} />);
    expect(box.check!.result).toBeDefined();
    expect(box.check!.stale).toBe(true);
  });
});

describe('useLiveEvaluation result contract validation', () => {
  it('treats a resolved `undefined` as a failure, without throwing, and shows the error', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => undefined as unknown as EvaluationResult);
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(box.check!.error).toBe('Jev returned a result that does not match the evaluation contract.');
    expect(box.check!.result).toBeUndefined();
    // Backoff applies exactly like any other failure.
    expect(box.check!.retryAt).toBeGreaterThan(Date.now());
  });

  it('treats a resolved `null` as a failure', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => null as unknown as EvaluationResult);
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.error).toBe('Jev returned a result that does not match the evaluation contract.');
    expect(box.check!.result).toBeUndefined();
  });

  it('treats a resolved `{}` as a failure', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => ({}) as unknown as EvaluationResult);
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.error).toBe('Jev returned a result that does not match the evaluation contract.');
    expect(box.check!.result).toBeUndefined();
  });

  it('treats an otherwise-valid result for a different workflow as a contract violation', async () => {
    vi.useFakeTimers();
    // Shaped exactly like `fakeResult()`, but for the wrong workflow: this alone must be rejected.
    const evaluate = vi.fn(async () => ({ ...fakeResult(), workflow: 'templates' }) as unknown as EvaluationResult);
    const box: { check?: LiveEvaluation } = {};
    render(<Harness evaluate={evaluate} text="Initial sufficiently long context" delayMs={10} onReady={c => { box.check = c; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(box.check!.error).toBe('Jev returned a result that does not match the evaluation contract.');
    expect(box.check!.result).toBeUndefined();
  });
});

describe('useLivePreference sharing', () => {
  function Probe({ label }: { label: string }) {
    const [live, setLive] = useLivePreference();
    return <label>{label}<input type="checkbox" aria-label={label} checked={live} onChange={e => setLive(e.target.checked)} /></label>;
  }

  it('defaults to off and shares one Live preference across every mounted consumer', () => {
    const view = render(<div><Probe label="A" /><Probe label="B" /></div>);
    const a = view.getByLabelText('A') as HTMLInputElement;
    const b = view.getByLabelText('B') as HTMLInputElement;
    expect(a.checked).toBe(false);
    expect(b.checked).toBe(false);
    fireEvent.click(a);
    expect(a.checked).toBe(true);
    // Toggling in one mounted consumer must be reflected in the other, without remounting either.
    expect(b.checked).toBe(true);
    expect(window.localStorage.getItem('jev-operations-support.live')).toBe('on');
  });
});
