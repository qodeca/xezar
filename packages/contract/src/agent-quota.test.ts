import { describe, expect, it } from 'vitest';

import {
  agentQuotaProducerResponseSchema,
  agentQuotaResponseSchema,
  agentQuotaStatusSchema,
  projectConfigQuotaInputSchema,
  projectConfigQuotaResponseSchema,
} from './agent-quota.ts';
// @ts-expect-error Vitest supplies raw asset imports; production contract modules remain Node-free.
import fixtureText from './__fixtures__/agent-quota.expected.json?raw';

const AGENT_QUOTA_FIXTURE_SHA256 = '967b5b4c67401ad7c0fd49808d6526cae0fc4e430fd1038d709b05427f35d930';

async function sha256(text: string): Promise<string> {
  const runtime = globalThis as unknown as {
    TextEncoder: new () => { encode(value: string): Uint8Array };
    crypto: { subtle: { digest(algorithm: string, value: Uint8Array): Promise<ArrayBuffer> } };
  };
  const bytes = new runtime.TextEncoder().encode(text);
  const digest = await runtime.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The fixture is the CONTRACT for the HTTP and project_config quota answers (#867 S1), not a
 * sample. A later implementation must produce these bytes for its deterministic fixture path.
 */
describe('the agent-quota answer matches its committed fixture', () => {
  it('pins the fixture bytes to an independently reviewed SHA-256 digest', async () => {
    expect(await sha256(fixtureText)).toBe(AGENT_QUOTA_FIXTURE_SHA256);
  });

  it('strictly parses and canonically serialises byte-for-byte to the fixture', () => {
    const parsed = agentQuotaProducerResponseSchema.parse(JSON.parse(fixtureText));

    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(fixtureText);
  });

  it('pins the schema version and agent-quota scope as literals', () => {
    const fixture = JSON.parse(fixtureText) as Record<string, unknown>;

    expect(agentQuotaResponseSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(false);
    expect(agentQuotaResponseSchema.safeParse({ ...fixture, scope: 'other' }).success).toBe(false);
  });

  it('ignores additive unknown keys for older consumers', () => {
    const fixture = JSON.parse(fixtureText) as Record<string, unknown>;
    const parsed = agentQuotaResponseSchema.parse({
      ...fixture,
      futureTopLevelFact: true,
      accounts: [{ ...(fixture.accounts as Record<string, unknown>[])[0], futureAccountFact: true }],
    });

    expect(parsed).not.toHaveProperty('futureTopLevelFact');
    expect(parsed.accounts[0]).not.toHaveProperty('futureAccountFact');
  });

  it('accepts an additive null fact and its notReported name only for consumers', () => {
    const fixture = JSON.parse(fixtureText) as { accounts: Record<string, unknown>[] };
    const first = fixture.accounts[0]!;
    const additiveAnswer = {
      ...fixture,
      accounts: [
        {
          ...first,
          futureFact: null,
          notReported: [...(first.notReported as string[]), 'futureFact'],
        },
      ],
    };

    expect(agentQuotaResponseSchema.safeParse(additiveAnswer).success).toBe(true);
    expect(agentQuotaProducerResponseSchema.safeParse(additiveAnswer).success).toBe(false);
    expect(
      agentQuotaResponseSchema.safeParse({
        ...fixture,
        accounts: [{ ...first, notReported: ['planType', 'futureFact'] }],
      }).success,
    ).toBe(false);
  });

  it('keeps the two project_config request and response actions on the same answer schema', () => {
    const answer = agentQuotaResponseSchema.parse(JSON.parse(fixtureText));

    expect(projectConfigQuotaInputSchema.parse({ action: 'read_quota', provider: 'claude' })).toEqual({
      action: 'read_quota',
      provider: 'claude',
    });
    expect(projectConfigQuotaInputSchema.parse({ action: 'check_quota', accountId: 'default' })).toEqual({
      action: 'check_quota',
      accountId: 'default',
    });
    expect(
      projectConfigQuotaResponseSchema.parse({ action: 'read_quota', origin: 'mcp', result: answer }).result,
    ).toEqual(answer);
    expect(projectConfigQuotaInputSchema.safeParse({ action: 'read_quota', runner: 'claude' }).success).toBe(false);
  });

  it('requires resetsAt only for an out account', () => {
    const answer = JSON.parse(fixtureText) as { accounts: Record<string, unknown>[] };
    const ok = answer.accounts[0];
    const out = answer.accounts[3];

    expect(
      agentQuotaResponseSchema.safeParse({
        ...answer,
        accounts: [{ ...ok, resetsAt: '2026-09-22T15:10:00Z' }],
      }).success,
    ).toBe(false);
    expect(
      agentQuotaResponseSchema.safeParse({ ...answer, accounts: [{ ...out, resetsAt: undefined }] }).success,
    ).toBe(false);
  });

  it('rejects ok when any reported window is at 100 percent', () => {
    const answer = JSON.parse(fixtureText) as { accounts: Record<string, unknown>[] };
    const ok = answer.accounts[0] as {
      shortWindow: Record<string, unknown>;
      weeklyWindow: Record<string, unknown>;
      modelWindows: Record<string, unknown>[];
    };
    const entries = [
      { ...ok, shortWindow: { ...ok.shortWindow, usedPercent: 100 } },
      { ...ok, weeklyWindow: { ...ok.weeklyWindow, usedPercent: 100 } },
      { ...ok, modelWindows: [{ ...ok.modelWindows[0], usedPercent: 100 }] },
    ];

    for (const entry of entries) {
      expect(agentQuotaResponseSchema.safeParse({ ...answer, accounts: [entry] }).success).toBe(false);
    }
  });

  it('keeps status to exactly ok, out and unknown', () => {
    expect(agentQuotaStatusSchema.options).toEqual(['ok', 'out', 'unknown']);
    expect(agentQuotaStatusSchema.safeParse('warning').success).toBe(false);
  });
});
