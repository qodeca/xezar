import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDACTED } from '../core/secret-redaction.ts';
import { rootNotConfirmedNote } from './run-process-report.ts';
import { RUN_MARKER_ENV, RunProcessSweeper, type RunProcessSweeperDeps } from './run-process-sweeper.ts';
import { FakeMachine, type FakeProcess } from './run-process-sweeper.testkit.ts';

const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN = '99999999-2222-4333-8444-555555555555';
const MARKER = `${RUN_MARKER_ENV}=${RUN}`;
const T0 = 1_800_000_000_000;
const XEZAR = 50;
const XEZAR_PARENT = 40;
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

interface Harness {
  machine: FakeMachine;
  sweeper: RunProcessSweeper;
  reports: Array<[string, string]>;
  tracked: Array<Promise<void>>;
}

function harness(platform: NodeJS.Platform, overrides: Partial<RunProcessSweeperDeps> = {}): Harness {
  const machine = new FakeMachine(platform, XEZAR).add(
    { pid: 1, ppid: 0, startedAt: T0 - 9_000_000 },
    { pid: XEZAR_PARENT, ppid: 1, startedAt: T0 - 60_000 },
    { pid: XEZAR, ppid: XEZAR_PARENT, startedAt: T0 - 50_000 },
  );
  const reports: Array<[string, string]> = [];
  const tracked: Array<Promise<void>> = [];
  const sweeper = new RunProcessSweeper(
    { report: (runId, text) => reports.push([runId, text]), track: (sweep) => tracked.push(sweep) },
    machine.deps(overrides),
  );
  return { machine, sweeper, reports, tracked };
}

/** Run a sweep to its end on the fake clock. */
async function settle(sweep: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await sweep;
}

