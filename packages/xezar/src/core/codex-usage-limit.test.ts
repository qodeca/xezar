import { describe, expect, it } from 'vitest';
import { codexTurnLimit, isCodexModelBucket, mergeCodexSnapshot } from './codex-usage-limit.ts';

// Shapes follow the Codex 0.156.0 app-server schema (`TurnCompletedNotification.turn`, `TurnError`,
// `CodexErrorInfo`, `RateLimitSnapshot`). They are schema-shaped, not captured from a live limit:
// the proving Codex account was out of credits when this was written.
const now = Date.parse('2026-09-20T12:00:00Z');
const failed = (codexErrorInfo: unknown, message = "You've hit your usage limit. Try again later.") => ({
  id: 'turn_1', status: 'failed', items: [], error: { message, codexErrorInfo, additionalDetails: null },
});

describe('codexTurnLimit', () => {
  it('classifies usageLimitExceeded from the structured field and dates it from the session snapshot', () => {
    const limit = codexTurnLimit(failed('usageLimitExceeded'), {
      limitId: 'codex',
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: now / 1_000 + 600 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now / 1_000 + 7_200 },
    }, now);
    expect(limit).toEqual({
      kind: 'usageLimitExceeded',
      resetAt: new Date(now + 7_200_000),
      message: "Codex usage limit reached (usageLimitExceeded) — resets at 2026-09-20T14:00:00.000Z. You've hit your usage limit. Try again later.",
    });
  });

  it("prefers Codex's own reset in the message over the snapshot", () => {
    const local = new Date(2026, 8, 20, 18, 30);
    const limit = codexTurnLimit(
      failed('usageLimitExceeded', "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Sep 20th, 2026 6:30 PM."),
      { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now / 1_000 + 60 } },
      new Date(2026, 8, 20, 12, 0).getTime(),
    );
    expect(limit?.resetAt).toEqual(local);
  });

  it('dates a reached limit from the latest window when Codex does not say which one', () => {
    const limit = codexTurnLimit(failed('rateLimitExceeded', 'Rate limit reached.'), {
      rateLimitReachedType: 'rate_limit_reached',
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: now / 1_000 + 600 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: now / 1_000 - 60 },
    }, now);
    expect(limit).toMatchObject({ kind: 'rateLimitExceeded', resetAt: new Date(now + 600_000) });
    expect(limit?.message).toMatch(/^Codex rate limit reached \(rateLimitExceeded\) — resets at /);
  });

  it('keeps an undated limit undated instead of guessing a window', () => {
    const limit = codexTurnLimit(failed('usageLimitExceeded'), {
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now / 1_000 + 600 },
    }, now);
    expect(limit).toEqual({
      kind: 'usageLimitExceeded',
      resetAt: null,
      message: "Codex usage limit reached (usageLimitExceeded); Codex did not report when it lifts. You've hit your usage limit. Try again later.",
    });
  });

  it.each([
    ['a completed turn', { id: 'turn_1', status: 'completed', items: [], error: null }],
    ['a failed turn with no error object', { id: 'turn_1', status: 'failed', items: [], error: null }],
    ['another string variant', failed('contextWindowExceeded')],
    ['a session budget, which is not plan quota', failed('sessionBudgetExceeded')],
    ['an object variant', failed({ httpConnectionFailed: { httpStatusCode: 429 } })],
    ['no codexErrorInfo', failed(null)],
  ])('returns null for %s', (_label, turn) => {
    expect(codexTurnLimit(turn, undefined, now)).toBeNull();
  });
});

describe('Codex snapshot helpers', () => {
  it('recognises a model bucket only when it names a non-ordinary bucket and a model', () => {
    expect(isCodexModelBucket({ limitId: 'codex_astra', normalModelSlug: 'gpt-6-astra' })).toBe(true);
    expect(isCodexModelBucket({ limitId: 'codex', normalModelSlug: 'gpt-6-astra' })).toBe(false);
    expect(isCodexModelBucket({ limitId: 'code_review', normalModelSlug: null })).toBe(false);
    expect(isCodexModelBucket({ normalModelSlug: 'gpt-6-astra' })).toBe(false);
  });

  it('merges a sparse update without letting null clear an observed value', () => {
    const merged = mergeCodexSnapshot(
      { primary: { usedPercent: 10 }, planType: 'pro' },
      { primary: { usedPercent: 20 }, planType: null, rateLimitReachedType: 'rate_limit_reached' },
    );
    expect(merged).toEqual({ primary: { usedPercent: 20 }, planType: 'pro', rateLimitReachedType: 'rate_limit_reached' });
  });
});
