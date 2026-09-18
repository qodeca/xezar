/**
 * MP-11 / #342: a task-spawned client never sees the project's own `xezar` MCP bridge entry.
 *
 * The bug: xezar's bridge takes the project OWNER slot the moment it connects, and a
 * `keep-alive` entry connects at start-up with no prompt and no tool call. A `worktree: false`
 * run starts in the project root, so the task's own client held the slot for the run's lifetime
 * and the person's leader was refused `-32080 project occupied` (observed with pi, #342). The
 * `--tools` / `--allowedTools` allowlists hide the tools from the model; they do not stop the
 * client connecting.
 *
 * Named break for the red proof: `worktree-off-inherits-xezar` — revert the three runner source
 * files (`claude-cli-runner.ts`, `pi-runner.ts`, `opencode-server-runner.ts`) to the state that
 * passes no MCP isolation at all. Measured: 5 of these 16 cases fail — the three `the seam` cases
 * (the spawned client's effective MCP config carries `xezar` again) and the two `fail-open` cases
 * that also reach into a runner.
 *
 * The other eleven are CONTROLS: they exercise `run-mcp-isolation.ts`, which the break does not
 * touch, so they stay green either way. They pin the behaviour this change did NOT want to alter —
 * a project's other servers survive, a broken file never stops a run, and the run note never
 * claims a bridge nobody declared.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentRunSpec } from './agent-runner.js';
import { buildClaudeArgs } from './claude-cli-runner.js';
import {
  buildPiArgs,
  PiRunner,
  piSupportsMcpConfig,
  type PiMcpConfigAnswer,
  type PiMcpConfigProbe,
} from './pi-runner.js';
import { opencodeChildEnv } from './opencode-server-runner.js';
import {
  claudeMcpIsolation,
  opencodeMcpIsolation,
  piMcpIsolation,
  runMcpIsolationNote,
  writeMcpOverlay,
} from './run-mcp-isolation.js';

/** Only the M1 regression test below swaps the child out, mirroring the identical hook in
 *  `pi-runner.test.ts`; every other test in this file never reaches `node:child_process`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override(...args) : actual.spawn(...args),
  };
});

/** The entry a person adds so their leader session can reach xezar (docs/guide/13-mcp-leader.md). */
const BRIDGE = { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'], lifecycle: 'keep-alive' };
/** A server that is the PROJECT's own and must survive isolation untouched. */
const PROJECT_SERVER = { command: 'node', args: ['tools/docs-server.mjs'] };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xez-mcp-isolation-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, value: unknown): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function spec(): AgentRunSpec {
  return { userPrompt: 'do the thing', cwd: root };
}

// ---- the seam: one red proof per backend ----------------------------------

describe('the seam keeps the project xezar bridge out of a task-spawned client', () => {
  it('claude: the argv carries a bridge-free overlay and --strict-mcp-config', () => {
    write('.mcp.json', { mcpServers: { xezar: BRIDGE, docs: PROJECT_SERVER } });

    const args = buildClaudeArgs(spec(), {});

    expect(args).toContain('--strict-mcp-config');
    const overlay = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}') as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(overlay.mcpServers)).toEqual(['docs']);
    // `--mcp-config` is variadic, so nothing may follow its JSON.
    expect(args.at(-1)).toBe(JSON.stringify(overlay));
  });

  it('pi: the argv points --mcp-config at an overlay that marks the bridge disabled', () => {
    write('.pi/mcp.json', { mcpServers: { xezar: BRIDGE, docs: PROJECT_SERVER } });
    const isolation = piMcpIsolation(root, { PI_CODING_AGENT_DIR: join(root, 'pi-home') });
    const overlay = writeMcpOverlay('mcp.json', isolation.overlay);
    if (!overlay) throw new Error('the overlay must be writable in a test sandbox');

    const args = buildPiArgs(spec(), overlay.path);

    expect(args[args.indexOf('--mcp-config') + 1]).toBe(overlay.path);
    // Only the literal `true` disables a server for the adapter, and the flag has to survive the
    // project files merged above it — which it does, because that merge is field by field.
    expect((isolation.overlay.mcpServers as Record<string, { disabled?: boolean }>).xezar).toEqual({ disabled: true });
    overlay.cleanup();
  });

  it('opencode: the child env carries the one config layer that outranks the project file', () => {
    write('opencode.json', { mcp: { xezar: { type: 'local', command: ['npx', '-y', '@qodeca/xezar', 'mcp'] } } });

    const env = opencodeChildEnv(spec());
    const content = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT)) as { mcp: Record<string, unknown> };

    expect(content.mcp.xezar).toEqual({ enabled: false });
    // OPENCODE_CONFIG is merged BELOW the project's own opencode.json and would lose to it.
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });
});

