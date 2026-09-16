import { describe, expect, it } from 'vitest';

import type { BackendCheck } from '../core/backend-detect.ts';
import type { OnboardingRead } from './state.ts';
import {
  BUNDLED_TEMPLATES_DIGEST,
  deriveOnboardingStatus,
  hasAgentBackend,
  NO_BACKEND_REASON,
  observedIdentity,
  ONBOARDING_MODES,
  ONBOARDING_WORKFLOW_ID,
} from './status.ts';

/**
 * Every state of the onboarding surface (#464 P2, `states.html`), driven through the pure half.
 *
 * The derivation is where this feature can lie, so each case below is one claim it must not make:
 * that a check covered a version it never saw, that an offer is pending without a baseline, that a
 * corrupt record means "nothing has been set up", or that setup can run with no agent installed.
 */

const OBSERVED = observedIdentity('0.15.0');
const OLD = { engineVersion: '0.14.0', kitDigest: BUNDLED_TEMPLATES_DIGEST };

const AGENT: BackendCheck[] = [
  { name: 'claude', available: true },
  { name: 'gh', available: true },
  { name: 'git', available: true },
];
const NO_AGENT: BackendCheck[] = [
  { name: 'claude', available: false },
  { name: 'codex', available: false },
  { name: 'opencode', available: false },
  { name: 'pi', available: false },
  // Both present and both irrelevant: neither can run an agent step.
  { name: 'gh', available: true },
  { name: 'git', available: true },
];

const ok = (record: OnboardingRead['record']): OnboardingRead => ({ status: 'ok', record });
const absent: OnboardingRead = { status: 'absent', record: null };
const corrupt: OnboardingRead = { status: 'corrupt', record: null };

const derive = (read: OnboardingRead, over: { checks?: BackendCheck[]; localHandoff?: boolean; checkingRunId?: string | null } = {}) =>
  deriveOnboardingStatus(read, {
    observed: OBSERVED,
    checks: over.checks ?? AGENT,
    localHandoff: over.localHandoff ?? true,
    checkingRunId: over.checkingRunId ?? null,
  });

describe('the five states', () => {
  it('a project with no record is “never set up”, with no offer', () => {
    const status = derive(absent);
    expect(status.state).toBe('never');
    expect(status.provenance).toBe('unknown');
    expect(status.lastChecked).toBeNull();
    // No baseline means nothing to compare against. Inventing one is the failure this design
    // exists to avoid, so the offer row must stay away from a brand-new project (OQ-4).
    expect(status.offerPending).toBe(false);
  });

  it('a corrupt record is “provenance unknown”, never “never set up”', () => {
    // A file we can see and cannot read is not evidence that nothing was ever set up.
    expect(derive(corrupt).state).toBe('unknown');
    expect(derive(corrupt).provenance).toBe('unknown');
    expect(derive(corrupt).offerPending).toBe(false);
  });

  it('a finished check for the running pair is “set up”', () => {
    const status = derive(
      ok({ ...OBSERVED, lastOfferedAt: null, lastCheckedAt: '2026-09-14T09:12:00.000Z', checked: { ...OBSERVED, at: '2026-09-14T09:12:00.000Z' } }),
    );
    expect(status.state).toBe('set-up');
    expect(status.provenance).toBe('recorded');
    expect(status.lastChecked).toEqual({ ...OBSERVED, at: '2026-09-14T09:12:00.000Z' });
    expect(status.offerPending).toBe(false);
  });

  it('a finished check for a DIFFERENT pair is “changed”, and offers once', () => {
    const status = derive(
      ok({ ...OBSERVED, lastOfferedAt: null, lastCheckedAt: null, checked: { ...OLD, at: '2026-09-02T16:40:00.000Z' } }),
    );
    expect(status.state).toBe('changed');
    expect(status.offerPending).toBe(true);
    expect(status.dismissed).toBe(false);
    // Both pairs on the wire: the card says what was checked AND what is running.
    expect(status.lastChecked?.engineVersion).toBe('0.14.0');
    expect(status.observed.engineVersion).toBe('0.15.0');
  });

  it('an offer already made for this pair is “dismissed”, and never offers again', () => {
    const status = derive(
      ok({ ...OBSERVED, lastOfferedAt: '2026-09-16T08:02:00.000Z', lastCheckedAt: null, checked: { ...OLD, at: '2026-09-02T16:40:00.000Z' } }),
    );
    expect(status.state).toBe('changed');
    expect(status.dismissed).toBe(true);
    // The whole anti-nag rule: one appearance per identity pair.
    expect(status.offerPending).toBe(false);
    expect(status.lastOffered).toEqual({ ...OBSERVED, at: '2026-09-16T08:02:00.000Z' });
  });

  it('an offer recorded for an OLDER pair does not count as this one being dismissed', () => {
    const status = derive(
      ok({ ...OLD, lastOfferedAt: '2026-09-01T08:00:00.000Z', lastCheckedAt: null, checked: { ...OLD, at: '2026-09-02T16:40:00.000Z' } }),
    );
    expect(status.lastOffered).toBeNull();
    expect(status.dismissed).toBe(false);
    expect(status.offerPending).toBe(true);
  });

  it('a running check outranks every other state and replaces the offer', () => {
    const status = derive(
      ok({ ...OBSERVED, lastOfferedAt: null, lastCheckedAt: null, checked: { ...OLD, at: '2026-09-02T16:40:00.000Z' } }),
      { checkingRunId: 'run-7' },
    );
    expect(status.state).toBe('checking');
    expect(status.checkingRunId).toBe('run-7');
    // Two clicks must not start two checks, so no offer sits beside a running one.
    expect(status.offerPending).toBe(false);
  });
});

describe('availability and mode', () => {
  it('counts only the agent CLIs, never `gh` or `git`', () => {
    expect(hasAgentBackend(AGENT)).toBe(true);
    expect(hasAgentBackend(NO_AGENT)).toBe(false);
    const status = derive(absent, { checks: NO_AGENT });
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe(NO_BACKEND_REASON);
  });

  it('carries the reason only when the action is actually unavailable', () => {
    expect(derive(absent).available).toBe(true);
    expect(derive(absent).unavailableReason).toBeNull();
  });

  it('reports hosted mode without hiding the entry', () => {
    // OQ-2 option A: setup still runs; the cockpit only has to say which step finishes elsewhere.
    const status = derive(absent, { localHandoff: false });
    expect(status.localHandoff).toBe(false);
    expect(status.available).toBe(true);
  });

  it('names the bundled launch definition and all three modes', () => {
    // A leader that cannot see `preview` cannot dispatch a report-only check (design review NB-6).
    expect(derive(absent).launch).toEqual({
      workflowId: ONBOARDING_WORKFLOW_ID,
      modes: ['setup', 'preview', 'recheck'],
    });
    expect([...ONBOARDING_MODES]).toContain('preview');
  });
});
