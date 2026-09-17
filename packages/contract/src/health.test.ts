import { describe, expect, it } from 'vitest';
import { capabilitiesSchema, healthResponseSchema } from './health.ts';

/**
 * `GET /api/v1/health` is the most externally-depended-on JSON in the app and
 * the one endpoint CORS is open for, so every field added to it is additive by
 * rule (BACKWARD_COMPATIBILITY.md §2).
 *
 * `singleProjectRoot` (#600) is the first capability that is OPTIONAL, and
 * these cases are why: a 0.16.0 cockpit can be pointed at a 0.15.0 server,
 * which has never heard of the key, and a required field would make that
 * payload fail to parse outright rather than degrade. Absent reads as the
 * global layout — what every xezar before 0.16.0 had.
 */
describe('capabilities — the single-project-root key is additive (SP-1.6)', () => {
  /** Exactly the capability object a 0.15.0 server sends. */
  const CAPABILITIES_0_15_0 = {
    localHandoff: true,
    followups: false,
    singleProject: false,
    automations: false,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
  };

  it('parses a 0.15.0 capabilities payload that has no such key', () => {
    const parsed = capabilitiesSchema.safeParse(CAPABILITIES_0_15_0);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.singleProjectRoot).toBeUndefined();
  });

  it('parses a 0.15.0 health payload whole', () => {
    const parsed = healthResponseSchema.safeParse({
      version: '0.15.0',
      channel: 'release',
      repoRoot: '/repos/shop',
      repo: { root: '/repos/shop', branch: 'main' },
      checks: [],
      defaultRunner: 'claude',
      forge: null,
      capabilities: CAPABILITIES_0_15_0,
      projects: [{ id: 'shop', name: 'shop' }],
      bootProject: 'shop',
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('accepts the key when a 0.16.0 server in the mode sends it', () => {
    const parsed = capabilitiesSchema.safeParse({ ...CAPABILITIES_0_15_0, singleProjectRoot: true });

    expect(parsed.success && parsed.data.singleProjectRoot).toBe(true);
  });

  it('still rejects a payload missing a REQUIRED capability — optional here is not laxity', () => {
    const { tokenMetrics: _dropped, ...withoutRequired } = CAPABILITIES_0_15_0;

    expect(capabilitiesSchema.safeParse(withoutRequired).success).toBe(false);
  });
});
