import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from './store.ts';
import { closeStoreAndRemove } from './store.testkit.ts';

type StoredRun = { id: string; steps: Array<{ outputTokens?: number }> };

/**
 * What a run store does when the directory it writes into goes away underneath it (#631, #671
 * rows F-26 and F-29).
 *
 * The defect: `RunStore` debounces its `runs.json` write by 300 ms, and a fixture that removed its
 * temporary directory while that timer was pending got the timer anyway. `saveNow()` hit `ENOENT`
 * on `runs.json.tmp` and `console.error`'d it — a late `console.*` with no test left to own it,
 * which vitest reports as `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
 * pending` (the `MCP per-file coverage` job, red three times on 2026-09-18 with all 2 267 tests
 * passing) and a gate reads as a timeout in whichever case was running when it landed
 * (`acceptance-parity.test.ts` P-14/P-15).
 *
 * These cases run on REAL timers on purpose: the fake-timer discipline at the top of
 * `store.test.ts` is what that file does to avoid this race, so it cannot be what proves the race
 * is gone. The debounce itself is unchanged on the live path, and the last two cases pin that.
 */
describe('RunStore — a vanished data directory is a shutdown, not an error', () => {
  let dataDir: string;
  let errors: string[];

  const metered = (store: RunStore): string => {
    const run = store.createRun({
      title: 'metered task',
      workflow: 'quick-task',
      task: 'metered task',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    return run.id;
  };

  /** A non-decision mutation: exactly what the 300 ms debounce exists to coalesce. */
  const meter = (store: RunStore, id: string, outputTokens: number): void => {
    store.updateStep(id, 'task', { iterations: 1, inputTokens: 10, outputTokens });
  };

  const afterTheDebounce = () => new Promise((resolve) => setTimeout(resolve, 500));

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xez-store-teardown-'));
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a pending debounced save whose directory is gone neither logs nor throws', async () => {
    const store = RunStore.open(dataDir);
    const id = metered(store);
    meter(store, id, 30); // arms the 300 ms debounce

    rmSync(dataDir, { recursive: true, force: true }); // the fixture teardown that used to win
    await afterTheDebounce();

    expect(errors).toEqual([]);
    expect(store.isClosed).toBe(true);
    // The records are still readable in memory: a shutdown, not a corrupted store.
    expect(store.getRun(id)?.steps[0]?.outputTokens).toBe(30);
  });

  it('a write that arrives after the directory is gone is silent too, and schedules nothing', async () => {
    const store = RunStore.open(dataDir);
    const id = metered(store);
    rmSync(dataDir, { recursive: true, force: true });

    meter(store, id, 40);
    await afterTheDebounce();
    meter(store, id, 50);
    await afterTheDebounce();

    expect(errors).toEqual([]);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('close() writes the index out and cancels the debounce, so a later removal is silent', async () => {
    const store = RunStore.open(dataDir);
    const id = metered(store);
    meter(store, id, 60);

    store.close();
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8')) as StoredRun[];
    expect(onDisk.find((r) => r.id === id)?.steps[0]?.outputTokens).toBe(60);

    rmSync(dataDir, { recursive: true, force: true });
    meter(store, id, 70); // a writer that had not finished letting go
    await afterTheDebounce();
    expect(errors).toEqual([]);
    expect(store.isClosed).toBe(true);
  });

  it('close() is idempotent and safe on a store whose directory has already gone', () => {
    const store = RunStore.open(dataDir);
    metered(store);
    rmSync(dataDir, { recursive: true, force: true });

    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
    expect(errors).toEqual([]);
  });

  it('the fixture helper closes the store BEFORE it removes the directory', async () => {
    const store = RunStore.open(dataDir);
    const id = metered(store);
    meter(store, id, 100); // the debounce a fixture teardown used to race

    closeStoreAndRemove(store, dataDir);

    // Closed first, so the index it wrote is complete; removed second, so nothing is left to
    // fire into the gap. A helper that only removed the directory would leave the timer armed.
    expect(store.isClosed).toBe(true);
    expect(existsSync(dataDir)).toBe(false);
    meter(store, id, 110);
    await afterTheDebounce();
    expect(errors).toEqual([]);
  });

  // ---- the controls: what must NOT have changed -------------------------------------------

  it('GUARD: a real write failure with the directory still there is still logged', () => {
    const store = RunStore.open(dataDir);
    const id = metered(store);
    // `runs.json.tmp` as a DIRECTORY: the atomic write fails, but the data directory is present,
    // so this is a disk problem and must stay loud.
    mkdirSync(join(dataDir, 'runs.json.tmp'), { recursive: true });

    meter(store, id, 80);
    store.flush();

    expect(errors.join('\n')).toContain('failed to save runs.json');
  });

  it('GUARD: an open store still debounces and still writes through tmp+rename', async () => {
    const store = RunStore.open(dataDir);
    const id = metered(store);
    meter(store, id, 90);

    await afterTheDebounce();

    const onDisk = JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8')) as StoredRun[];
    expect(onDisk.find((r) => r.id === id)?.steps[0]?.outputTokens).toBe(90);
    expect(existsSync(join(dataDir, 'runs.json.tmp'))).toBe(false);
    expect(store.isClosed).toBe(false);
    expect(errors).toEqual([]);
    store.close();
  });
});
