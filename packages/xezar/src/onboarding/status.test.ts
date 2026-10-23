import { describe, expect, it } from 'vitest';

import type { BackendCheck } from '../core/backend-detect.ts';
import type { OnboardingRead } from './state.ts';
import {
  BUNDLED_TEMPLATES_DIGEST,
  deriveOnboardingStatus,
  hasAgentBackend,
  isOlderSetupVersion,
  MINIMUM_SETUP_VERSION,
  NO_BACKEND_REASON,
  observedIdentity,
  ONBOARDING_MODES,
  ONBOARDING_WORKFLOW_ID,
  parseSetupVersion,
  SETUP_UPGRADE_GUIDE_URL,
} from './status.ts';
import type { InstallRecord } from './install-record.ts';
import { PROJECT_SETUP_WORKFLOW } from '../workflows/types.ts';

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
  { name: 'qwen', available: false },
  // Both present and both irrelevant: neither can run an agent step.
  { name: 'gh', available: true },
  { name: 'git', available: true },
];

const ISSUE_FILING = { status: 'available', reason: null, skill: 'xez-issue-create' } as const;

const ok = (record: OnboardingRead['record']): OnboardingRead => ({ status: 'ok', record });
const absent: OnboardingRead = { status: 'absent', record: null };
const corrupt: OnboardingRead = { status: 'corrupt', record: null };

/** An install record with no `version` — the shape older records have. */
const INSTALLED: InstallRecord = { skill: 'xez-onboard-opinionated', date: '2026-09-27T09:11:23Z', version: null };
const installedAt = (version: string | null): InstallRecord => ({ ...INSTALLED, version });

const derive = (
  read: OnboardingRead,
  over: { checks?: BackendCheck[]; localHandoff?: boolean; checkingRunId?: string | null; installRecord?: InstallRecord | null } = {},
) =>
  deriveOnboardingStatus(read, {
    observed: OBSERVED,
    checks: over.checks ?? AGENT,
    localHandoff: over.localHandoff ?? true,
    checkingRunId: over.checkingRunId ?? null,
    issueFiling: ISSUE_FILING,
    installRecord: over.installRecord ?? null,
  });

describe('the bundled templates pin (0.20.0)', () => {
  it('pins the 3.2.1 onboarding (v3.2.1, b86ddf0), not 3.0.3 or the retired xez-onboard revision', () => {
    expect(BUNDLED_TEMPLATES_DIGEST).toBe('b86ddf0');
  });

  it('a project last checked against the 3.0.3 pin is offered one re-check', () => {
    const at = '2026-10-01T09:12:00.000Z';
    const status = derive(
      ok({
        engineVersion: '0.15.0',
        kitDigest: 'ec856f8',
        lastOfferedAt: null,
        lastCheckedAt: at,
        checked: { engineVersion: '0.15.0', kitDigest: 'ec856f8', at },
      }),
    );
    expect(status.state).toBe('changed');
    expect(status.offerPending).toBe(true);
  });

  it('a project last checked against the old xez-onboard pin is offered one re-check', () => {
    const at = '2026-09-14T09:12:00.000Z';
    const status = derive(
      ok({
        engineVersion: '0.15.0',
        kitDigest: '2c20c60',
        lastOfferedAt: null,
        lastCheckedAt: at,
        checked: { engineVersion: '0.15.0', kitDigest: '2c20c60', at },
      }),
    );
    expect(status.state).toBe('changed');
    expect(status.offerPending).toBe(true);
    expect(status.launch.workflowId).toBe('project-setup');
  });

  it('the launch definition runs the onboarding skill, and only that one', () => {
    expect(PROJECT_SETUP_WORKFLOW.name).toBe(ONBOARDING_WORKFLOW_ID);
    expect(PROJECT_SETUP_WORKFLOW.steps.map((step) => step.skill)).toEqual(['xez-onboard-opinionated']);
  });
});

describe('the committed install record', () => {
  it('a project onboarded outside the cockpit reads as set up, with no first-time or re-check offer', () => {
    const status = derive(absent, { installRecord: INSTALLED });
    expect(status.state).toBe('set-up');
    expect(status.provenance).toBe('recorded');
    expect(status.offerPending).toBe(false);
    expect(status.lastChecked).toBeNull();
  });

  it('outranks an older cockpit check and an unreadable scratch record, but not a running check', () => {
    const at = '2026-09-14T09:12:00.000Z';
    const older = ok({ ...OLD, lastOfferedAt: null, lastCheckedAt: at, checked: { ...OLD, at } });
    expect(derive(older, { installRecord: INSTALLED }).state).toBe('set-up');
    expect(derive(older, { installRecord: INSTALLED }).offerPending).toBe(false);
    expect(derive(corrupt, { installRecord: INSTALLED }).state).toBe('set-up');
    expect(derive(absent, { installRecord: INSTALLED, checkingRunId: 'run-1' }).state).toBe('checking');
  });

  it('without the record, the cockpit-run detection is unchanged', () => {
    expect(derive(absent, { installRecord: null }).state).toBe('never');
    const at = '2026-09-14T09:12:00.000Z';
    const current = ok({ ...OBSERVED, lastOfferedAt: null, lastCheckedAt: at, checked: { ...OBSERVED, at } });
    expect(derive(current, { installRecord: null }).state).toBe('set-up');
  });
});