// ---- M1: the seam must resolve the ACCOUNT's pi home, not the host default's --------------

describe('pi startSession resolves the agent home from the env the child actually spawns with (#342 review M1)', () => {
  it("the run's overlay carries the account pi home's servers, not the host default account's", async () => {
    write('host-pi-home/mcp.json', { mcpServers: { 'host-only': { command: 'h' } } });
    write('account-pi-home/mcp.json', { mcpServers: { 'account-only': { command: 'a' } } });

    // The host process's OWN default account — must lose to `spec.env` below.
    const savedHostDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'host-pi-home');

    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    let overlayPath: string | undefined;
    spawnHook.override = (_bin: unknown, args: unknown) => {
      const argv = args as string[];
      overlayPath = argv[argv.indexOf('--mcp-config') + 1];
      return child;
    };

    let session: ReturnType<PiRunner['startSession']>;
    try {
      // The step runs under a STORED pi agent account: `spec.env` is what `workflows/run.ts`
      // gives the child, carrying that account's own `PI_CODING_AGENT_DIR` (#342 review M1).
      session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: async () => 'yes' }).startSession(
        { userPrompt: 'do it', cwd: root, env: { PI_CODING_AGENT_DIR: join(root, 'account-pi-home') } },
        () => {},
      );
      // The capability question is asked before the child exists (#548), so the spawn the hook
      // is waiting for happens a microtask later.
      await vi.waitFor(() => expect(overlayPath).toBeDefined());
    } finally {
      spawnHook.override = null;
      if (savedHostDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedHostDir;
    }

    expect(overlayPath).toBeDefined();
    const overlay = JSON.parse(readFileSync(overlayPath as string, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    // Reviewer's probe: the runner must answer `account-only,xezar`, never `host-only,xezar`.
    expect(Object.keys(overlay.mcpServers).sort()).toEqual(['account-only', 'xezar']);

    Object.assign(child, { exitCode: 0 });
    stdout.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await session.result.catch(() => {});
  });
});

// ---- #548: `--mcp-config` belongs to an OPTIONAL pi extension --------------

/**
 * The #342 pi lever is `--mcp-config`, and that flag is not pi's own: the optional
 * `pi-mcp-adapter` extension registers it. Pushing it unconditionally made EVERY pi task die at
 * spawn (`Error: Unknown option: --mcp-config`, exit 1) wherever the extension is absent —
 * verified against pi 0.85.1 with an empty `PI_CODING_AGENT_DIR`.
 *
 * Review round 1 then showed the first answer could still be wrong FOR THE CHILD: an extension
 * resolves from the project folder as well as the agent home, and a process-wide cache never went
 * stale. So the probe now runs with the child's own cwd and env, is not cached, is asynchronous
 * and hard-bounded, and a pi that refuses the option anyway restarts the session once without it.
 *
 * Named break for the red proof: `pi-mcp-config-unconditional` — revert `pi-runner.ts` to the
 * state that runs `piMcpIsolation` and pushes the flag without asking; the guard case stays green
 * either way, because it pins the behaviour with the extension present that must not change.
 */