const marked = (pid: number, extra: Partial<FakeProcess> = {}): FakeProcess => ({
  pid,
  ppid: 1,
  startedAt: T0 + pid,
  environ: ['PATH=/usr/bin', MARKER],
  cmdline: `node job-${pid}.js`,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 100_000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RunProcessSweeper on Linux – the marker in /proc is the proof', () => {
  it("stops every process carrying the run's exact marker, and nothing else (SEC-4, SEC-10)", async () => {
    const { machine, sweeper, reports } = harness('linux');
    machine.add(
      marked(4121, { cmdline: 'node server.js' }),
      marked(4133, { ppid: 4121, cmdline: 'esbuild --watch' }),
      { pid: 5001, ppid: 1, startedAt: T0, environ: [`${RUN_MARKER_ENV}=${OTHER_RUN}`], cmdline: 'node other-run.js' },
      { pid: 5002, ppid: 1, startedAt: T0, environ: ['PATH=/bin'], cmdline: `sh -c "echo ${MARKER}"` },
      { pid: 5003, ppid: 1, startedAt: T0, environ: [`${MARKER}x`], cmdline: 'node near-miss.js' },
      { pid: 5004, ppid: 1, startedAt: T0, environ: [`X${MARKER}`], cmdline: 'node near-miss.js' },
      { pid: 5005, ppid: 1, startedAt: T0, environ: [`NOTE=${MARKER}`], cmdline: 'node near-miss.js' },
    );
    // xezar itself, its parent and init carrying the marker are never targets
    for (const pid of [1, XEZAR_PARENT, XEZAR]) machine.processes.get(pid)!.environ = [MARKER];

    await settle(sweeper.now(RUN, 'cancel'));

    expect(machine.signals).toEqual([
      [4121, 'SIGTERM'],
      [4133, 'SIGTERM'],
    ]);
    for (const pid of [5001, 5002, 5003, 5004, 5005, 1, XEZAR_PARENT, XEZAR]) expect(machine.isAlive(pid)).toBe(true);
    expect(reports).toEqual([[RUN, 'Stopped 2 programs this task started: 4121 node server.js; 4133 esbuild --watch.']]);
  });

  it('never signals a pid that names another process by the time of the signal (SEC-3)', async () => {
    const { machine, sweeper, reports } = harness('linux');
    // two start-time reads bracket the proof; the third, right before SIGTERM, sees a newer process
    machine.add(marked(4200, { reusedAfterReads: 2 }), marked(4201));
    await settle(sweeper.now(RUN, 'cancel'));
    expect(machine.signals).toEqual([[4201, 'SIGTERM']]);
    expect(reports[0]![1]).toBe('Stopped 1 program this task started: 4201 node job-4201.js.');
  });

  it('re-checks the start time before SIGKILL too: a survivor replaced meanwhile is not killed', async () => {
    const { machine, sweeper, reports } = harness('linux');
    machine.add(marked(4300, { survives: ['SIGTERM'], reusedAfterReads: 3 }));
    await settle(sweeper.now(RUN, 'timeout'));
    expect(machine.signals).toEqual([[4300, 'SIGTERM']]);
    expect(reports[0]![1]).toBe('Stopped 1 program this task started: 4300 node job-4300.js.');
  });

  it('escalates to SIGKILL, and names what it may not signal or could not stop', async () => {
    const { machine, sweeper, reports } = harness('linux');
    machine.add(
      marked(4400, { survives: ['SIGTERM'], cmdline: 'node traps-term.js' }),
      marked(4401, { denied: true, cmdline: 'node other-user.js' }),
      marked(4402, { survives: ['SIGTERM', 'SIGKILL'], cmdline: 'python3 -m http.server' }),
    );
    await settle(sweeper.now(RUN, 'memory-limit'));
    expect(machine.signals).toEqual([
      [4400, 'SIGTERM'],
      [4401, 'SIGTERM'],
      [4402, 'SIGTERM'],
      [4400, 'SIGKILL'],
      [4402, 'SIGKILL'],
    ]);
    expect(reports[0]![1]).toBe(
      'Stopped 1 program this task started: 4400 node traps-term.js. Could not stop 2: 4401 node other-user.js (access denied); 4402 python3 -m http.server (still running).',
    );
  });

  it('scans again after stopping, so a restarted child is caught – at most three passes, each pid once', async () => {
    const { machine, sweeper, reports } = harness('linux');
    let next = 4600;
    const respawning = (pid: number): FakeProcess =>
      marked(pid, {
        onDeath: (m) => {
          next += 1;
          m.add(respawning(next));
        },
      });
    machine.add(respawning(next));
    await settle(sweeper.now(RUN, 'cancel'));
    expect(machine.signals.map(([pid]) => pid)).toEqual([4600, 4601, 4602]);
    expect(machine.isAlive(4603)).toBe(true);
    expect(reports[0]![1]).toMatch(/^Stopped 3 programs this task started: 4600 .*; 4601 .*; 4602 /);
  });

  it('ends at its cap, calls an unconfirmed stop "still running", and leaves no timer behind', async () => {
    const { machine, sweeper, reports } = harness('linux', { capMs: 1_000 });
    machine.add(marked(4700, { survives: ['SIGTERM', 'SIGKILL'] }));
    const sweep = sweeper.now(RUN, 'cancel');
    await vi.advanceTimersByTimeAsync(1_000);
    await sweep;
    expect(reports[0]![1]).toBe('Could not stop 1 program this task started: 4700 node job-4700.js (still running).');
    await vi.runAllTimersAsync();
    expect(machine.signals).toEqual([[4700, 'SIGTERM']]); // no SIGKILL after the cap
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says nothing when nothing carries the marker, and does not subscribe to the sampler', async () => {
    const { machine, sweeper, reports } = harness('linux');
    machine.add({ pid: 4800, ppid: 1, startedAt: T0, environ: ['A=1'] });
    sweeper.pinRoot(RUN, 4800, T0);
    expect(machine.subscribed).toBe(false);
    expect(sweeper.ledgerHas(RUN, 4800)).toBe(false);
    await settle(sweeper.now(RUN, 'cancel'));
    expect(machine.signals).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('redacts the command lines it names (SEC-6)', async () => {
    const { machine, sweeper, reports } = harness('linux', { secretValues: () => ['host-secret-value-123'] });
    machine.add(marked(4900, { cmdline: `env GITHUB_TOKEN=${TOKEN} node deploy.js --key-file x host-secret-value-123` }));
    await settle(sweeper.now(RUN, 'cancel'));
    expect(reports[0]![1]).toBe(`Stopped 1 program this task started: 4900 env GITHUB_TOKEN=${REDACTED} node deploy.js --key-file x ${REDACTED}.`);
  });

  it('failing readers whose errors hold a token leave no trace and stop nothing wrongly (SEC-5)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const leak = (): never => {
      throw Object.assign(new Error(`Command failed: GITHUB_TOKEN=${TOKEN}`), { stdout: `GITHUB_TOKEN=${TOKEN}` });
    };
    const { machine, sweeper, reports } = harness('linux', {
      readCommandLines: async () => leak(),
      envHasEntry: async (pid, entry) => (pid === 5100 ? leak() : entry === MARKER && pid === 5101),
    });
    machine.add(marked(5100), marked(5101));
    await settle(sweeper.now(RUN, 'cancel'));
    expect(machine.signals).toEqual([[5101, 'SIGTERM']]);
    expect(reports).toEqual([[RUN, 'Stopped 1 program this task started: 5101.']]);

    const failingTable = harness('linux', { readTable: async () => leak() });
    failingTable.machine.add(marked(5200));
    await settle(failingTable.sweeper.now(RUN, 'cancel'));
    expect(failingTable.machine.signals).toEqual([]);
    expect(failingTable.reports).toEqual([]);
    for (const spy of [error, warn, log]) expect(spy).not.toHaveBeenCalled();
  });
});