describe('the setup version compare', () => {
  it('reads strict major.minor.patch, with an optional pre-release and build', () => {
    expect(parseSetupVersion('3.2.0')).toEqual({ core: [3, 2, 0], preRelease: false });
    expect(parseSetupVersion('3.2.0-rc.1')).toEqual({ core: [3, 2, 0], preRelease: true });
    expect(parseSetupVersion('3.2.0+build.7')).toEqual({ core: [3, 2, 0], preRelease: false });
    for (const bad of ['', '3', '3.2', '3.2.0.1', 'v3.2.0', '03.2.0', '3.2.x', 'next', '3.2.0-']) {
      expect(parseSetupVersion(bad), bad).toBeNull();
    }
  });

  it('calls a populated, readable version older only when it is below the minimum', () => {
    expect(MINIMUM_SETUP_VERSION).toBe('3.2.0');
    expect(isOlderSetupVersion('3.0.3')).toBe(true);
    expect(isOlderSetupVersion('3.1.0')).toBe(true);
    expect(isOlderSetupVersion('2.9.9')).toBe(true);
    expect(isOlderSetupVersion('3.2.0-rc.1')).toBe(true);
    expect(isOlderSetupVersion('3.2.0')).toBe(false);
    expect(isOlderSetupVersion('3.2.1')).toBe(false);
    expect(isOlderSetupVersion('3.10.0')).toBe(false);
    expect(isOlderSetupVersion('4.0.0')).toBe(false);
  });

  // Fail-open needs its empty case pinned (AGENTS.md § Changing a mechanism): an absent or
  // unreadable version must read as "not known to be old", and the populated cases above prove
  // the same function does say "old" when it has evidence — so the two cannot collapse into one.
  it('never calls an absent, empty or unreadable version old', () => {
    expect(isOlderSetupVersion(null)).toBe(false);
    expect(isOlderSetupVersion('')).toBe(false);
    expect(isOlderSetupVersion('next')).toBe(false);
    expect(isOlderSetupVersion('3.1')).toBe(false);
  });
});

describe('an install record from an older setup collection', () => {
  it('stays set up, carries olderSetup, and offers the upgrade once', () => {
    const status = derive(absent, { installRecord: installedAt('3.0.3') });
    expect(status.state).toBe('set-up');
    expect(status.olderSetup).toEqual({
      recordedVersion: '3.0.3',
      minimumVersion: '3.2.0',
      upgradeGuideUrl: SETUP_UPGRADE_GUIDE_URL,
    });
    expect(status.offerPending).toBe(true);
    expect(status.dismissed).toBe(false);
  });

  it('Later for this pair hides the offer, and the warning stays on the answer', () => {
    const status = derive(
      ok({ ...OBSERVED, lastOfferedAt: '2026-10-18T08:00:00.000Z', lastCheckedAt: null, checked: null }),
      { installRecord: installedAt('3.1.0') },
    );
    expect(status.state).toBe('set-up');
    expect(status.offerPending).toBe(false);
    expect(status.dismissed).toBe(true);
    expect(status.olderSetup?.recordedVersion).toBe('3.1.0');
  });

  it('a Later recorded for an older pair does not hide it for this one', () => {
    const status = derive(
      ok({ ...OLD, lastOfferedAt: '2026-10-01T08:00:00.000Z', lastCheckedAt: null, checked: null }),
      { installRecord: installedAt('3.1.0') },
    );
    expect(status.offerPending).toBe(true);
    expect(status.dismissed).toBe(false);
  });

  it('a running check replaces the offer, and the answer still says the setup is older', () => {
    const status = derive(absent, { installRecord: installedAt('3.0.3'), checkingRunId: 'run-9' });
    expect(status.state).toBe('checking');
    expect(status.offerPending).toBe(false);
    expect(status.dismissed).toBe(false);
    expect(status.olderSetup?.recordedVersion).toBe('3.0.3');
  });

  it('a current, absent or unreadable version is unchanged: set up, no warning, no offer', () => {
    for (const version of ['3.2.0', '3.2.1', null, 'next']) {
      const status = derive(absent, { installRecord: installedAt(version) });
      expect(status.state, String(version)).toBe('set-up');
      expect(status.olderSetup, String(version)).toBeNull();
      expect(status.offerPending, String(version)).toBe(false);
      expect(status.dismissed, String(version)).toBe(false);
    }
  });

  it('no install record means no warning, whatever the scratch record says', () => {
    expect(derive(absent).olderSetup).toBeNull();
    expect(derive(corrupt).olderSetup).toBeNull();
  });
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

  it('states the disabled reason without naming xezar’s own working files or process', () => {
    // The server-side half of the #466 guard (review round 1 finding 5): the cockpit's own strings
    // are held to this in `packages/web/src/lib/onboarding.test.ts`, and this sentence is the one
    // shipped string of this deck that a user reads and that does NOT live there.
    for (const forbidden of [/\.xezar/, /\bkit\b/i, /\bSDLC\b/, /\bworkflow/i, /\bskill/i]) {
      expect(NO_BACKEND_REASON).not.toMatch(forbidden);
    }
  });
});

describe('issue filing (#468)', () => {
  it('carries the discovered answer through unchanged, whatever the setup state', () => {
    const closed = {
      status: 'unavailable',
      reason: 'Not available: The GitHub CLI (gh) is not installed. A person can install it and run `gh auth login`.',
      skill: 'xez-issue-create',
    } as const;
    for (const read of [absent, corrupt]) {
      const status = deriveOnboardingStatus(read, {
        observed: OBSERVED,
        checks: NO_AGENT,
        localHandoff: false,
        checkingRunId: 'run-1',
        issueFiling: closed,
        installRecord: null,
      });
      expect(status.issueFiling).toEqual(closed);
    }
    expect(derive(absent).issueFiling).toEqual(ISSUE_FILING);
  });
});