describe('pi only passes --mcp-config when the pi MCP extension is installed (#548)', () => {
  /** A child that never really spawns. Each call is a fresh one, so a restart gets its own. */
  function fakePiChild(): { child: ChildProcessWithoutNullStreams; stdout: PassThrough; stderr: PassThrough } {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4343,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    return { child, stdout, stderr };
  }

  /** Executable stub `pi`s. `--help` is all the probe ever asks for. */
  function fakeBin(name: string, helpText: string): string {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  echo '${helpText}'\n  exit 0\nfi\nexit 7\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
  }

  /**
   * Drive one `PiRunner` session over a fake child and report what the runner asked for.
   * `exit` decides how each child dies, which is what the restart case needs.
   */
  async function piSpawn(
    probe: PiMcpConfigProbe,
    exit: (n: number) => { code: number; stderr?: string } = () => ({ code: 0 }),
    specEnv: Record<string, string> = { PI_CODING_AGENT_DIR: join(root, 'pi-home') },
    cwd: string = root,
  ): Promise<{ argv: string[][]; overlay: string | undefined; notes: string[] }> {
    write('.pi/mcp.json', { mcpServers: { xezar: BRIDGE, docs: PROJECT_SERVER } });
    write('pi-home/mcp.json', { mcpServers: { personal: { command: 'node' } } });

    const argv: string[][] = [];
    let overlay: string | undefined;
    let spawns = 0;
    const settle = (fake: ReturnType<typeof fakePiChild>, at: number): void => {
      const how = exit(at);
      if (how.stderr) fake.stderr.write(how.stderr);
      Object.assign(fake.child, { exitCode: how.code });
      fake.stdout.end();
      fake.child.emit('exit', how.code, null);
      fake.child.emit('close', how.code, null);
    };
    spawnHook.override = (_bin: unknown, args: unknown) => {
      const these = args as string[];
      // The capability probe spawns too. Hand it a child that never settles — that is the
      // "never exits" case, and its own bound is what has to end it — and never count it as
      // a session spawn.
      if (these[0] === '--help') return fakePiChild().child;
      argv.push(these);
      const at = these.indexOf('--mcp-config');
      // Read it here: the overlay is removed as soon as the child settles.
      if (at >= 0) overlay = readFileSync(these[at + 1] as string, 'utf8');
      const fake = fakePiChild();
      const which = spawns++;
      // One turn of the loop later, so the runner has wired its listeners first.
      setImmediate(() => settle(fake, which));
      return fake.child;
    };

    const notes: string[] = [];
    try {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: probe }).startSession(
        { userPrompt: 'do it', cwd, env: specEnv },
        (event: AgentEvent) => {
          if (event.type === 'note') notes.push(event.message);
        },
      );
      await session.result.catch(() => {});
    } finally {
      spawnHook.override = null;
    }

    return { argv, overlay, notes };
  }

  it('extension absent: no --mcp-config in the argv, and one note says the extension is not there', async () => {
    const { argv, overlay, notes } = await piSpawn(async () => 'no');

    expect(argv).toHaveLength(1);
    expect(argv[0]).not.toContain('--mcp-config');
    expect(overlay).toBeUndefined();
    const explained = notes.filter((note) => note.includes('MCP adapter extension is not available'));
    expect(explained).toHaveLength(1);
    // With no MCP config read at all there is no bridge to switch off, so the run must not
    // claim it switched one off.
    expect(notes.some((note) => note.includes('does not load xezar'))).toBe(false);
  });

  it('extension present: the flag and the overlay are exactly what #342 shipped (guard)', async () => {
    const { argv, overlay, notes } = await piSpawn(async () => 'yes');

    expect(argv[0]).toContain('--mcp-config');
    const written = JSON.parse(overlay ?? '{}') as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.xezar).toEqual({ disabled: true });
    expect(written.mcpServers.personal).toEqual({ command: 'node' });
    expect(notes.some((note) => note.includes('does not load xezar'))).toBe(true);
    expect(notes.some((note) => note.includes('MCP adapter extension is not available'))).toBe(false);
  });

  // ---- round 1, M-A: the answer has to be about the CHILD's folder and environment ----

  it('the probe is asked with the task\'s own cwd and the child\'s env, not the server\'s', async () => {
    const asked: Array<{ env: NodeJS.ProcessEnv; cwd: string }> = [];
    const here = join(root, 'task-folder');
    mkdirSync(here, { recursive: true });

    await piSpawn(
      async (_bin, env, cwd) => {
        asked.push({ env, cwd });
        return 'no';
      },
      () => ({ code: 0 }),
      { PI_CODING_AGENT_DIR: join(root, 'account-pi-home') },
      here,
    );

    expect(asked).toHaveLength(1);
    // `spec.cwd`, because a project-local install of the adapter only exists for THAT folder.
    expect(asked[0]?.cwd).toBe(here);
    // …and the built child env, so a stored agent account resolves the same home the child gets.
    expect(asked[0]?.env.PI_CODING_AGENT_DIR).toBe(join(root, 'account-pi-home'));
  });

  it('the same binary and agent folder are asked again for a different folder — no cached answer', async () => {
    const asked: string[] = [];
    const probe: PiMcpConfigProbe = async (_bin, _env, cwd) => {
      asked.push(cwd);
      return 'no';
    };
    const one = join(root, 'folder-one');
    const other = join(root, 'folder-two');
    mkdirSync(one, { recursive: true });
    mkdirSync(other, { recursive: true });
    const env = { PI_CODING_AGENT_DIR: join(root, 'pi-home') };

    await piSpawn(probe, () => ({ code: 0 }), env, one);
    await piSpawn(probe, () => ({ code: 0 }), env, other);

    // Same bin, same agent directory, different folder: two questions, each about its own folder.
    expect(asked).toEqual([one, other]);
  });

  // ---- round 1, M-B: a change while the server runs may not be absorbed by a cache ----

  it('a failed probe is never cached: the next session asks again and can get a different answer', async () => {
    const answers: PiMcpConfigAnswer[] = ['unknown', 'yes'];
    let asked = 0;
    const probe: PiMcpConfigProbe = async () => {
      asked += 1;
      return answers.shift() ?? 'no';
    };

    const first = await piSpawn(probe);
    const second = await piSpawn(probe);

    expect(asked).toBe(2);
    expect(first.argv[0]).not.toContain('--mcp-config');
    // The failure answered nothing, so the extension that was there all along is used next time.
    expect(second.argv[0]).toContain('--mcp-config');
  });

  // ---- round 1, m-1: the probe is bounded and never blocks ----

  it('a probe that never exits is cut at its bound, and the session still starts without the flag', async () => {
    const hanging = join(root, 'hanging-pi');
    writeFileSync(hanging, '#!/bin/sh\nsleep 300\n', 'utf8');
    chmodSync(hanging, 0o755);

    // First against a REAL process that ignores everything: the bound, not the child, ends it.
    const alone = Date.now();
    await expect(piSupportsMcpConfig(hanging, {}, root, 120)).resolves.toBe('unknown');
    expect(Date.now() - alone).toBeLessThan(5_000);

    // Then through the runner, so the session's own behaviour at the bound is pinned too.
    const started = Date.now();
    const { argv, notes } = await piSpawn((_bin, env, cwd) => piSupportsMcpConfig(hanging, env, cwd, 120));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(argv).toHaveLength(1);
    expect(argv[0]).not.toContain('--mcp-config');
    expect(notes.some((note) => note.includes('could not confirm'))).toBe(true);
  });

  // ---- round 1, m-2: a failed probe never claims the extension is absent ----

  it('a probe that fails says so, and never reports a cause it could not measure', async () => {
    const { argv, notes } = await piSpawn(async () => {
      throw new Error('probe exploded');
    });

    expect(argv[0]).not.toContain('--mcp-config');
    expect(notes.filter((note) => note.includes('could not confirm'))).toHaveLength(1);
    expect(notes.some((note) => note.includes('is not available'))).toBe(false);
  });

  // ---- round 1, item 3: the self-healing fallback ----

  it('a pi that refuses the option anyway is restarted exactly once, without the flag', async () => {
    const { argv, notes } = await piSpawn(async () => 'yes', (at) =>
      at === 0 ? { code: 1, stderr: 'Error: Unknown option: --mcp-config\n' } : { code: 0 },
    );

    expect(argv).toHaveLength(2);
    expect(argv[0]).toContain('--mcp-config');
    expect(argv[1]).not.toContain('--mcp-config');
    expect(notes.filter((note) => note.includes('rejected the MCP configuration option'))).toHaveLength(1);
  });

  it('no restart for any other spawn failure — one attempt, and the error stands', async () => {
    const { argv, notes } = await piSpawn(async () => 'yes', () => ({
      code: 1,
      stderr: 'Error: No API key found for the selected model\n',
    }));

    expect(argv).toHaveLength(1);
    expect(notes.some((note) => note.includes('rejected the MCP configuration option'))).toBe(false);
  });

  // ---- the real probe, both directions ----

  it('the real probe answers "yes" for a binary whose --help prints --mcp-config', async () => {
    const bin = fakeBin('pi-with-adapter', '  --mcp-config <file>  use this MCP config');
    await expect(piSupportsMcpConfig(bin, {}, root)).resolves.toBe('yes');
  });

  it('the real probe answers "no" for a binary whose --help does not', async () => {
    const bin = fakeBin('pi-without-adapter', '  --mode <mode>  the run mode');
    await expect(piSupportsMcpConfig(bin, {}, root)).resolves.toBe('no');
  });

  it('the real probe answers "unknown" for a binary that is not there, and never throws', async () => {
    await expect(piSupportsMcpConfig(join(root, 'no-such-pi-binary'), {}, root)).resolves.toBe('unknown');
  });
});


