import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  agentQuotaProducerAccountSchema,
  agentQuotaProducerResponseSchema,
  type AgentQuotaProducerAccount,
  type AgentQuotaProducerResponse,
  type AgentQuotaRunner,
} from '@qodeca/xezar-contract';
import { buildChildEnv } from '../core/agent-env.ts';
import { profileEnv } from '../core/agent-profiles.ts';
import { defaultAgentAccountStore, loadAgentAccounts } from './agent-accounts.ts';
import { listAgentProfiles, type ResolvedAgentProfile } from './agent-profiles.ts';
import {
  AgentQuotaStore,
  isoUtc,
  MINIMUM_CLAUDE_QUOTA_VERSION,
  MINIMUM_CODEX_QUOTA_VERSION,
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  type AgentQuotaSelector,
} from './agent-quota.ts';
import { dryRunQuotaAnswer } from './agent-quota-sample.ts';

type QuotaProfile = Omit<ResolvedAgentProfile, 'provider'> & { provider: AgentQuotaRunner };

export { MINIMUM_CLAUDE_QUOTA_VERSION, MINIMUM_CODEX_QUOTA_VERSION };
export const AGENT_QUOTA_CHECK_GAP_MS = 5 * 60_000;
export const AGENT_QUOTA_STALE_MS = 15 * 60_000;
export const AGENT_QUOTA_CHECK_TIMEOUT_MS = 20_000;
export const AGENT_QUOTA_WAIT_MS = 20_000;
const MAX_CONCURRENT_CHECKS = 2;
const MAX_OUTPUT_BYTES = 1_000_000;
const PROCESS_CLOSE_GRACE_MS = 1_000;

const claudeTextReplySchema = z.object({
  type: z.literal('result').optional(),
  is_error: z.boolean().optional(),
  local_command: z.literal('usage').optional(),
  result: z.string(),
});

const claudeLimitSchema = z.object({
  kind: z.enum(['session', 'weekly_all', 'weekly_scoped']),
  percent: z.number().min(0).max(100),
  resets_at: z.string().datetime({ offset: true }),
  // The live reply sends `scope: null` for the session and all-models entries (#906).
  scope: z.object({ model: z.object({ display_name: z.string().min(1) }).nullish() }).nullish(),
});

const claudeRateLimitSchema = z.object({
  utilization: z.number().min(0).max(100),
  resets_at: z.string().datetime({ offset: true }),
});

const claudeUsageSchema = z.object({
  subscription_type: z.string().min(1).optional(),
  rate_limits_available: z.boolean().optional(),
  limits: z.array(claudeLimitSchema).optional(),
  rate_limits: z.object({
    five_hour: claudeRateLimitSchema.optional(),
    seven_day: claudeRateLimitSchema.optional(),
    seven_day_opus: claudeRateLimitSchema.nullable().optional(),
    seven_day_sonnet: claudeRateLimitSchema.nullable().optional(),
    // Claude Code 2.1.280 nests the typed limit list here, beside the fixed windows (#906).
    limits: z.array(claudeLimitSchema).optional(),
  }).optional(),
}).refine((value) => value.limits !== undefined || value.rate_limits !== undefined || value.rate_limits_available === false, {
  message: 'Claude usage reply carries no rate-limit fields',
});

