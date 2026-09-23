import { describe, expect, it, vi } from 'vitest';
import { agentQuotaProducerResponseSchema, agentQuotaResponseSchema } from '@qodeca/xezar-contract';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import frozenText from '../../../contract/src/__fixtures__/agent-quota.expected.json?raw';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import claudeDefaultText from '../__fixtures__/agent-quota/claude-default-usage.json?raw';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import claudeUnknownText from '../__fixtures__/agent-quota/claude-qodeca-priv-usage.json?raw';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import codexDefaultText from '../__fixtures__/agent-quota/codex-account-rateLimits-read.json?raw';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import codexByLimitIdText from '../__fixtures__/agent-quota/codex-rateLimits-by-limit-id.schema-shaped.json?raw';
import {
  AgentQuotaStore,
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  normalizeLiveQuota,
} from './agent-quota.ts';

const at = (value: string) => new Date(value);
const frozen = agentQuotaProducerResponseSchema.parse(JSON.parse(frozenText));
const claudeDefault: unknown = JSON.parse(claudeDefaultText);
const claudeUnknown: unknown = JSON.parse(claudeUnknownText);
const codexDefault: unknown = JSON.parse(codexDefaultText);

describe('agent quota normalisers', () => {
  it('normalises the S0 Claude reply, including model windows and UTC reset instants', () => {
    const row = normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z'));
    expect(row).toMatchObject({
      runner: 'claude', status: 'ok',
      shortWindow: { usedPercent: 92, resetsAt: '2026-09-22T15:10:00Z' },
      weeklyWindow: { usedPercent: 26, resetsAt: '2026-09-28T17:00:00Z' },
      modelWindows: [{ model: 'Fable', usedPercent: 29 }],
    });
  });

  it('treats a successful Claude reply with no percent lines as unknown, never ok', () => {
    expect(normalizeClaudeUsage(claudeUnknown, 'qodeca-priv', at('2026-09-22T14:21:00Z')).status).toBe('unknown');
  });

  it('marks every reported window at or above 100 percent out and emits resetsAt only then', () => {
    const raw = { result: 'Current session: 100% used · resets Sep 22 at 5:10pm (Europe/Warsaw)' };
    const out = normalizeClaudeUsage(raw, 'default', at('2026-09-22T14:20:00Z'));
    expect(out).toMatchObject({ status: 'out', resetsAt: '2026-09-22T15:10:00Z' });
    expect(normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z'))).not.toHaveProperty('resetsAt');
  });

  it('classifies Codex primary by duration instead of slot and keeps plan and credits', () => {
    const row = normalizeCodexRateLimits(codexDefault, 'default', at('2026-09-22T14:22:00Z'));
    expect(row).toMatchObject({
      status: 'ok', shortWindow: null,
      weeklyWindow: { usedPercent: 0, windowMinutes: 10080, resetsAt: '2026-09-29T12:45:02Z' },
      credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'pro',
    });
  });

  it('normalises runner live notifications without inventing a top-level reset for available quota', () => {
    const claude = normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 1, resets_at: 1_790_685_902, status: 'rejected' },
    }, 'default', at('2026-09-22T14:22:00Z'));
    const codex = normalizeLiveQuota('codex', {
      rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_790_685_902 } },
    }, 'default', at('2026-09-22T14:22:00Z'));
    expect(claude).toMatchObject({ source: 'live', status: 'out', resetsAt: '2026-09-29T12:45:02Z' });
    expect(codex).toMatchObject({ source: 'live', status: 'ok', shortWindow: { usedPercent: 25 } });
    expect(codex).not.toHaveProperty('resetsAt');
  });

  it('maps Claude live window kinds and ignores empty Codex updates', () => {
    const weekly = normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 0.4, resetsAt: 1_790_685_902, rateLimitType: 'seven_day' },
    }, 'default', at('2026-09-22T14:22:00Z'));
    const opus = normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 0.5, resetsAt: 1_790_685_902, rateLimitType: 'seven_day_opus' },
    }, 'default', at('2026-09-22T14:22:00Z'));
    expect(weekly).toMatchObject({ shortWindow: null, weeklyWindow: { windowMinutes: 10080 } });
    expect(opus).toMatchObject({ modelWindows: [{ model: 'Opus', windowMinutes: 10080 }] });
    expect(normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 0.5, resetsAt: 1_790_685_902, rateLimitType: 'overage' },
    }, 'default', at('2026-09-22T14:22:00Z'))).toBeNull();
    expect(normalizeLiveQuota('codex', { rateLimits: { planType: 'pro' } }, 'default', at('2026-09-22T14:22:00Z'))).toBeNull();
  });

  it('clamps live Codex percentages and drops malformed windows', () => {
    expect(normalizeLiveQuota('codex', {
      rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: 1_790_685_902 } },
    }, 'default', at('2026-09-22T14:22:00Z'))).toMatchObject({ shortWindow: { usedPercent: 100 } });
    expect(() => normalizeLiveQuota('codex', {
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: -1, resetsAt: 1_790_685_902_000 } },
    }, 'default', at('2026-09-22T14:22:00Z'))).toThrow('invalid duration');
  });

  it('honours Codex blocking signals and chooses the latest blocking reset', () => {
    const row = normalizeCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: {
      rateLimitReachedType: 'rate_limit_reached',
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_790_685_902 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_790_600_000 },
    } }, 'default', at('2026-09-22T14:22:00Z'));
    expect(row).toMatchObject({ status: 'out', resetsAt: '2026-09-28T12:53:20Z' });
    expect(normalizeCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: {
      resetsAt: 1_790_685_902,
    } }, 'default', at('2026-09-22T14:22:00Z'))).toMatchObject({
      status: 'out', resetsAt: '2026-09-29T12:45:02Z', shortWindow: null, weeklyWindow: null,
    });
  });

  it('uses the exhausted Claude window length as a conservative reset when its reset text is unreadable', () => {
    const row = normalizeClaudeUsage({
      result: 'Current session: 100% used · resets definitely not a date\nCurrent week (all models): 20% used · resets Sep 28 at 7:00pm (Europe/Warsaw)',
    }, 'default', at('2026-09-22T14:20:00Z'));
    expect(row).toMatchObject({ status: 'out', resetsAt: '2026-09-22T19:20:00Z' });
  });
});

