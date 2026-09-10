import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ghCloneRunner, type RepoRef } from './checkout.ts';

/**
 * `ghCloneRunner` — the only part of the checkout module that talks to a process, and therefore
 * the only part `checkout.test.ts` cannot reach: everything there injects a `CloneRunner` instead.
 * It lives in its own file because the seam is `node:child_process`, and mocking that module in
 * the sibling file would also mock it for the `POST /projects/checkout` cases, which register real
 * projects and probe them with real git.
 *
 * What is worth pinning here is not "gh gets spawned" — it is the two things that are easy to get
 * wrong and impossible to see: the progress stream is split on CARRIAGE RETURNS (git writes its
 * counters that way, and splitting on `\n` alone turns the whole "Receiving objects" phase into
 * one line delivered at the end — the silent spinner this stream exists to avoid), and the error
 * message is gh's own last few lines rather than a paraphrase.
 */

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const REF: RepoRef = { owner: 'qodeca', repo: 'xezar', slug: 'qodeca/xezar' };

/** A stand-in for the spawned `gh`: two readable streams and the two events the runner listens to. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  kill = vi.fn();
}

let child: FakeChild;

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => child);
});

/** Start a clone and collect every progress line it emits. */
function startClone(signal?: AbortSignal) {
  const lines: string[] = [];
  const result = ghCloneRunner(REF, '/tmp/checkouts/xezar', (line) => lines.push(line), signal);
  return { lines, result };
}

describe('ghCloneRunner — the command line', () => {
  it('clones the NORMALIZED slug, into the directory the caller already created', async () => {
    const { result } = startClone();
    child.emit('close', 0);
    await result;

    expect(spawnMock.mock.calls[0]?.[0]).toBe('gh');
    // `--` before `--progress`: everything after it is git's, so no repo spelling can ever be
    // read by `gh` as one of its own flags.
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'repo',
      'clone',
      'qodeca/xezar',
      '/tmp/checkouts/xezar',
      '--',
      '--progress',
    ]);
  });

  it('runs non-interactively and on a timeout, with stdin closed', async () => {
    const { result } = startClone();
    child.emit('close', 0);
    await result;

    const options = spawnMock.mock.calls[0]?.[2] as {
      stdio: string[];
      timeout: number;
      env: Record<string, string>;
    };
    // An unauthenticated `gh` must fail with a message the dialog can show, never block on a
    // prompt nobody can see.
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.env.GH_PROMPT_DISABLED).toBe('1');
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    // Inherited otherwise — `gh` needs PATH and its own config to authenticate at all.
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(options.timeout).toBe(10 * 60_000);
  });
});

describe('ghCloneRunner — progress streaming', () => {
  it('delivers each carriage-return-separated counter as its own line', async () => {
    const { lines, result } = startClone();

    // Exactly what `git clone --progress` writes: one growing line, rewritten in place.
    child.stderr.emit(
      'data',
      'Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.\r'
    );
    child.emit('close', 0);
    await result;

    expect(lines).toEqual([
      'Receiving objects:  10% (1/10)',
      'Receiving objects:  50% (5/10)',
      'Receiving objects: 100% (10/10), done.',
    ]);
  });

  it('holds a partial line back until its terminator arrives', async () => {
    const { lines, result } = startClone();

    child.stderr.emit('data', 'Cloning into ');
    expect(lines).toEqual([]);
    child.stderr.emit('data', "'/tmp/checkouts/xezar'...\n");
    expect(lines).toEqual(["Cloning into '/tmp/checkouts/xezar'..."]);

    child.emit('close', 0);
    await result;
  });

  it('skips blank lines and trims the rest', async () => {
    const { lines, result } = startClone();

    child.stderr.emit('data', '\r\n   \n  remote: Enumerating objects  \n\n');
    child.emit('close', 0);
    await result;

    expect(lines).toEqual(['remote: Enumerating objects']);
  });

  it('reads stdout too, so nothing gh says is lost', async () => {
    const { lines, result } = startClone();

    child.stdout.emit('data', 'Cloning into it\n');
    child.emit('close', 0);
    await result;

    expect(lines).toEqual(['Cloning into it']);
    expect(child.stdout.setEncoding).toHaveBeenCalledWith('utf8');
    expect(child.stderr.setEncoding).toHaveBeenCalledWith('utf8');
  });
});

describe('ghCloneRunner — outcomes', () => {
  it('reports success on exit code 0', async () => {
    const { result } = startClone();
    child.emit('close', 0);

    await expect(result).resolves.toEqual({ ok: true });
  });

  it("hands back gh's own last lines as the error, not a paraphrase", async () => {
    const { result } = startClone();

    // Nine lines; only the last six are kept — a failure's useful part is always at the end,
    // and `git clone` is chatty enough that keeping everything would bury it.
    for (let i = 1; i <= 8; i += 1) child.stderr.emit('data', `noise ${i}\n`);
    child.stderr.emit('data', 'ERROR: Repository not found.\n');
    child.emit('close', 1);

    await expect(result).resolves.toEqual({
      ok: false,
      error: ['noise 4', 'noise 5', 'noise 6', 'noise 7', 'noise 8', 'ERROR: Repository not found.'].join('\n'),
    });
  });

  it('falls back to the exit code when gh said nothing at all', async () => {
    const { result } = startClone();
    child.emit('close', 128);

    await expect(result).resolves.toEqual({ ok: false, error: 'gh repo clone exited with code 128' });
  });

  it('marks a missing gh binary as notFound, which the route degrades on', async () => {
    const { result } = startClone();
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);

    await expect(result).resolves.toEqual({ ok: false, error: 'spawn gh ENOENT', notFound: true });
  });

  it('leaves any other spawn error as an ordinary clone failure', async () => {
    const { result } = startClone();
    child.emit('error', Object.assign(new Error('spawn gh EACCES'), { code: 'EACCES' }));

    await expect(result).resolves.toEqual({ ok: false, error: 'spawn gh EACCES', notFound: false });
  });

  it('settles exactly once — a close after an error does not overwrite the answer', async () => {
    const { result } = startClone();
    child.emit('error', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    child.emit('close', 1);

    await expect(result).resolves.toMatchObject({ notFound: true });
  });
});

describe('ghCloneRunner — cancellation', () => {
  it('kills the clone when the client hangs up', async () => {
    const controller = new AbortController();
    const { result } = startClone(controller.signal);

    controller.abort();

    await expect(result).resolves.toEqual({ ok: false, error: 'checkout cancelled' });
    // Killed rather than left writing into a directory nobody is waiting for — the caller then
    // takes the failure path, which cleans the half-clone up.
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it("the dying process's own close does not overwrite the cancellation", async () => {
    const controller = new AbortController();
    const { result } = startClone(controller.signal);

    controller.abort();
    child.emit('close', 143);

    await expect(result).resolves.toEqual({ ok: false, error: 'checkout cancelled' });
  });

  it('stops listening to the signal once the clone has finished', async () => {
    const controller = new AbortController();
    const { result } = startClone(controller.signal);

    child.emit('close', 0);
    await expect(result).resolves.toEqual({ ok: true });

    // A later abort — the tab closing after a successful clone — must not kill anything.
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('runs without a signal at all', async () => {
    const { result } = startClone(undefined);
    child.emit('close', 0);

    await expect(result).resolves.toEqual({ ok: true });
  });
});