const codexAccountSchema = z.object({
  account: z.discriminatedUnion('type', [
    z.object({ type: z.literal('chatgpt'), planType: z.string().nullable().optional(), email: z.string().optional() }),
    z.object({ type: z.literal('apiKey') }),
    z.object({ type: z.literal('amazonBedrock') }),
  ]).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const codexInitializeSchema = z.object({
  userAgent: z.string().optional(),
  codexHome: z.string().optional(),
});

const codexWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().int().positive(),
  resetsAt: z.number(),
});
const codexCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.union([z.string(), z.number()]),
});
const codexSnapshotSchema = z.object({
  primary: codexWindowSchema.nullable(),
  secondary: codexWindowSchema.nullable(),
  credits: codexCreditsSchema.optional(),
  planType: z.string().nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
});
const codexRateLimitsSchema = z.object({
  ordinaryUsageAllowed: z.boolean(),
  rateLimits: codexSnapshotSchema.nullable(),
  accountId: z.string().optional(),
});
const codexUsageSchema = z.object({
  summary: z.object({
    lifetimeTokens: z.number(),
    peakDailyTokens: z.number(),
    longestRunningTurnSec: z.number().optional(),
    currentStreakDays: z.number().optional(),
    longestStreakDays: z.number().optional(),
  }),
  dailyUsageBuckets: z.array(z.object({ startDate: z.string(), tokens: z.number() })),
  threadUsage: z.unknown().nullable().optional(),
});

export interface AgentQuotaProcessSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: readonly unknown[];
  nextInput?: (message: unknown) => readonly unknown[];
  waitFor?: (message: unknown) => unknown | undefined;
  deadline: number;
}

export type RunQuotaProcess = (spec: AgentQuotaProcessSpec) => Promise<unknown>;

/** A reply that is well-formed but carries no plan limits: the check failed, the format did not change. */
class QuotaNotReportedError extends Error {}

/**
 * The heading of the usage-composition report Claude Code prints for `/usage` when it shows no
 * limit rows (the #893 capture, Claude Code 2.1.280). It is a known reply with nothing to read.
 */
const CLAUDE_USAGE_COMPOSITION = /^What[’']s contributing to your limits usage\?$/m;

function processFailure(message: string, code?: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  if (code) error.code = code;
  return error;
}

function signalSavedProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The group may already have closed between the reply and the signal. Falling back to the
    // saved child handle is safe and keeps a timer callback from becoming an uncaught exception.
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Fixed-argv child runner. It never invokes a shell and signals only the saved process group. */
export const runQuotaProcess: RunQuotaProcess = (spec) => new Promise((resolve, reject) => {
  const remaining = Math.max(1, spec.deadline - Date.now());
  let child: ChildProcessWithoutNullStreams;
  try {
    child = nodeSpawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: true,
    });
  } catch (error) {
    reject(error);
    return;
  }
  let settled = false;
  let stopping = false;
  let stopError: Error | undefined;
  let stopValue: unknown;
  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  let killTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  const finish = (error?: Error, value?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (error) reject(error);
    else resolve(value);
  };
  const finishAfterKill = (error?: Error, value?: unknown) => {
    // `close` only proves that the group leader and its inherited stdio are gone. A grandchild
    // may still occupy the saved process group, so every completion path escalates before it can
    // clear the timer that would otherwise perform this kill (#892).
    signalSavedProcessGroup(child, 'SIGKILL');
    finish(error, value);
  };
  const stop = (error?: Error, value?: unknown) => {
    if (stopping || settled) return;
    stopping = true;
    stopError = error;
    stopValue = value;
    child.stdin.end();
    signalSavedProcessGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => {
      signalSavedProcessGroup(child, 'SIGKILL');
      closeTimer = setTimeout(() => finishAfterKill(stopError, stopValue), PROCESS_CLOSE_GRACE_MS);
      closeTimer.unref?.();
    }, PROCESS_CLOSE_GRACE_MS);
    killTimer.unref?.();
  };
  const timer = setTimeout(() => {
    stop(processFailure('agent quota check timed out', 'ETIMEDOUT'));
  }, remaining);
  timer.unref?.();
  child.once('error', (error) => finishAfterKill(error));
  child.stdin.on('error', (error) => {
    if (!stopping) stop(error);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.length > MAX_OUTPUT_BYTES) {
      stop(processFailure('agent quota check output exceeded its limit'));
      return;
    }
    if (!spec.waitFor || stopping) return;
    lineBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = lineBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        for (const next of spec.nextInput?.(message) ?? []) child.stdin.write(`${JSON.stringify(next)}\n`);
        const found = spec.waitFor(message);
        if (found !== undefined) {
          stop(undefined, found);
          return;
        }
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
  });
  child.once('close', (code) => {
    if (settled) return;
    if (stopping) return finishAfterKill(stopError, stopValue);
    if (code !== 0) return finishAfterKill(processFailure(stderr.trim() || `${spec.executable} exited ${code ?? 'without a code'}`));
    if (spec.waitFor) return finishAfterKill(processFailure(`${spec.executable} exited before replying`));
    finishAfterKill(undefined, stdout.trim());
  });
  for (const message of spec.input ?? []) child.stdin.write(`${JSON.stringify(message)}\n`);
  if (!spec.waitFor) child.stdin.end();
});

