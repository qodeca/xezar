import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { onboardingStatePath, resetOnboardingWarnings } from '../onboarding/state.ts';
import { BUNDLED_TEMPLATES_DIGEST, ONBOARDING_WORKFLOW_ID } from '../onboarding/status.ts';
import { watchSetupCompletion } from '../onboarding/watch.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/onboarding` and `POST /api/v1/onboarding/offered` (#464 P2).
 *
 * The invariant worth naming first: **the GET writes nothing.** That is not a performance
 * preference — it is what keeps a page load from creating state, and it is what lets the route
 * answer byte-identically under its three scope spellings, which `route-parity.test.ts` requires.
 */
describe('the onboarding API', () => {
  let repoRoot: string;
  let xezHome: string;
  let store: RunStore;
  let active: Set<string>;
  let app: Hono;
  const savedHome = process.env.XEZ_HOME;
  const savedDry = process.env.XEZ_DRY_RUN;

  beforeEach(() => {
    xezHome = mkdtempSync(join(tmpdir(), 'xez-onboarding-home-'));
    process.env.XEZ_HOME = xezHome;
    // The probes are mocked, so "an agent backend is available" is a fixture rather than a fact
    // about the developer's laptop.
    process.env.XEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-onboarding-'));
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    active = new Set<string>();
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: (id: string) => active.has(id) } as unknown as RunManager,
      version: '0.15.0',
    });
    resetOnboardingWarnings();
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedDry === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDry;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(xezHome, { recursive: true, force: true });
  });

  const statePath = () => onboardingStatePath(join(repoRoot, '.local/xezar'));
  const writeRecord = (value: unknown) =>
    writeFileSync(statePath(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

  const get = async () => {
    const res = await apiRequest(app, '/api/v1/onboarding');
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  const OBSERVED = { engineVersion: '0.15.0', kitDigest: BUNDLED_TEMPLATES_DIGEST };

  it('reads a fresh project without creating anything on disk', async () => {
    const body = await get();
    expect(body).toMatchObject({
      state: 'never',
      provenance: 'unknown',
      offerPending: false,
      dismissed: false,
      observed: OBSERVED,
      lastOffered: null,
      lastChecked: null,
      checkingRunId: null,
      launch: { workflowId: ONBOARDING_WORKFLOW_ID, modes: ['setup', 'preview', 'recheck'] },
    });
    // The rule this whole route is shaped around: reading is not writing.
    expect(existsSync(statePath())).toBe(false);
  });

  it('answers identically on repeat — a GET that drifted would fail scope parity', async () => {
    expect(await get()).toEqual(await get());
  });

  it('keeps working when the record is deleted or corrupted under it', async () => {
    writeRecord('{{ not json');
    const corrupt = await get();
    expect(corrupt.state).toBe('unknown');
    expect(corrupt.provenance).toBe('unknown');
    // Never an offer off an unreadable baseline: a comparison nobody can trust is worse than none.
    expect(corrupt.offerPending).toBe(false);

    rmSync(statePath());
    expect((await get()).state).toBe('never');
  });

  it('offers exactly once for a changed identity, then stops', async () => {
    writeRecord({
      ...OBSERVED,
      lastOfferedAt: null,
      lastCheckedAt: null,
      checked: { engineVersion: '0.14.0', kitDigest: BUNDLED_TEMPLATES_DIGEST, at: '2026-09-02T16:40:00.000Z' },
    });
    expect((await get()).offerPending).toBe(true);

    const res = await apiRequest(app, '/api/v1/onboarding/offered', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OBSERVED),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; onboarding: Record<string, unknown> };
    expect(body.status).toBe('recorded');
    expect(body.onboarding).toMatchObject({ state: 'changed', dismissed: true, offerPending: false });

    // And it stays gone across a reload — the anti-nag rule the whole feature rests on.
    expect((await get()).offerPending).toBe(false);
  });

  it('answers `conflict` and writes nothing when the caller’s identity has moved on', async () => {
    const res = await apiRequest(app, '/api/v1/onboarding/offered', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engineVersion: '0.14.0', kitDigest: BUNDLED_TEMPLATES_DIGEST }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('conflict');
    // Nothing written: dismissing a pair nobody was shown would swallow the real offer silently.
    expect(existsSync(statePath())).toBe(false);
  });

  it('rejects a body that is not an identity', async () => {
    const res = await apiRequest(app, '/api/v1/onboarding/offered', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engineVersion: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });

  it('answers `unwritable` on a read-only data directory rather than failing', async () => {
    const dataDir = join(repoRoot, '.local/xezar');
    chmodSync(dataDir, 0o500);
    try {
      const res = await apiRequest(app, '/api/v1/onboarding/offered', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(OBSERVED),
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { status: string }).status).toBe('unwritable');
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });

  it('reports a RUNNING setup task, and stops reporting it once it finishes', async () => {
    const other = store.createRun({ title: 'unrelated', workflow: 'quick-task', task: 't', steps: [] });
    const setup = store.createRun({ title: 'set up', workflow: ONBOARDING_WORKFLOW_ID, task: 't', steps: [] });
    active.add(other.id);
    // An active task of another workflow is not a check: only the launch definition counts.
    expect((await get()).checkingRunId).toBeNull();

    active.add(setup.id);
    expect(await get()).toMatchObject({ state: 'checking', checkingRunId: setup.id });

    // Liveness, not existence. A finished setup task must not leave the card stuck on "Re-checking".
    active.delete(setup.id);
    expect((await get()).checkingRunId).toBeNull();
  });

  /**
   * The default path end to end (review round 1 finding 1): a setup task finishing is the ONLY
   * thing that moves this route's answer off `never`, and nothing here hand-writes the record.
   *
   * `createApp` is what attaches the watcher, so this is the wiring under test and not a helper:
   * asking for the handle again returns the one `createApp` installed, which is how the assertion
   * awaits a write that is deliberately fire-and-forget.
   */
  describe('after a setup task finishes', () => {
    const FINISHED_AT = '2026-09-16T04:00:00.000Z';
    const settle = () => watchSetupCompletion(store, '0.15.0').idle();

    const runSetup = (over: { status: 'done' | 'failed' | 'cancelled'; step: 'done' | 'cancelled' | 'failed' }) => {
      const run = store.createRun({
        title: 'set up',
        workflow: ONBOARDING_WORKFLOW_ID,
        task: 't',
        steps: [{ id: 'setup', name: 'Set up this project', kind: 'agent' }],
      });
      active.add(run.id);
      return {
        id: run.id,
        end: () => {
          active.delete(run.id);
          store.updateStep(run.id, 'setup', { status: over.step, finishedAt: FINISHED_AT });
          store.updateRun(run.id, { status: over.status, finishedAt: FINISHED_AT });
        },
      };
    };

    it('answers `set-up`, with the identity and the moment the check really covered', async () => {
      const run = runSetup({ status: 'done', step: 'done' });
      expect((await get()).state).toBe('checking');

      run.end();
      await settle();

      expect(await get()).toMatchObject({
        state: 'set-up',
        provenance: 'recorded',
        offerPending: false,
        checkingRunId: null,
        lastChecked: { ...OBSERVED, at: FINISHED_AT },
      });
    });

    it('answers `never` still, for a cancelled or a failed one (AC-12)', async () => {
      runSetup({ status: 'cancelled', step: 'cancelled' }).end();
      runSetup({ status: 'failed', step: 'failed' }).end();
      await settle();

      expect(await get()).toMatchObject({ state: 'never', lastChecked: null });
      expect(existsSync(statePath())).toBe(false);
    });

    it('offers a re-check once the running identity moves past the finished one', async () => {
      // The post-update offer, reached the way a user reaches it: a real check finishes, and a
      // later xezar reads the record it left. Nothing in this case writes the file by hand.
      runSetup({ status: 'done', step: 'done' }).end();
      await settle();

      const later = createApp({
        repoRoot,
        store,
        manager: { isActive: (id: string) => active.has(id) } as unknown as RunManager,
        version: '0.16.0',
      });
      const res = await apiRequest(later, '/api/v1/onboarding');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        state: 'changed',
        offerPending: true,
        dismissed: false,
        observed: { engineVersion: '0.16.0', kitDigest: BUNDLED_TEMPLATES_DIGEST },
        lastChecked: { ...OBSERVED, at: FINISHED_AT },
      });
    });
  });
});
