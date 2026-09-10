import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_PROJECT_OCCUPIED_CODE,
  MCP_PROJECT_OCCUPIED_REASON,
  MCP_SESSION_EXPIRED_CODE,
  MCP_SESSION_EXPIRED_REASON,
  mcpProjectOccupiedErrorSchema,
  mcpSessionExpiredErrorSchema,
} from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import {
  OWNER_ACQUIRE_ATTEMPTS,
  OWNER_CLAIM_DIR,
  OWNER_LEASE_MS,
  OWNER_RENEW_INTERVAL_MS,
  ProjectOwnership,
  type AcquireResult,
  type ProjectOwnershipOptions,
} from './project-owner.ts';

/**
 * #99 — one owner per project, implementing D-02
 * (`docs/features/mcp-server/mcp-d02-session-binding-decision.md` § 6 lists what these prove).
 *
 * Most cases run several `ProjectOwnership` objects in this one process with injected pids, a
 * shared fake clock and an injected liveness probe: each object stands in for a different holder
 * process, which is how "the old process is still alive" and "the old process crashed" are both
 * expressible without timing races. The simultaneous-arrival case alone uses real child processes,
 * because only real processes can interleave inside one acquisition attempt.
 */

const roots: string[] = [];
const owners: ProjectOwnership[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A clock every holder in one test shares, so "30 s later" means the same thing to all of them. */
function fakeClock(start = 1_800_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

/** Pids the test declares alive or dead. Unknown pids count as alive: fail closed. */
function pidTable() {
  const dead = new Set<number>();
  return { isAlive: (pid: number) => !dead.has(pid), kill: (pid: number) => { dead.add(pid); } };
}

function ownership(options: Partial<ProjectOwnershipOptions> & Pick<ProjectOwnershipOptions, 'dataDir'>): ProjectOwnership {
  const owner = new ProjectOwnership({
    projectId: 'proj-a',
    autoRenew: false,
    sleep: async () => {},
    ...options,
  });
  owners.push(owner);
  return owner;
}

function tokenOf(result: AcquireResult): string {
  if (result.outcome !== 'owner') throw new Error(`expected to own the project, got ${result.outcome}`);
  return result.token;
}

function claims(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, OWNER_CLAIM_DIR));
  } catch {
    return [];
  }
}