function versionNumber(raw: string): string | null {
  return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

function minimumFor(provider: AgentQuotaRunner): string {
  return provider === 'claude' ? MINIMUM_CLAUDE_QUOTA_VERSION : MINIMUM_CODEX_QUOTA_VERSION;
}

function executableFor(provider: AgentQuotaRunner): string {
  return provider === 'claude' ? (process.env.XEZ_CLAUDE_BIN ?? 'claude') : (process.env.XEZ_CODEX_BIN ?? 'codex');
}

function profileProcessEnv(profile: QuotaProfile): NodeJS.ProcessEnv {
  return buildChildEnv({
    backend: profile.provider,
    extraEnv: profileEnv(profile.provider, profile.isDefault ? undefined : profile.path),
  });
}

function unknownRecord(
  profile: QuotaProfile,
  checkedAt: Date,
  reason: 'check-failed' | 'format-changed' | 'version-too-old' | 'not-installed' | 'api-key',
  toolVersion: string | null,
  warning: string,
): AgentQuotaProducerAccount {
  return agentQuotaProducerAccountSchema.parse({
    runner: profile.provider,
    accountId: profile.id,
    status: 'unknown',
    checkedAt: isoUtc(checkedAt),
    ageSeconds: 0,
    source: 'check',
    shortWindow: null,
    weeklyWindow: null,
    modelWindows: null,
    credits: null,
    planType: null,
    notReported: ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'],
    stale: false,
    refreshing: false,
    nextCheckAt: isoUtc(checkedAt.getTime() + AGENT_QUOTA_CHECK_GAP_MS),
    toolVersion,
    minimumVersion: minimumFor(profile.provider),
    statusReason: reason,
    warnings: [warning],
    unavailableReason: warning,
  });
}

function usageObject(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.limits !== undefined || row.rate_limits !== undefined || row.rate_limits_available === false) return row;
  for (const key of ['response', 'result', 'data']) {
    const found = usageObject(row[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function normalizeClaudeControl(raw: unknown, profile: QuotaProfile, checkedAt: Date): AgentQuotaProducerAccount {
  const usage = claudeUsageSchema.parse(usageObject(raw));
  if (usage.rate_limits_available === false) {
    return unknownRecord(profile, checkedAt, 'api-key', null, 'API-key logins do not report plan limits.');
  }
  const lines: string[] = [];
  const add = (label: string, percent: number, reset: string) => {
    const date = new Date(reset);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone,
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
    const text = `${part('month')} ${part('day')} at ${part('hour')}:${part('minute')}${part('dayPeriod').toLowerCase()} (${timeZone})`;
    lines.push(`Current ${label}: ${percent}% used · resets ${text}`);
  };
  const limits = usage.limits ?? usage.rate_limits?.limits;
  // An empty list reports nothing, so the fixed windows below are read instead.
  if (limits?.length) {
    for (const limit of limits) {
      const label = limit.kind === 'session' ? 'session'
        : limit.kind === 'weekly_all' ? 'week (all models)'
        : `week (${limit.scope?.model?.display_name ?? 'model'})`;
      add(label, limit.percent, limit.resets_at);
    }
  } else {
    const fixed = usage.rate_limits;
    if (fixed?.five_hour) add('session', fixed.five_hour.utilization, fixed.five_hour.resets_at);
    if (fixed?.seven_day) add('week (all models)', fixed.seven_day.utilization, fixed.seven_day.resets_at);
    if (fixed?.seven_day_opus) add('week (Opus)', fixed.seven_day_opus.utilization, fixed.seven_day_opus.resets_at);
    if (fixed?.seven_day_sonnet) add('week (Sonnet)', fixed.seven_day_sonnet.utilization, fixed.seven_day_sonnet.resets_at);
  }
  const record = normalizeClaudeUsage({ result: lines.join('\n') }, profile.id, checkedAt);
  return agentQuotaProducerAccountSchema.parse({
    ...record,
    planType: usage.subscription_type ?? null,
    notReported: usage.subscription_type
      ? record.notReported.filter((field) => field !== 'planType')
      : record.notReported,
  });
}

async function runClaudeCheck(
  profile: QuotaProfile,
  checkedAt: Date,
  deadline: number,
  run: RunQuotaProcess,
): Promise<AgentQuotaProducerAccount> {
  const cwd = await mkdtemp(join(tmpdir(), 'xez-agent-quota-'));
  const env = profileProcessEnv(profile);
  const executable = executableFor('claude');
  try {
    try {
      const requestId = 'xezar-agent-quota';
      const raw = await run({
        executable,
        args: ['-p', '--safe-mode', '--strict-mcp-config', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        cwd,
        env,
        input: [{ type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } }],
        waitFor: (message) => {
          const row = message as { type?: unknown; response?: { request_id?: unknown } };
          return row.type === 'control_response' && row.response?.request_id === requestId
            ? message
            : undefined;
        },
        deadline: Math.min(deadline, Date.now() + 8_000),
      });
      return normalizeClaudeControl(raw, profile, checkedAt);
    } catch {
      const rawText = await run({
        executable,
        args: ['-p', '/usage', '--safe-mode', '--strict-mcp-config', '--output-format', 'json'],
        cwd,
        env,
        deadline,
      });
      const raw = claudeTextReplySchema.parse(JSON.parse(String(rawText)));
      const record = normalizeClaudeUsage(raw, profile.id, checkedAt);
      if (record.shortWindow === null && record.weeklyWindow === null && record.modelWindows === null) {
        if (CLAUDE_USAGE_COMPOSITION.test(raw.result)) throw new QuotaNotReportedError('Claude Code did not report plan limits.');
        throw new SyntaxError('Claude /usage reply carried no recognised quota rows');
      }
      return agentQuotaProducerAccountSchema.parse({
        ...record,
        source: 'check-text',
        warnings: ['Quota was read from the Claude Code /usage text fallback.'],
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function runCodexRpc(
  profile: QuotaProfile,
  deadline: number,
  run: RunQuotaProcess,
): Promise<{ initialize: unknown; account: unknown; limits?: unknown; usage?: unknown }> {
  const cwd = await mkdtemp(join(tmpdir(), 'xez-agent-quota-'));
  try {
    const replies = new Map<number, unknown>();
    const raw = await run({
      executable: executableFor('codex'),
      args: ['-s', 'read-only', '-a', 'never', 'app-server'],
      cwd,
      env: profileProcessEnv(profile),
      input: [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'xezar', title: 'xezar', version: '0.1.0' }, capabilities: { experimentalApi: true } } }],
      nextInput: (message) => {
        const id = (message as { id?: unknown }).id;
        if (id === 1) return [
          { method: 'initialized', params: {} },
          { id: 2, method: 'account/read', params: { refreshToken: false } },
        ];
        if (id === 2) {
          const account = codexAccountSchema.safeParse((message as { result?: unknown }).result);
          if (account.success && account.data.account?.type === 'apiKey') return [];
          return [{ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }];
        }
        if (id === 3) return [{ id: 4, method: 'account/usage/read', params: {} }];
        return [];
      },
      waitFor: (message) => {
        const row = message as { id?: unknown; result?: unknown; error?: unknown };
        if (typeof row.id === 'number') {
          if (row.error !== undefined) throw processFailure(`codex app-server request ${row.id} failed`);
          replies.set(row.id, row.result);
        }
        if (replies.has(1) && replies.has(2)) {
          const account = codexAccountSchema.safeParse(replies.get(2));
          if (account.success && account.data.account?.type === 'apiKey') {
            return { initialize: replies.get(1), account: replies.get(2) };
          }
        }
        return replies.has(1) && replies.has(2) && replies.has(3) && replies.has(4)
          ? { initialize: replies.get(1), account: replies.get(2), limits: replies.get(3), usage: replies.get(4) }
          : undefined;
      },
      deadline,
    });
    return raw as { initialize: unknown; account: unknown; limits?: unknown; usage?: unknown };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function runCodexCheck(
  profile: QuotaProfile,
  checkedAt: Date,
  deadline: number,
  run: RunQuotaProcess,
): Promise<AgentQuotaProducerAccount> {
  const raw = await runCodexRpc(profile, deadline, run);
  codexInitializeSchema.parse(raw.initialize);
  const account = codexAccountSchema.parse(raw.account);
  if (account.account?.type === 'apiKey') {
    return unknownRecord(profile, checkedAt, 'api-key', null, 'API-key logins do not report plan limits.');
  }
  const limits = codexRateLimitsSchema.parse(raw.limits);
  codexUsageSchema.parse(raw.usage);
  if (limits.rateLimits === null) throw new Error('Codex did not report a rate-limit snapshot');
  return normalizeCodexRateLimits({ result: limits }, profile.id, checkedAt);
}

export interface AgentQuotaCheckerOptions {
  store: AgentQuotaStore;
  now?: () => number;
  runProcess?: RunQuotaProcess;
  profiles?: () => Promise<ResolvedAgentProfile[]>;
  logger?: Pick<Console, 'warn'>;
  dryRun?: () => boolean;
}

/** Workspace-wide bounded scheduler for zero-token provider quota checks. */
export class AgentQuotaChecker {
  private readonly now: () => number;
  private readonly runProcess: RunQuotaProcess;
  private readonly profiles: () => Promise<ResolvedAgentProfile[]>;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly dryRun: () => boolean;
  private readonly lastAttempt = new Map<string, number>();
  private readonly versions = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly loggedFormats = new Set<string>();
  private readonly slotWaiters: Array<() => void> = [];
  private active = 0;
  private viewers = 0;
  private lastReadAt = 0;
  private scheduler?: NodeJS.Timeout;

  constructor(private readonly options: AgentQuotaCheckerOptions) {
    this.now = options.now ?? Date.now;
    this.runProcess = options.runProcess ?? runQuotaProcess;
    this.profiles = options.profiles ?? (async () => listAgentProfiles(
      await loadAgentAccounts().catch(() => defaultAgentAccountStore()),
      ['claude', 'codex'],
    ));
    this.logger = options.logger ?? console;
    this.dryRun = options.dryRun ?? (() => process.env.XEZ_DRY_RUN === '1');
  }

  private key(profile: Pick<ResolvedAgentProfile, 'provider' | 'id'>): string {
    return `${profile.provider}:${profile.id}`;
  }

  async knownProfiles(selector: AgentQuotaSelector = {}): Promise<QuotaProfile[]> {
    return (await this.profiles())
      .filter((profile): profile is QuotaProfile => profile.provider === 'claude' || profile.provider === 'codex')
      .filter((profile) => selector.provider === undefined || profile.provider === selector.provider)
      .filter((profile) => selector.accountId === undefined || profile.id === selector.accountId);
  }

  async answer(selector: AgentQuotaSelector = {}): Promise<AgentQuotaProducerResponse> {
    // #867 AC-4 / AC-27: dry run answers with the approved sample and never checks.
    if (this.dryRun()) return dryRunQuotaAnswer(selector);
    const profiles = await this.knownProfiles();
    const base = this.options.store.answer(selector, profiles.map((profile) => ({ runner: profile.provider, accountId: profile.id })));
    const now = this.now();
    return agentQuotaProducerResponseSchema.parse({
      ...base,
      accounts: base.accounts.map((account) => {
        const key = `${account.runner}:${account.accountId}`;
        const attempted = this.lastAttempt.get(key);
        return {
          ...account,
          stale: account.source === 'none' || now - Date.parse(account.checkedAt) >= AGENT_QUOTA_STALE_MS,
          refreshing: this.inFlight.has(key),
          nextCheckAt: attempted === undefined ? null : isoUtc(attempted + AGENT_QUOTA_CHECK_GAP_MS),
          toolVersion: this.versions.get(key) ?? account.toolVersion ?? null,
          minimumVersion: minimumFor(account.runner),
          statusReason: account.statusReason ?? null,
          warnings: account.warnings ?? [],
          unavailableReason: account.unavailableReason ?? (account.source === 'none' ? 'Quota has not been checked yet.' : null),
        };
      }),
    });
  }

  async refresh(selector: AgentQuotaSelector = {}, wait = true): Promise<AgentQuotaProducerResponse> {
    const profiles = await this.knownProfiles(selector);
    return this.runChecks(selector, profiles, wait);
  }

  async refreshStale(selector: AgentQuotaSelector = {}, wait = true): Promise<AgentQuotaProducerResponse> {
    const current = await this.answer(selector);
    const stale = new Set(current.accounts.filter((row) => row.stale).map((row) => `${row.runner}:${row.accountId}`));
    const profiles = (await this.knownProfiles(selector)).filter((profile) => stale.has(this.key(profile)));
    return this.runChecks(selector, profiles, wait);
  }

  private async runChecks(
    selector: AgentQuotaSelector,
    profiles: QuotaProfile[],
    wait: boolean,
  ): Promise<AgentQuotaProducerResponse> {
    const checks = profiles.map((profile) => this.schedule(profile));
    if (wait && checks.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(checks),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, AGENT_QUOTA_WAIT_MS);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return this.answer(selector);
  }

  noteRead(): void {
    this.lastReadAt = this.now();
    this.ensureScheduler();
    void this.refreshStaleInBackground();
  }

  viewerStarted(): () => void {
    this.viewers += 1;
    this.ensureScheduler();
    void this.refreshStaleInBackground();
    return () => {
      this.viewers = Math.max(0, this.viewers - 1);
      this.stopSchedulerWhenIdle();
    };
  }

  startup(): void {
    void this.knownProfiles().then((profiles) => {
      for (const profile of profiles) void this.schedule(profile);
    }).catch(() => undefined);
  }

  close(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  private looking(): boolean {
    return this.viewers > 0 || this.now() - this.lastReadAt < AGENT_QUOTA_STALE_MS;
  }

  private ensureScheduler(): void {
    if (this.scheduler || !this.looking()) return;
    this.scheduler = setInterval(() => {
      if (!this.looking()) return this.stopSchedulerWhenIdle();
      void this.refreshStaleInBackground();
    }, 60_000);
    this.scheduler.unref?.();
  }

  private stopSchedulerWhenIdle(): void {
    if (this.looking() || !this.scheduler) return;
    clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  private async refreshStaleInBackground(): Promise<void> {
    if (!this.looking()) return;
    const answer = await this.answer();
    const stale = new Set(answer.accounts.filter((row) => row.stale).map((row) => `${row.runner}:${row.accountId}`));
    for (const profile of await this.knownProfiles()) {
      if (stale.has(this.key(profile))) void this.schedule(profile);
    }
  }

  private schedule(profile: QuotaProfile): Promise<void> {
    if (this.dryRun()) return Promise.resolve();
    const key = this.key(profile);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const now = this.now();
    if (now - (this.lastAttempt.get(key) ?? -Infinity) < AGENT_QUOTA_CHECK_GAP_MS) return Promise.resolve();
    this.lastAttempt.set(key, now);
    const promise = this.withSlot(() => this.check(profile)).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async withSlot(work: () => Promise<void>): Promise<void> {
    while (this.active >= MAX_CONCURRENT_CHECKS) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    this.active += 1;
    try {
      await work();
    } finally {
      this.active -= 1;
      this.slotWaiters.shift()?.();
    }
  }

  private async check(profile: QuotaProfile): Promise<void> {
    const checkedAt = new Date(this.now());
    const deadline = Date.now() + AGENT_QUOTA_CHECK_TIMEOUT_MS;
    const previous = this.options.store.answer({ provider: profile.provider, accountId: profile.id }).accounts[0];
    let toolVersion: string | null = null;
    try {
      const rawVersion = String(await this.runProcess({
        executable: executableFor(profile.provider),
        args: ['--version'],
        cwd: tmpdir(),
        env: profileProcessEnv(profile),
        deadline,
      }));
      toolVersion = versionNumber(rawVersion);
      if (!toolVersion) throw new Error('tool version could not be read');
      this.versions.set(this.key(profile), toolVersion);
      if (!versionAtLeast(toolVersion, minimumFor(profile.provider))) {
        await this.options.store.put(unknownRecord(
          profile,
          checkedAt,
          'version-too-old',
          toolVersion,
          `Update ${profile.provider === 'claude' ? 'Claude Code' : 'Codex'} to at least ${minimumFor(profile.provider)} to report limits.`,
        ));
        return;
      }
      const record = profile.provider === 'claude'
        ? await runClaudeCheck(profile, checkedAt, deadline, this.runProcess)
        : await runCodexCheck(profile, checkedAt, deadline, this.runProcess);
      await this.options.store.put(agentQuotaProducerAccountSchema.parse({
        ...record,
        stale: false,
        refreshing: false,
        nextCheckAt: isoUtc(checkedAt.getTime() + AGENT_QUOTA_CHECK_GAP_MS),
        toolVersion,
        minimumVersion: minimumFor(profile.provider),
        statusReason: record.statusReason ?? null,
        warnings: record.warnings ?? [],
        unavailableReason: record.status === 'unknown'
          ? (record.unavailableReason ?? 'The agent did not report quota limits.')
          : null,
      }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const missing = code === 'ENOENT';
      const format = error instanceof z.ZodError || error instanceof SyntaxError;
      const reason = missing ? 'not-installed' : format ? 'format-changed' : 'check-failed';
      const label = profile.provider === 'claude' ? 'Claude Code' : 'Codex';
      const warning = missing
        ? `${label} is not installed.`
        : format
          ? `${label}${toolVersion ? ` ${toolVersion}` : ''} changed its quota format.`
          : error instanceof QuotaNotReportedError
            ? error.message
            : `${label} quota check failed.`;
      if (format) {
        const logKey = `${this.key(profile)}:${toolVersion ?? 'unknown'}`;
        if (!this.loggedFormats.has(logKey)) {
          this.loggedFormats.add(logKey);
          this.logger.warn(`[xez] ${warning}`);
        }
      }
      if (profile.provider === 'claude' && !missing && previous?.source === 'live') {
        await this.options.store.put(agentQuotaProducerAccountSchema.parse({
          ...previous,
          stale: true,
          refreshing: false,
          nextCheckAt: isoUtc(checkedAt.getTime() + AGENT_QUOTA_CHECK_GAP_MS),
          toolVersion,
          minimumVersion: MINIMUM_CLAUDE_QUOTA_VERSION,
          statusReason: null,
          warnings: [...(previous.warnings ?? []), `${warning} Showing live task data.`],
          unavailableReason: null,
        }));
        return;
      }
      await this.options.store.put(unknownRecord(profile, checkedAt, reason, toolVersion, warning));
    }
  }
}
