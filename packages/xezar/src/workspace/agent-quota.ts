import {
  agentQuotaProducerAccountSchema,
  agentQuotaProducerResponseSchema,
  type AgentQuotaProducerAccount,
  type AgentQuotaProducerResponse,
  type AgentQuotaRunner,
  type AgentQuotaModelWindow,
  type AgentQuotaWindow,
} from '@qodeca/xezar-contract';
import { parseUsageLimit } from '../core/usage-limit.ts';
import { CODEX_DEFAULT_LIMIT_ID, isCodexModelBucket } from '../core/codex-usage-limit.ts';

function isoUtc(value: Date | number): string {
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

export interface AgentQuotaSelector {
  provider?: AgentQuotaRunner;
  accountId?: string;
}

export interface AgentQuotaStoreOptions {
  now?: () => number;
}

/** Process-lifetime quota observations keyed by runner and account id. */
export class AgentQuotaStore {
  private readonly now: () => number;
  private records = new Map<string, AgentQuotaProducerAccount>();
  private listeners = new Set<(answer: AgentQuotaProducerResponse) => void>();

  constructor(options: AgentQuotaStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private key(runner: AgentQuotaRunner, accountId: string): string {
    return `${runner}:${accountId}`;
  }

  async put(input: AgentQuotaProducerAccount): Promise<void> {
    let record = agentQuotaProducerAccountSchema.parse(input);
    const key = this.key(record.runner, record.accountId);
    const previous = this.records.get(key);
    if (previous && record.source === 'live') record = mergeLiveRecord(previous, record);
    if (previous && JSON.stringify(previous) === JSON.stringify(record)) return;
    this.records.set(key, record);
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
    const knownKeys: string[] = [];
    for (const known of knownAccounts) {
      const key = this.key(known.runner, known.accountId);
      knownKeys.push(key);
      if (records.has(key)) continue;
      records.set(key, agentQuotaProducerAccountSchema.parse({
        ...known,
        status: 'unknown',
        checkedAt: isoUtc(now),
        ageSeconds: 0,
        source: 'none',
        shortWindow: null,
        weeklyWindow: null,
        modelWindows: null,
        credits: null,
        planType: null,
        notReported: ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'],
        stale: true,
        refreshing: false,
        nextCheckAt: null,
        toolVersion: null,
        minimumVersion: known.runner === 'claude' ? '2.1.278' : '0.155.1',
        statusReason: null,
        warnings: [],
        unavailableReason: 'No quota check has completed yet.',
      }));
    }
    // When the caller supplies the current account registry it is authoritative:
    // observations for removed accounts disappear from the public answer.
    const orderedKeys = knownAccounts.length > 0 ? knownKeys : [...records.keys()];
    const accounts = orderedKeys
      .map((key) => records.get(key)!)
      .filter((record) => selector.provider === undefined || record.runner === selector.provider)
      .filter((record) => selector.accountId === undefined || record.accountId === selector.accountId)
      .map((record) => currentRecord(record, now));
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
}

function notReportedFor(record: Pick<AgentQuotaProducerAccount, 'shortWindow' | 'weeklyWindow' | 'modelWindows' | 'credits' | 'planType'>) {
  return [
    ...(record.shortWindow ? [] : ['shortWindow' as const]),
    ...(record.weeklyWindow ? [] : ['weeklyWindow' as const]),
    ...(record.modelWindows?.length ? [] : ['modelWindows' as const]),
    ...(record.credits ? [] : ['credits' as const]),
    ...(record.planType ? [] : ['planType' as const]),
  ];
}

/**
 * The windows that can make a row `ok`. A Codex model bucket describes one model only, so it never
 * says the login can work (#867 FR-5); a Claude per-model window keeps counting as it always has.
 */
function statusWindows(record: Pick<AgentQuotaProducerAccount, 'runner' | 'shortWindow' | 'weeklyWindow' | 'modelWindows'>) {
  return [record.shortWindow, record.weeklyWindow, ...(record.runner === 'claude' ? record.modelWindows ?? [] : [])]
    .filter((window) => window !== null);
}

function mergeModelWindows(previous: AgentQuotaModelWindow[] | null, incoming: AgentQuotaModelWindow[] | null) {
  if (!incoming?.length) return previous;
  const merged = new Map((previous ?? []).map((window) => [window.model, window]));
  for (const window of incoming) merged.set(window.model, window);
  return [...merged.values()];
}

function mergeLiveRecord(previous: AgentQuotaProducerAccount, incoming: AgentQuotaProducerAccount): AgentQuotaProducerAccount {
  const detail = {
    ...incoming,
    shortWindow: incoming.shortWindow ?? previous.shortWindow,
    weeklyWindow: incoming.weeklyWindow ?? previous.weeklyWindow,
    modelWindows: mergeModelWindows(previous.modelWindows, incoming.modelWindows),
    credits: incoming.credits ?? previous.credits,
    planType: incoming.planType ?? previous.planType,
  };
  const windows = [detail.shortWindow, detail.weeklyWindow, ...(detail.modelWindows ?? [])].filter(
    (window): window is AgentQuotaWindow | AgentQuotaModelWindow => window !== null,
  );
  // #867 FR-5: percentages are a blocking signal for Claude only. Codex
  // availability comes from its explicit ordinary-usage/rate-limit facts.
  const exhausted = detail.runner === 'claude'
    ? windows.find((window) => window.usedPercent >= 100)
    : undefined;
  // A newer live snapshot may omit a failed-run/check limit. Preserve that
  // observed fact until its reset instead of treating omission as recovery.
  const previousOut = previous.status === 'out'
    && Date.parse(previous.resetsAt) > Date.parse(incoming.checkedAt);
  const status = incoming.status === 'out' || previousOut || exhausted ? 'out' : statusWindows(detail).length ? 'ok' : 'unknown';
  const { resetsAt: _resetsAt, ...withoutReset } = detail;
  return agentQuotaProducerAccountSchema.parse({
    ...withoutReset,
    status,
    ...(status === 'out'
      ? { resetsAt: incoming.status === 'out' ? incoming.resetsAt : previousOut ? previous.resetsAt : exhausted!.resetsAt }
      : {}),
    notReported: notReportedFor(detail),
  });
}

function currentRecord(record: AgentQuotaProducerAccount, now: number): AgentQuotaProducerAccount {
  const alive = <T extends AgentQuotaWindow | AgentQuotaModelWindow>(window: T | null): T | null =>
    window && Date.parse(window.resetsAt) > now ? window : null;
  const detail = {
    ...record,
    shortWindow: alive(record.shortWindow),
    weeklyWindow: alive(record.weeklyWindow),
    modelWindows: record.modelWindows?.map((window) => alive(window)).filter((window): window is AgentQuotaModelWindow => window !== null) ?? null,
  };
  if (detail.modelWindows?.length === 0) detail.modelWindows = null;
  const windows = [detail.shortWindow, detail.weeklyWindow, ...(detail.modelWindows ?? [])].filter(
    (window): window is AgentQuotaWindow | AgentQuotaModelWindow => window !== null,
  );
  // #867 FR-5: Codex percentages are descriptive, never a status decision.
  const exhausted = record.runner === 'claude'
    ? windows.find((window) => window.usedPercent >= 100)
    : undefined;
  const topLevelOut = record.status === 'out' && Date.parse(record.resetsAt) > now;
  const status = topLevelOut || exhausted ? 'out' : statusWindows(detail).length ? 'ok' : 'unknown';
  const { resetsAt: _resetsAt, ...withoutReset } = detail;
  return agentQuotaProducerAccountSchema.parse({
    ...withoutReset,
    status,
    ...(status === 'out'
      ? { resetsAt: topLevelOut ? record.resetsAt : exhausted!.resetsAt }
      : {}),
    ageSeconds: Math.max(0, Math.floor((now - Date.parse(record.checkedAt)) / 1_000)),
    notReported: notReportedFor(detail),
  });
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
  let unreadableExhaustedReset: Date | null = null;
  for (const row of rows) {
    const usedPercent = Number(row[3]);
    const reset = claudeReset(row[4]!, checkedAt.getTime());
    if (!reset) {
      if (usedPercent >= 100) {
        const windowMinutes = row[1] === 'session' ? 300 : 10080;
        // An unreadable reset must not turn exhaustion into availability. The
        // window length supplies a conservative, finite bound for this fact.
        const conservativeReset = new Date(checkedAt.getTime() + windowMinutes * 60_000);
        if (!unreadableExhaustedReset || conservativeReset > unreadableExhaustedReset) {
          unreadableExhaustedReset = conservativeReset;
        }
      }
      continue;
    }
    if (row[1] === 'session') shortWindow = windowFromPercent(usedPercent, reset, 300);
    else if (row[1] === 'week (all models)') weeklyWindow = windowFromPercent(usedPercent, reset, 10080);
    else modelWindows.push({ model: row[2]!, ...windowFromPercent(usedPercent, reset, 10080) });
  }
  const windows = [shortWindow, weeklyWindow, ...modelWindows].filter((value) => value !== null);
  const exhausted = windows.filter((window) => window.usedPercent >= 100);
  const unknown = windows.length === 0;
  const exhaustedReset = [
    ...exhausted.map((window) => window.resetsAt),
    ...(unreadableExhaustedReset ? [isoUtc(unreadableExhaustedReset)] : []),
  ].reduce<string | undefined>((latest, candidate) =>
    !latest || Date.parse(candidate) > Date.parse(latest) ? candidate : latest, undefined);
  return agentQuotaProducerAccountSchema.parse({
    runner: 'claude',
    accountId,
    status: exhaustedReset ? 'out' : unknown ? 'unknown' : 'ok',
    ...(exhaustedReset ? { resetsAt: exhaustedReset } : {}),
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
  if (typeof value.usedPercent !== 'number' || typeof value.windowDurationMins !== 'number' || typeof value.resetsAt !== 'number') {
    throw new Error('Codex quota window has an invalid shape');
  }
  if (!Number.isFinite(value.usedPercent) || !Number.isInteger(value.windowDurationMins) || value.windowDurationMins <= 0) {
    throw new Error('Codex quota window has an invalid duration');
  }
  if (!Number.isFinite(value.resetsAt) || value.resetsAt > 10_000_000_000) {
    throw new Error('Codex quota reset must be epoch seconds');
  }
  return windowFromPercent(Math.min(100, Math.max(0, value.usedPercent)), new Date(value.resetsAt * 1_000), value.windowDurationMins);
}

/**
 * A model bucket's weekly window, or `null`. The Codex 0.156.0 schema lets `resetsAt` and
 * `windowDurationMins` be `null`, so a bucket window that lacks either is skipped rather than
 * failing the whole reading: model windows are extra detail on top of the ordinary bucket.
 */
function codexModelWeeklyWindow(raw: unknown): AgentQuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as CodexWindow;
  if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null;
  if (value.windowDurationMins !== 10_080) return null;
  if (typeof value.resetsAt !== 'number' || !Number.isFinite(value.resetsAt) || value.resetsAt > 10_000_000_000) return null;
  return windowFromPercent(Math.min(100, Math.max(0, value.usedPercent)), new Date(value.resetsAt * 1_000), 10_080);
}

/**
 * #867 AC-9: per-model weekly windows. Codex reports them as extra buckets in
 * `rateLimitsByLimitId` ("multi-bucket view keyed by metered `limit_id`"), each a
 * `RateLimitSnapshot` whose `normalModelSlug` names the model the bucket is for. The ordinary
 * bucket (the one `rateLimits` mirrors) is not a model window; a bucket with no model slug has no
 * model to name and is left out. Only 7-day windows become model windows, the same meaning Claude's
 * per-model rows have; a short model window has no place in the answer shape.
 */
function codexModelWindows(result: Record<string, unknown>, defaultLimitId: string): AgentQuotaModelWindow[] | null {
  const buckets = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
    ? result.rateLimitsByLimitId as Record<string, unknown>
    : {};
  const byModel = new Map<string, AgentQuotaModelWindow>();
  for (const [limitId, bucket] of Object.entries(buckets)) {
    if (limitId === defaultLimitId || !bucket || typeof bucket !== 'object') continue;
    const snapshot = bucket as Record<string, unknown>;
    const model = typeof snapshot.normalModelSlug === 'string' ? snapshot.normalModelSlug : '';
    if (!model) continue;
    for (const window of [codexModelWeeklyWindow(snapshot.primary), codexModelWeeklyWindow(snapshot.secondary)]) {
      if (!window) continue;
      // Two buckets for one model: show the more constrained one rather than an arbitrary one.
      const seen = byModel.get(model);
      if (!seen || window.usedPercent > seen.usedPercent) byModel.set(model, { model, ...window });
    }
  }
  const windows = [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
  return windows.length ? windows : null;
}

/** Normalise the Codex app-server `account/rateLimits/read` result. */
export function normalizeCodexRateLimits(raw: unknown, accountId: string, checkedAt: Date): AgentQuotaProducerAccount {
  const envelope = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result = envelope.result && typeof envelope.result === 'object' ? envelope.result as Record<string, unknown> : envelope;
  const snapshot = result.rateLimits && typeof result.rateLimits === 'object' ? result.rateLimits as Record<string, unknown> : {};
  const defaultLimitId = typeof snapshot.limitId === 'string' && snapshot.limitId ? snapshot.limitId : CODEX_DEFAULT_LIMIT_ID;
  const modelWindows = codexModelWindows(result, defaultLimitId);
  const candidates = [codexWindow(snapshot.primary), codexWindow(snapshot.secondary)].filter((value): value is AgentQuotaWindow => value !== null);
  const shortWindow = candidates.find((window) => window.windowMinutes <= 1_440) ?? null;
  const weeklyWindow = candidates.find((window) => window.windowMinutes === 10_080) ?? null;
  const creditsRaw = snapshot.credits && typeof snapshot.credits === 'object' ? snapshot.credits as Record<string, unknown> : null;
  const credits = creditsRaw && typeof creditsRaw.hasCredits === 'boolean' && typeof creditsRaw.unlimited === 'boolean'
    && (typeof creditsRaw.balance === 'string' || typeof creditsRaw.balance === 'number')
    ? { hasCredits: creditsRaw.hasCredits, unlimited: creditsRaw.unlimited, balance: String(creditsRaw.balance) }
    : null;
  const reached = typeof snapshot.rateLimitReachedType === 'string' && snapshot.rateLimitReachedType.length > 0;
  const resetCandidates = candidates.filter((window) => Date.parse(window.resetsAt) > checkedAt.getTime());
  const exhaustedCandidates = resetCandidates.filter((window) => window.usedPercent >= 100);
  const blockingCandidates = exhaustedCandidates.length ? exhaustedCandidates : resetCandidates;
  const blocking = blockingCandidates.reduce<AgentQuotaWindow | undefined>((latest, window) =>
    !latest || Date.parse(window.resetsAt) > Date.parse(latest.resetsAt) ? window : latest, undefined);
  const resetValue = snapshot.resetsAt ?? result.resetsAt;
  const explicitReset = typeof resetValue === 'number' && resetValue <= 10_000_000_000
    ? isoUtc(resetValue * 1_000)
    : undefined;
  const exhausted = result.ordinaryUsageAllowed === false || reached;
  // A model bucket describes one model, never whether the login can work (#867 FR-5), so it
  // neither decides the status nor makes an otherwise empty reading `ok`.
  const unknown = candidates.length === 0;
  return agentQuotaProducerAccountSchema.parse({
    runner: 'codex',
    accountId,
    status: exhausted && (blocking || explicitReset) ? 'out' : unknown ? 'unknown' : 'ok',
    ...(exhausted && (blocking || explicitReset) ? { resetsAt: blocking?.resetsAt ?? explicitReset } : {}),
    checkedAt: isoUtc(checkedAt),
    ageSeconds: 0,
    source: 'check',
    shortWindow,
    weeklyWindow,
    modelWindows,
    credits,
    planType: typeof snapshot.planType === 'string' && snapshot.planType ? snapshot.planType : null,
    notReported: [
      ...(shortWindow ? [] : ['shortWindow' as const]),
      ...(weeklyWindow ? [] : ['weeklyWindow' as const]),
      ...(modelWindows ? [] : ['modelWindows' as const]),
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
    // A live update carries ONE snapshot. A model bucket's update fills that model's window only;
    // read as the ordinary bucket it would overwrite the login's own short/weekly windows.
    const snapshot = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).rateLimits : undefined;
    const result = isCodexModelBucket(snapshot)
      ? { rateLimits: {}, rateLimitsByLimitId: { [snapshot.limitId]: snapshot } }
      : raw;
    const record = normalizeCodexRateLimits({ result }, accountId, observedAt);
    if (!record.shortWindow && !record.weeklyWindow && !record.modelWindows) return null;
    return agentQuotaProducerAccountSchema.parse({ ...record, source: 'live' });
  }
  if (!raw || typeof raw !== 'object') return null;
  const info = ((raw as Record<string, unknown>).rate_limit_info ?? (raw as Record<string, unknown>).rateLimitInfo) as Record<string, unknown> | undefined;
  if (!info) return null;
  const utilization = typeof info.utilization === 'number' ? Math.min(100, Math.max(0, info.utilization * 100)) : null;
  const resetValue = info.resetsAt ?? info.resets_at;
  const reset = typeof resetValue === 'number' ? new Date(resetValue * 1_000) : null;
  if (utilization === null || !reset) return null;
  const out = info.status === 'rejected' || utilization >= 100;
  const rateLimitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'five_hour';
  const window = windowFromPercent(utilization, reset, rateLimitType === 'five_hour' ? 300 : 10080);
  const model = rateLimitType.startsWith('seven_day_') && rateLimitType !== 'seven_day_overage_included'
    ? rateLimitType.slice('seven_day_'.length).replace(/(^|_)([a-z])/g, (_match, prefix, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`)
    : null;
  const detail = {
    shortWindow: rateLimitType === 'five_hour' ? window : null,
    weeklyWindow: rateLimitType === 'seven_day' ? window : null,
    modelWindows: model ? [{ model, ...window }] : null,
    credits: null,
    planType: null,
  };
  if (!detail.shortWindow && !detail.weeklyWindow && !detail.modelWindows) return null;
  return agentQuotaProducerAccountSchema.parse({
    runner: 'claude', accountId, status: out ? 'out' : 'ok', ...(out ? { resetsAt: isoUtc(reset) } : {}),
    checkedAt: isoUtc(observedAt), ageSeconds: 0, source: 'live',
    ...detail,
    notReported: notReportedFor(detail),
  });
}
