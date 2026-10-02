import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentifiedPid, ProcessTable } from './process-table.ts';
import { readTableThenKill, type KillHelper, type TableThenKillDeps } from './table-then-kill.ts';

/**
 * The one-PowerShell descendant stop (#963 C-02), on every OS against a fake helper: the exchange
 * (table, `end-of-table`, one line of targets on stdin, outcomes), what is written to the helper,
 * the priority raise, and every way it can end – it never rejects. The real helper runs in
 * process-tree.windows.test.ts.
 */

const SYSTEM = { SystemRoot: 'C:\\Windows' };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const JAN_1_2024_FILETIME = '133485408000000000';
const JAN_1_2024_MS = Date.UTC(2024, 0, 1);
const TABLE_TEXT = `queried ${JAN_1_2024_FILETIME}\r\n100 4 10 0 ${JAN_1_2024_FILETIME}\r\n101 100 10 0 ${JAN_1_2024_FILETIME}\r\n`;

class FakeHelper extends EventEmitter implements KillHelper {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.close());
    return true;
  });
  /** Everything xezar wrote to the helper's stdin. */
  written = '';
  readonly pid: number | undefined;
  constructor(options: { pid?: number } = { pid: 7000 }) {
    super();
    this.pid = options.pid;
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.written += chunk;
    });
  }
  say(text: string): void {
    this.stdout.write(text);
  }
  close(): void {
    this.stdout.end();
    this.emit('close');
  }
}

interface Harness {
  helper: FakeHelper;
  started: Array<[string, readonly string[]]>;
  raised: number[];
  deps: TableThenKillDeps;
}

function harness(overrides: Partial<TableThenKillDeps> = {}, helper = new FakeHelper()): Harness {
  const started: Array<[string, readonly string[]]> = [];
  const raised: number[] = [];
  const deps: TableThenKillDeps = {
    platform: 'win32',
    env: SYSTEM,
    start: (file, args) => {
      started.push([file, args]);
      return helper;
    },
    raise: (pid) => raised.push(pid),
    ...overrides,
  };
  return { helper, started, raised, deps };
}

