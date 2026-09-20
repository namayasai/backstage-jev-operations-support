import { describe, expect, it } from 'vitest';
import { evaluationRequestByteLength, evaluationRequestSchema, fitCandidatesToBudget, truncateCodePoints, type Candidate } from './index';

describe('truncateCodePoints', () => {
  it('leaves text at or under the limit untouched', () => {
    expect(truncateCodePoints('hello', 10)).toBe('hello');
    expect(truncateCodePoints('hello', 5)).toBe('hello');
  });

  it('cuts plain ASCII exactly at the limit', () => {
    expect(truncateCodePoints('abcdefgh', 4)).toBe('abcd');
  });

  it('never splits a surrogate pair (an emoji outside the BMP)', () => {
    const emoji = '\u{1F600}'; // 😀 — a surrogate pair, 2 UTF-16 code units
    const text = `ab${emoji}cd`; // a, b, [hi, lo], c, d — 6 code units total
    // Cutting right after the high surrogate must back off to before the pair.
    expect(truncateCodePoints(text, 3)).toBe('ab');
    // Cutting after the full pair keeps it intact.
    expect(truncateCodePoints(text, 4)).toBe(`ab${emoji}`);
  });
});

function candidate(id: string, title: string, description: string): Candidate {
  return { id, title, description };
}

describe('fitCandidatesToBudget', () => {
  it('returns the input unchanged when it already fits', () => {
    const candidates = [candidate('c0', 'Team A', 'short description')];
    const result = fitCandidatesToBudget({ workflow: 'ownership', text: 'Some alarm context here.', candidates });
    expect(result).toEqual({ candidates, shortened: false, dropped: 0 });
  });

  it('fits 20 candidates at the schema maximum (200-char title, 1500-char description) of ASCII text', () => {
    const candidates = Array.from({ length: 20 }, (_unused, i) => candidate(`c${i}`, 'T'.repeat(200), 'D'.repeat(1500)));
    const result = fitCandidatesToBudget({ workflow: 'ownership', text: 'A'.repeat(1000), candidates });
    expect(result.shortened).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'ownership', text: 'A'.repeat(1000), candidates: result.candidates });
    expect(parsed.success).toBe(true);
  });

  it('fits candidates whose descriptions are CJK text without splitting a multi-byte character', () => {
    const candidates = Array.from({ length: 20 }, (_unused, i) => candidate(`c${i}`, `チーム${i}`, '説明文'.repeat(500)));
    const result = fitCandidatesToBudget({ workflow: 'ownership', text: 'アラームの内容です。'.repeat(20), candidates });
    expect(result.shortened || result.dropped > 0).toBe(true);
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'ownership', text: 'アラームの内容です。'.repeat(20), candidates: result.candidates });
    expect(parsed.success).toBe(true);
    // No description should contain a lone/invalid surrogate half.
    for (const c of result.candidates) expect(() => encodeURIComponent(c.description)).not.toThrow();
  });

  it('fits candidates whose descriptions end mid-emoji without splitting a surrogate pair', () => {
    const emojiHeavy = '🎉🎊🥳🎈'.repeat(400); // well over the 1500-char cap on its own
    const candidates = Array.from({ length: 20 }, (_unused, i) => candidate(`c${i}`, `Team ${i}`, emojiHeavy));
    const text = 'Emoji-heavy alarm context.'.repeat(50);
    const result = fitCandidatesToBudget({ workflow: 'ownership', text, candidates });
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'ownership', text, candidates: result.candidates });
    expect(parsed.success).toBe(true);
    for (const c of result.candidates) {
      // A lone surrogate would make this string invalid to re-encode as UTF-8/URI.
      expect(() => encodeURIComponent(c.description)).not.toThrow();
    }
  });

  it('fits escape-heavy descriptions (quotes, backslashes, control characters) whose JSON-escaped size differs sharply from raw length', () => {
    const escapeHeavy = '"\\\n\t'.repeat(500); // each raw char becomes 2+ escaped chars in JSON
    const candidates = Array.from({ length: 20 }, (_unused, i) => candidate(`c${i}`, `Team ${i}`, escapeHeavy));
    const text = 'Alarm context with escape-heavy candidates.';
    const result = fitCandidatesToBudget({ workflow: 'ownership', text, candidates });
    expect(evaluationRequestByteLength({ workflow: 'ownership', text, candidates: result.candidates })).toBeLessThanOrEqual(24_000);
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'ownership', text, candidates: result.candidates });
    expect(parsed.success).toBe(true);
  });

  it('drops candidates from the tail when even title-only candidates do not fit, then re-fits descriptions for the survivors', () => {
    // Control characters escape to ~6 raw bytes each in JSON (`` and similar), so a
    // 200-character control-heavy title costs roughly 6x a plain-ASCII one — enough that
    // 20 such titles alone (every description emptied) do not fit the 24 KB budget.
    const heavyTitle = ''.repeat(200);
    const candidates = Array.from({ length: 20 }, (_unused, i) => candidate(`c${i}`, heavyTitle, 'D'.repeat(1500)));
    const text = 'Alarm context.';
    const titleOnlyBytes = evaluationRequestByteLength({ workflow: 'ownership', text, candidates: candidates.map(c => ({ ...c, description: '' })) });
    // Confirms the premise this test relies on, rather than assuming the hand-picked
    // fixture actually reaches the drop branch.
    expect(titleOnlyBytes).toBeGreaterThan(24_000);

    const result = fitCandidatesToBudget({ workflow: 'ownership', text, candidates });

    expect(result.dropped).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThan(candidates.length);
    expect(evaluationRequestByteLength({ workflow: 'ownership', text, candidates: result.candidates })).toBeLessThanOrEqual(24_000);
    const parsed = evaluationRequestSchema.safeParse({ workflow: 'ownership', text, candidates: result.candidates });
    expect(parsed.success).toBe(true);

    // The re-fit step must give the survivors back some of their description when there
    // is meaningful headroom for it, rather than leaving them at the empty title-only
    // string the drop step used only to decide how many candidates to keep.
    const survivorsTitleOnlyBytes = evaluationRequestByteLength({ workflow: 'ownership', text, candidates: result.candidates.map(c => ({ ...c, description: '' })) });
    const headroom = 24_000 - survivorsTitleOnlyBytes;
    if (headroom > result.candidates.length * 10) {
      expect(result.candidates.some(c => c.description.length > 0)).toBe(true);
    }
  });

  it('never fails on size when shrinking would make it fit: the result is always at or under budget', () => {
    const scenarios: Candidate[][] = [
      Array.from({ length: 20 }, (_unused, i) => candidate(`c${i}`, 'T'.repeat(200), 'D'.repeat(1500))),
      Array.from({ length: 5 }, (_unused, i) => candidate(`c${i}`, `Team ${i}`, '長'.repeat(1500))),
      Array.from({ length: 1 }, (_unused, i) => candidate(`c${i}`, 'Solo', '🎉'.repeat(1500))),
    ];
    for (const candidates of scenarios) {
      const result = fitCandidatesToBudget({ workflow: 'ownership', text: 'Alarm context.', candidates });
      expect(evaluationRequestByteLength({ workflow: 'ownership', text: 'Alarm context.', candidates: result.candidates })).toBeLessThanOrEqual(24_000);
    }
  });
});