// ---- controls: the pure seam and the fail-open guard -----------------------

describe('the pure seam', () => {
  it('claude keeps every project server that is not the bridge', () => {
    write('.mcp.json', { mcpServers: { xezar: BRIDGE, docs: PROJECT_SERVER } });

    const isolation = claudeMcpIsolation(root);

    expect(isolation.bridges).toEqual(['xezar']);
    expect(isolation.overlay).toEqual({ mcpServers: { docs: PROJECT_SERVER } });
    expect(isolation.unreadable).toEqual([]);
  });

  it('pi carries the agent-directory file forward instead of replacing it', () => {
    write('pi-home/mcp.json', { mcpServers: { personal: { command: 'node' } } });
    write('.pi/mcp.json', { mcpServers: { xezar: BRIDGE } });

    const isolation = piMcpIsolation(root, { PI_CODING_AGENT_DIR: join(root, 'pi-home') });
    const servers = isolation.overlay.mcpServers as Record<string, unknown>;

    // The person's own global servers survive; only the bridge is marked off.
    expect(servers.personal).toEqual({ command: 'node' });
    expect(servers.xezar).toEqual({ disabled: true });
  });

  it('pi merges its two project files in the adapter order, later winning', () => {
    write('.mcp.json', { mcpServers: { docs: PROJECT_SERVER, shared: { command: 'a' } } });
    write('.pi/mcp.json', { mcpServers: { shared: { command: 'b' } } });

    const isolation = piMcpIsolation(root, { PI_CODING_AGENT_DIR: join(root, 'pi-home') });

    expect(isolation.servers).toEqual({ docs: PROJECT_SERVER, shared: { command: 'b' } });
  });

  it('the reserved name is switched off even when the project declares no bridge at all', () => {
    write('opencode.json', { mcp: { docs: PROJECT_SERVER } });

    // A bridge in the person's own global config is never in a project file, and would otherwise
    // contend in every project. Claude needs no such floor: its overlay is exclusive.
    expect(opencodeMcpIsolation(root).overlay).toEqual({ mcp: { xezar: { enabled: false } } });
    expect(claudeMcpIsolation(root).bridges).toEqual([]);
  });

  it('the note reports only bridges that were really declared, never the floor', () => {
    write('opencode.json', { mcp: { docs: PROJECT_SERVER } });

    const isolation = opencodeMcpIsolation(root);

    // The floor is in `disabled` and must NOT reach `bridges`: a run that saw no bridge would
    // otherwise tell the user it had switched one off on every single start.
    expect(isolation.disabled).toEqual(['xezar']);
    expect(isolation.bridges).toEqual([]);
    expect(runMcpIsolationNote('opencode', isolation)).toBeNull();
  });

  it('recognises a bridge under another name by its launch line, and leaves lookalikes alone', () => {
    write('.mcp.json', {
      mcpServers: {
        leader: { command: 'sh', args: ['-c', 'npx -y @qodeca/xezar mcp'] },
        elsewhere: { command: 'node', args: ['--root', '/src/xezar/server.js'] },
      },
    });

    const isolation = claudeMcpIsolation(root);

    expect(isolation.bridges).toEqual(['leader']);
    expect(Object.keys(isolation.overlay.mcpServers)).toEqual(['elsewhere']);
  });

  it('never assigns through the prototype for a server named __proto__', () => {
    write('.mcp.json', `{"mcpServers": {"__proto__": {"command": "node"}, "docs": {"command": "d"}}}`);

    const isolation = claudeMcpIsolation(root);

    expect(Object.hasOwn(isolation.overlay.mcpServers, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

describe('fail-open: a config the seam cannot read never stops the run', () => {
  it('an ABSENT config says nothing and strips nothing', () => {
    const isolation = claudeMcpIsolation(root);

    expect(isolation).toEqual({ servers: {}, bridges: [], unreadable: [], overlay: { mcpServers: {} } });
    expect(runMcpIsolationNote('claude', isolation)).toBeNull();
  });

  it('an UNREADABLE config is also empty — and says so, which is the whole difference', () => {
    write('.mcp.json', '{ this is not json');

    const isolation = claudeMcpIsolation(root);

    expect(isolation.overlay).toEqual({ mcpServers: {} });
    expect(isolation.unreadable).toEqual(['.mcp.json']);
    expect(runMcpIsolationNote('claude', isolation)).toContain('could not read .mcp.json');
  });

  it('a config that parses to a non-object is unreadable, not an empty server map', () => {
    write('.mcp.json', '[]');

    expect(claudeMcpIsolation(root).unreadable).toEqual(['.mcp.json']);
  });

  it('a config with no mcp key at all is readable and simply has no servers', () => {
    write('opencode.json', { $schema: 'https://opencode.ai/config.json' });

    const isolation = opencodeMcpIsolation(root);

    expect(isolation.servers).toEqual({});
    expect(isolation.unreadable).toEqual([]);
  });

  it('every backend still builds its launch inputs when no config exists at all', () => {
    expect(() => buildClaudeArgs(spec(), {})).not.toThrow();
    expect(() => buildPiArgs(spec(), undefined)).not.toThrow();
    expect(() => opencodeChildEnv(spec())).not.toThrow();
  });

  it('a claude run whose project file is broken starts with no project MCP servers at all', () => {
    write('.mcp.json', 'not json');

    const args = buildClaudeArgs(spec(), {});

    expect(args).toContain('--strict-mcp-config');
    expect(args.at(-1)).toBe(JSON.stringify({ mcpServers: {} }));
  });
});