/** Lets the stream events of everything written so far be delivered. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('readTableThenKill', () => {
  it('starts nothing off Windows or without a drive SystemRoot', async () => {
    const choose = vi.fn(() => []);
    for (const deps of [{ platform: 'linux' as const }, { platform: 'darwin' as const }, { platform: 'win32' as const, env: {} }]) {
      const { started, deps: full } = harness(deps);
      expect(await readTableThenKill(choose, { timeoutMs: 1_000 }, { ...full, ...deps })).toBeNull();
      expect(started).toEqual([]);
    }
    expect(choose).not.toHaveBeenCalled();
  });

  it('runs ONE System32 PowerShell that reads the table, then the targets from stdin, then kills by identity', async () => {
    const { helper, started, raised, deps } = harness();
    const pending = readTableThenKill(() => [], { timeoutMs: 1_000 }, deps);
    expect(started).toHaveLength(1);
    const [file, args] = started[0]!;
    expect(file).toBe(POWERSHELL);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    const order = ['queried', 'Get-CimInstance Win32_Process', '"end-of-table"', '[Console]::In.ReadLine()', '$null = $p.Handle'];
    const at = order.map((part) => script.indexOf(part));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(script).not.toMatch(/taskkill|Stop-Process/);
    // above-normal priority, so programs busy at normal priority do not starve the stop
    expect(raised).toEqual([7000]);
    helper.close();
    expect(await pending).toBeNull();
  });

  it('hands `choose` the table, writes only valid targets, and answers the outcomes of those', async () => {
    const { helper, deps } = harness();
    let seen: ProcessTable | undefined;
    const choose = (table: ProcessTable): IdentifiedPid[] => {
      seen = table;
      return [
        { pid: 101, startedAt: JAN_1_2024_MS },
        { pid: 101, startedAt: JAN_1_2024_MS }, // once
        { pid: 4, startedAt: JAN_1_2024_MS }, // the System process
        { pid: process.pid, startedAt: JAN_1_2024_MS }, // xezar itself
        { pid: 102.5, startedAt: JAN_1_2024_MS },
        { pid: 103, startedAt: 0 },
      ];
    };
    const pending = readTableThenKill(choose, { timeoutMs: 1_000 }, deps);
    helper.say(TABLE_TEXT);
    await flush();
    expect(helper.written).toBe(''); // nothing before the table is complete
    helper.say('end-of-table\r\n');
    await flush();
    expect(seen).toEqual({
      rows: [
        { pid: 100, ppid: 4, rssKb: 10, cpuPct: 0, startedAt: JAN_1_2024_MS },
        { pid: 101, ppid: 100, rssKb: 10, cpuPct: 0, startedAt: JAN_1_2024_MS },
      ],
      queriedAt: JAN_1_2024_MS,
    });
    expect(helper.written).toBe(`101,${JAN_1_2024_MS}\n`);
    expect(helper.stdin.writableEnded).toBe(true);
    helper.say('101 killed\r\n4 killed\r\n999 killed\r\n');
    helper.close();
    const result = await pending;
    expect(result?.outcomes).toEqual(new Map([[101, 'killed']]));
    expect(result?.table).toBe(seen);
  });

  it('writes an empty line when there is nothing to kill, or `choose` throws', async () => {
    for (const choose of [() => [], () => { throw new Error('boom'); }]) {
      const { helper, deps } = harness();
      const pending = readTableThenKill(choose, { timeoutMs: 1_000 }, deps);
      helper.say(`${TABLE_TEXT}end-of-table\n`);
      await flush();
      expect(helper.written).toBe('\n');
      helper.close();
      expect((await pending)?.outcomes).toEqual(new Map());
    }
  });

  it('ends the helper at the bound: null before the table, the table and what was killed after it', async () => {
    vi.useFakeTimers();
    const early = harness();
    const none = readTableThenKill(() => [], { timeoutMs: 5_000 }, early.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(early.helper.kill).toHaveBeenCalledTimes(1);
    expect(await none).toBeNull();

    const late = harness();
    const some = readTableThenKill(() => [{ pid: 101, startedAt: JAN_1_2024_MS }], { timeoutMs: 5_000 }, late.deps);
    late.helper.say(`${TABLE_TEXT}end-of-table\n`);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(late.helper.kill).toHaveBeenCalledTimes(1);
    const result = await some;
    expect(result?.table.rows).toHaveLength(2);
    expect(result?.outcomes).toEqual(new Map());
  });

  it('never rejects: a start that throws, a helper that fails, a raise that throws', async () => {
    const throwing = harness({
      start: () => {
        throw new Error('EPERM');
      },
    });
    expect(await readTableThenKill(() => [], { timeoutMs: 1_000 }, throwing.deps)).toBeNull();

    const failing = harness();
    const pending = readTableThenKill(() => [], { timeoutMs: 1_000 }, failing.deps);
    failing.helper.emit('error', new Error('ENOENT'));
    expect(await pending).toBeNull();

    const noRaise = harness({
      raise: () => {
        throw new Error('EACCES');
      },
    });
    const raised = readTableThenKill(() => [], { timeoutMs: 1_000 }, noRaise.deps);
    noRaise.helper.say(`${TABLE_TEXT}end-of-table\n`);
    await flush();
    noRaise.helper.close();
    expect((await raised)?.table.rows).toHaveLength(2);
  });

  it('raises nothing for a helper without a pid, and survives a helper that closed its stdin', async () => {
    const { helper, raised, deps } = harness({}, new FakeHelper({}));
    helper.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const pending = readTableThenKill(() => [{ pid: 101, startedAt: JAN_1_2024_MS }], { timeoutMs: 1_000 }, deps);
    helper.say(`${TABLE_TEXT}end-of-table\n`);
    await flush();
    helper.close();
    expect((await pending)?.outcomes).toEqual(new Map());
    expect(raised).toEqual([]);
  });
});
