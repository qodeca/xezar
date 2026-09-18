import { describe, expect, it } from 'vitest';
import { MAX_USAGE_LIMIT_WAIT_MS, parseUsageLimit } from './usage-limit.ts';

/** A fixed clock — every expectation below is relative to it. */
const NOW = Date.parse('2026-08-03T12:00:00.000Z');

describe('parseUsageLimit', () => {
  it('reads Claude Code\'s own envelope, in epoch seconds', () => {
    const resetAt = Date.parse('2026-08-03T17:00:00.000Z');
    const hit = parseUsageLimit(
      `continue failed: Claude AI usage limit reached|${resetAt / 1_000}`,
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T17:00:00.000Z');
    expect(hit?.evidence).toBe('claude-marker');
  });

  it('accepts the same marker in milliseconds rather than parking it ~50,000 years out', () => {
    const hit = parseUsageLimit(`Claude AI usage limit reached|${NOW + 3_600_000}`, NOW);
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T13:00:00.000Z');
  });

  it('reads an explicit reset instant out of prose', () => {
    const hit = parseUsageLimit(
      "You've hit your usage limit. Try again at 2026-08-03T15:30:00Z.",
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T15:30:00.000Z');
    expect(hit?.evidence).toBe('timestamp');
  });

  it('reads a date-only reset as local midnight, the way the zoneless prose forms are read', () => {
    // The ECMAScript date-ONLY form is defined as UTC, so a bare `YYYY-MM-DD` reaching
    // `Date.parse` unchanged would land up to a day away from the day the provider named. The
    // zoneless prose forms are deliberately read on the host's clock — the provider is talking
    // to the person at this machine — and a bare date has to answer the same way.
    // Two days out, so the expectation is unambiguous (and un-clamped) in every host timezone.
    const hit = parseUsageLimit('Usage limit reached. Try again at 2026-08-05.', NOW);
    const midnight = new Date(2026, 7, 5, 0, 0, 0, 0);
    expect(hit?.resetAt.getTime()).toBe(midnight.getTime());
    expect(hit?.evidence).toBe('timestamp');
  });

  it('reads Claude Code session-limit prose with a clock and IANA timezone', () => {
    const hit = parseUsageLimit(
      "You've hit your session limit · resets 8:10pm (Europe/Warsaw)",
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T18:10:00.000Z');
    expect(hit?.evidence).toBe('clock');
  });

  it('uses tomorrow when a clock-only reset already passed today in its named timezone', () => {
    const lateWarsawNight = Date.parse('2026-08-03T20:30:00.000Z');
    const hit = parseUsageLimit(
      "You've hit your session limit · resets 8:10pm (Europe/Warsaw)",
      lateWarsawNight,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-04T18:10:00.000Z');
  });

  it('reads a weekly-limit reset that names an explicit month/day, not just a clock (#581)', () => {
    // Real CLI text, run 24ec6a4d-65f7-46e9-90d4-a2a9b3687e4e (.local/xezar/runs.json):
    // hit at 2026-09-17T16:15:23Z, message names Sep 19 at 6pm Warsaw — two days out. A parser
    // that drops the month/day and only reads the clock guesses "the next 18:00 from now", which
    // lands on Sep 18 (one day early) because 18:00 had already passed on the 17th.
    const hitAt = Date.parse('2026-09-17T16:15:23.000Z');
    const hit = parseUsageLimit(
      "step \"review\" failed: You've hit your weekly limit · resets Sep 19 at 6pm (Europe/Warsaw)",
      hitAt,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-09-19T16:00:00.000Z');
    expect(hit?.evidence).toBe('date');
  });

  it('reads a weekly-limit reset named for tomorrow, not today\'s next occurrence (#581)', () => {
    // Real CLI text, run 35489d1a-43f3-4765-b2d9-e3a247cf3ec7: hit at 2026-09-17T16:30:58Z,
    // message names Sep 18 at 9pm Warsaw. The clock-only reading picks today (17th) because
    // 21:00 had not yet passed on the 17th — the explicit date says otherwise.
    const hitAt = Date.parse('2026-09-17T16:30:58.000Z');
    const hit = parseUsageLimit(
      "step \"address\" failed: You've hit your weekly limit · resets Sep 18 at 9pm (Europe/Warsaw)",
      hitAt,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-09-18T19:00:00.000Z');
    expect(hit?.evidence).toBe('date');
  });

  it('reads a month/day reset in the zone the machine is not in', () => {
    const hitAt = Date.parse('2026-09-17T16:15:23.000Z');
    const hit = parseUsageLimit("You've hit your weekly limit · resets Sep 19 at 6pm (America/Los_Angeles)", hitAt);
    expect(hit?.resetAt.toISOString()).toBe('2026-09-20T01:00:00.000Z');
    expect(hit?.evidence).toBe('date');
  });

  it('still reads the session-limit clock-only form the same way (unaffected by #581)', () => {
    // Real CLI text, run b9c9ddfd-5a3d-4c9e-8d3f-50a125a8c781 — already correct before the fix.
    const hitAt = Date.parse('2026-09-17T16:00:00.000Z');
    const hit = parseUsageLimit("You've hit your session limit · resets 6:30pm (Europe/Warsaw)", hitAt);
    expect(hit?.resetAt.toISOString()).toBe('2026-09-17T16:30:00.000Z');
    expect(hit?.evidence).toBe('clock');
  });

  it('reads a relative delay, and a bare retry-after', () => {
    expect(parseUsageLimit('rate limit exceeded — try again in 42 minutes', NOW)?.resetAt.toISOString())
      .toBe('2026-08-03T12:42:00.000Z');
    expect(parseUsageLimit('429 rate_limit_error; retry-after: 3600', NOW)?.resetAt.toISOString())
      .toBe('2026-08-03T13:00:00.000Z');
    expect(parseUsageLimit('usage limit reached, retry after 90 s', NOW)?.evidence).toBe('delay');
  });

  it('clamps an already-elapsed reset to now — the limit has lifted, resume as soon as allowed', () => {
    const hit = parseUsageLimit(`Claude AI usage limit reached|${(NOW - 60_000) / 1_000}`, NOW);
    expect(hit?.resetAt.getTime()).toBe(NOW);
  });

  it('refuses a reset further out than a week — a corrupt number must not swallow the task', () => {
    const beyond = (NOW + MAX_USAGE_LIMIT_WAIT_MS + 60_000) / 1_000;
    expect(parseUsageLimit(`Claude AI usage limit reached|${beyond}`, NOW)).toBeNull();
  });

  it('is null for anything that is not a usage limit', () => {
    expect(parseUsageLimit(undefined, NOW)).toBeNull();
    expect(parseUsageLimit('claude CLI exited with code 1 — ENOENT', NOW)).toBeNull();
    expect(parseUsageLimit('Failed to authenticate. API Error: 401', NOW)).toBeNull();
    // A timestamp with no limit phrase around it must never schedule a resume.
    expect(parseUsageLimit('build failed at 2026-08-03T15:30:00Z', NOW)).toBeNull();
  });

  it('is null for a limit with no recoverable instant — guessing would be a retry loop', () => {
    expect(parseUsageLimit('You have hit your usage limit. Upgrade to continue.', NOW)).toBeNull();
    expect(parseUsageLimit('429 {"type":"rate_limit_error"}', NOW)).toBeNull();
  });
});
