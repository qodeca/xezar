import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT_PIN_WINDOW_MS } from '../runs/run-process-ledger.ts';
import { rootNotConfirmedNote } from '../runs/run-process-report.ts';
import { RunProcessSweeper } from '../runs/run-process-sweeper.ts';
import { FakeMachine } from '../runs/run-process-sweeper.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * #943 T-02: the run's root is pinned by the time it was SPAWNED. On Windows `registerRunProcess`
 * starts the sampler's first PowerShell read, which blocks the thread for a second or more under
 * load; a pin read after it missed the ledger's window, the root was rejected, and a later stop
 * swept nothing – silently. Here registration "blocks" by moving the clock past the window, the
 * process table is a fake Windows machine, and the table is read right after the pin.
 */

const usage = vi.hoisted(() => ({
  onRegister: undefined as ((runId: string, pid: number) => void) | undefined,
}));

vi.mock('../core/process-usage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/process-usage.ts')>();
  return { ...actual, registerRunProcess: (runId: string, pid: number) => usage.onRegister?.(runId, pid) };
});

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const ONE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
/** How long registration "blocks": past the window, as a cold PowerShell start under load can. */
const BLOCKED_MS = ROOT_PIN_WINDOW_MS + 500;

/** Reads the table right after each pin and keeps whether the ledger then held the root. */
class ReadAfterPin extends RunProcessSweeper {
  readonly pins: Array<{ pid: number; recorded: boolean }> = [];
  constructor(
    hooks: ConstructorParameters<typeof RunProcessSweeper>[0],
    private readonly machine: FakeMachine,
  ) {
    super(hooks, machine.deps());
  }
  override pinRoot(runId: string, pid: number, spawnedAt: number): void {
    super.pinRoot(runId, pid, spawnedAt);
    this.machine.tick();
    this.pins.push({ pid, recorded: this.ledgerHas(runId, pid) });
  }
}

describe('RunManager pins the run root by its spawn time (#943 T-02)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let machine: FakeMachine;
  let sweeper: ReadAfterPin;
  let skewMs = 0;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-943-pin-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: repoRoot });
    for (const key of ['XEZ_DRY_RUN', 'XEZ_CLAUDE_BIN']) savedEnv[key] = process.env[key];
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_CLAUDE_BIN;
    skewMs = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    // Windows rules on every host: the ledger, not the Linux marker, proves the run's processes.
    machine = new FakeMachine('win32', process.pid);
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: 100_000 } }),
      runProcesses: (hooks) => (sweeper = new ReadAfterPin(hooks, machine)),
    });
  });

  afterEach(async () => {
    usage.onRegister = undefined;
    await manager.quiesce();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    closeStoreAndRemove(store, repoRoot);
  });

  const waitFor = async (pred: () => boolean, what: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const notes = (id: string): string[] =>
    (store.readEvents(id) as Array<{ type: string; message?: string }>)
      .filter((e) => e.type === 'note')
      .map((e) => e.message ?? '');

  it('a registration that blocks past the window still leaves the root recorded, and says nothing', async () => {
    usage.onRegister = (_runId, pid) => {
      // The kernel dated the root when it was spawned – just now – and then the thread stalled.
      machine.add({ pid, ppid: process.pid, startedAt: Date.now() });
      skewMs += BLOCKED_MS;
    };
    const run = manager.startRun(ONE_STEP, { task: 'mock:done', worktree: false });
    await waitFor(() => !manager.isActive(run.id), 'the run to end');
    expect(sweeper.pins).toHaveLength(1);
    expect(sweeper.pins[0]!.recorded).toBe(true);
    expect(notes(run.id).filter((n) => n.startsWith('Could not confirm process'))).toEqual([]);
  }, 60_000);

  it('a root the ledger rejects is named in one note, never skipped in silence', async () => {
    usage.onRegister = (_runId, pid) => {
      // The pid already names a process that started a minute ago: not the one just spawned.
      machine.add({ pid, ppid: process.pid, startedAt: Date.now() - 60_000 });
    };
    const run = manager.startRun(ONE_STEP, { task: 'mock:done', worktree: false });
    await waitFor(() => !manager.isActive(run.id), 'the run to end');
    expect(sweeper.pins).toHaveLength(1);
    const { pid, recorded } = sweeper.pins[0]!;
    expect(recorded).toBe(false);
    expect(notes(run.id).filter((n) => n.startsWith('Could not confirm process'))).toEqual([rootNotConfirmedNote(pid)]);
  }, 60_000);
});
