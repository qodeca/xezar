import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

describe('AgentQuotaStore', () => {
  it('degrades absent state to an empty answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xez-quota-'));
    const store = new AgentQuotaStore({ path: join(root, 'quota', 'quota.json'), now: () => Date.parse('2026-09-22T14:24:00Z') });
    await store.load();
    expect(store.answer().accounts).toEqual([]);
  });

  it('degrades corrupt state to empty and warns once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xez-quota-'));
    const path = join(root, 'quota.json');
    await writeFile(path, '{bad');
    const warn = vi.fn();
    const store = new AgentQuotaStore({ path, warn });
    await store.load();
    await store.load();
    expect(store.answer().accounts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('writes atomically, parses through the strict producer, and publishes only changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xez-quota-'));
    const path = join(root, 'agent-quota', 'quota.json');
    const store = new AgentQuotaStore({ path, now: () => Date.parse('2026-09-22T14:24:00Z') });
    const publish = vi.fn();
    store.subscribe(publish);
    const record = normalizeClaudeUsage(claudeDefault, 'default', at('2026-09-22T14:20:00Z'));
    await store.put(record);
    await store.put(record);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path, 'utf8')).records).toHaveLength(1);
    expect(agentQuotaResponseSchema.parse(store.answer()).accounts).toHaveLength(1);
  });

  it('reproduces the frozen documented sample and the consumer accepts the full answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xez-quota-'));
    const store = new AgentQuotaStore({ path: join(root, 'quota.json'), now: () => Date.parse(frozen.generatedAt) });
    for (const row of frozen.accounts) await store.put(row);
    const answer = store.answer();
    expect(agentQuotaResponseSchema.parse(answer)).toEqual(frozen);
    expect(answer).toEqual(frozen);
  });
});
