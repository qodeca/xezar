import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STATE_NAMES_PAYLOAD } from './local-xezar-top-level-names.ts';
import { runStateNamesCommand, stateNamesJson, type StateNamesIo } from './state-names-cli.ts';

/**
 * `xezar state-names` (#852), exercised through the REAL program.
 *
 * The binding case is the first one: the bytes the command prints must equal the committed
 * fixture, because an external check reads them from an installed copy of this package and a
 * hand-copied list is exactly what the command exists to replace. `index.ts` runs `main()` on
 * import, so the only way to prove the WIRING — that the word reaches the command, and that no
 * banner, mode line or first-run notice shares the stream — is to spawn the program the way a
 * person runs it.
 *
 * The fixture is read here and nowhere in production: the command generates its output from
 * `STATE_NAMES_PAYLOAD`, and `dist/__fixtures__` is not emitted, so a command that read the file
 * would answer nothing once installed.
 */

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const FIXTURE = fileURLToPath(new URL('./__fixtures__/local-xezar-top-level-names.expected.json', import.meta.url));

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A capturing pair of streams, so the in-process cases read both without touching the process. */
function capture(): StateNamesIo & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (text) => void stdout.push(text), err: (text) => void stderr.push(`${text}\n`) };
}

describe('xezar state-names (#852)', () => {
  let home: string;

  /**
   * Every spawn runs in a temporary folder with its own `XEZ_HOME` and a closed stdin. The command
   * is meant to touch neither, and pinning both is what makes "it wrote nothing" a real claim
   * rather than a hope: a case that did reach the first-run door would write inside this folder.
   */
  const cli = (...args: string[]): Run => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, ...args], {
      cwd: home,
      env: { ...process.env, XEZ_HOME: join(home, 'home'), VITEST: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'xezar-state-names-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('prints the fixture bytes exactly, through the real command line', () => {
    const run = cli('state-names', '--json');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(readFileSync(FIXTURE, 'utf8'));
  });

  it('generates those bytes from the module rather than reading the fixture', () => {
    // The control for the case above: with the fixture unreadable the command still answers, which
    // is the whole reason an installed copy can serve it at all.
    expect(stateNamesJson()).toBe(`${JSON.stringify(STATE_NAMES_PAYLOAD, null, 2)}\n`);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(stateNamesJson());
  });

  it('prints a human listing without --json, and says it is not the contract', () => {
    const run = cli('state-names');

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(() => JSON.parse(run.stdout)).toThrow();
    expect(run.stdout).toContain('name');
    expect(run.stdout).toContain('runs.json');
    expect(run.stdout).toContain('worktrees');
    expect(run.stdout).toMatch(/not for parsing/);
    for (const entry of STATE_NAMES_PAYLOAD.names) expect(run.stdout).toContain(entry.name);
  });

  it('refuses an unknown flag with its usage on stderr and a non-zero status', () => {
    const run = cli('state-names', '--jsonn');

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('usage: xezar state-names [--json]');
  });

  it('refuses an extra word the same way', () => {
    const run = cli('state-names', 'names');

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('usage: xezar state-names [--json]');
  });

  it('refuses the command behind a global flag rather than sharing the stream with a boot line', () => {
    const run = cli('--repo', home, 'state-names');

    expect(run.status).toBe(2);
    expect(run.stdout).not.toContain('"schemaVersion"');
    expect(run.stderr).toContain('takes no other option');

    // With `--json` behind a global flag the shared parser refuses first — `--json` belongs to this
    // command, not to the program — so the refusal is the parser's rather than this command's. Both
    // are non-zero and neither prints the payload, which is what the caller depends on.
    const withFlag = cli('--repo', home, 'state-names', '--json');
    expect(withFlag.status).not.toBe(0);
    expect(withFlag.stdout).not.toContain('"schemaVersion"');
  });

  it('is not triggered by the word appearing later on the command line', () => {
    // The word is a command only as the FIRST one, so `xezar run "… state-names …"` stays a run.
    // Proven with `--help`, which reaches the same shared parser without starting anything.
    const run = cli('--help', 'state-names');

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('"schemaVersion"');
  });

  it('answers 0 and 2 through the command function itself', () => {
    const ok = capture();
    expect(runStateNamesCommand(['--json'], ok)).toBe(0);
    expect(ok.stdout.join('')).toBe(stateNamesJson());
    expect(ok.stderr).toEqual([]);

    const bad = capture();
    expect(runStateNamesCommand(['--nope'], bad)).toBe(2);
    expect(bad.stdout).toEqual([]);
    expect(bad.stderr.join('')).toContain('usage: xezar state-names [--json]');
  });

  it('is listed in the help', () => {
    const run = cli('--help');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('xezar state-names [--json]');
  });
});