describe('RunProcessSweeper on Windows – the ledger is the proof', () => {
  const ROOT = 300;

  function windows(): Harness {
    const h = harness('win32');
    h.machine.add({ pid: ROOT, ppid: XEZAR, startedAt: T0, cmdline: 'node claude.js' });
    h.sweeper.pinRoot(RUN, ROOT, T0 + 500);
    return h;
  }

  it('records the tree at each tick and stops it by identity, orphans included', async () => {
    const { machine, sweeper, reports } = windows();
    machine.add({ pid: 301, ppid: ROOT, startedAt: T0 + 1_000, cmdline: 'cmd /c npm run dev' });
    machine.add({ pid: 302, ppid: 301, startedAt: T0 + 1_100, cmdline: 'node vite.js' });
    machine.tick();
    expect([ROOT, 301, 302].map((pid) => sweeper.ledgerHas(RUN, pid))).toEqual([true, true, true]);
    // the launcher exits; its server lives on, reparented by nobody, and starts a worker
    machine.processes.get(301)!.alive = false;
    machine.add({ pid: 303, ppid: 302, startedAt: T0 + 200_000, cmdline: 'node worker.js' });
    // a process that was started under 301 before it was last seen, never recorded itself
    machine.add({ pid: 304, ppid: 301, startedAt: T0 + 1_500, cmdline: 'node late.js' });
    machine.processes.get(ROOT)!.alive = false;

    await settle(sweeper.now(RUN, 'cancel'));

    const asked = machine.killRequests.flat();
    expect(asked.map(({ pid }) => pid).sort()).toEqual([302, 303, 304]);
    expect(asked.find(({ pid }) => pid === 302)).toEqual({ pid: 302, startedAt: T0 + 1_100 });
    expect(reports[0]![1]).toMatch(/^Stopped 3 programs this task started: /);
    expect(machine.signals).toEqual([]);
  });

  it("leaves strangers, another run's tree and a reused pid alone (SEC-2, SEC-4, SEC-10)", async () => {
    const { machine, sweeper } = windows();
    machine.add({ pid: 400, ppid: XEZAR, startedAt: T0, cmdline: 'node other-claude.js' });
    sweeper.pinRoot(OTHER_RUN, 400, T0);
    machine.add({ pid: 401, ppid: 400, startedAt: T0 + 50, cmdline: 'node other-server.js' });
    machine.add({ pid: 310, ppid: ROOT, startedAt: T0 + 2_000, cmdline: 'node ours.js' });
    machine.tick();
    // a stranger quoting the marker, started beside the run; and pid 310 reused by a newer process
    machine.add({ pid: 500, ppid: XEZAR, startedAt: T0 + 3_000, cmdline: `node -e "${MARKER}"` });
    machine.processes.set(310, { pid: 310, ppid: 1, startedAt: T0 + 90_000, alive: true, cmdline: 'node reused.js' });

    await settle(sweeper.now(RUN, 'cancel'));

    const asked = machine.killRequests.flat().map(({ pid }) => pid);
    expect(asked).toEqual([ROOT]);
    for (const pid of [400, 401, 500, 310]) expect(machine.isAlive(pid)).toBe(true);
  });

  it('names what it may not kill, and what the next table still shows', async () => {
    const { machine, sweeper, reports } = windows();
    machine.add({ pid: 320, ppid: ROOT, startedAt: T0 + 1_000, cmdline: 'node admin.js', denied: true });
    machine.add({ pid: 321, ppid: ROOT, startedAt: T0 + 1_000, cmdline: 'node stuck.js', survives: ['SIGKILL'] });
    machine.tick();
    machine.processes.get(ROOT)!.alive = false;
    await settle(sweeper.now(RUN, 'cancel'));
    expect(reports[0]![1]).toBe('Could not stop 2 programs this task started: 320 node admin.js (access denied); 321 node stuck.js (still running).');
  });

  describe('Git Bash process groups (#963)', () => {
    const flush = (): Promise<void> => vi.runAllTimersAsync().then(() => undefined);

    /** The agent's Bash tool: a Git Bash shell under the root, leading its own MSYS group 865. */
    async function withShell(): Promise<Harness> {
      const h = windows();
      h.machine.add({ pid: 340, ppid: ROOT, startedAt: T0 + 1_000, cmdline: 'bash -c ...', msys: { pid: 865, ppid: 1, pgid: 865 } });
      h.machine.tick();
      await flush();
      return h;
    }

    /** `nohup node dev.js &` from a subshell no read ever saw: its Windows parent is gone. */
    function orphanOf(h: Harness): void {
      h.machine.add({ pid: 342, ppid: 341, startedAt: T0 + 1_200, cmdline: 'nohup node dev.js', msys: { pid: 867, ppid: 1, pgid: 865 } });
      h.machine.add({ pid: 343, ppid: 342, startedAt: T0 + 1_300, cmdline: 'node dev.js', msys: { pid: 868, ppid: 867, pgid: 865 } });
      h.machine.add({ pid: 344, ppid: 343, startedAt: T0 + 1_400, cmdline: 'node worker.js' });
      h.machine.processes.get(340)!.alive = false;
      h.machine.processes.get(ROOT)!.alive = false;
    }

    it('stops what a shell started after its MSYS parent exited between two reads', async () => {
      const h = await withShell();
      orphanOf(h);
      await settle(h.sweeper.now(RUN, 'cancel'));
      expect(h.machine.killRequests.flat().map(({ pid }) => pid).sort()).toEqual([342, 343, 344]);
      expect(h.reports[0]![1]).toMatch(/^Stopped 3 programs this task started: /);
    });

    it('without the group, the same orphans are out of reach (the gap it closes)', async () => {
      const h = windows();
      h.machine.hasGit = false;
      h.machine.add({ pid: 340, ppid: ROOT, startedAt: T0 + 1_000, cmdline: 'bash -c ...', msys: { pid: 865, ppid: 1, pgid: 865 } });
      h.machine.tick();
      await flush();
      orphanOf(h);
      await settle(h.sweeper.now(RUN, 'cancel'));
      expect(h.machine.killRequests.flat().map(({ pid }) => pid)).toEqual([]);
    });

    it('leaves a group whose leader pid MSYS gave to a stranger, and a member older than the leader', async () => {
      const h = await withShell();
      h.machine.processes.get(340)!.alive = false;
      // MSYS reused 865 for a stranger's shell, which leads a group of its own.
      h.machine.add({ pid: 900, ppid: 1, startedAt: T0 + 50_000, cmdline: 'bash stranger', msys: { pid: 865, ppid: 1, pgid: 865 } });
      h.machine.add({ pid: 901, ppid: 900, startedAt: T0 + 50_100, cmdline: 'node stranger.js', msys: { pid: 870, ppid: 865, pgid: 865 } });
      await settle(h.sweeper.now(RUN, 'cancel'));
      expect(h.machine.killRequests.flat().map(({ pid }) => pid)).toEqual([ROOT]);

      const old = await withShell();
      old.machine.add({ pid: 350, ppid: 1, startedAt: T0 + 900, cmdline: 'node older.js', msys: { pid: 880, ppid: 1, pgid: 865 } });
      await settle(old.sweeper.now(RUN, 'cancel'));
      expect(old.machine.killRequests.flat().map(({ pid }) => pid).sort()).toEqual([ROOT, 340]);
    });

    it("reads Git's ps only while a ledger holds something, and at a stop only for a run with a group", async () => {
      const h = harness('win32');
      h.machine.add({ pid: ROOT, ppid: XEZAR, startedAt: T0, cmdline: 'node claude.js' });
      h.machine.tick();
      await flush();
      expect(h.machine.msysReads).toBe(0); // nothing pinned, nothing recorded
      h.sweeper.pinRoot(RUN, ROOT, T0 + 500);
      h.machine.tick();
      await flush();
      expect(h.machine.msysReads).toBe(1);
      h.machine.msysReads = 0;
      await settle(h.sweeper.now(RUN, 'cancel'));
      expect(h.machine.msysReads).toBe(0); // no shell recorded a group

      const g = await withShell();
      g.machine.msysReads = 0;
      await settle(g.sweeper.now(RUN, 'cancel'));
      expect(g.machine.msysReads).toBeGreaterThan(0);
    });

    it('never reads Git ps on macOS', async () => {
      const h = harness('darwin');
      h.machine.add({ pid: ROOT, ppid: XEZAR, startedAt: T0, cmdline: 'node claude.js' });
      h.sweeper.pinRoot(RUN, ROOT, T0 + 500);
      h.machine.tick();
      await flush();
      await settle(h.sweeper.now(RUN, 'cancel'));
      expect(h.machine.msysReads).toBe(0);
    });
  });

  it('confirms a killed pid that is gone without another table read (#963)', async () => {
    let reads = 0;
    const h = harness('win32', {
      readTable: async () => {
        reads += 1;
        return h.machine.table();
      },
    });
    h.machine.add({ pid: ROOT, ppid: XEZAR, startedAt: T0, cmdline: 'node claude.js' });
    h.sweeper.pinRoot(RUN, ROOT, T0 + 500);
    h.machine.add({ pid: 330, ppid: ROOT, startedAt: T0 + 1_000, cmdline: 'node dev.js' });
    h.machine.tick();
    h.machine.processes.get(ROOT)!.alive = false;
    await settle(h.sweeper.now(RUN, 'cancel'));
    expect(h.reports[0]![1]).toMatch(/^Stopped 1 program this task started: 330 node dev\.js/);
    // One read to find it, one rescan that finds nothing – none to confirm a pid that is gone.
    expect(reads).toBe(2);
  });

  it("a timeout keeps the run's ledger; a cancel or pause hands it to the sweep", async () => {
    const { machine, sweeper } = windows();
    machine.tick();
    await settle(sweeper.now(RUN, 'timeout'));
    expect(sweeper.ledgerHas(RUN, ROOT)).toBe(true);
    sweeper.start(RUN, 'memory-limit');
    expect(sweeper.ledgerHas(RUN, ROOT)).toBe(false);
    await settle(sweeper.pending(RUN)!);
  });

  it('names a root the ledger rejects in one note, for that run only (T-02)', async () => {
    const { machine, sweeper, reports } = windows();
    // pid 400 already named a process that started long before this run's spawn
    machine.add({ pid: 400, ppid: XEZAR, startedAt: T0 - 60_000, cmdline: 'node stranger.js' });
    sweeper.pinRoot(OTHER_RUN, 400, T0);
    machine.tick();
    machine.tick();
    expect(reports).toEqual([[OTHER_RUN, rootNotConfirmedNote(400)]]);
    expect(sweeper.ledgerHas(RUN, ROOT)).toBe(true);
    // a stop of that run then finds nothing – already said, not a second note
    await settle(sweeper.now(OTHER_RUN, 'cancel'));
    expect(reports).toHaveLength(1);
  });

  it('reads no table at all for a run whose ledger recorded nothing', async () => {
    let reads = 0;
    const { machine, sweeper, reports } = harness('win32', {
      readTable: async () => {
        reads += 1;
        return machine.table();
      },
    });
    await settle(sweeper.now(RUN, 'cancel'));
    sweeper.pinRoot(RUN, 999, T0); // pinned, but no tick ever saw it
    await settle(sweeper.now(RUN, 'cancel'));
    expect(reads).toBe(0);
    expect(reports).toEqual([]);
  });

  it('drop() forgets the ledger; dispose() stops listening', () => {
    const { machine, sweeper } = windows();
    machine.tick();
    sweeper.drop(RUN);
    expect(sweeper.ledgerHas(RUN, ROOT)).toBe(false);
    sweeper.dispose();
    expect(machine.subscribed).toBe(false);
    sweeper.pinRoot(RUN, ROOT, T0);
    expect(sweeper.ledgerHas(RUN, ROOT)).toBe(false);
  });
});