describe('ProjectOwnership — one owner per project (#99)', () => {
  it('pins the D-02 numbers rather than inventing them', () => {
    // D-02.5 / D-09 B-13, B-14; D-02.2 / D-09 B-15. A change here is a decision change.
    expect(OWNER_RENEW_INTERVAL_MS).toBe(5_000);
    expect(OWNER_LEASE_MS).toBe(30_000);
    expect(OWNER_ACQUIRE_ATTEMPTS).toBe(5);
  });

  it('refuses a second logical client with the occupied error while the first owns the project, revealing nothing about the owner', async () => {
    const dataDir = tempDir('xez-owner-');
    const clock = fakeClock();
    const pids = pidTable();
    const first = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 4101 });
    const token = tokenOf(await first.acquire('session-first'));

    // A second session inside the same service.
    const inProcess = await first.acquire('session-second');
    // A second holder process on the same project, which must go through the claim files.
    let sleeps = 0;
    const other = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 4102, sleep: async () => { sleeps += 1; } });
    const crossProcess = await other.acquire('session-third');

    for (const refused of [inProcess, crossProcess]) {
      expect(refused.outcome).toBe('occupied');
      if (refused.outcome !== 'occupied') continue;
      const error = mcpProjectOccupiedErrorSchema.parse(refused.error); // strict: no extra fields
      expect(error.code).toBe(MCP_PROJECT_OCCUPIED_CODE);
      expect(error.data).toEqual({ reason: MCP_PROJECT_OCCUPIED_REASON, projectId: 'proj-a', retryable: true });
      const wire = JSON.stringify(refused.error);
      for (const secret of [token, 'session-first', '4101', token.split('-').slice(1).join('-')]) {
        expect(wire).not.toContain(secret);
      }
    }
    // The cross-process contender used its whole bounded budget and then answered — no hang.
    expect(sleeps).toBe(OWNER_ACQUIRE_ATTEMPTS - 1);
    // Refusal left the owner exactly as it was, and left no claim of the refused contender behind.
    expect(first.checkMutation(token)).toEqual({ ok: true });
    expect(claims(dataDir)).toHaveLength(1);
    expect(first.state()).toBe('owned');
    expect(other.state()).toBe('owned');
  });

  it('lets many concurrent requests and streams of the SAME owner all succeed', async () => {
    const dataDir = tempDir('xez-owner-');
    const owner = ownership({ dataDir });
    // 200 concurrent `initialize`-shaped arrivals from one logical session: one owner, one token.
    const results = await Promise.all(Array.from({ length: 200 }, () => owner.acquire('session-one')));
    const tokens = new Set(results.map(tokenOf));
    expect(tokens.size).toBe(1);
    const [token] = tokens;
    // 200 concurrent mutations carrying that token: every one passes the fence.
    const checks = await Promise.all(Array.from({ length: 200 }, async () => owner.checkMutation(token!)));
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(owner.sessionToken('session-one')).toBe(token);
    expect(claims(dataDir)).toHaveLength(1);
  });

  it('leaves a different project unaffected', async () => {
    const clock = fakeClock();
    const projectA = ownership({ dataDir: tempDir('xez-owner-a-'), now: clock.now, projectId: 'proj-a' });
    const projectB = ownership({ dataDir: tempDir('xez-owner-b-'), now: clock.now, projectId: 'proj-b' });
    const tokenA = tokenOf(await projectA.acquire('leader-a'));
    const tokenB = tokenOf(await projectB.acquire('leader-b'));
    expect(projectA.checkMutation(tokenA)).toEqual({ ok: true });
    expect(projectB.checkMutation(tokenB)).toEqual({ ok: true });
    // A's token means nothing to B, in either direction.
    expect(projectB.checkMutation(tokenA).ok).toBe(false);
    expect(projectA.checkMutation(tokenB).ok).toBe(false);
  });

  describe('fencing', () => {
    it('after a crash and lease expiry a new owner acquires and the old generation cannot write, though its process is alive', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const pids = pidTable();
      // The old holder "crashes" in the way no transport event reports: it is frozen — alive to the
      // pid probe, and never renewing again.
      const old = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 5101 });
      const oldToken = tokenOf(await old.acquire('old-leader'));

      const next = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 5102 });
      clock.advance(OWNER_LEASE_MS - 1);
      expect((await next.acquire('new-leader')).outcome).toBe('occupied'); // not before the lease
      clock.advance(2);
      expect(next.state()).toBe('expired'); // derived at read time, before anyone reaps
      const newToken = tokenOf(await next.acquire('new-leader'));

      expect(newToken).not.toBe(oldToken);
      // THE FENCE: the live owner's gate refuses the old token by equality.
      const fenced = next.checkMutation(oldToken);
      expect(fenced.ok).toBe(false);
      if (!fenced.ok) {
        const error = mcpSessionExpiredErrorSchema.parse(fenced.error);
        expect(error.code).toBe(MCP_SESSION_EXPIRED_CODE);
        expect(error.data.reason).toBe(MCP_SESSION_EXPIRED_REASON);
      }
      // …and the stale process's own gate refuses it too: its lease lapsed in its own memory.
      expect(old.checkMutation(oldToken).ok).toBe(false);
      expect(next.checkMutation(newToken)).toEqual({ ok: true });
      expect(claims(dataDir)).toHaveLength(1); // the expired claim was reaped
    });

    it('fences the previous owner after a graceful release, where a derived counter would re-issue its generation', async () => {
      const dataDir = tempDir('xez-owner-');
      const owner = ownership({ dataDir });
      const firstToken = tokenOf(await owner.acquire('first'));
      owner.release('first'); // transport close: the claim — the counter's only evidence — is gone
      expect(claims(dataDir)).toEqual([]);
      const secondToken = tokenOf(await owner.acquire('second'));
      expect(secondToken).not.toBe(firstToken);
      expect(owner.checkMutation(firstToken).ok).toBe(false);
      expect(owner.checkMutation(secondToken)).toEqual({ ok: true });
    });

    it('keeps a pre-deletion owner fenced when the whole claim directory is wiped', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const pids = pidTable();
      const old = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 5201 });
      const oldToken = tokenOf(await old.acquire('old-leader'));
      rmSync(join(dataDir, OWNER_CLAIM_DIR), { recursive: true, force: true });
      pids.kill(5201); // the service restarted
      const next = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 5202 });
      const newToken = tokenOf(await next.acquire('new-leader'));
      expect(next.checkMutation(oldToken).ok).toBe(false);
      expect(next.checkMutation(newToken)).toEqual({ ok: true });
    });

    it('frees a dead holder at once on restart — the pid probe, not the lease — and fences its in-flight write', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const pids = pidTable();
      const before = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 5301 });
      const beforeToken = tokenOf(await before.acquire('leader'));
      pids.kill(5301); // SIGKILLed: its claim file survives on disk
      const after = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 5302 });
      expect(after.state()).toBe('expired');
      const afterToken = tokenOf(await after.acquire('leader')); // same client, reconnecting — no clock advance
      expect(afterToken).not.toBe(beforeToken);
      expect(after.checkMutation(beforeToken).ok).toBe(false);
      expect(claims(dataDir)).toHaveLength(1);
    });
  });

  describe('liveness', () => {
    it('treats model silence as life: renewals alone keep an owner that says nothing for minutes', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const pids = pidTable();
      const owner = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 6101 });
      const token = tokenOf(await owner.acquire('quiet-leader'));
      // Ten minutes with no request, no stream, no model turn — only the background renewal timer.
      for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += OWNER_RENEW_INTERVAL_MS) {
        clock.advance(OWNER_RENEW_INTERVAL_MS);
        owner.renewalTick();
      }
      expect(owner.checkMutation(token)).toEqual({ ok: true });
      expect(owner.sessionToken('quiet-leader')).toBe(token);
      const rival = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 6102 });
      expect((await rival.acquire('rival')).outcome).toBe('occupied');
      expect(rival.state()).toBe('owned');
    });

    it('frees the project on confirmed termination (transport close), with no lease wait', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const owner = ownership({ dataDir, now: clock.now });
      const token = tokenOf(await owner.acquire('leader'));
      owner.release('some-other-session'); // a different session closing changes nothing
      expect(owner.checkMutation(token)).toEqual({ ok: true });
      owner.release('leader');
      expect(owner.state()).toBe('unowned');
      expect(owner.checkMutation(token).ok).toBe(false);
      expect(tokenOf(await owner.acquire('successor'))).not.toBe(token);
    });

    it('does not keep a claim for a session whose transport closed while it was still acquiring', async () => {
      const dataDir = tempDir('xez-owner-');
      const owner = ownership({ dataDir });
      const pending = owner.acquire('leaving');
      owner.release('leaving');
      expect((await pending).outcome).toBe('closed');
      expect(claims(dataDir)).toEqual([]);
      expect(owner.state()).toBe('unowned');
    });

    it('a resumed owner whose lease lapsed never renews it, and loses to the owner that took over', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const pids = pidTable();
      const sleeper = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 6201 });
      const sleeperToken = tokenOf(await sleeper.acquire('laptop-leader'));
      const sleeperClaim = claims(dataDir)[0]!;

      clock.advance(OWNER_LEASE_MS + 12_508); // the lid was closed; the renewal timer froze
      const taker = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 6202 });
      const takerToken = tokenOf(await taker.acquire('desktop-leader'));
      const takerClaim = claims(dataDir)[0]!;

      sleeper.renewalTick(); // the first tick after resuming carries the whole gap
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // It did not resurrect or renew its reaped claim: the taker's is still the only one.
      expect(claims(dataDir)).toEqual([takerClaim]);
      expect(claims(dataDir)).not.toContain(sleeperClaim);
      expect(sleeper.sessionToken('laptop-leader')).toBeUndefined();
      expect(sleeper.checkMutation(sleeperToken).ok).toBe(false);
      expect(taker.checkMutation(takerToken)).toEqual({ ok: true });
    });

    it('a resumed owner nobody replaced re-acquires under a NEW token instead of renewing the old one', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const owner = ownership({ dataDir, now: clock.now });
      const oldToken = tokenOf(await owner.acquire('leader'));
      clock.advance(OWNER_LEASE_MS + 1);
      expect(owner.checkMutation(oldToken).ok).toBe(false); // expired before any timer ran
      owner.renewalTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const newToken = owner.sessionToken('leader');
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(oldToken);
      expect(owner.checkMutation(oldToken).ok).toBe(false); // in-flight writes from before stay fenced
      expect(owner.checkMutation(newToken!)).toEqual({ ok: true });
      expect(claims(dataDir)).toHaveLength(1);
    });

    it('renews by rewriting the claim in place, never by recreating a claim that vanished', async () => {
      const dataDir = tempDir('xez-owner-');
      const clock = fakeClock();
      const owner = ownership({ dataDir, now: clock.now });
      const token = tokenOf(await owner.acquire('leader'));
      const path = join(dataDir, OWNER_CLAIM_DIR, claims(dataDir)[0]!);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      clock.advance(OWNER_RENEW_INTERVAL_MS);
      owner.renewalTick();
      const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({ v: 1, token, renewedAt: clock.now() });
      expect(Object.keys(body).sort()).toEqual(['acquiredAt', 'host', 'pid', 'renewedAt', 'token', 'v']);
      expect(JSON.stringify(body)).not.toContain('leader'); // no session key on disk
    });
  });

  describe('N-05 — releasing a lease never cancels or loses a started task', () => {
    it('a task started before the handover keeps running across it and still reaches its terminal status', async () => {
      const repoRoot = tempDir('xez-owner-run-');
      const dataDir = join(repoRoot, '.local/xezar');
      const store = RunStore.open(dataDir);
      const manager = new RunManager(store, repoRoot);
      const gate = join(dataDir, 'owner-gate');
      const held: WorkflowDef = {
        name: 'held',
        source: 'built-in',
        steps: [{
          id: 'hold',
          command: `node -e 'const fs=require("fs");const g=process.argv[1];const d=Date.now()+20000;const p=()=>{if(fs.existsSync(g)||Date.now()>d)return;setTimeout(p,10)};p()' '${gate.replaceAll("'", `'\\''`)}'`,
        }],
      };
      const clock = fakeClock(Date.now());
      const pids = pidTable();
      let runId = '';
      try {
        const leader = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 7101 });
        const leaderToken = tokenOf(await leader.acquire('leader'));
        expect(leader.checkMutation(leaderToken)).toEqual({ ok: true });
        const run = manager.startRun(held, { task: 'survive the handover', worktree: false });
        runId = run.id;
        await waitFor(() => store.readEvents(run.id).some((event) => event.type === 'step-start' && event.stepId === 'hold'), 'the task to start');

        // Every way occupancy can end: a confirmed close, then a crash that only the lease ends.
        leader.release('leader');
        const second = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 7102 });
        tokenOf(await second.acquire('second-leader'));
        clock.advance(OWNER_LEASE_MS + 1);
        const third = ownership({ dataDir, now: clock.now, isAlive: pids.isAlive, pid: 7103 });
        tokenOf(await third.acquire('third-leader'));
        second.renewalTick(); // the stale owner resumes, finds its lease gone, and is fenced
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(store.getRun(run.id)?.status).toBe('running');
        writeFileSync(gate, '');
        await waitFor(() => store.getRun(run.id)?.status === 'done', 'the task to finish');
        expect(store.getRun(run.id)?.status).toBe('done');
      } finally {
        writeFileSync(gate, '');
        // Never delete the fixture under a run that is still writing its closing events.
        await waitFor(() => !runId || ['done', 'failed', 'cancelled', 'review'].includes(store.getRun(runId)?.status ?? ''), 'the task to settle').catch(() => {});
        manager.dispose();
      }
    }, 30_000);

    it('cannot reach a run: the module imports nothing from the run machinery', () => {
      // D-02.7 asks for this pinned by a test, not a convention: the coupling is one import away.
      const source = readFileSync(new URL('./project-owner.ts', import.meta.url), 'utf8');
      const imports = [...source.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((match) => match[1]);
      expect(imports.sort()).toEqual(['@qodeca/xezar-contract', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'zod']);
    });
  });

  it('never admits two owners, and never none, when real processes arrive at once', async () => {
    const dataDir = tempDir('xez-owner-race-');
    const source = new URL('./project-owner.ts', import.meta.url).href;
    const startAt = Date.now() + 1_500;
    const script = `
      const [dataDir, startAt] = [process.argv[1], Number(process.argv[2])];
      const { ProjectOwnership } = await import(${JSON.stringify(source)});
      const owner = new ProjectOwnership({ dataDir, projectId: 'race', autoRenew: false });
      while (Date.now() < startAt) { /* spin to a common start */ }
      const result = await owner.acquire('session-' + process.pid);
      console.log(JSON.stringify({ outcome: result.outcome }));
      setTimeout(() => { owner.dispose(); process.exit(0); }, 2_000); // hold, so any overlap is visible
    `;
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dataDir, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => reject(new Error(`contender did not answer: ${stderr}`)), 15_000);
      child.stdout!.once('data', (chunk) => { clearTimeout(timer); resolve((JSON.parse(String(chunk)) as { outcome: string }).outcome); });
      child.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`contender exited ${code}: ${stderr}`)); });
    })));
    expect(outcomes.filter((outcome) => outcome === 'owner')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'occupied')).toHaveLength(3);
  }, 30_000);
});

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
