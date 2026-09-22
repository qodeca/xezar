import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { leaseProbe, leaseProbeJson, leaseProbeSchema } from './lease-probe.ts';

/**
 * `xezar lease gates --probe` (#838 item B), exercised through the REAL program.
 *
 * The probe exists so a caller never has to read the `usage: xezar lease gates …` text to learn
 * whether this xezar can lease gate slots. Three properties are the contract and each has a case:
 * the exact bytes of the answer, that it writes nothing (above all nothing under the gate-slots
 * directory), and that every other `lease gates` invocation behaves exactly as it did before.
 *
 * Every spawn pins `HOME` (the slot directory is `~/.cache/xez/gate-slots` in every layout) and
 * `XEZ_HOME`, so no case can queue behind, or be queued by, a real gate run on this machine.
 */

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every path under `root`, relative and sorted; `[]` for a folder that does not exist. */
function listTree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
}

describe('xezar lease gates --probe (#838 B)', () => {
  let base: string;
  let home: string;
  let xezarHome: string;
  let slotDir: string;

  const cli = (args: readonly string[], cwd: string = base): Run => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, ...args], {
      cwd,
      env: { ...process.env, HOME: home, XEZ_HOME: xezarHome, VITEST: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'xezar-lease-probe-'));
    home = join(base, 'home');
    xezarHome = join(base, 'xezar-home');
    slotDir = join(home, '.cache', 'xez', 'gate-slots');
    mkdirSync(home);
  });
  afterAll(() => {
    if (existsSync(slotDir)) chmodSync(slotDir, 0o700);
    rmSync(base, { recursive: true, force: true });
  });

  it('prints exactly one JSON line naming the gates lease and the resolved slot count, exit 0', () => {
    const run = cli(['lease', 'gates', '--probe']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{"lease":{"gates":true},"slots":1}\n');
    expect(leaseProbeSchema.parse(JSON.parse(run.stdout))).toEqual({ lease: { gates: true }, slots: 1 });
  });

  it('creates no file under the gate-slots directory, nor in either state home', () => {
    rmSync(slotDir, { recursive: true, force: true });

    const run = cli(['lease', 'gates', '--probe']);

    expect(run.status).toBe(0);
    expect(existsSync(slotDir)).toBe(false);
    expect(listTree(home)).toEqual([]);
    expect(listTree(xezarHome)).toEqual([]);
  });

  it('gives the same answer when the slot directory exists but cannot be written, and adds nothing to it', () => {
    // Capability, not health: the verb runs the command anyway on an unusable directory, so the
    // probe must not report the lease as missing there.
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, 'gate-slot-1.lock'), 'someone else\n');
    const before = listTree(slotDir);
    chmodSync(slotDir, 0o500);
    try {
      const run = cli(['lease', 'gates', '--probe']);

      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('{"lease":{"gates":true},"slots":1}\n');
      expect(listTree(slotDir)).toEqual(before);
      expect(readFileSync(join(slotDir, 'gate-slot-1.lock'), 'utf8')).toBe('someone else\n');
    } finally {
      chmodSync(slotDir, 0o700);
      rmSync(slotDir, { recursive: true, force: true });
    }
  });

  it('reports the stored gateSlots of the global layout', () => {
    mkdirSync(xezarHome, { recursive: true });
    writeFileSync(join(xezarHome, 'config.json'), `${JSON.stringify({ resources: { gateSlots: 4 } })}\n`);
    try {
      const run = cli(['lease', 'gates', '--probe']);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe('{"lease":{"gates":true},"slots":4}\n');
      expect(listTree(xezarHome)).toEqual(['config.json']);
    } finally {
      rmSync(xezarHome, { recursive: true, force: true });
    }
  });

  it('reports the project’s own gateSlots in single-project mode and writes nothing into the project', () => {
    // The shape the ordinary boot writes `.local/xezar/` and the first-run import into, so an
    // unchanged tree is a claim, not a hope.
    const project = mkdtempSync(join(base, 'single-project-'));
    expect(spawnSync('git', ['init', '-q'], { cwd: project }).status).toBe(0);
    mkdirSync(join(project, '.xezar'));
    writeFileSync(join(project, '.xezar', 'workspace.json'), `${JSON.stringify({ resources: { gateSlots: 3 } })}\n`);
    const before = listTree(project);

    const run = cli(['--repo', project, '--single-project', 'lease', 'gates', '--probe']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{"lease":{"gates":true},"slots":3}\n');
    expect(listTree(project)).toEqual(before);
    expect(listTree(xezarHome)).toEqual([]);
    expect(existsSync(slotDir)).toBe(false);
  });

  it('refuses a probe that also names a command, another lease or an unknown flag: exit 2, nothing on stdout', () => {
    for (const args of [
      ['lease', 'gates', '--probe', '--', 'true'],
      ['lease', 'other', '--probe'],
      ['lease', '--probe'],
      ['lease', 'gates', '--probe', '--probee'],
      ['lease', 'gates', 'extra', '--probe'],
    ]) {
      const run = cli(args);
      expect(run.status, args.join(' ')).toBe(2);
      expect(run.stdout, args.join(' ')).toBe('');
      expect(run.stderr, args.join(' ')).toContain('usage: xezar lease gates --probe');
    }
    expect(existsSync(slotDir)).toBe(false);
  });

  it('builds its bytes from the schema, clamping the slot count the way the lease does', () => {
    expect(leaseProbeJson(leaseProbe(undefined))).toBe('{"lease":{"gates":true},"slots":1}\n');
    expect(leaseProbe(40).slots).toBe(16);
    expect(leaseProbe(0).slots).toBe(1);
    expect(() => leaseProbeSchema.parse({ lease: { gates: true }, slots: 1, extra: 1 })).toThrow();
  });
});

describe('xezar lease gates -- <command> is unchanged by the probe (#838 B)', () => {
  let base: string;
  let home: string;

  const cli = (args: readonly string[]): Run => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, ...args], {
      cwd: base,
      env: { ...process.env, HOME: home, XEZ_HOME: join(base, 'xezar-home'), VITEST: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'xezar-lease-unchanged-'));
    home = join(base, 'home');
    mkdirSync(home);
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('passes the command’s stdout and exit code through, and leaves stdout to the command alone', () => {
    const run = cli(['lease', 'gates', '--', process.execPath, '-e', 'process.stdout.write("out\\n"); process.exit(3)']);

    expect(run.status).toBe(3);
    expect(run.stdout).toBe('out\n');
    expect(run.stderr).toContain('gate slot 1 of 1 taken');
  });

  it('hands a --probe AFTER `--` to the command rather than answering it', () => {
    // A script FILE, because `node -e … --probe` would read `--probe` as node's own option.
    const script = join(base, 'print-args.mjs');
    writeFileSync(script, 'process.stdout.write(process.argv.slice(2).join(" ") + "\\n");\n');
    const run = cli(['lease', 'gates', '--', process.execPath, script, '--probe']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('--probe\n');
  });

  it('still writes the --status-file line', () => {
    const statusFile = join(base, 'status.json');
    const run = cli(['lease', 'gates', '--status-file', statusFile, '--', process.execPath, '-e', '']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
    expect(status).toMatchObject({ held: true, outcome: 'acquired', slot: 1, slots: 1 });
  });

  it('keeps its usage refusals at exit 2 with nothing on stdout', () => {
    for (const args of [['lease'], ['lease', 'other', '--', 'true'], ['lease', 'gates']]) {
      const run = cli(args);
      expect(run.status, args.join(' ')).toBe(2);
      expect(run.stdout, args.join(' ')).toBe('');
    }
  });
});