describe('RunProcessSweeper on macOS – the ledger, with POSIX signals', () => {
  it('signals by the start time the ledger recorded, re-read before each signal', async () => {
    const { machine, sweeper, reports } = harness('darwin');
    machine.add({ pid: 600, ppid: XEZAR, startedAt: T0 }, { pid: 601, ppid: 600, startedAt: T0 + 1_000, cmdline: 'node dev.js' });
    machine.add({ pid: 602, ppid: 600, startedAt: T0 + 1_000, cmdline: 'node gone-soon.js', reusedAfterReads: 0 });
    sweeper.pinRoot(RUN, 600, T0);
    machine.tick();
    machine.processes.get(600)!.alive = false;
    await settle(sweeper.now(RUN, 'cancel'));
    expect(machine.signals).toEqual([[601, 'SIGTERM']]);
    expect(reports[0]![1]).toBe('Stopped 1 program this task started: 601 node dev.js.');
  });
});

describe('RunProcessSweeper – one sweep per run', () => {
  it('chains a second trigger after the first, and keeps the newer promise as pending', async () => {
    const reads: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { machine, sweeper, tracked } = harness('linux', {
      readTable: async () => {
        reads.push(`read ${reads.length + 1}`);
        if (reads.length === 1) await gate;
        return machine.table();
      },
    });
    const first = sweeper.now(RUN, 'timeout');
    sweeper.start(RUN, 'cancel');
    const second = sweeper.pending(RUN)!;
    expect(second).not.toBe(first);
    expect(tracked).toEqual([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['read 1']);
    release();
    await first;
    expect(sweeper.pending(RUN)).toBe(second); // the first's settling does not drop the newer entry
    await settle(second);
    expect(reads).toEqual(['read 1', 'read 2']);
    expect(sweeper.pending(RUN)).toBeUndefined();
  });

  it('a sweep that ends after dispose() still stops its targets but reports nothing', async () => {
    const { machine, sweeper, reports } = harness('linux');
    machine.add(marked(4121));
    const sweep = sweeper.now(RUN, 'cancel');
    sweeper.dispose();
    await settle(sweep);
    expect(machine.isAlive(4121)).toBe(false);
    expect(reports).toEqual([]);
  });

  it('never rejects, even when the report throws', async () => {
    const machine = new FakeMachine('linux', XEZAR).add(marked(4121));
    const sweeper = new RunProcessSweeper(
      {
        report: () => {
          throw new Error('store closed');
        },
      },
      machine.deps(),
    );
    await expect(settle(sweeper.now(RUN, 'cancel'))).resolves.toBeUndefined();
  });
});
