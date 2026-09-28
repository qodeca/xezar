import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RENAME_HELD_HINT,
  RENAME_RETRY_WAITS_MS,
  renameReplacing,
  renameReplacingSync,
  uniqueTmpPath,
  writeFileAtomic,
  writeFileAtomicSync,
  type RenameSeams,
} from './atomic-write.ts';

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename 'a' -> 'b'`), {
    code,
    errno: -1,
    syscall: 'rename',
    path: 'a',
    dest: 'b',
  });
}

function fakeStats(mode: number, kind: 'file' | 'dir' = 'file'): Stats {
  return { mode, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' } as unknown as Stats;
}

/** A scripted rename: each call takes the next outcome (an error to throw, or `ok`). */
interface Harness {
  seams: RenameSeams;
  renames: number;
  sleeps: number[];
  chmods: Array<[string, number]>;
  lstats: number;
}

function harness(
  outcomes: Array<NodeJS.ErrnoException | 'ok'>,
  options: { platform?: NodeJS.Platform; lstat?: Stats | Error; now?: (h: Harness) => number } = {},
): Harness {
  const h: Harness = { seams: {}, renames: 0, sleeps: [], chmods: [], lstats: 0 };
  const rename = (): void => {
    const outcome = outcomes[h.renames] ?? outcomes[outcomes.length - 1]!;
    h.renames += 1;
    if (outcome !== 'ok') throw outcome;
  };
  const lstat = (): Stats => {
    h.lstats += 1;
    if (options.lstat instanceof Error) throw options.lstat;
    if (!options.lstat) throw fsError('ENOENT');
    return options.lstat;
  };
  const chmod = (path: unknown, mode: unknown): void => {
    h.chmods.push([String(path), Number(mode)]);
  };
  h.seams = {
    platform: options.platform ?? 'win32',
    now: () => (options.now ? options.now(h) : 0),
    sleepSync: (ms) => { h.sleeps.push(ms); },
    sleep: async (ms) => { h.sleeps.push(ms); },
    fs: { renameSync: rename, lstatSync: lstat as never, chmodSync: chmod },
    fsp: {
      rename: async () => rename(),
      lstat: (async () => lstat()) as never,
      chmod: async (path, mode) => chmod(path, mode),
    },
  };
  return h;
}

const both = [
  ['sync', async (h: Harness, to = 'to') => renameReplacingSync('from', to, h.seams)],
  ['async', (h: Harness, to = 'to') => renameReplacing('from', to, h.seams)],
] as const;

/** The error a synchronous call threw – the object itself, so a test can assert identity. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe.each(both)('renameReplacing (%s)', (_name, run) => {
  it.each(['linux', 'darwin'] as const)('makes ONE attempt on %s and rethrows the same error object', async (platform) => {
    const error = fsError('EBUSY');
    const h = harness([error], { platform });
    await expect(run(h)).rejects.toBe(error);
    expect(h.renames).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.lstats).toBe(0);
  });

  it('retries EBUSY and EPERM on win32 until the rename succeeds', async () => {
    const h = harness([fsError('EBUSY'), fsError('EPERM'), 'ok']);
    await run(h);
    expect(h.renames).toBe(3);
    expect(h.sleeps).toEqual([10, 20]);
  });

  it('stops after 8 attempts with an error that names the file, the attempts and the likely cause', async () => {
    const original = fsError('EPERM');
    const h = harness([original]);
    const target = 'C:\\state\\config.json';
    const error = (await run(h, target).then(() => undefined, (e: unknown) => e)) as NodeJS.ErrnoException;
    expect(h.renames).toBe(8);
    expect(h.sleeps).toEqual([...RENAME_RETRY_WAITS_MS]);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(810);
    expect(error.message).toBe(`could not replace ${target} after 8 attempts (EPERM): ${RENAME_HELD_HINT}. Try again in a moment.`);
    expect(error.code).toBe('EPERM');
    expect(error.syscall).toBe('rename');
    expect(error.cause).toBe(original);
  });

  it('never waits past the time budget', async () => {
    // The clock jumps near the budget after the second attempt: the next wait would pass it.
    const h = harness([fsError('EBUSY')], { now: (state) => (state.renames >= 2 ? 995 : 0) });
    const error = (await run(h).then(() => undefined, (e: unknown) => e)) as NodeJS.ErrnoException;
    expect(h.renames).toBe(2);
    expect(h.sleeps).toEqual([10]);
    expect(error.message).toContain('2 attempts');
    expect(error.code).toBe('EBUSY');
  });

  it.each(['ENOENT', 'EXDEV', 'ENOSPC'])('never retries %s and rethrows the original object', async (code) => {
    const error = fsError(code);
    const h = harness([error]);
    await expect(run(h)).rejects.toBe(error);
    expect(h.renames).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('throws at once when the target is a folder – a folder is not held by antivirus', async () => {
    const error = fsError('EPERM');
    const h = harness([error], { lstat: fakeStats(0o40777, 'dir') });
    await expect(run(h)).rejects.toBe(error);
    expect(h.renames).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('makes a read-only target writable and retries at once', async () => {
    const h = harness([fsError('EPERM'), 'ok'], { lstat: fakeStats(0o100444) });
    await run(h);
    expect(h.chmods).toEqual([['to', 0o666]]);
    expect(h.renames).toBe(2);
    expect(h.sleeps).toEqual([]);
  });

  it('puts the read-only flag back when the replace still fails', async () => {
    const h = harness([fsError('EPERM')], { lstat: fakeStats(0o100444) });
    await expect(run(h)).rejects.toMatchObject({ code: 'EPERM' });
    expect(h.chmods).toEqual([['to', 0o666], ['to', 0o444]]);
    expect(h.renames).toBe(9); // one immediate retry after clearing, then the eight bounded ones
    expect(h.sleeps).toEqual([...RENAME_RETRY_WAITS_MS]);
  });

  it('never inspects the target for EBUSY', async () => {
    const h = harness([fsError('EBUSY'), 'ok'], { lstat: fakeStats(0o100444) });
    await run(h);
    expect(h.lstats).toBe(0);
    expect(h.chmods).toEqual([]);
  });

  it('waits when the target cannot be inspected', async () => {
    const h = harness([fsError('EACCES'), 'ok'], { lstat: fsError('ENOENT') });
    await run(h);
    expect(h.lstats).toBe(1);
    expect(h.sleeps).toEqual([10]);
  });
});

describe('writeFileAtomic on the real file system', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xez-atomic-'));
  });
  afterEach(() => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      try { chmodSync(join(dir, name), 0o666); } catch { /* best-effort */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the content and leaves no temporary file (sync and async)', async () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    writeFileAtomicSync(target, 'new', { encoding: 'utf8' });
    expect(readFileSync(target, 'utf8')).toBe('new');
    await writeFileAtomic(target, 'newer', { encoding: 'utf8' });
    expect(readFileSync(target, 'utf8')).toBe('newer');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('stages through <name>.<pid>.<8 hex>.tmp by default and honours tmpPath', () => {
    expect(uniqueTmpPath(join(dir, 'a.json'))).toMatch(/\.\d+\.[0-9a-f]{8}\.tmp$/);
    const target = join(dir, 'runs.json');
    const renames: string[] = [];
    writeFileAtomicSync(target, '[]', { tmpPath: `${target}.tmp` }, {
      fs: { renameSync: (from, to) => { renames.push(String(from)); return renameReplacingSync(String(from), String(to), {}); } },
    });
    expect(renames).toEqual([`${target}.tmp`]);
    expect(readFileSync(target, 'utf8')).toBe('[]');
  });

  it('keeps the old bytes, removes the temporary file and rethrows the original error when the rename fails', async () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    const error = fsError('ENOSPC');
    const fail = { platform: 'linux' as const, fs: { renameSync: () => { throw error; } }, fsp: { rename: async () => { throw error; } } };
    expect(thrownBy(() => writeFileAtomicSync(target, 'new', {}, fail))).toBe(error);
    await expect(writeFileAtomic(target, 'new', {}, fail)).rejects.toBe(error);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it("does not remove a temporary file a 'wx' create found already there", async () => {
    const target = join(dir, 'hook.mjs');
    const tmp = `${target}.1.abc.tmp`;
    writeFileSync(tmp, 'someone else');
    expect(() => writeFileAtomicSync(target, 'x', { tmpPath: tmp, flag: 'wx' })).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    await expect(writeFileAtomic(target, 'x', { tmpPath: tmp, flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(tmp, 'utf8')).toBe('someone else');
    expect(existsSync(target)).toBe(false);
  });

  it('removes the temporary file when the strict temp chmod fails', async () => {
    const target = join(dir, 'lock.json');
    const error = fsError('EPERM');
    expect(thrownBy(() => writeFileAtomicSync(target, 'x', { tempMode: 0o600 }, { fs: { chmodSync: () => { throw error; } } }))).toBe(error);
    await expect(writeFileAtomic(target, 'x', { tempMode: 0o600 }, { fsp: { chmod: async () => { throw error; } } })).rejects.toBe(error);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ignores a failing final chmod', async () => {
    const target = join(dir, 'config.json');
    const refuse = () => { throw fsError('EPERM'); };
    writeFileAtomicSync(target, 'x', { finalMode: 0o600 }, { fs: { chmodSync: refuse } });
    await writeFileAtomic(target, 'y', { finalMode: 0o600 }, { fsp: { chmod: async () => refuse() } });
    expect(readFileSync(target, 'utf8')).toBe('y');
  });

  it('replaces a read-only target and applies the requested final mode', async () => {
    const target = join(dir, 'hook.mjs');
    writeFileSync(target, 'old');
    chmodSync(target, 0o444);
    writeFileAtomicSync(target, 'new', { finalMode: 0o444 });
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(statSync(target).mode & 0o200).toBe(0);
    await writeFileAtomic(target, 'newer', { finalMode: 0o444 });
    expect(readFileSync(target, 'utf8')).toBe('newer');
    expect(statSync(target).mode & 0o200).toBe(0);
    expect(readdirSync(dir)).toEqual(['hook.mjs']);
  });

  it('writes a read-only temporary file and still cleans it up when the rename fails', async () => {
    const target = join(dir, 'hook.mjs');
    const error = fsError('EXDEV');
    const fail = { fs: { renameSync: () => { throw error; } }, fsp: { rename: async () => { throw error; } } };
    expect(thrownBy(() => writeFileAtomicSync(target, 'x', { mode: 0o600, flag: 'wx', tempMode: 0o444 }, fail))).toBe(error);
    await expect(writeFileAtomic(target, 'x', { mode: 0o600, flag: 'wx', tempMode: 0o444 }, fail)).rejects.toBe(error);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// The Windows temp-cleanup branch, driven through the seams so it runs on every OS: Windows refuses
// to delete a read-only temporary file (the 0o444 hook cache) until it is made writable.
describe('writeFileAtomic – removing the temporary file after a failed rename', () => {
  interface Cleanup {
    seams: RenameSeams;
    unlinks: string[];
    chmods: Array<[string, number]>;
  }
  const renameError = fsError('EXDEV');

  /** Every write "succeeds", every rename fails with EXDEV, the first unlink is refused with EPERM. */
  function cleanup(platform: NodeJS.Platform): Cleanup {
    const c: Cleanup = { seams: {}, unlinks: [], chmods: [] };
    const unlink = (path: unknown): void => {
      c.unlinks.push(String(path));
      if (c.unlinks.length === 1) throw fsError('EPERM');
    };
    const chmod = (path: unknown, mode: unknown): void => {
      c.chmods.push([String(path), Number(mode)]);
    };
    c.seams = {
      platform,
      fs: { writeFileSync: () => undefined, renameSync: () => { throw renameError; }, unlinkSync: unlink, chmodSync: chmod },
      fsp: { writeFile: async () => undefined, rename: async () => { throw renameError; }, unlink: async (path) => unlink(path), chmod: async (path, mode) => chmod(path, mode) },
    };
    return c;
  }

  const writers = [
    ['sync', async (c: Cleanup) => thrownBy(() => writeFileAtomicSync('C:\\x\\hook.mjs', 'x', { tmpPath: 'C:\\x\\hook.tmp' }, c.seams))],
    ['async', (c: Cleanup) => writeFileAtomic('C:\\x\\hook.mjs', 'x', { tmpPath: 'C:\\x\\hook.tmp' }, c.seams).then(() => undefined, (e: unknown) => e)],
  ] as const;

  it.each(writers)('%s: on win32 an EPERM unlink makes the temporary file writable and deletes it again', async (_name, write) => {
    const c = cleanup('win32');
    expect(await write(c)).toBe(renameError);
    expect(c.chmods).toEqual([['C:\\x\\hook.tmp', 0o666]]);
    expect(c.unlinks).toEqual(['C:\\x\\hook.tmp', 'C:\\x\\hook.tmp']);
  });

  it.each(writers)('%s: on linux an EPERM unlink is left alone – one unlink, no chmod', async (_name, write) => {
    const c = cleanup('linux');
    expect(await write(c)).toBe(renameError);
    expect(c.chmods).toEqual([]);
    expect(c.unlinks).toEqual(['C:\\x\\hook.tmp']);
  });
});
