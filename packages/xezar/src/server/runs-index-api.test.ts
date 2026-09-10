import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunsIndexResponse } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import { __seedRefStatusCacheForTests } from './forge/github.ts';

/**
 * `GET /api/v1/workspace/runs-index` — the ⌘K palette's cross-project task finder.
 *
 * The behaviours worth pinning are the ones a future change could quietly break: that a project
 * this process has never opened still contributes rows (read off disk), that reading them does
 * NOT build a context — which would prune worktrees and resume agents — and that the wire shape
 * stays slim, because the whole reason this route exists instead of N `/runs` calls is that
 * `RunRecord` carries `steps[]`.
 */

/** A stored record, written straight to a cold project's `runs.json`. */
function storedRun(over: Record<string, unknown> & { id: string; title: string }) {
  return {
    workflow: 'build',
    task: 'do the thing',
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [{ id: 's1', name: 'work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
    ...over,
  };
}

describe('workspace runs index API', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-runs-index-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-runs-index-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-runs-index-other-'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const getIndex = async (over: Partial<ServerDeps> = {}): Promise<RunsIndexResponse> => {
    const res = await apiRequest(makeApp(over), '/api/v1/workspace/runs-index');
    expect(res.status).toBe(200);
    return (await res.json()) as RunsIndexResponse;
  };

  /** Give `root` a `runs.json` without ever opening a store on it — a genuinely COLD project. */
  const seedColdProject = (root: string, runs: unknown[]) => {
    mkdirSync(join(root, '.local/xezar'), { recursive: true });
    writeFileSync(join(root, '.local/xezar/runs.json'), JSON.stringify(runs), 'utf8');
  };

  it('answers an empty index for an empty registry — never a 404', async () => {
    const body = await getIndex();
    expect(body).toEqual({ runs: [], perProjectLimit: 200, truncated: [], referenceStatuses: {} });
  });

  it('merges the boot project’s live store with a cold project read off disk, newest first', async () => {
    const boot = await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    const live = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    store.updateRun(live.id, { createdAt: '2026-07-10T10:00:00Z' });
    seedColdProject(otherRoot, [
      storedRun({ id: 'cold-1', title: 'Cold task', createdAt: '2026-07-15T10:00:00Z' }),
    ]);

    const body = await getIndex();

    expect(body.runs.map((run) => run.id)).toEqual(['cold-1', live.id]);
    expect(body.runs.map((run) => run.projectId)).toEqual([other.id, boot.id]);
    expect(body.truncated).toEqual([]);
  });

  it('never builds a project context — a search must not resume agents', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    seedColdProject(otherRoot, [storedRun({ id: 'cold-1', title: 'Cold task' })]);
    const contexts = new ProjectContexts({ listProjects });

    const body = await getIndex({ contexts });

    expect(body.runs.map((run) => run.id)).toEqual(['cold-1']);
    // The row came from disk, and the project is still unopened: no store, no manager, no
    // `recover()`. This is the guarantee the whole read-only reader exists to provide.
    expect(contexts.peek(other.id)).toBeUndefined();
    expect(contexts.ids()).toEqual([]);
    contexts.disposeAll();
  });

  it("resolves each row's runner against ITS OWN project's default, and carries the model verbatim", async () => {
    // Two projects with different `defaultRunner`s, and rows from BOTH in one answer — the case
    // the browser cannot finish, because doing so would be one config request per project. A
    // build that read a single config per REQUEST would still pass without the boot row below.
    mkdirSync(join(otherRoot, '.xezar'), { recursive: true });
    writeFileSync(
      join(otherRoot, '.xezar/config.json'),
      JSON.stringify({ defaultRunner: 'opencode' }),
      'utf8',
    );
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    // The boot project configures nothing, so its own default is the shipped 'claude'.
    const bootQueued = store.createRun({ title: 'Boot queued', workflow: 'build', task: 't', steps: [] });
    store.updateRun(bootQueued.id, { status: 'queued', createdAt: '2026-07-15T09:00:00Z' });
    seedColdProject(otherRoot, [
      // Never started: no runner, no step backend. THIS is the inherited case — the value is what
      // the task would run as, not what it ran as.
      storedRun({
        id: 'cold-queued',
        title: 'Queued',
        status: 'queued',
        createdAt: '2026-07-15T12:00:00Z',
        steps: [],
      }),
      // Chose both. The model string is whatever the caller asked for, never a catalog lookup.
      storedRun({
        id: 'cold-chosen',
        title: 'Chosen',
        createdAt: '2026-07-15T11:00:00Z',
        runner: 'codex',
        model: 'gpt-5-codex',
      }),
      // A locally-hosted model id survives byte for byte.
      storedRun({
        id: 'cold-local',
        title: 'Local',
        createdAt: '2026-07-15T10:30:00Z',
        runner: 'opencode',
        model: 'local/qwen3-coder-30b',
      }),
    ]);

    const body = await getIndex();
    const row = (id: string) => body.runs.find((entry) => entry.id === id)!;

    // Each against its OWN project: 'opencode' for the configured one, 'claude' for the boot one.
    expect(row('cold-queued').runner).toBe('opencode');
    expect(row('cold-queued').runnerInherited).toBe(true);
    expect(Object.keys(row('cold-queued'))).not.toContain('model');
    expect(row(bootQueued.id).runner).toBe('claude');
    expect(row(bootQueued.id).runnerInherited).toBe(true);

    expect(row('cold-chosen').runner).toBe('codex');
    expect(Object.keys(row('cold-chosen'))).not.toContain('runnerInherited');
    expect(row('cold-chosen').model).toBe('gpt-5-codex');
    expect(row('cold-local').model).toBe('local/qwen3-coder-30b');
  });

  it('prefers a legacy record’s own step backend over today’s project default', async () => {
    // `execute` has written the resolved `runner` onto every run it started since backend
    // affinity landed, so a record without one is either queued or pre-affinity. For the
    // pre-affinity case the steps stamped what actually spawned, and resolving THAT against the
    // project's current default would name a backend the run never touched.
    mkdirSync(join(otherRoot, '.xezar'), { recursive: true });
    writeFileSync(
      join(otherRoot, '.xezar/config.json'),
      JSON.stringify({ defaultRunner: 'opencode' }),
      'utf8',
    );
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'cold-legacy',
        title: 'Pre-affinity record',
        createdAt: '2026-07-15T12:00:00Z',
        steps: [
          { id: 's1', name: 'plan', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
          { id: 's2', name: 'check', kind: 'check', status: 'done', iterations: 1, tokensUsed: 0 },
        ],
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'cold-legacy')!;

    expect(row.runner).toBe('codex');
    // History, not a projection — so it is NOT marked inherited.
    expect(Object.keys(row)).not.toContain('runnerInherited');
  });

  it('derives the mixed-chain signal as a COUNT, because the row carries no steps', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    const step = (id: string, backend?: string) => ({
      id,
      name: id,
      kind: 'agent',
      status: 'done',
      iterations: 1,
      tokensUsed: 0,
      ...(backend ? { backend } : {}),
    });
    seedColdProject(otherRoot, [
      storedRun({
        id: 'cold-mixed',
        title: 'Mixed chain',
        createdAt: '2026-07-15T12:00:00Z',
        runner: 'claude',
        steps: [step('plan', 'claude'), step('build', 'codex'), step('check')],
      }),
      storedRun({
        id: 'cold-single',
        title: 'One backend',
        createdAt: '2026-07-15T11:00:00Z',
        runner: 'claude',
        steps: [step('plan', 'claude'), step('build', 'claude')],
      }),
    ]);

    const body = await getIndex();
    const row = (id: string) => body.runs.find((entry) => entry.id === id)!;

    expect(row('cold-mixed').stepBackends).toBe(2);
    // Absent when it would say nothing — one backend, or none, is every ordinary run.
    expect(Object.keys(row('cold-single'))).not.toContain('stepBackends');
    // And the expensive half still never reaches the wire; the count is the whole point.
    expect(row('cold-mixed')).not.toHaveProperty('steps');
  });

  it('sends the slim row — no steps, and optional keys absent rather than null', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'cold-1',
        title: 'raw title',
        titleSummary: 'Nice summary',
        titleOrigin: 'auto',
        finishedAt: '2026-07-14T11:00:00Z',
        seenAt: '2026-07-14T12:00:00Z',
      }),
    ]);

    const body = await getIndex();

    const [row] = body.runs;
    expect(row).toEqual({
      projectId: expect.any(String),
      id: 'cold-1',
      title: 'raw title',
      titleSummary: 'Nice summary',
      titleOrigin: 'auto',
      status: 'done',
      createdAt: '2026-07-14T10:00:00Z',
      finishedAt: '2026-07-14T11:00:00Z',
      // The read receipt and the archive flag ride along so the palette can compute `isUnread`
      // for a project it is not standing in — the same inputs the Tasks badge reads.
      seenAt: '2026-07-14T12:00:00Z',
      archived: false,
      // The global Tasks page's own columns: always-present workflow, plus branch/startedAt
      // when the run has them (this one does not — see the absent-key assertions below).
      workflow: 'build',
      // Always present and RESOLVED: this record chose no runner, so the row carries the
      // project's own `defaultRunner` and says out loud that nobody picked it.
      runner: 'claude',
      runnerInherited: true,
    });
    // The fat keys neither consumer has a use for never reach the wire — `workflow` rides along
    // as a plain string, `steps[]` and `workflowDef` (the expensive half) do not.
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('task');
    expect(row).not.toHaveProperty('workflowDef');
    // An absent optional is absent, not `undefined` — the wire has no such value.
    expect(Object.keys(row!)).not.toContain('activity');
    expect(Object.keys(row!)).not.toContain('branch');
    expect(Object.keys(row!)).not.toContain('startedAt');
    // …including every tracker-reference input and every usage field: an untracked, never-run
    // task carries none of them.
    for (const key of [
      'pullRequestUrl',
      'referencedPullRequestUrl',
      'prNumber',
      'issueNumber',
      'referencedIssueUrl',
      'markerRefs',
      'costUsd',
      'peakRssBytes',
      'peakProcCount',
      'usage',
      // No model was recorded and every step shared one backend (there are none), so neither
      // key reaches the wire: the cockpit prints a muted `auto` and no mixed-chain marker.
      'model',
      'stepBackends',
    ]) {
      expect(Object.keys(row!), key).not.toContain(key);
    }
  });

  it('carries cost and the persisted usage peaks the cross-project table paints', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'measured',
        title: 'Measured',
        costUsd: 0.31,
        peakRssBytes: 943718400,
        peakProcCount: 4,
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'measured');

    expect(row).toMatchObject({ costUsd: 0.31, peakRssBytes: 943718400, peakProcCount: 4 });
    // The LIVE sample is not persisted, so a cold project's row never carries one.
    expect(Object.keys(row!)).not.toContain('usage');
  });

  it('carries the tracker-reference inputs so a cross-project row can show its PR/issue chip', async () => {
    // Verbatim, not pre-resolved: the rule that picks between them (#407, #526) lives in the
    // cockpit's `taskReference()`, and resolving it a second time here would be a second rule.
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'tracked',
        title: 'Ship it',
        branch: 'feat/ship',
        startedAt: '2026-07-14T10:00:05Z',
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        prNumber: 42,
        markerRefs: { pr: 42 },
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'tracked');

    expect(row).toMatchObject({
      branch: 'feat/ship',
      startedAt: '2026-07-14T10:00:05Z',
      pullRequestUrl: 'https://github.com/acme/demo/pull/42',
      prNumber: 42,
      markerRefs: { pr: 42 },
    });
    // Still the slim row — the expensive half never rides along.
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('workflowDef');
  });

  it('includes archived runs — findable from a project is findable from anywhere', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({ id: 'live', title: 'Live', createdAt: '2026-07-14T11:00:00Z' }),
      storedRun({ id: 'filed', title: 'Archived', archived: true, createdAt: '2026-07-14T10:00:00Z' }),
    ]);

    const body = await getIndex();

    // The project-scoped `GET /runs` carries archived runs, so the cross-project finder must
    // too — otherwise a task disappears from search the moment you switch away from it.
    expect(body.runs.map((run) => run.id)).toEqual(['live', 'filed']);
  });

  it('caps each project and names it in `truncated`, so no cap is silent', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    // 210 > the 200 cap. Ids sort with the timestamps so the newest survivors are predictable.
    seedColdProject(
      otherRoot,
      Array.from({ length: 210 }, (_, i) => {
        const n = String(i).padStart(3, '0');
        const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
        const minute = String(i % 60).padStart(2, '0');
        return storedRun({ id: `r-${n}`, title: `Task ${n}`, createdAt: `2026-07-14T${hour}:${minute}:00Z` });
      }),
    );

    const body = await getIndex();

    expect(body.runs).toHaveLength(200);
    expect(body.perProjectLimit).toBe(200);
    expect(body.truncated).toEqual([other.id]);
    // The NEWEST 200 survived, not the first 200 in file order.
    expect(body.runs[0]?.id).toBe('r-209');
    expect(body.runs.at(-1)?.id).toBe('r-010');
  });

  it('carries `autoResumeAt`, so a usage-limit park does not read as a failure', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'parked',
        title: 'Waiting out the limit',
        status: 'failed',
        finishedAt: '2026-07-14T11:00:00Z',
        autoResumeAt: '2026-07-14T15:00:00Z',
      }),
    ]);

    const body = await getIndex();

    // `deriveAttention` and `isUnread` both read this field. Dropping it from the slim row would
    // make the palette paint a red "failed" dot on work that is merely waiting for its slot.
    expect(body.runs[0]).toMatchObject({
      id: 'parked',
      status: 'failed',
      autoResumeAt: '2026-07-14T15:00:00Z',
    });
  });

  it('reads a crashed process’s `running` row as interrupted, exactly as opening it would', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [storedRun({ id: 'ghost', title: 'Ghost', status: 'running' })]);

    const body = await getIndex();

    // Shared with `RunStore.open` through `reconcileLoadedRun`: a task cannot read as running in
    // the palette and failed the moment it is opened.
    expect(body.runs[0]?.status).toBe('failed');
  });

  it('skips a project whose folder is gone and degrades a corrupt index to no rows', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    mkdirSync(join(otherRoot, '.local/xezar'), { recursive: true });
    writeFileSync(join(otherRoot, '.local/xezar/runs.json'), '{ not json', 'utf8');
    const live = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });

    const body = await getIndex();

    // One unreadable project costs its own rows, never the whole workspace's search.
    expect(body.runs.map((run) => run.id)).toEqual([live.id]);
  });

  /**
   * Statuses ride along with the rows that carry the references, so the chips are coloured in the
   * same paint as the table rather than a round trip later. The rule that makes it free — and
   * therefore safe on a route the palette hits — is that it reads the ref-status cache and NEVER
   * asks the forge.
   */
  describe('reference statuses', () => {
    it('ships an empty map when the server has looked nothing up', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Has a PR', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, { pullRequestUrl: 'https://github.com/acme/demo/pull/42' });

      const body = await getIndex();

      // Present but empty — never absent, so a consumer can read it without a guard, and never
      // invented, so a cold reference stays "nothing known" rather than a guessed status.
      expect(body.referenceStatuses).toEqual({});
      expect(body.runs.some((row) => row.id === run.id)).toBe(true);
    });

    it('ships what the cache holds, keyed by project', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Has a PR', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        issueNumber: 7,
      });
      // Warm the cache the way the lazy route would have.
      __seedRefStatusCacheForTests(realpathSync(repoRoot), [
        [42, { kind: 'pr', status: 'merged' }],
        [7, { kind: 'issue', status: 'open' }],
      ]);

      const body = await getIndex();

      const project = Object.keys(body.referenceStatuses)[0]!;
      expect(body.referenceStatuses[project]).toEqual({ prs: { 42: 'merged' }, issues: { 7: 'open' } });
    });

    it('looks up every number a run MENTIONS, not just the one its chip will show', async () => {
      // Which reference is displayed is the cockpit's rule (#407, #526) and is deliberately not
      // re-derived here. A cache read costs nothing per number, so the superset is free — and it
      // is what lets the client apply its own rule to whatever it gets.
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Several', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        referencedPullRequestUrl: 'https://github.com/acme/demo/pull/40',
        referencedIssueUrl: 'https://github.com/acme/demo/issues/12',
      });
      __seedRefStatusCacheForTests(realpathSync(repoRoot), [
        [42, { kind: 'pr', status: 'merged' }],
        [40, { kind: 'pr', status: 'ready' }],
        [12, { kind: 'issue', status: 'completed' }],
      ]);

      const body = await getIndex();

      const project = Object.keys(body.referenceStatuses)[0]!;
      expect(body.referenceStatuses[project]).toEqual({
        prs: { 40: 'ready', 42: 'merged' },
        issues: { 12: 'completed' },
      });
    });
  });
});
