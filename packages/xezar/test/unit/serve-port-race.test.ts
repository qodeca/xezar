import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { launch } from '../../src/platform/process-launch.ts';
import { stopChildTree } from '../../src/platform/process-tree.ts';
import { TEST_DIR_RM_OPTIONS } from '../helpers/platform.ts';

// #238: `xezar serve` printed `cockpit → <url>` before it knew whether the bind worked. It
// proved a port free with a throwaway listener, RELEASED it, and only then let the real server
// bind — so anything that took the port in that gap left a printed URL nobody answered (the
// packaged-CLI e2e saw it as ECONNREFUSED on three release pull requests).
//
// The gap is a few event-loop ticks wide, so waiting for it to happen by chance is useless as a
// test. A preload module (`THIEF` below) makes it certain: it wraps `net.Server` inside the serve
// child and binds the port itself at the exact moment the scenario names. The CLI runs from
// source through tsx, like cli-version.test.ts, so no build is needed.

const packageRoot = resolve(import.meta.dirname, '../..');
const entry = join(packageRoot, 'src', 'index.ts');
// Resolved here, where the repo's node_modules is reachable (see cli-version.test.ts, #27).
const tsxLoader = import.meta.resolve('tsx');
/** Every candidate `serve` may try: the requested port and the 49 after it. */
const PORT_SPAN = 50;
const COCKPIT_LINE = /cockpit → http:\/\/localhost:(\d+)/;

/**
 * The preload. `BOOT_RACE_MODE` picks the moment the port is taken, for every port in
 * `[BOOT_RACE_PORT, BOOT_RACE_PORT + BOOT_RACE_SPAN)`:
 *   - `after-probe`: right after a listener on that port CLOSES — the check-then-use gap.
 *   - `at-bind`: right before anything LISTENS on it — a port that is busy when bound.
 * The thief binds through the same async host lookup `listen(port, host)` uses and is queued
 * first, so it always wins. It accepts connections and never answers, like a real squatter.
 */
const THIEF = `
import net from 'node:net';
const mode = process.env.BOOT_RACE_MODE;
const first = Number(process.env.BOOT_RACE_PORT);
const span = Number(process.env.BOOT_RACE_SPAN);
const inRange = (port) => port >= first && port < first + span;
const listen = net.Server.prototype.listen;
const close = net.Server.prototype.close;
const thieves = new Set();
const stolen = new Set();
function steal(port, host) {
  if (stolen.has(port)) return;
  stolen.add(port);
  const thief = net.createServer();
  thieves.add(thief);
  thief.on('error', () => {});
  listen.call(thief, port, host);
  thief.unref();
}
if (mode === 'after-probe') {
  net.Server.prototype.close = function (...args) {
    const address = this.address();
    if (!thieves.has(this) && address && typeof address === 'object' && inRange(address.port)) {
      this.once('close', () => steal(address.port, address.address));
    }
    return close.apply(this, args);
  };
}
if (mode === 'at-bind') {
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    const port = Number(options.port);
    if (!thieves.has(this) && inRange(port)) steal(port, options.host ?? '127.0.0.1');
    return listen.apply(this, args);
  };
}
`;

const fixtureRoot = await mkdtemp(join(tmpdir(), 'xez-serve-race-'));
const thiefPath = join(fixtureRoot, 'thief.mjs');
await writeFile(thiefPath, THIEF, 'utf8');
/** The clean-up of every `serve` child not yet cleaned up. A test that fails or times out can
 *  leave its child running – its `bootServe` is still polling – so the folder is removed only
 *  after each of these has run. */
const cleanups = new Set<() => Promise<void>>();
after(async () => {
  await Promise.all([...cleanups].map((cleanup) => cleanup()));
  await rm(fixtureRoot, TEST_DIR_RM_OPTIONS);
});

/** True when `promise` settles within `ms`. The timer is cancelled either way, so a race that
 *  is already decided never holds the event loop open. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([promise.then(() => true, () => true), sleep(ms, false, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

interface Boot {
  output: string;
  /** The port the cockpit line named, or undefined when no cockpit line was printed. */
  port: number | undefined;
  /** Exit code when the process ended on its own, undefined while it is still serving. */
  exitCode: number | null | undefined;
  /** `GET /api/v1/health` status on the printed port, or the error that request failed with. */
  health: number | string | undefined;
}

/**
 * Boot `serve` with the thief preloaded, wait for a cockpit line or an exit, probe the printed
 * URL once, then stop the process by the PID this test started — never by pattern.
 *
 * Windows: the child starts through `launch` and stops through `stopChildTree`, which also stops
 * what it started. `child.kill()` alone ends only `serve` there, and what it started lives on –
 * tsx's own esbuild service among them, which inherits the stderr pipe this test reads. Such a
 * leftover was seen stuck in its own exit with its handles still open: its pipe end kept this
 * file's process alive with no time limit, and the boot folder it worked in could not be removed
 * (EBUSY). So the child works outside the fixture, and this side closes its pipes, bounded.
 */