describe('AgentQuotaStore', () => {
  it('has no persistence path; observations exist only for this instance', async () => {
    const first = new AgentQuotaStore();
    await first.put(normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z')));
    expect(first).not.toHaveProperty('path');
    expect(new AgentQuotaStore().answer().accounts).toEqual([]);
  });

  it('keeps observations in memory, parses through the strict producer, and publishes only changes', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    const publish = vi.fn();
    store.subscribe(publish);
    const record = normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z'));
    await store.put(record);
    await store.put(record);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(agentQuotaResponseSchema.parse(store.answer()).accounts).toHaveLength(1);
  });

  it('orders known profiles before stored-only rows regardless of observation arrival order', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.put(normalizeClaudeUsage(claudeDefault, 'named', at('2026-09-22T14:20:00Z')));
    await store.put(normalizeCodexRateLimits(codexDefault, 'removed', at('2026-09-22T14:22:00Z')));
    await store.put(normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z')));

    expect(store.answer({}, [
      { runner: 'claude', accountId: 'default' },
      { runner: 'claude', accountId: 'named' },
      { runner: 'codex', accountId: 'default' },
    ]).accounts.map(({ runner, accountId }) => `${runner}:${accountId}`)).toEqual([
      'claude:default',
      'claude:named',
      'codex:default',
    ]);
  });

  it('expires reset facts and recomputes status from remaining windows', async () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    const store = new AgentQuotaStore({ now: () => now });
    await store.markOut('claude', 'default', at('2026-09-29T00:00:00Z'), at('2026-09-22T00:00:00Z'));
    expect(store.answer().accounts[0]).toMatchObject({ status: 'unknown' });
    expect(store.answer().accounts[0]).not.toHaveProperty('resetsAt');
  });

  it('merges sparse live windows without erasing checked facts', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.put(normalizeCodexRateLimits(codexDefault, 'default', at('2026-09-22T14:22:00Z')));
    await store.put(normalizeLiveQuota('codex', { rateLimits: {
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_790_685_902 },
    } }, 'default', at('2026-09-22T14:23:00Z'))!);
    expect(store.answer().accounts[0]).toMatchObject({
      shortWindow: { usedPercent: 25 }, weeklyWindow: { usedPercent: 0 }, planType: 'pro',
      credits: { balance: '0' },
    });
  });

  it.each([
    ['reported 100 percent with ordinary usage allowed', { ordinaryUsageAllowed: true, rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_790_685_902 },
    } }],
    ['clamped malformed 140 percent', { rateLimits: {
      primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: 1_790_685_902 },
    } }],
  ])('does not mark usable Codex quota out from %s alone', async (_case, raw) => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.put(normalizeLiveQuota('codex', raw, 'default', at('2026-09-22T14:22:00Z'))!);
    expect(store.answer().accounts[0]).toMatchObject({ status: 'ok', shortWindow: { usedPercent: 100 } });
  });

  it.each([
    '2026-09-22T14:20:00Z',
    '2026-09-22T15:20:00Z',
  ])('keeps an exhausted Claude row out at %s when its reset text is unreadable', async (now) => {
    const store = new AgentQuotaStore({ now: () => Date.parse(now) });
    await store.put(normalizeClaudeUsage({
      result: 'Current session: 100% used · resets definitely not a date\nCurrent week (all models): 20% used · resets Sep 28 at 7:00pm (Europe/Warsaw)',
    }, 'default', at('2026-09-22T14:20:00Z')));
    expect(store.answer().accounts[0]).toMatchObject({
      status: 'out', resetsAt: '2026-09-22T19:20:00Z',
    });
  });

  it('keeps a failed-run out fact through a non-out Claude live update before its reset', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.markOut('claude', 'default', at('2026-09-22T15:10:00Z'), at('2026-09-22T14:20:00Z'));
    await store.put(normalizeLiveQuota('claude', {
      rate_limit_info: {
        utilization: 0.4,
        resetsAt: Date.parse('2026-09-22T19:20:00Z') / 1_000,
        rateLimitType: 'five_hour',
        status: 'allowed',
      },
    }, 'default', at('2026-09-22T14:23:00Z'))!);
    expect(store.answer().accounts[0]).toMatchObject({
      status: 'out', resetsAt: '2026-09-22T15:10:00Z', source: 'live',
    });
  });

  it('reproduces the frozen sample from the S0 inputs through normalisers and store', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse(frozen.generatedAt) });
    await store.put(normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z')));
    await store.put(normalizeClaudeUsage(claudeUnknown, 'qodeca-priv', at('2026-09-22T14:21:00Z')));
    await store.put(normalizeCodexRateLimits(codexDefault, 'default', at('2026-09-22T14:22:00Z')));
    await store.markOut('claude', 'quota-exhausted', at('2026-09-22T15:10:00Z'), at('2026-09-22T14:19:00Z'));
    await store.put(frozen.accounts.find((row) => row.runner === 'codex' && row.accountId === 'api-key')!);
    const answer = store.answer();
    expect(agentQuotaResponseSchema.parse(answer)).toEqual(frozen);
    expect(answer).toEqual(frozen);
  });
});

