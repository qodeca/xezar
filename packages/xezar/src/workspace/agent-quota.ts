import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  agentQuotaProducerAccountSchema,
  agentQuotaProducerResponseSchema,
  type AgentQuotaProducerAccount,
  type AgentQuotaProducerResponse,
  type AgentQuotaRunner,
  type AgentQuotaWindow,
} from '@qodeca/xezar-contract';
import { activeStateLayout } from '../state-layout.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import { atomicTmpPath } from './config.ts';

interface PersistedQuota {
  records: AgentQuotaProducerAccount[];
}

function isoUtc(value: Date | number): string {
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

export interface AgentQuotaSelector {
  provider?: AgentQuotaRunner;
  accountId?: string;
}

export interface AgentQuotaStoreOptions {
  path?: string;
  now?: () => number;
  warn?: (message: string) => void;
}

/** File-backed, process-coherent quota observations keyed by runner and account id. */
export class AgentQuotaStore {
  readonly path: string;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private warnedCorrupt = false;
  private records = new Map<string, AgentQuotaProducerAccount>();
  private loaded = false;
  private listeners = new Set<(answer: AgentQuotaProducerResponse) => void>();

  constructor(options: AgentQuotaStoreOptions = {}) {
    this.path = options.path ?? activeStateLayout().agentQuotaPath;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  private key(runner: AgentQuotaRunner, accountId: string): string {
    return `${runner}:${accountId}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.warnCorrupt(error);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedQuota;
      if (!parsed || !Array.isArray(parsed.records)) throw new Error('records must be an array');
      for (const value of parsed.records) {
        const record = agentQuotaProducerAccountSchema.parse(value);
        this.records.set(this.key(record.runner, record.accountId), record);
      }
    } catch (error) {
      this.records.clear();
      this.warnCorrupt(error);
    }
  }

  private warnCorrupt(error: unknown): void {
    if (this.warnedCorrupt) return;
    this.warnedCorrupt = true;
    this.warn(`agent quota state is unreadable; starting empty (${error instanceof Error ? error.message : String(error)})`);
  }

  async put(input: AgentQuotaProducerAccount): Promise<void> {
    await this.load();
    const record = agentQuotaProducerAccountSchema.parse(input);
    const key = this.key(record.runner, record.accountId);
    const previous = this.records.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(record)) return;
    this.records.set(key, record);
    await this.persist();
    const answer = this.answer();
    for (const listener of [...this.listeners]) listener(answer);
  }

  async markOut(runner: AgentQuotaRunner, accountId: string, resetsAt: Date, checkedAt = new Date(this.now())): Promise<void> {
    await this.put({
      runner,
      accountId,
      status: 'out',
      resetsAt: isoUtc(resetsAt),
      checkedAt: isoUtc(checkedAt),
      ageSeconds: 0,
      source: 'failedRun',
      shortWindow: null,
      weeklyWindow: null,
      modelWindows: null,
      credits: null,
      planType: null,
      notReported: ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'],
    });
  }

  answer(
    selector: AgentQuotaSelector = {},
    knownAccounts: readonly { runner: AgentQuotaRunner; accountId: string }[] = [],
  ): AgentQuotaProducerResponse {
    const now = this.now();
    const records = new Map(this.records);
    for (const known of knownAccounts) {
      const key = this.key(known.runner, known.accountId);
      if (records.has(key)) continue;
      records.set(key, agentQuotaProducerAccountSchema.parse({
        ...known,
        status: 'unknown',
        checkedAt: isoUtc(now),
        ageSeconds: 0,
        source: 'check',
        shortWindow: null,
        weeklyWindow: null,
        modelWindows: null,
        credits: null,
        planType: null,
        notReported: ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'],
      }));
    }
    const accounts = [...records.values()]
      .filter((record) => selector.provider === undefined || record.runner === selector.provider)
      .filter((record) => selector.accountId === undefined || record.accountId === selector.accountId)
      .map((record) => ({
        ...record,
        ageSeconds: Math.max(0, Math.floor((now - Date.parse(record.checkedAt)) / 1_000)),
      }));
    return agentQuotaProducerResponseSchema.parse({
      schemaVersion: 1,
      scope: 'agent-quota',
      generatedAt: isoUtc(now),
      accounts,
    });
  }

  subscribe(listener: (answer: AgentQuotaProducerResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = atomicTmpPath(this.path);
    await writeFile(tmp, `${JSON.stringify({ records: [...this.records.values()] }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}

function windowFromPercent(usedPercent: number, resetsAt: Date, windowMinutes: number): AgentQuotaWindow {
  return { usedPercent, resetsAt: isoUtc(resetsAt), windowMinutes };
}

function claudeReset(text: string, now: number): Date | null {
  return parseUsageLimit(`usage limit reached; ${text}`, now)?.resetAt ?? null;
}

/** Normalise the zero-token `claude -p "/usage" --output-format json` reply. */
export function normalizeClaudeUsage(
  raw: unknown,
  accountId: string,
  checkedAt: Date,
): AgentQuotaProducerAccount {
  const result = typeof raw === 'object' && raw !== null && typeof (raw as { result?: unknown }).result === 'string'
    ? (raw as { result: string }).result
    : '';
  const rows = [...result.matchAll(/^Current (session|week \(all models\)|week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)% used · (resets .+)$/gmi)];
  let shortWindow: AgentQuotaWindow | null = null;
  let weeklyWindow: AgentQuotaWindow | null = null;
  const modelWindows: Array<AgentQuotaWindow & { model: string }> = [];
  for (const row of rows) {
    const reset = claudeReset(row[4]!, checkedAt.getTime());
    if (!reset) continue;
    const usedPercent = Number(row[3]);
    if (row[1] === 'session') shortWindow = windowFromPercent(usedPercent, reset, 300);
    else if (row[1] === 'week (all models)') weeklyWindow = windowFromPercent(usedPercent, reset, 10080);
    else modelWindows.push({ model: row[2]!, ...windowFromPercent(usedPercent, reset, 10080) });
  }
  const windows = [shortWindow, weeklyWindow, ...modelWindows].filter((value) => value !== null);
  const exhausted = windows.find((window) => window.usedPercent >= 100);
  const unknown = windows.length === 0;
  return agentQuotaProducerAccountSchema.parse({
    runner: 'claude',
    accountId,
    status: unknown ? 'unknown' : exhausted ? 'out' : 'ok',
    ...(exhausted ? { resetsAt: exhausted.resetsAt } : {}),
    checkedAt: isoUtc(checkedAt),
    ageSeconds: 0,
    source: 'check',
    shortWindow,
    weeklyWindow,
    modelWindows: modelWindows.length ? modelWindows : null,
    credits: null,
    planType: null,
    notReported: [
      ...(shortWindow ? [] : ['shortWindow' as const]),
      ...(weeklyWindow ? [] : ['weeklyWindow' as const]),
      ...(modelWindows.length ? [] : ['modelWindows' as const]),
      'credits',
      'planType',
    ],
  });
}

type CodexWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };

function codexWindow(raw: unknown): AgentQuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as CodexWindow;
  if (typeof value.usedPercent !== 'number' || typeof value.windowDurationMins !== 'number' || typeof value.resetsAt !== 'number') return null;
  return windowFromPercent(value.usedPercent, new Date(value.resetsAt * 1_000), value.windowDurationMins);
}

/** Normalise the Codex app-server `account/rateLimits/read` result. */
export function normalizeCodexRateLimits(raw: unknown, accountId: string, checkedAt: Date): AgentQuotaProducerAccount {
  const envelope = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result = envelope.result && typeof envelope.result === 'object' ? envelope.result as Record<string, unknown> : envelope;
  const snapshot = result.rateLimits && typeof result.rateLimits === 'object' ? result.rateLimits as Record<string, unknown> : {};
  const candidates = [codexWindow(snapshot.primary), codexWindow(snapshot.secondary)].filter((value): value is AgentQuotaWindow => value !== null);
  const shortWindow = candidates.find((window) => window.windowMinutes <= 1_440) ?? null;
  const weeklyWindow = candidates.find((window) => window.windowMinutes === 10_080) ?? null;
  const creditsRaw = snapshot.credits && typeof snapshot.credits === 'object' ? snapshot.credits as Record<string, unknown> : null;
  const credits = creditsRaw && typeof creditsRaw.hasCredits === 'boolean' && typeof creditsRaw.unlimited === 'boolean'
    && (typeof creditsRaw.balance === 'string' || typeof creditsRaw.balance === 'number')
    ? { hasCredits: creditsRaw.hasCredits, unlimited: creditsRaw.unlimited, balance: String(creditsRaw.balance) }
    : null;
  const exhausted = result.ordinaryUsageAllowed === false
    ? candidates[0]
    : candidates.find((window) => window.usedPercent >= 100);
  const unknown = candidates.length === 0;
  return agentQuotaProducerAccountSchema.parse({
    runner: 'codex',
    accountId,
    status: exhausted ? 'out' : unknown ? 'unknown' : 'ok',
    ...(exhausted ? { resetsAt: exhausted.resetsAt } : {}),
    checkedAt: isoUtc(checkedAt),
    ageSeconds: 0,
    source: 'check',
    shortWindow,
    weeklyWindow,
    modelWindows: null,
    credits,
    planType: typeof snapshot.planType === 'string' && snapshot.planType ? snapshot.planType : null,
    notReported: [
      ...(shortWindow ? [] : ['shortWindow' as const]),
      ...(weeklyWindow ? [] : ['weeklyWindow' as const]),
      'modelWindows',
      ...(credits ? [] : ['credits' as const]),
      ...(typeof snapshot.planType === 'string' && snapshot.planType ? [] : ['planType' as const]),
    ],
  });
}

/** Translate a runner's live quota payload into a stored record when it carries usable facts. */
export function normalizeLiveQuota(
  runner: AgentQuotaRunner,
  raw: unknown,
  accountId: string,
  observedAt: Date,
): AgentQuotaProducerAccount | null {
  if (runner === 'codex') {
    const record = normalizeCodexRateLimits({ result: raw }, accountId, observedAt);
    return { ...record, source: 'live' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const info = ((raw as Record<string, unknown>).rate_limit_info ?? (raw as Record<string, unknown>).rateLimitInfo) as Record<string, unknown> | undefined;
  if (!info) return null;
  const utilization = typeof info.utilization === 'number' ? Math.min(100, Math.max(0, info.utilization * 100)) : null;
  const resetValue = info.resetsAt ?? info.resets_at;
  const reset = typeof resetValue === 'number' ? new Date(resetValue * 1_000) : null;
  if (utilization === null || !reset) return null;
  const out = info.status === 'rejected' || utilization >= 100;
  return agentQuotaProducerAccountSchema.parse({
    runner: 'claude', accountId, status: out ? 'out' : 'ok', ...(out ? { resetsAt: isoUtc(reset) } : {}),
    checkedAt: isoUtc(observedAt), ageSeconds: 0, source: 'live',
    shortWindow: windowFromPercent(utilization, reset, 300), weeklyWindow: null, modelWindows: null,
    credits: null, planType: null,
    notReported: ['weeklyWindow', 'modelWindows', 'credits', 'planType'],
  });
}