async function bootServe(mode: 'after-probe' | 'at-bind', firstPort: number, span: number): Promise<Boot> {
  const dir = await mkdtemp(join(fixtureRoot, 'boot-'));
  const child = launch(
    process.execPath,
    [
      '--import', tsxLoader, '--import', pathToFileURL(thiefPath).href,
      entry, 'serve', '--no-open', '--port', String(firstPort), '--repo', dir,
    ],
    {
      // `--repo` names the project; the working folder is only what leftovers would pin.
      cwd: packageRoot,
      env: {
        ...process.env,
        BOOT_RACE_MODE: mode,
        BOOT_RACE_PORT: String(firstPort),
        BOOT_RACE_SPAN: String(span),
        // The same isolation the packaged-CLI boot uses, plus no background skills update.
        XEZ_DRY_RUN: '1',
        XEZ_HOME: join(dir, 'home'),
        XEZ_NO_BANNER: '1',
        XEZ_SKILLS_AUTO_UPDATE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  let exitCode: number | null | undefined;
  const exited = once(child, 'exit').then(([code]) => { exitCode = code as number | null; });
  // Both pipes end only when every process holding their write end – serve and anything that
  // inherited it – is gone.
  const pipesClosed = Promise.all([once(child.stdout, 'close'), once(child.stderr, 'close')]).then(() => {}, () => {});
  const reap = () => { child.kill('SIGKILL'); };
  process.once('exit', reap);
  let stopping: Promise<void> | undefined;
  const cleanup = (): Promise<void> => (stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await stopChildTree(child, 'SIGTERM');
      if (!(await within(exited, 10_000))) {
        await stopChildTree(child, 'SIGKILL');
        await within(exited, 10_000);
      }
    }
    // Bounded: a leftover that never lets go of its pipe end must not keep this process alive.
    await within(pipesClosed, 5_000);
    child.stdout.destroy();
    child.stderr.destroy();
    process.off('exit', reap);
    cleanups.delete(cleanup);
  })());
  cleanups.add(cleanup);
  try {
    const deadline = Date.now() + 60_000;
    while (!COCKPIT_LINE.test(output) && exitCode === undefined && Date.now() < deadline) await sleep(50);
    const printed = COCKPIT_LINE.exec(output);
    const port = printed ? Number(printed[1]) : undefined;
    let health: number | string | undefined;
    if (port !== undefined) {
      // The old boot printed first and died a moment later; give it that moment, so the
      // check sees the state a client trusting the line would see.
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(5_000) });
        health = res.status;
      } catch (err) {
        const cause = (err as { cause?: { code?: string } }).cause?.code;
        health = cause ?? (err instanceof Error ? err.name : String(err));
      }
    }
    return { output, port, exitCode, health };
  } finally {
    await cleanup();
  }
}

/** A port free right now with `span - 1` more after it that still fit under 65536. */
async function freePort(span: number): Promise<number> {
  for (;;) {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    assert.ok(address && typeof address === 'object');
    probe.close();
    await once(probe, 'close');
    if (address.port + span <= 65_536) return address.port;
  }
}

test('a port taken between the free-port check and the bind never leaves a cockpit URL that does not answer', { timeout: 120_000 }, async () => {
  const wanted = await freePort(1);
  const boot = await bootServe('after-probe', wanted, 1);
  assert.notEqual(boot.port, undefined, `serve never printed its cockpit line. Output:\n${boot.output}`);
  assert.equal(boot.health, 200, `the printed cockpit URL must answer (got ${String(boot.health)}). Output:\n${boot.output}`);
  assert.equal(boot.exitCode, undefined, `serve must keep serving after it printed the URL. Output:\n${boot.output}`);
});

// Guard, not the regression: this one passed before the fix too, because the old probe was the
// first listener on the port and simply moved on. It pins the port-fallback contract
// (the backward-compatibility promise) for the new bind-and-retry path.
test('a port that is busy at bind time moves serve to the next port and says so', { timeout: 120_000 }, async () => {
  const wanted = await freePort(PORT_SPAN);
  const boot = await bootServe('at-bind', wanted, 1);
  assert.notEqual(boot.port, undefined, `serve never printed its cockpit line. Output:\n${boot.output}`);
  assert.notEqual(boot.port, wanted, 'a taken port must not be the port serve reports');
  assert.equal(boot.health, 200, `the fallback port must answer (got ${String(boot.health)}). Output:\n${boot.output}`);
  assert.match(boot.output, new RegExp(`port ${wanted} was busy — using ${boot.port}`));
});

test('when every candidate port is taken, serve prints no cockpit URL and exits with a clear error', { timeout: 120_000 }, async () => {
  const wanted = await freePort(PORT_SPAN);
  const boot = await bootServe('at-bind', wanted, PORT_SPAN);
  assert.equal(boot.port, undefined, `serve must not print a cockpit URL it cannot serve. Output:\n${boot.output}`);
  assert.equal(boot.exitCode, 1, `serve must exit 1 when no port is free. Output:\n${boot.output}`);
  assert.match(boot.output, new RegExp(`no free port in ${wanted}–${wanted + PORT_SPAN - 1}`));
});
