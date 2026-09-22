import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentProfile } from './agent-profiles.ts';
import { AgentQuotaStore, normalizeLiveQuota } from './agent-quota.ts';
import {
  AGENT_QUOTA_CHECK_GAP_MS,
  AgentQuotaChecker,
  MINIMUM_CLAUDE_QUOTA_VERSION,
  MINIMUM_CODEX_QUOTA_VERSION,
  runQuotaProcess,
  type AgentQuotaProcessSpec,
  type RunQuotaProcess,
} from './agent-quota-checker.ts';

const profile = (provider: 'claude' | 'codex', id = 'default'): ResolvedAgentProfile => ({
  provider,
  id,
  label: id,
  configDir: `/private/agent-home/${id}`,
  path: `/private/agent-home/${id}`,
  isDefault: id === 'default',
});

describe('AgentQuotaChecker', () => {
  it('prefers Claude get_usage and maps its strict control reply without invoking /usage', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const run: RunQuotaProcess = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      return {
        type: 'control_response',
        response: {
          subtype: 'success', request_id: 'xezar-agent-quota',
          response: {
            subscription_type: 'max',
            rate_limits_available: true,
            limits: [{ kind: 'session', percent: 25, resets_at: '2026-09-22T17:10:00+02:00' }],
          },
        },
      };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:00:00Z') }),
      now: () => Date.parse('2026-09-22T14:00:00Z'),
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toEqual([{
      type: 'control_request', request_id: 'xezar-agent-quota', request: { subtype: 'get_usage', skip_behaviors: true },
    }]);
    expect(answer.accounts[0]).toMatchObject({ source: 'check', status: 'ok', planType: 'max', warnings: [] });
  });

  it('uses fixed isolated Claude argv and reports the /usage fallback in the row', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const run: RunQuotaProcess = vi.fn(async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args.includes('--input-format')) throw new Error('get_usage unavailable');
      return JSON.stringify({
        type: 'result', is_error: false, local_command: 'usage',
        result: 'Current session: 25% used · resets Sep 22 at 5:10pm (Europe/Warsaw)',
      });
    });
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00Z') }),
      now: () => Date.parse('2026-09-22T14:20:00Z'),
      profiles: async () => [profile('claude')],
      runProcess: run,
      dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(calls[1]!.args).toEqual([
      '-p', '--safe-mode', '--strict-mcp-config', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose',
    ]);
    expect(calls[2]!.args).toEqual(['-p', '/usage', '--safe-mode', '--strict-mcp-config', '--output-format', 'json']);
    expect(calls[1]!.cwd).toMatch(/xez-agent-quota-/);
    expect(calls[1]!.cwd).not.toContain(process.cwd());
    expect(answer.accounts[0]).toMatchObject({
      accountId: 'default', source: 'check-text', status: 'ok',
      warnings: ['Quota was read from the Claude Code /usage text fallback.'],
    });
  });

  it('runs Codex account reads without starting a thread and attributes the answer to the requested login', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const run: RunQuotaProcess = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `codex-cli ${MINIMUM_CODEX_QUOTA_VERSION}`;
      return {
        initialize: { userAgent: 'mock-codex/0.155.1', codexHome: '/must/not/leak' },
        account: { account: { type: 'chatgpt', planType: 'pro', email: 'must-not-leak@example.test' }, requiresOpenaiAuth: true },
        limits: {
          ordinaryUsageAllowed: false,
          rateLimits: {
            primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1790109000 },
            secondary: null,
            credits: { hasCredits: false, unlimited: false, balance: '0' },
            planType: 'pro',
            rateLimitReachedType: 'rate_limit_reached',
          },
          accountId: 'foreign-vendor-id',
        },
        usage: { summary: { lifetimeTokens: 1, peakDailyTokens: 1 }, dailyUsageBuckets: [], threadUsage: null },
      };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00Z') }),
      now: () => Date.parse('2026-09-22T14:20:00Z'),
      profiles: async () => [profile('codex', 'work')],
      runProcess: run,
      dryRun: () => false,
    });

    const answer = await checker.refresh();
    const rpc = calls[1]!;
    expect(rpc.args).toEqual(['-s', 'read-only', '-a', 'never', 'app-server']);
    const methods = [
      ...(rpc.input ?? []),
      ...(rpc.nextInput?.({ id: 1 }) ?? []),
      ...(rpc.nextInput?.({ id: 2 }) ?? []),
      ...(rpc.nextInput?.({ id: 3 }) ?? []),
    ].map((message) => (message as { method?: string }).method);
    expect(methods).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/usage/read']);
    expect(JSON.stringify(methods)).not.toContain('thread/');
    expect(answer.accounts[0]).toMatchObject({ runner: 'codex', accountId: 'work', status: 'out' });
    expect(JSON.stringify(answer)).not.toContain('foreign-vendor-id');
    expect(JSON.stringify(answer)).not.toContain('must-not-leak');
  });

  it('stops after account/read for a Codex API-key login and reports no plan limits', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const run: RunQuotaProcess = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `codex-cli ${MINIMUM_CODEX_QUOTA_VERSION}`;
      return { initialize: {}, account: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('codex')], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'api-key' });
    expect(calls[1]!.nextInput?.({ id: 2, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } })).toEqual([]);
  });

  it('reports a Claude API-key login without trying the text fallback', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const run: RunQuotaProcess = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      return { type: 'control_response', response: { response: { rate_limits_available: false } } };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'api-key' });
    expect(calls).toHaveLength(2);
  });

  it('gates old versions before a quota process and honours the five-minute per-login gap', async () => {
    let now = Date.parse('2026-09-22T14:20:00Z');
    const run = vi.fn(async () => '2.1.277 (Claude Code)');
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => now }), now: () => now,
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    const first = await checker.refresh();
    await checker.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    expect(first.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'version-too-old' });
    now += AGENT_QUOTA_CHECK_GAP_MS;
    await checker.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never runs more than two login checks concurrently', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args.includes('--input-format')) throw new Error('fallback');
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return JSON.stringify({ result: 'Current session: 25% used · resets Sep 22 at 5:10pm (Europe/Warsaw)' });
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00Z') }),
      now: () => Date.parse('2026-09-22T14:20:00Z'),
      profiles: async () => [profile('claude', 'a'), profile('claude', 'b'), profile('claude', 'c')],
      runProcess: run, dryRun: () => false,
    });
    const pending = checker.refresh();
    await expect.poll(() => releases.length).toBe(2);
    releases.splice(0).forEach((release) => release());
    await expect.poll(() => releases.length).toBe(1);
    releases.shift()?.();
    await pending;
    expect(peak).toBe(2);
  });

  it('logs one format warning per login and version and leaves other accounts unchanged', async () => {
    const warn = vi.fn();
    let now = Date.parse('2026-09-22T14:20:00Z');
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args.includes('--input-format')) throw new Error('fallback');
      return '{"result":42}';
    };
    const store = new AgentQuotaStore({ now: () => now });
    const checker = new AgentQuotaChecker({
      store, now: () => now, profiles: async () => [profile('claude', 'a'), profile('claude', 'b')],
      runProcess: run, logger: { warn }, dryRun: () => false,
    });
    await checker.refresh({ accountId: 'a' });
    now += AGENT_QUOTA_CHECK_GAP_MS;
    await checker.refresh({ accountId: 'a' });
    const answer = await checker.answer();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(answer.accounts.find((row) => row.accountId === 'a')).toMatchObject({ statusReason: 'format-changed' });
    expect(answer.accounts.find((row) => row.accountId === 'b')).toMatchObject({ source: 'none' });
  });

  it('keeps Claude live task data when both active check formats fail', async () => {
    const now = Date.parse('2026-09-22T14:20:00Z');
    const store = new AgentQuotaStore({ now: () => now });
    const live = normalizeLiveQuota('claude', {
      rate_limit_info: { utilization: 0.4, resets_at: Math.floor((now + 60_000) / 1_000), rateLimitType: 'five_hour' },
    }, 'work', new Date(now - 16 * 60_000));
    expect(live).not.toBeNull();
    await store.put(live!);
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args.includes('--input-format')) throw new Error('get_usage unavailable');
      return '{"result":42}';
    };
    const checker = new AgentQuotaChecker({
      store, now: () => now, profiles: async () => [profile('claude', 'work')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refresh({ accountId: 'work' });

    expect(answer.accounts[0]).toMatchObject({ source: 'live', status: 'ok', stale: true });
    expect(answer.accounts[0]!.warnings).toEqual([
      `Claude Code ${MINIMUM_CLAUDE_QUOTA_VERSION} changed its quota format. Showing live task data.`,
    ]);
  });

  it('dry-run starts no process and returns deterministic rows for both providers', async () => {
    const run = vi.fn();
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00Z') }),
      now: () => Date.parse('2026-09-22T14:20:00Z'), profiles: async () => [profile('claude'), profile('codex')],
      runProcess: run, dryRun: () => true,
    });
    const answer = await checker.refresh();
    expect(run).not.toHaveBeenCalled();
    expect(answer.accounts.map((row) => [row.runner, row.status])).toEqual([['claude', 'ok'], ['codex', 'ok']]);
  });

  it('contains no forbidden credential or private endpoint reads', () => {
    const source = readFileSync(new URL('./agent-quota-checker.ts', import.meta.url), 'utf8');
    for (const forbidden of ['Keychain', '.credentials.json', 'auth.json', 'api/oauth/usage', 'wham/usage', '-ratelimit-']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('terminates its own saved child when the deadline expires', async () => {
    await expect(runQuotaProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: tmpdir(),
      env: {},
      deadline: Date.now() + 50,
    })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('startup is detached from a running check', async () => {
    let release!: () => void;
    const run: RunQuotaProcess = () => new Promise((resolve) => { release = () => resolve(MINIMUM_CLAUDE_QUOTA_VERSION); });
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    expect(checker.startup()).toBeUndefined();
    await expect.poll(() => typeof release).toBe('function');
    release();
  });
});
