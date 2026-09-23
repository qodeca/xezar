import {
  agentQuotaProducerResponseSchema,
  type AgentQuotaProducerAccount,
  type AgentQuotaProducerResponse,
} from '@qodeca/xezar-contract';
import type { AgentQuotaSelector } from './agent-quota.ts';

const none = ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'] as const;

/**
 * The dry-run sample (#867 AC-4, AC-27): the answer time and rows of the contract's approved
 * frozen fixture `agent-quota.expected.json`, bundled so the published CLI carries them.
 * `agent-quota.test.ts` fails when this copy and the fixture differ.
 */
export const DRY_RUN_QUOTA_GENERATED_AT = '2026-09-22T14:24:00Z';

export const DRY_RUN_QUOTA_ACCOUNTS: readonly AgentQuotaProducerAccount[] = [
  {
    runner: 'claude', accountId: 'default', status: 'ok', checkedAt: '2026-09-22T14:20:00Z', ageSeconds: 240, source: 'check',
    shortWindow: { usedPercent: 92, resetsAt: '2026-09-22T15:10:00Z', windowMinutes: 300 },
    weeklyWindow: { usedPercent: 26, resetsAt: '2026-09-28T17:00:00Z', windowMinutes: 10080 },
    modelWindows: [{ model: 'Fable', usedPercent: 29, resetsAt: '2026-09-28T17:00:00Z', windowMinutes: 10080 }],
    credits: null, planType: null, notReported: ['credits', 'planType'],
  },
  {
    runner: 'claude', accountId: 'qodeca-priv', status: 'unknown', checkedAt: '2026-09-22T14:21:00Z', ageSeconds: 180, source: 'check',
    shortWindow: null, weeklyWindow: null, modelWindows: null, credits: null, planType: null, notReported: [...none],
  },
  {
    runner: 'codex', accountId: 'default', status: 'ok', checkedAt: '2026-09-22T14:22:00Z', ageSeconds: 120, source: 'check',
    shortWindow: null,
    weeklyWindow: { usedPercent: 0, resetsAt: '2026-09-29T12:45:02Z', windowMinutes: 10080 },
    modelWindows: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'pro', notReported: ['shortWindow', 'modelWindows'],
  },
  {
    runner: 'claude', accountId: 'quota-exhausted', status: 'out', resetsAt: '2026-09-22T15:10:00Z',
    checkedAt: '2026-09-22T14:19:00Z', ageSeconds: 300, source: 'failedRun',
    shortWindow: null, weeklyWindow: null, modelWindows: null, credits: null, planType: null, notReported: [...none],
  },
  {
    runner: 'codex', accountId: 'api-key', status: 'unknown', checkedAt: '2026-09-22T14:18:00Z', ageSeconds: 360, source: 'check',
    shortWindow: null, weeklyWindow: null, modelWindows: null, credits: null, planType: null, notReported: [...none],
  },
];

/**
 * The dry-run answer: the frozen sample as it was answered at its own clock, filtered by the
 * selector. It is fixed rather than re-aged against the real clock, so a dry run is deterministic
 * (#867 FR-8) and its windows never expire into a different status as the calendar moves on.
 */
export function dryRunQuotaAnswer(selector: AgentQuotaSelector = {}): AgentQuotaProducerResponse {
  return agentQuotaProducerResponseSchema.parse({
    schemaVersion: 1,
    scope: 'agent-quota',
    generatedAt: DRY_RUN_QUOTA_GENERATED_AT,
    accounts: DRY_RUN_QUOTA_ACCOUNTS
      .filter((account) => selector.provider === undefined || account.runner === selector.provider)
      .filter((account) => selector.accountId === undefined || account.accountId === selector.accountId),
  });
}
