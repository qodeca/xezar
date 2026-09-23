import { readFileSync } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentProfile } from './agent-profiles.ts';
import { AgentQuotaStore, normalizeClaudeUsage, normalizeLiveQuota } from './agent-quota.ts';
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
    const checker = new AgentQuotaChecker({
      store, now: Date.now, profiles: async () => [profile('claude')], dryRun: () => true,
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
