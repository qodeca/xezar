import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `--bind-host ""` must behave exactly like the flag being absent (#838 item A, owner decision):
 * both bind loopback only. Before the fix, three call sites each reached their own conclusion
 * about an empty string — `index.ts`'s `bindHost ?? '127.0.0.1'` (only replaces a MISSING value,
 * so `''` passed through), its non-loopback warning (`''` is falsy, so it never fired) and
 * `isLoopbackHost` (`if (!host) return true`, so hosted-mode protections stayed off) — and their
 * disagreement was the defect. The fix normalises the empty value once, where the flag is parsed,
 * so `serveCommand` never sees `''` at all.
 *
 * Exercised through the REAL CLI process, the way a person invokes it, because the property under
 * test — which interface `server.listen()` actually binds — lives in the process, not in a
 * function: `server.listen(port, '')` binds the IPv6 wildcard `::`, which (dual-stack, the
 * default) also accepts `127.0.0.1` connections, so the two cases are indistinguishable from a
 * plain "can I reach 127.0.0.1" probe. Connecting to the IPv6 loopback `::1` is what tells them
 * apart: a socket bound to `127.0.0.1` alone refuses it, one bound to `::` accepts it.
 */

const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
let base: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'xez-bind-host-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }
  rmSync(base, { recursive: true, force: true });
});

function freshRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

/** Boots the real CLI's `serve` command and resolves once it has reported its bound port. */
async function bootServe(repo: string, args: readonly string[]): Promise<{ proc: ChildProcess; port: number; output: string }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', cli, 'serve', '--repo', repo, '--port', '0', '--no-open',
    '--output', 'lines', '--color', 'never', ...args], {
    env: { ...process.env, XEZ_HOME: join(repo, '..', 'xez-home'), XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let output = '';
  let exited = false;
  proc.once('exit', () => { exited = true; });
  for (const pipe of [proc.stdout!, proc.stderr!]) pipe.on('data', (chunk: Buffer) => { output += String(chunk); });
  const port = await new Promise<number>((resolvePort, reject) => {
    const deadline = Date.now() + 20_000;
    const poll = setInterval(() => {
      if (exited) {
        clearInterval(poll);
        reject(new Error(`CLI exited before reporting its bound URL. Output:\n${output}`));
        return;
      }
      const match = /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(output);
      if (match) {
        clearInterval(poll);
        resolvePort(Number(match[1]));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`CLI did not report its bound URL within 20s. Output:\n${output}`));
      }
    }, 25);
  });
  return { proc, port, output };
}

/** Whether a TCP connect to `host:port` succeeds — the only way to tell "bound to 127.0.0.1
 *  alone" from "bound to :: (every interface, dual-stack)" from outside the process. */
async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, family: host === '::1' ? 6 : 4 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const ended = once(proc, 'exit');
  proc.kill('SIGTERM');
  await Promise.race([ended, new Promise((r) => setTimeout(r, 3000))]);
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL');
    await once(proc, 'exit');
  }
}

describe('serve --bind-host (#838 item A)', () => {
  it('an empty --bind-host value binds loopback, not every interface', async () => {
    const { proc, port } = await bootServe(freshRepo('empty'), ['--bind-host', '']);
    try {
      expect(await canConnect('127.0.0.1', port)).toBe(true);
      expect(await canConnect('::1', port)).toBe(false); // would be true if bound to '::'
    } finally {
      await stop(proc);
    }
  }, 25_000);

  it('an absent --bind-host flag still binds loopback (unchanged default)', async () => {
    const { proc, port } = await bootServe(freshRepo('absent'), []);
    try {
      expect(await canConnect('127.0.0.1', port)).toBe(true);
      expect(await canConnect('::1', port)).toBe(false);
    } finally {
      await stop(proc);
    }
  }, 25_000);

  it('a genuinely non-loopback --bind-host still prints the no-auth warning', async () => {
    const { proc, output } = await bootServe(freshRepo('non-loopback'), ['--bind-host', '0.0.0.0']);
    try {
      expect(output).toContain('xezar has no built-in auth');
    } finally {
      await stop(proc);
    }
  }, 25_000);

  it('an empty --bind-host value prints no non-loopback warning (silent by design)', async () => {
    const { proc, output } = await bootServe(freshRepo('empty-silent'), ['--bind-host', '']);
    try {
      expect(output).not.toContain('no built-in auth');
    } finally {
      await stop(proc);
    }
  }, 25_000);
});
