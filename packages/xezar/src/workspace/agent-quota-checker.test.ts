import { readFileSync } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentProfile } from './agent-profiles.ts';
import { AgentQuotaStore, normalizeClaudeUsage, normalizeLiveQuota } from './agent-quota.ts';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import codexByLimitIdText from '../__fixtures__/agent-quota/codex-rateLimits-by-limit-id.schema-shaped.json?raw';
import {
  AGENT_QUOTA_CHECK_GAP_MS,
  AGENT_QUOTA_WAIT_MS,
  AgentQuotaChecker,
  MINIMUM_CLAUDE_QUOTA_VERSION,
  claudeLoginKind,
  codexLoginKind,
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

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runHungClaudeCheck(ignoreTerm: boolean): Promise<{
  pgids: number[];
  sigkillPgids: number[];
  cleanup: () => Promise<void>;
}> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'xez-agent-quota-group-'));
  const pgidsPath = join(fixtureDir, 'pgids.txt');
  const executable = join(fixtureDir, 'claude');
  const child = ignoreTerm
    ? "( trap '' TERM; exec sleep 999 ) </dev/null >/dev/null 2>&1 &"
    : 'sleep 999 &';
  await writeFile(executable, [
    '#!/bin/bash',
    'if [[ "$1" == "--version" ]]; then echo "2.1.280 (Claude Code)"; exit 0; fi',
    `printf '%s\\n' "$$" >> ${JSON.stringify(pgidsPath)}`,
    child,
    'CHILD=$!',
    'wait "$CHILD"',
  ].join('\n'));
  await chmod(executable, 0o755);

  const previousExecutable = process.env.XEZ_CLAUDE_BIN;
  process.env.XEZ_CLAUDE_BIN = executable;
  const actualNow = Date.now.bind(Date);
  const nowSpy = vi.spyOn(Date, 'now')
    .mockImplementationOnce(() => actualNow() - 19_500)
    .mockImplementation(actualNow);
  const originalKill = process.kill.bind(process);
  const killCalls: Array<[number, string | number | undefined]> = [];
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    killCalls.push([pid, signal]);
    return originalKill(pid, signal as NodeJS.Signals | number | undefined);
  });
  try {
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(),
      now: () => Date.parse('2026-09-22T14:20:00Z'),
      profiles: async () => [profile('claude')],
      dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'check-failed' });
  } finally {
    killSpy.mockRestore();
    nowSpy.mockRestore();
    if (previousExecutable === undefined) delete process.env.XEZ_CLAUDE_BIN;
    else process.env.XEZ_CLAUDE_BIN = previousExecutable;
  }

  const pgids = (await readFile(pgidsPath, 'utf8'))
    .trim().split('\n').filter(Boolean).map(Number);
  return {
    pgids,
    sigkillPgids: killCalls
      .filter(([, signal]) => signal === 'SIGKILL')
      .map(([pid]) => -pid),
    cleanup: async () => {
      for (const pgid of pgids) {
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
      }
      await rm(fixtureDir, { recursive: true, force: true });
    },
  };
}

