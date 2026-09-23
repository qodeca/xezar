import { describe, expect, it, vi } from 'vitest';
import { agentQuotaProducerResponseSchema, agentQuotaResponseSchema } from '@qodeca/xezar-contract';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import frozenText from '../../../contract/src/__fixtures__/agent-quota.expected.json?raw';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import claudeDefaultText from '../__fixtures__/agent-quota/claude-default-usage.json?raw';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import claudeUnknownText from '../__fixtures__/agent-quota/claude-work-usage.json?raw';
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
import { dryRunQuotaAnswer } from './agent-quota-sample.ts';

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
    expect(normalizeClaudeUsage(claudeUnknown, 'work', at('2026-09-22T14:21:00Z')).status).toBe('unknown');
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

  // #867 AC-12 / D22: when two blocking facts are both still in the future, the later reset wins.
  const weeklyReset = '2026-09-28T17:00:00Z';
  const shortReset = '2026-09-22T15:10:00Z';
  const liveOut = (reset: string, observedAt: string) => normalizeLiveQuota('claude', {
    rate_limit_info: { utilization: 1, resetsAt: Date.parse(reset) / 1_000, rateLimitType: 'five_hour', status: 'rejected' },
  }, 'default', at(observedAt))!;
  it.each([
    ['a failed-run out, then a live out with an earlier reset', async (store: AgentQuotaStore) => {
      await store.markOut('claude', 'default', at(weeklyReset), at('2026-09-22T14:20:00Z'));
      await store.put(liveOut(shortReset, '2026-09-22T14:23:00Z'));
    }],
    ['a live out, then a failed-run out with an earlier reset', async (store: AgentQuotaStore) => {
      await store.put(normalizeLiveQuota('claude', {
        rate_limit_info: { utilization: 1, resetsAt: Date.parse(weeklyReset) / 1_000, rateLimitType: 'seven_day', status: 'rejected' },
      }, 'default', at('2026-09-22T14:20:00Z'))!);
      await store.markOut('claude', 'default', at(shortReset), at('2026-09-22T14:23:00Z'));
    }],
    ['a live weekly window at 100 percent, then a live out with an earlier reset', async (store: AgentQuotaStore) => {
      await store.put(normalizeLiveQuota('claude', {
        rate_limit_info: { utilization: 1, resetsAt: Date.parse(weeklyReset) / 1_000, rateLimitType: 'seven_day' },
      }, 'default', at('2026-09-22T14:20:00Z'))!);
      await store.put(liveOut(shortReset, '2026-09-22T14:23:00Z'));
    }],
  ])('keeps the later still-future reset after %s', async (_case, arrange) => {
    let now = Date.parse('2026-09-22T14:24:00Z');
    const store = new AgentQuotaStore({ now: () => now });
    await arrange(store);
    expect(store.answer().accounts[0]).toMatchObject({ status: 'out', resetsAt: weeklyReset });
    now = Date.parse('2026-09-22T15:30:00Z');
    expect(store.answer().accounts[0]).toMatchObject({ status: 'out', resetsAt: weeklyReset });
  });

  it('lets a later live out replace an earlier retained out, and an expired one never wins', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T16:00:00Z') });
    await store.markOut('claude', 'default', at(shortReset), at('2026-09-22T14:20:00Z'));
    await store.put(liveOut(weeklyReset, '2026-09-22T15:30:00Z'));
    expect(store.answer().accounts[0]).toMatchObject({ status: 'out', resetsAt: weeklyReset });
  });

  it('lets a fresh check replace a retained out outright', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.markOut('claude', 'default', at(weeklyReset), at('2026-09-22T14:19:00Z'));
    await store.put(normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z')));
    expect(store.answer().accounts[0]).toMatchObject({ status: 'ok', source: 'check' });
  });

  // #867 AC-7: every machine time is whole seconds, `…:ssZ`, whatever the source's precision.
  it('emits every time in whole UTC seconds', async () => {
    const machineTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00.448Z') });
    await store.put(normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00.448Z')));
    await store.put(normalizeCodexRateLimits(codexDefault, 'codex', at('2026-09-22T14:22:00.448Z')));
    await store.markOut('claude', 'limited', at('2026-09-22T15:10:00.999Z'), at('2026-09-22T14:19:00.001Z'));
    await store.put(normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 0.4, resetsAt: 1_790_685_902.5, rateLimitType: 'five_hour' },
    }, 'live', at('2026-09-22T14:23:00.448Z'))!);
    const answer = store.answer({}, [{ runner: 'codex', accountId: 'none' }, { runner: 'claude', accountId: 'default' },
      { runner: 'codex', accountId: 'codex' }, { runner: 'claude', accountId: 'limited' }, { runner: 'claude', accountId: 'live' }]);
    const times: string[] = [answer.generatedAt];
    for (const row of answer.accounts) {
      times.push(row.observedAt, ...(row.status === 'out' ? [row.resetsAt] : []));
      for (const window of [row.shortWindow, row.weeklyWindow, ...(row.modelWindows ?? [])]) {
        if (window) times.push(window.resetsAt);
      }
    }
    expect(times.length).toBeGreaterThan(8);
    expect(times.filter((time) => !machineTime.test(time))).toEqual([]);
    expect(answer.generatedAt).toBe('2026-09-22T14:24:00Z');
    expect(answer.accounts.find((row) => row.accountId === 'limited')).toMatchObject({ resetsAt: '2026-09-22T15:10:00Z' });
  });

  it('reproduces the frozen sample from the S0 inputs through normalisers and store', async () => {
    const store = new AgentQuotaStore({ now: () => Date.parse(frozen.generatedAt) });
    // The normalisers read quota replies, which say nothing about credentials; the checker adds the
    // login kind it read from the tool's own auth report (#867 AC-36).
    await store.put({ ...normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z')), loginKind: 'subscription' });
    await store.put(normalizeClaudeUsage(claudeUnknown, 'work', at('2026-09-22T14:21:00Z')));
    await store.put({ ...normalizeCodexRateLimits(codexDefault, 'default', at('2026-09-22T14:22:00Z')), loginKind: 'subscription' });
    await store.markOut('claude', 'quota-exhausted', at('2026-09-22T15:10:00Z'), at('2026-09-22T14:19:00Z'));
    await store.put(frozen.accounts.find((row) => row.runner === 'codex' && row.accountId === 'api-key')!);
    const answer = store.answer();
    expect(agentQuotaResponseSchema.parse(answer)).toEqual(frozen);
    expect(answer).toEqual(frozen);
  });

  it('keeps the checked login kind across a live event and a failed run, but not across a new check', async () => {
    const now = Date.parse('2026-09-22T14:00:00Z');
    const store = new AgentQuotaStore({ now: () => now });
    const checked = { ...normalizeClaudeUsage(claudeDefault, 'work', at('2026-09-22T13:59:00Z')), loginKind: 'subscription' as const };
    await store.put(checked);
    const live = normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 0.5, resets_at: Math.floor((now + 60 * 60_000) / 1_000), rateLimitType: 'five_hour' },
    }, 'work', at('2026-09-22T14:00:00Z'));
    expect(live?.loginKind).toBe('unknown');
    await store.put(live!);
    expect(store.answer().accounts[0]).toMatchObject({ source: 'live', loginKind: 'subscription' });
    await store.markOut('claude', 'work', at('2026-09-22T15:00:00Z'), at('2026-09-22T14:00:00Z'));
    expect(store.answer().accounts[0]).toMatchObject({ source: 'failedRun', loginKind: 'subscription' });
    await store.put(normalizeClaudeUsage(claudeDefault, 'work', at('2026-09-22T14:00:00Z')));
    expect(store.answer().accounts[0]).toMatchObject({ source: 'check', loginKind: 'unknown' });
  });

  it('marks a row stale by observedAt: 15 minutes after the observation, not before', async () => {
    let now = Date.parse('2026-09-22T14:00:00Z');
    const store = new AgentQuotaStore({ now: () => now });
    const { AgentQuotaChecker, AGENT_QUOTA_STALE_MS } = await import('./agent-quota-checker.ts');
    const checker = new AgentQuotaChecker({
      store, now: () => now, dryRun: () => false,
      profiles: async () => [{ provider: 'claude', id: 'default', isDefault: true } as never],
    });
    await store.put({ ...normalizeClaudeUsage(claudeDefault, 'default', new Date(now)), loginKind: 'subscription' });
    now += AGENT_QUOTA_STALE_MS - 1_000;
    expect((await checker.answer()).accounts[0]).toMatchObject({ stale: false });
    now += 1_000;
    expect((await checker.answer()).accounts[0]).toMatchObject({ stale: true });
  });

  it('bundles the frozen sample as the dry-run answer', () => {
    expect(`${JSON.stringify(dryRunQuotaAnswer(), null, 2)}\n`).toBe(frozenText);
    expect(dryRunQuotaAnswer({ provider: 'codex', accountId: 'api-key' }).accounts).toEqual([frozen.accounts[4]]);
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