// #867 AC-9. The input is SCHEMA-SHAPED, not captured: it validates against the Codex 0.156.0
// `GetAccountRateLimitsResponse` schema (`codex app-server generate-json-schema`), but no live
// account with model buckets was available when it was written (the proving account was out of
// credits). The captured `codexDefault` reading has `rateLimitsByLimitId: {}`.
describe('Codex per-model weekly windows', () => {
  const byLimitId: unknown = JSON.parse(codexByLimitIdText);

  it('names each model bucket by normalModelSlug and keeps only its weekly window', () => {
    const row = normalizeCodexRateLimits(byLimitId, 'default', at('2026-09-22T14:22:00Z'));
    expect(row.modelWindows).toEqual([
      { model: 'gpt-5.6-sol', usedPercent: 55, resetsAt: '2026-09-29T12:45:02Z', windowMinutes: 10080 },
      { model: 'gpt-6-astra', usedPercent: 100, resetsAt: '2026-09-29T12:45:02Z', windowMinutes: 10080 },
    ]);
    expect(row.notReported).not.toContain('modelWindows');
    // The ordinary bucket stays the login's own windows; it is not repeated as a model window.
    expect(row).toMatchObject({
      shortWindow: { usedPercent: 12, windowMinutes: 300 },
      weeklyWindow: { usedPercent: 40, windowMinutes: 10080 },
    });
  });

  it('never lets an exhausted model bucket decide whether the login can work', async () => {
    const row = normalizeCodexRateLimits(byLimitId, 'default', at('2026-09-22T14:22:00Z'));
    expect(row.status).toBe('ok');
    expect(row).not.toHaveProperty('resetsAt');
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.put(row);
    expect(store.answer().accounts[0]).toMatchObject({ status: 'ok', modelWindows: [{}, { usedPercent: 100 }] });
  });

  it('keeps reporting modelWindows as not reported when Codex sends no model bucket', () => {
    const row = normalizeCodexRateLimits(codexDefault, 'default', at('2026-09-22T14:22:00Z'));
    expect(row.modelWindows).toBeNull();
    expect(row.notReported).toContain('modelWindows');
  });

  it('files a live model-bucket update as that model window without touching the login windows', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.put(normalizeCodexRateLimits(codexDefault, 'default', at('2026-09-22T14:22:00Z')));
    await store.put(normalizeLiveQuota('codex', { rateLimits: {
      limitId: 'codex_astra', normalModelSlug: 'gpt-6-astra', rateLimitReachedType: 'rate_limit_reached',
      primary: null, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_790_685_902 },
    } }, 'default', at('2026-09-22T14:23:00Z'))!);
    expect(store.answer().accounts[0]).toMatchObject({
      status: 'ok', shortWindow: null,
      weeklyWindow: { usedPercent: 0, resetsAt: '2026-09-29T12:45:02Z' },
      modelWindows: [{ model: 'gpt-6-astra', usedPercent: 60 }],
    });
  });

  it('does not call a login able to work from a lone model-bucket update', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.put(normalizeLiveQuota('codex', { rateLimits: {
      limitId: 'codex_sol', normalModelSlug: 'gpt-5.6-sol',
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_790_685_902 },
    } }, 'default', at('2026-09-22T14:23:00Z'))!);
    expect(store.answer().accounts[0]).toMatchObject({
      status: 'unknown', modelWindows: [{ model: 'gpt-5.6-sol' }], shortWindow: null, weeklyWindow: null,
    });
  });
});