describe('AgentQuotaChecker', () => {
  afterEach(() => vi.useRealTimers());

  it('prefers Claude get_usage and maps the captured zero-token reply without invoking /usage', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const capture = JSON.parse(await readFile(
      new URL('../__fixtures__/agent-quota/claude-get-usage-control-response.json', import.meta.url),
      'utf8',
    )) as { response: { request_id: string } };
    capture.response.request_id = 'xezar-agent-quota';
    const run: RunQuotaProcess = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args[0] === 'auth') return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
      return capture;
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:00:00Z') }),
      now: () => Date.parse('2026-09-22T14:00:00Z'),
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(calls).toHaveLength(3);
    expect(calls[1]!.args).toEqual(['auth', 'status', '--json']);
    expect(calls[2]!.input).toEqual([{
      type: 'control_request', request_id: 'xezar-agent-quota', request: { subtype: 'get_usage', skip_behaviors: true },
    }]);
    expect(calls[2]!.waitFor?.({ type: 'control_response', response: {} })).toBeUndefined();
    expect(calls[2]!.waitFor?.({ type: 'control_response', response: { request_id: 'other' } })).toBeUndefined();
    expect(calls[2]!.waitFor?.(capture)).toBe(capture);
    // Claude Code 2.1.280 answered this live capture without an initialize message.
    expect(answer.accounts[0]).toMatchObject({
      source: 'check', status: 'ok', planType: 'max', warnings: [], loginKind: 'subscription',
    });
    expect(answer.accounts[0]!.shortWindow?.usedPercent).toBe(7);
    expect(answer.accounts[0]!.weeklyWindow?.usedPercent).toBe(29);
  });

  // #906: the live Claude Code 2.1.280 get_usage reply (issue 867, "AC-38 re-proof (get_usage,
  // live)") nests `limits[]` under `rate_limits`, and its session and weekly entries carry
  // `scope: null`. The per-model weekly window (Fable) must reach the answer.
  it('reads the per-model window from the limits nested under rate_limits in the live reply', async () => {
    const capture: unknown = JSON.parse(await readFile(
      new URL('../__fixtures__/agent-quota/claude-get-usage-nested-limits.json', import.meta.url), 'utf8',
    ));
    const run: RunQuotaProcess = async (spec) => (spec.args[0] === '--version' ? '2.1.280 (Claude Code)' : capture);
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-23T07:00:00Z') }),
      now: () => Date.parse('2026-09-23T07:00:00Z'),
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(answer.accounts[0]).toMatchObject({
      source: 'check', status: 'ok', planType: 'max', statusReason: null, warnings: [],
      shortWindow: { usedPercent: 9, windowMinutes: 300 },
      weeklyWindow: { usedPercent: 23, windowMinutes: 10080 },
      modelWindows: [{ model: 'Fable', usedPercent: 4, windowMinutes: 10080 }],
    });
    expect(answer.accounts[0]!.notReported).toEqual(['credits']);
  });

  // An empty limit list carries no rows; the fixed windows beside it still hold the numbers.
  it.each(['top-level', 'nested'] as const)('reads the fixed windows when the %s limits list is empty', async (where) => {
    const capture = JSON.parse(await readFile(
      new URL('../__fixtures__/agent-quota/claude-get-usage-control-response.json', import.meta.url), 'utf8',
    )) as { response: { request_id: string; response: { limits?: unknown[]; rate_limits: { limits?: unknown[] } } } };
    capture.response.request_id = 'xezar-agent-quota';
    if (where === 'top-level') capture.response.response.limits = [];
    else capture.response.response.rate_limits.limits = [];
    const run: RunQuotaProcess = async (spec) => (spec.args[0] === '--version' ? '2.1.280 (Claude Code)' : capture);
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:00:00Z') }),
      now: () => Date.parse('2026-09-22T14:00:00Z'),
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(answer.accounts[0]).toMatchObject({
      source: 'check', status: 'ok', shortWindow: { usedPercent: 7 }, weeklyWindow: { usedPercent: 29 },
    });
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

    expect(calls[1]!.args).toEqual(['auth', 'status', '--json']);
    expect(calls[2]!.args).toEqual([
      '-p', '--safe-mode', '--strict-mcp-config', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose',
    ]);
    expect(calls[3]!.args).toEqual(['-p', '/usage', '--safe-mode', '--strict-mcp-config', '--output-format', 'json']);
    expect(relative(tmpdir(), calls[2]!.cwd)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(basename(calls[2]!.cwd)).toMatch(/^xez-agent-quota-/);
    expect(calls[3]!.cwd).toBe(calls[2]!.cwd);
    await expect(access(calls[2]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
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
    expect(answer.accounts[0]).toMatchObject({ runner: 'codex', accountId: 'work', status: 'out', loginKind: 'subscription' });
    expect(JSON.stringify(answer)).not.toContain('foreign-vendor-id');
    expect(JSON.stringify(answer)).not.toContain('must-not-leak');
  });

  it('carries Codex model buckets through the check into per-model weekly windows (#867 AC-9)', async () => {
    // Schema-shaped per the Codex 0.156.0 `GetAccountRateLimitsResponse`; not captured live.
    const byLimitId = JSON.parse(codexByLimitIdText) as { result: unknown };
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `codex-cli ${MINIMUM_CODEX_QUOTA_VERSION}`;
      return {
        initialize: { userAgent: 'mock-codex/0.156.0' },
        account: { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
        limits: byLimitId.result,
        usage: { summary: { lifetimeTokens: 1, peakDailyTokens: 1 }, dailyUsageBuckets: [], threadUsage: null },
      };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00Z') }),
      now: () => Date.parse('2026-09-22T14:20:00Z'),
      profiles: async () => [profile('codex')],
      runProcess: run,
      dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({
      runner: 'codex', status: 'ok', source: 'check',
      modelWindows: [{ model: 'gpt-5.6-sol', usedPercent: 55 }, { model: 'gpt-6-astra', usedPercent: 100 }],
    });
    expect(answer.accounts[0]?.notReported).not.toContain('modelWindows');
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
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'api-key', loginKind: 'api-key' });
    expect(calls[1]!.nextInput?.({ id: 2, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } })).toEqual([]);
  });

  it('reports a Claude API-key login without trying the text fallback', async () => {
    const calls: AgentQuotaProcessSpec[] = [];
    const run: RunQuotaProcess = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args[0] === 'auth') return JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' });
      return { type: 'control_response', response: { response: { rate_limits_available: false } } };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'api-key', loginKind: 'api-key' });
    expect(calls).toHaveLength(3);
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

  // #867 AC-26 / D29: the minimums are the versions the D18 live QA ran on (PR 888 QA:
  // Claude Code 2.1.280, codex-cli 0.155.1); a version below them is gated, and the unchecked
  // store row names the same minimum as the checker.
  it.each([
    ['claude', '2.1.279 (Claude Code)', '2.1.280'],
    ['codex', 'codex-cli 0.155.0', '0.155.1'],
  ] as const)('gates %s below the D18 proof version %s', async (provider, reply, minimum) => {
    const run = vi.fn(async () => reply);
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00Z') });
    expect(store.answer({}, [{ runner: provider, accountId: 'unchecked' }]).accounts[0]!.minimumVersion).toBe(minimum);
    const checker = new AgentQuotaChecker({
      store, now: () => Date.parse('2026-09-22T14:20:00Z'),
      profiles: async () => [profile(provider)], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'version-too-old', minimumVersion: minimum });
  });

  // #867 AC-7: the checker's own times (`observedAt`, `nextCheckAt`) are whole seconds too.
  it('emits whole-second times on a check that started inside a second', async () => {
    const machineTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
    const run: RunQuotaProcess = async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:20:00.448Z') }),
      now: () => Date.parse('2026-09-22T14:20:00.448Z'),
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    const row = answer.accounts[0]!;
    expect(row).toMatchObject({ statusReason: 'not-installed' });
    expect([answer.generatedAt, row.observedAt, row.nextCheckAt]).toEqual([
      expect.stringMatching(machineTime), expect.stringMatching(machineTime), expect.stringMatching(machineTime),
    ]);
  });

  it('never runs more than two login checks concurrently', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args[0] === 'auth') throw new Error('no auth status');
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

  it('does not over-admit when a released slot races a newly scheduled login', async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const releases: Array<() => void> = [];
    const waits = Array.from({ length: 4 }, () => new Promise<void>((resolve) => releases.push(resolve)));
    const checker = new AgentQuotaChecker({ store: new AgentQuotaStore(), profiles: async () => [] });
    const withSlot = (checker as unknown as {
      withSlot(work: () => Promise<void>): Promise<void>;
    }).withSlot.bind(checker);
    const work = (index: number) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await waits[index];
      active -= 1;
      completed += 1;
    };
    const flush = async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };
    const initial = Promise.all([withSlot(work(0)), withSlot(work(1)), withSlot(work(2))]);
    await flush();
    expect(active).toBe(2);
    const slotWaiters = (checker as unknown as { slotWaiters: Array<() => void> }).slotWaiters;
    const originalWake = slotWaiters[0]!;
    let late: Promise<void> | undefined;
    slotWaiters[0] = () => {
      originalWake();
      late = withSlot(work(3));
    };

    releases[0]!();
    await flush();
    expect(late).toBeDefined();
    expect(peak).toBe(2);
    releases[1]!();
    releases[3]!();
    await flush();
    releases[2]!();
    await Promise.all([initial, late!]);
    expect(completed).toBe(4);
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

  it('classifies /usage text with zero recognised quota rows as one format change', async () => {
    const warn = vi.fn();
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args.includes('--input-format')) throw new Error('fallback');
      return JSON.stringify({ result: 'You are using your subscription. No quota rows are present.' });
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')],
      runProcess: run, logger: { warn }, dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'format-changed' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // #893: the real `claude -p "/usage"` reply from Claude Code 2.1.280 on a max-plan login is a
  // usage-composition report with no limit rows. It is not a format change: the fallback simply
  // has no limits to read, so the row says the check failed and nothing logs a format warning.
  // The fixture is the reply quoted in #893 (captured at PR 888 head f823b97b).
  it('reports the #893 usage-composition reply as a failed check, not a format change', async () => {
    const warn = vi.fn();
    const composition = await readFile(
      new URL('../__fixtures__/agent-quota/claude-usage-composition.json', import.meta.url), 'utf8',
    );
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return '2.1.280 (Claude Code)';
      if (spec.args.includes('--input-format')) throw new Error('get_usage failed');
      return composition;
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')],
      runProcess: run, logger: { warn }, dryRun: () => false,
    });

    const answer = await checker.refresh();

    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'check-failed', source: 'check' });
    expect(answer.accounts[0]!.warnings).toEqual(['Claude Code did not report plan limits.']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('wait mode checks stale rows only', async () => {
    const now = Date.parse('2026-09-22T14:20:00Z');
    const store = new AgentQuotaStore({ now: () => now });
    await store.put(normalizeClaudeUsage(
      { result: 'Current session: 25% used · resets Sep 22 at 5:10pm (Europe/Warsaw)' },
      'default', new Date(now),
    ));
    const run = vi.fn();
    const checker = new AgentQuotaChecker({
      store, now: () => now, profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refreshStale({}, true);

    expect(run).not.toHaveBeenCalled();
    expect(answer.accounts[0]).toMatchObject({ stale: false, refreshing: false });
  });

  it('starts the minute scheduler only while someone is looking', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T14:20:00Z'));
    const store = new AgentQuotaStore({ now: Date.now });
    const put = vi.spyOn(store, 'put');
    const run: RunQuotaProcess = async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    const checker = new AgentQuotaChecker({
      store, now: Date.now, profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(put).not.toHaveBeenCalled();
    const stopLooking = checker.viewerStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(put).toHaveBeenCalledTimes(2);
    stopLooking();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(put).toHaveBeenCalledTimes(2);
    checker.close();
  });

  it('returns a still-stale row when a waited check exceeds twenty seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T14:20:00Z'));
    const now = Date.now();
    const store = new AgentQuotaStore({ now: Date.now });
    await store.put(normalizeClaudeUsage(
      { result: 'Current session: 25% used · resets Sep 22 at 5:10pm (Europe/Warsaw)' },
      'default', new Date(now - 16 * 60_000),
    ));
    let releaseVersion!: () => void;
    const versionBlocked = new Promise<void>((resolve) => { releaseVersion = resolve; });
    const run: RunQuotaProcess = vi.fn(async (spec) => {
      if (spec.args[0] === '--version') {
        await versionBlocked;
        return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      }
      throw new Error('stop after the bounded caller has returned');
    });
    const checker = new AgentQuotaChecker({
      store, now: Date.now, profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const pending = checker.refreshStale({}, true);
    await vi.advanceTimersByTimeAsync(AGENT_QUOTA_WAIT_MS);
    const answer = await pending;

    expect(answer.accounts[0]).toMatchObject({ stale: true, refreshing: true });
    releaseVersion();
    await vi.advanceTimersByTimeAsync(0);
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

  // #867 AC-27: dry run starts no process on any path and answers with the frozen sample's rows.
  it('dry-run starts no process and returns the frozen sample rows', async () => {
    const run = vi.fn();
    const store = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
    const put = vi.spyOn(store, 'put');
    const checker = new AgentQuotaChecker({
      store, now: () => Date.parse('2026-09-22T14:24:00Z'), profiles: async () => [profile('claude'), profile('codex')],
      runProcess: run, dryRun: () => true,
    });
    checker.startup();
    const answers = [await checker.refresh(), await checker.refreshStale({}, true), await checker.answer()];
    checker.viewerStarted()();
    checker.noteRead();
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    for (const answer of answers) {
      expect(answer.accounts.map((row) => `${row.runner}:${row.accountId}:${row.status}`)).toEqual([
        'claude:default:ok', 'claude:work:unknown', 'codex:default:ok', 'claude:quota-exhausted:out', 'codex:api-key:unknown',
      ]);
    }
    expect((await checker.answer({ provider: 'codex', accountId: 'api-key' })).accounts).toHaveLength(1);
    expect((await checker.answer({ accountId: 'no-such-login' })).accounts).toEqual([]);
    checker.close();
    const later = new AgentQuotaChecker({
      store, now: () => Date.parse('2026-10-30T09:00:00.500Z'), profiles: async () => [], runProcess: run, dryRun: () => true,
    });
    expect(await later.answer()).toEqual(answers[2]);
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

  it('kills the saved process group as soon as a matching reply arrives', async () => {
    const reply = await runQuotaProcess({
      executable: process.execPath,
      args: ['-e', [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "console.log(JSON.stringify({ type: 'reply', parentPid: process.pid, childPid: child.pid }));",
        'setInterval(() => {}, 1000);',
      ].join(' ')],
      cwd: tmpdir(),
      env: process.env,
      waitFor: (message) => (message as { type?: string }).type === 'reply' ? message : undefined,
      deadline: Date.now() + 5_000,
    }) as { parentPid: number; childPid: number };
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };

    await expect.poll(() => [alive(reply.parentPid), alive(reply.childPid)]).toEqual([false, false]);
  });

  it('kills every saved group after the full Claude checker times out on the QA hang shape', async () => {
    const result = await runHungClaudeCheck(false);
    try {
      expect(result.pgids.length).toBeGreaterThan(0);
      expect(result.sigkillPgids).toEqual(expect.arrayContaining(result.pgids));
      await expect.poll(() => result.pgids.map(processGroupAlive)).toEqual(result.pgids.map(() => false));
    } finally {
      await result.cleanup();
    }
  });

  it('kills every saved group when a full-checker grandchild ignores SIGTERM', async () => {
    const result = await runHungClaudeCheck(true);
    try {
      expect(result.pgids.length).toBeGreaterThan(0);
      expect(result.sigkillPgids).toEqual(expect.arrayContaining(result.pgids));
      await expect.poll(() => result.pgids.map(processGroupAlive)).toEqual(result.pgids.map(() => false));
    } finally {
      await result.cleanup();
    }
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

describe('login kind (#867 AC-36)', () => {
  it('reads Claude Code auth status: claude.ai and setup-token logins are subscriptions, an API key is an API key', () => {
    // The shapes `claude auth status --json` printed on Claude Code 2.1.280 (identity keys dropped).
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'x@example.test' })).toBe('subscription');
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' })).toBe('subscription');
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('api-key');
  });

  it('never reads a Claude login it cannot place as a subscription', () => {
    expect(claudeLoginKind({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })).toBe('unknown');
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' })).toBe('unknown');
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'vertex' })).toBe('unknown');
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'claude.ai' })).toBe('unknown');
    expect(claudeLoginKind({ loggedIn: true, authMethod: 'future_method', apiProvider: 'firstParty' })).toBe('unknown');
    expect(claudeLoginKind({ subscriptionType: 'max' })).toBe('unknown');
    expect(claudeLoginKind(undefined)).toBe('unknown');
  });

  it('reads Codex account/read: ChatGPT is a subscription, an API key is an API key, anything else is unknown', () => {
    expect(codexLoginKind({ account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true })).toBe('subscription');
    expect(codexLoginKind({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toBe('api-key');
    expect(codexLoginKind({ account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false })).toBe('unknown');
    expect(codexLoginKind({ account: null, requiresOpenaiAuth: true })).toBe('unknown');
  });

  it('keeps a Claude login unknown when auth status fails, even though its quota reply names a plan', async () => {
    const capture = JSON.parse(await readFile(
      new URL('../__fixtures__/agent-quota/claude-get-usage-control-response.json', import.meta.url),
      'utf8',
    )) as { response: { request_id: string } };
    capture.response.request_id = 'xezar-agent-quota';
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args[0] === 'auth') throw new Error("error: unknown command 'auth'");
      return capture;
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:00:00Z') }),
      now: () => Date.parse('2026-09-22T14:00:00Z'),
      profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });

    const answer = await checker.refresh();

    // The reply carries `subscription_type: "max"` and real windows; neither decides the kind.
    expect(answer.accounts[0]).toMatchObject({ status: 'ok', planType: 'max', loginKind: 'unknown' });
  });

  it('keeps the login kind read before a Claude quota check that then fails', async () => {
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args[0] === 'auth') return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
      throw new Error('check failed');
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'check-failed', loginKind: 'subscription' });
  });

  it('never words a subscription login as an API key when get_usage reports no rate limits (#908 B-1)', async () => {
    // The mismatched pair: auth status says a claude.ai login, get_usage says no rate limits.
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `${MINIMUM_CLAUDE_QUOTA_VERSION} (Claude Code)`;
      if (spec.args[0] === 'auth') return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
      return { type: 'control_response', response: { response: { rate_limits_available: false } } };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude')], runProcess: run, dryRun: () => false,
    });
    const row = (await checker.refresh()).accounts[0]!;
    // `statusReason: api-key` still says "the tool reported no plan limits"; the words follow the kind.
    expect(row).toMatchObject({
      status: 'unknown',
      loginKind: 'subscription',
      unavailableReason: 'Claude Code reported no plan limits for this login.',
      warnings: ['Claude Code reported no plan limits for this login.'],
    });
    expect([row.unavailableReason, ...(row.warnings ?? [])].join(' ')).not.toMatch(/API.key/i);
  });

  it('keeps a Codex login kind read by account/read when a later step of the check fails', async () => {
    const run: RunQuotaProcess = async (spec) => {
      if (spec.args[0] === '--version') return `codex-cli ${MINIMUM_CODEX_QUOTA_VERSION}`;
      return {
        initialize: {},
        account: { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
        limits: { ordinaryUsageAllowed: true, rateLimits: null },
        usage: { summary: { lifetimeTokens: 1, peakDailyTokens: 1 }, dailyUsageBuckets: [], threadUsage: null },
      };
    };
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('codex')], runProcess: run, dryRun: () => false,
    });
    const answer = await checker.refresh();
    expect(answer.accounts[0]).toMatchObject({ status: 'unknown', statusReason: 'check-failed', loginKind: 'subscription' });
  });

  it('reports every login as unknown kind before its first check', async () => {
    const checker = new AgentQuotaChecker({
      store: new AgentQuotaStore(), profiles: async () => [profile('claude'), profile('codex')], dryRun: () => false,
    });
    const answer = await checker.answer();
    expect(answer.accounts.map((row) => row.loginKind)).toEqual(['unknown', 'unknown']);
  });
});
