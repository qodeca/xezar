/**
 * The Qwen Code runner (#1044) against a recording stub (`__fixtures__/qwen/stub-qwen.mjs`): what
 * reaches each turn's process (argv, stdin, environment, the run's private settings file), the
 * read-only lock through the bundled hook program, the `.env` block, the version gate, and the
 * missing-binary path. The wire mapping is pinned by `qwen-ui-mapper.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pidExists } from '../platform/process-proof.ts';
import { signalPid } from '../platform/process-table.ts';
import type { AgentEvent, AgentRunSpec } from './agent-runner.ts';
import { QwenRunner, buildQwenArgs, qwenHookScriptPath, qwenVersionVerdict, QWEN_MIN_VERSION } from './qwen-runner.ts';
import { QWEN_TOOL_POLICY_ENV, decideQwenPreToolUse, qwenToolPolicy } from './qwen-tool-policy.ts';
import { scanQwenProjectEnv } from './qwen-run-config.ts';
import { settingsFromObject, type QwenSettings } from './qwen-settings.ts';
import { linkDir, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, '__fixtures__', 'qwen', 'stub-qwen.mjs');
const LAUNCHER = join(HERE, '__fixtures__', 'qwen', 'stub-qwen-launcher.mjs');
const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash'];

interface Record_ {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  settings: Record<string, unknown> | null;
  mcpConfig: Record<string, unknown> | null;
}

const SETTINGS: QwenSettings = {
  status: 'ok',
  path: '/home/user/.qwen/settings.json',
  ...settingsFromObject({
    security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'local-model', baseUrl: 'http://127.0.0.1:18000/v1', envKey: 'LOCAL_LLM_KEY' }, { id: 'cloud-model', baseUrl: 'https://api.example.com/v1', envKey: 'CLOUD_KEY' }] },
    modelPricing: { 'cloud-model': { inputPerMillionTokens: 1, outputPerMillionTokens: 2 } },
  }),
};

let root: string;
let project: string;
let recordFile: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['QWEN_STUB_RECORD', 'QWEN_STUB_VERSION', 'QWEN_STUB_EXIT', 'QWEN_STUB_INIT_MODEL', 'QWEN_STUB_HANG', 'QWEN_USAGE_STATISTICS_ENABLED', 'XEZ_QWEN_USAGE_STATISTICS', 'XEZ_DRY_RUN', 'LOCAL_LLM_KEY', 'QWEN_CODE_SYSTEM_SETTINGS_PATH', 'HOME', 'QWEN_CODE_SAFE_MODE', 'QWEN_CODE_SIMPLE'];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xez-qwen-runner-')));
  // The fixture root is the home, so the walk for a project `.env` ends inside the fixture, as it
  // ends at a real home (the test temp folder may itself sit under the developer's home).
  process.env.HOME = root;
  project = join(root, 'repo');
  mkdirSync(project, { recursive: true });
  recordFile = join(root, 'record.ndjson');
  process.env.QWEN_STUB_RECORD = recordFile;
  // No machine system settings file reaches the test.
  process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH = join(root, 'no-system-settings.json');
  delete process.env.QWEN_STUB_VERSION;
  delete process.env.QWEN_STUB_EXIT;
  delete process.env.QWEN_STUB_INIT_MODEL;
  delete process.env.QWEN_STUB_HANG;
  delete process.env.QWEN_USAGE_STATISTICS_ENABLED;
  delete process.env.XEZ_QWEN_USAGE_STATISTICS;
  delete process.env.XEZ_DRY_RUN;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, TEST_DIR_RM_OPTIONS);
});

function records(): Record_[] {
  return readFileSync(recordFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record_);
}

async function runOnce(spec: Partial<AgentRunSpec> = {}, settings: QwenSettings = SETTINGS) {
  const events: AgentEvent[] = [];
  const runner = new QwenRunner({ bin: STUB, readSettings: () => settings });
  const result = await runner
    .startSession({ userPrompt: 'do it', cwd: project, sessionId: '11111111-1111-4111-8111-111111111111', ...spec }, (e) => events.push(e), { autoEndAfterFirstTurn: true })
    .result.then((value) => ({ value }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  return { events, result };
}

describe('QwenRunner turns', () => {
  it('runs one process per turn: --session-id first, --resume after, the prompt on stdin', async () => {
    const runner = new QwenRunner({ bin: STUB, readSettings: () => SETTINGS });
    const session = runner.startSession({ userPrompt: 'first', cwd: project, sessionId: 'sess-1' }, undefined, {});
    session.sendMessage([{ type: 'text', text: 'second' }]);
    setTimeout(() => session.end(), 1500);
    await session.result;
    const [first, second] = records();
    expect(first!.argv).toContain('--session-id=sess-1');
    expect(first!.argv).toContain('--approval-mode=default');
    expect(first!.stdin).toBe('first');
    expect(second!.argv).toContain('--resume=sess-1');
    expect(second!.stdin).toBe('second');
  });

  it('passes the model and its auth type, and refuses an id the settings do not list', async () => {
    await runOnce({ model: 'cloud-model' });
    expect(records()[0]!.argv).toEqual(expect.arrayContaining(['--model=cloud-model', '--auth-type=openai']));
    const runner = new QwenRunner({ bin: STUB, readSettings: () => SETTINGS });
    expect(() => runner.startSession({ userPrompt: 'x', cwd: project, model: 'no-such-model' })).toThrow(/not in your Qwen Code settings/);
  });

  it('fails the step when Qwen Code starts another model than the one asked for', async () => {
    process.env.QWEN_STUB_INIT_MODEL = 'some-default';
    const { result } = await runOnce({ model: 'cloud-model' });
    expect(result).toMatchObject({ error: expect.stringContaining('instead of the requested "cloud-model"') });
  });

  it('reports a metered model\'s cost from modelPricing, and 0 for a local endpoint', async () => {
    const metered = await runOnce({ model: 'cloud-model' });
    expect(metered.events).toContainEqual({ type: 'cost', usd: (100 / 1e6) * 1 + (10 / 1e6) * 2 });
    const local = await runOnce({ model: 'local-model' });
    expect(local.events.some((e) => e.type === 'cost')).toBe(false);
  });

  it('maps a documented exit code to its meaning (53: turn limit)', async () => {
    process.env.QWEN_STUB_EXIT = '53';
    const { result } = await runOnce();
    expect(result).toMatchObject({ error: expect.stringMatching(/exited with code 53 \(it reached its session turn limit\) — Reached max session turns/) });
  });
});

describe('QwenRunner stop (#1042)', () => {
  const alive = (pid: number): boolean => pidExists(pid);
  async function hungTurn() {
    const pidFile = join(root, 'hung.pids');
    process.env.QWEN_STUB_HANG = pidFile;
    const runner = new QwenRunner({ bin: LAUNCHER, readSettings: () => SETTINGS });
    const session = runner.startSession({ userPrompt: 'do it', cwd: project, sessionId: '11111111-1111-4111-8111-111111111111', timeoutMs: 60_000 }, () => undefined, { autoEndAfterFirstTurn: true });
    const settled = session.result.then(() => 'resolved', (error: unknown) => (error instanceof Error ? error.message : String(error)));
    await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split('\n').length === 2).toBe(true), { timeout: 10_000, interval: 50 });
    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    return { session, settled, pids };
  }

  it('an interrupt stops the program behind the `qwen` launcher and the command it runs, not only the launcher', async () => {
    const { session, settled, pids } = await hungTurn();
    try {
      session.interrupt();
      // Bounded, so a regression fails here and the finally still stops what the turn started.
      const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000))]);
      expect(outcome).not.toBe('still running');
      await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 5_000, interval: 50 });
    } finally {
      for (const pid of pids) signalPid(pid, 'SIGKILL');
    }
  });

  it('a stop xezar sends is not a failure, though the launcher dies by signal with no exit code', async () => {
    const { session, settled, pids } = await hungTurn();
    try {
      session.end();
      const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('still running'), 15_000))]);
      expect(outcome).toBe('resolved');
    } finally {
      for (const pid of pids) signalPid(pid, 'SIGKILL');
    }
  }, 30_000);
});

describe('QwenRunner between turns (#1042, the #793 trap)', () => {
  it('an open session waiting for its next message keeps a headless process alive until it ends', () => {
    // A headless `xezar run` holds no other handle, and the engine's idle timer is unref'd because a
    // live agent process normally holds the loop. Qwen Code runs one process per turn, so the session
    // itself must. The unref'd timer here plays the idle timer: it is the only way the session ends.
    const runnerUrl = pathToFileURL(join(HERE, 'qwen-runner.ts')).href;
    const settingsUrl = pathToFileURL(join(HERE, 'qwen-settings.ts')).href;
    const script = `
      const { QwenRunner } = await import(${JSON.stringify(runnerUrl)});
      const { settingsFromObject } = await import(${JSON.stringify(settingsUrl)});
      const settings = { status: 'ok', path: 'settings.json', ...settingsFromObject({}) };
      const session = new QwenRunner({ bin: process.argv[1], readSettings: () => settings })
        .startSession({ userPrompt: 'do it', cwd: process.argv[2], sessionId: '11111111-1111-4111-8111-111111111111' }, (e) => {
          if (e.type === 'turn-end') { console.log('PARKED'); setTimeout(() => session.end(), 1500).unref(); }
        });
      session.result.then(() => console.log('ENDED'), (e) => console.log('ERROR ' + e.message));
    `;
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, STUB, project], { encoding: 'utf8', timeout: 60_000, env: process.env });
    expect(run.stdout).toContain('PARKED');
    expect(run.stdout).toContain('ENDED');
  });
});

describe('QwenRunner MCP servers and questions (#1044 §4, §5)', () => {
  it('starts only the project\'s own servers, on the project\'s own definitions', async () => {
    const docs = { command: 'node', args: ['docs-server.js'] };
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { docs } }));
    await runOnce();
    const [record] = records();
    expect(record!.argv).toContain('--allowed-mcp-server-names=docs');
    expect(record!.argv.filter((a) => a.startsWith('--allowed-mcp-server-names='))).toHaveLength(1);
    expect(record!.mcpConfig).toEqual({ mcpServers: { docs } });
  });

  it('starts no server at all for a project that declares none, and passes no --mcp-config', async () => {
    await runOnce();
    const [record] = records();
    expect(record!.argv).toContain('--allowed-mcp-server-names=__xezar_none__');
    expect(record!.argv.some((a) => a.startsWith('--mcp-config='))).toBe(false);
  });

  it('removes Qwen Code\'s own question tool on every step, so a question ends the turn as XEZ:ASK', async () => {
    await runOnce({ allowedTools: ['Read', 'Edit', 'Write', 'Bash'] });
    await runOnce({ allowedTools: READ_ONLY, bashAllowlist: ['git status'] });
    for (const record of records()) expect(record.argv).toContain('--exclude-tools=ask_user_question');
  });
});

describe('QwenRunner environment (#1044 §11, §12)', () => {
  it('switches usage statistics off unless XEZ_QWEN_USAGE_STATISTICS opts in', async () => {
    await runOnce();
    expect(records()[0]!.env.QWEN_USAGE_STATISTICS_ENABLED).toBe('0');
    process.env.XEZ_QWEN_USAGE_STATISTICS = '1';
    rmSync(recordFile);
    await runOnce();
    expect(records()[0]!.env.QWEN_USAGE_STATISTICS_ENABLED).toBeUndefined();
  });

  it('forwards a provider key its settings name (envKey), and points Qwen at a private settings file', async () => {
    process.env.LOCAL_LLM_KEY = 'k-local';
    await runOnce();
    const [record] = records();
    expect(record!.env.LOCAL_LLM_KEY).toBe('k-local');
    expect(record!.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).not.toBe(join(root, 'no-system-settings.json'));
    expect(record!.settings).toMatchObject({ tools: { todoWrite: { enabled: true } } });
    // Qwen Code's managed auto-memory is off for task runs: no extra model call, no memory folder per worktree.
    expect(record!.settings).toMatchObject({ memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false } });
  });

  it('keeps a worktree\'s repository .env away from Qwen Code: its names are excluded, its values never read', async () => {
    writeFileSync(join(project, '.env'), 'OPENAI_API_KEY=sentinel\nexport OTHER_SECRET=sentinel2\n');
    const worktree = join(project, '.local', 'xezar', 'worktrees', 'run-1');
    mkdirSync(worktree, { recursive: true });
    await runOnce({ cwd: worktree });
    const [record] = records();
    const excluded = (record!.settings as { advanced: { excludedEnvVars: string[] } }).advanced.excludedEnvVars;
    expect(excluded).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'OTHER_SECRET', 'DEBUG', 'DEBUG_MODE']));
    expect(JSON.stringify(record)).not.toContain('sentinel');
  });

  it('refuses to start when a project .qwen/.env would be loaded, naming the file and the fix', () => {
    mkdirSync(join(project, '.qwen'));
    writeFileSync(join(project, '.qwen', '.env'), 'OPENAI_API_KEY=sentinel\n');
    const runner = new QwenRunner({ bin: STUB, readSettings: () => SETTINGS });
    expect(() => runner.startSession({ userPrompt: 'x', cwd: project })).toThrow(/\.qwen[/\\]\.env.*~\/\.qwen\/\.env/);
  });

  it('recognises the home folder when HOME reaches it through a link, so ~/.qwen/.env is not a project file', () => {
    mkdirSync(join(root, '.qwen'));
    writeFileSync(join(root, '.qwen', '.env'), 'OPENAI_API_KEY=sentinel\n');
    const linked = join(mkdtempSync(join(tmpdir(), 'xez-qwen-home-link-')), 'home');
    linkDir(root, linked);
    expect(scanQwenProjectEnv(project, { HOME: linked })).toEqual({ excludedNames: [], unblockable: [] });
    rmSync(dirname(linked), TEST_DIR_RM_OPTIONS);
  });

  it('stops the .env walk at the first file and at the home folder, as Qwen Code does', () => {
    writeFileSync(join(root, '.env'), 'HOME_ONLY=1\n');
    expect(scanQwenProjectEnv(project)).toEqual({ excludedNames: [], unblockable: [] });
    writeFileSync(join(project, '.env'), 'A=1\n# comment\nB=2\n');
    expect(scanQwenProjectEnv(project).excludedNames).toEqual(['A', 'B']);
  });
});

describe('QwenRunner read-only lock (#1044 acceptance 3)', () => {
  it('lists no file writer, removes them, and installs the hook with the step policy', async () => {
    await runOnce({ allowedTools: READ_ONLY, bashAllowlist: ['git status'] });
    const [record] = records();
    expect(record!.argv.filter((a) => a.startsWith('--allowed-tools='))).toEqual(['--allowed-tools=read_file', '--allowed-tools=grep_search', '--allowed-tools=glob', '--allowed-tools=run_shell_command(git status)']);
    expect(record!.argv).toEqual(expect.arrayContaining(['--exclude-tools=edit', '--exclude-tools=write_file', '--exclude-tools=notebook_edit', '--exclude-tools=exec']));
    expect(record!.settings).toMatchObject({ disableAllHooks: false, hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command' }] }] } });
    expect(JSON.parse(record!.env[QWEN_TOOL_POLICY_ENV]!)).toMatchObject({ readOnly: true, bash: { mode: 'allowlist', entries: ['git status'] } });
  });

  it('the bundled hook program refuses an edit and a command outside the allowlist, and allows one inside', () => {
    const policy = JSON.stringify(qwenToolPolicy(READ_ONLY, ['git status'], 'linux'));
    const ask = (payload: unknown) => spawnSync(process.execPath, [qwenHookScriptPath()], {
      input: JSON.stringify(payload),
      env: { ...process.env, [QWEN_TOOL_POLICY_ENV]: policy },
      encoding: 'utf8',
    }).stdout;
    expect(ask({ tool_name: 'edit', tool_input: { file_path: 'a', old_string: 'x', new_string: 'y' } })).toContain('"permissionDecision":"deny"');
    expect(ask({ tool_name: 'write_file', tool_input: { file_path: 'a', content: 'x' } })).toContain('"permissionDecision":"deny"');
    expect(ask({ tool_name: 'run_shell_command', tool_input: { command: 'touch hacked.txt' } })).toContain('"permissionDecision":"deny"');
    expect(ask({ tool_name: 'run_shell_command', tool_input: { command: 'git status; rm -rf x' } })).toContain('"permissionDecision":"deny"');
    expect(ask({ tool_name: 'tool_call', tool_input: { name: 'write_file', arguments: { file_path: 'a' } } })).toContain('"permissionDecision":"deny"');
    expect(ask({ tool_name: 'run_shell_command', tool_input: { command: 'git status --short' } })).toBe('');
    expect(ask({ tool_name: 'read_file', tool_input: { file_path: 'a' } })).toBe('');
  });

  it('blanks the host settings that switch every Qwen Code hook off (safe mode, bare mode)', async () => {
    process.env.QWEN_CODE_SAFE_MODE = '1';
    process.env.QWEN_CODE_SIMPLE = 'true';
    await runOnce({ allowedTools: READ_ONLY, bashAllowlist: ['git status'] });
    const [record] = records();
    expect(record!.env.QWEN_CODE_SAFE_MODE).toBe('');
    expect(record!.env.QWEN_CODE_SIMPLE).toBe('');
  });

  it('starts no turn when the hook program is missing, because Qwen Code would let every call through', async () => {
    const runner = new QwenRunner({ bin: STUB, readSettings: () => SETTINGS, hookScriptPath: join(root, 'gone', 'qwen-pre-tool-hook.mjs') });
    const outcome = await runner
      .startSession({ userPrompt: 'x', cwd: project, allowedTools: READ_ONLY, bashAllowlist: ['git status'] }, undefined, { autoEndAfterFirstTurn: true })
      .result.then(() => 'resolved', (error: Error) => error.message);
    expect(outcome).toMatch(/program that keeps this step's tool limits is missing .*gone/);
    expect(existsSync(recordFile)).toBe(false);
  });

  it('fails closed without a policy, and needs no hook on a writing step with a free shell', () => {
    expect(decideQwenPreToolUse({ tool_name: 'read_file' }, undefined)).toMatchObject({ allowed: false });
    expect(qwenToolPolicy(['Read', 'Edit', 'Write', 'Bash'], undefined)).toBeUndefined();
    expect(qwenToolPolicy(['Read', 'Edit', 'Write'], undefined)).toMatchObject({ readOnly: false, bash: { mode: 'off' } });
  });

  it('builds the flags in --name=value form, the system prompt on argv', () => {
    const args = buildQwenArgs({ userPrompt: 'x', cwd: '/w', systemPrompt: '-starts with a dash', additionalDirectories: ['/extra'] }, {
      resume: false, sessionId: 's', mcpServerNames: ['__xezar_none__'], systemPromptOnArgv: true,
    });
    expect(args).toEqual(expect.arrayContaining(['--append-system-prompt=-starts with a dash', '--allowed-mcp-server-names=__xezar_none__', '--include-directories=/extra']));
  });
});

describe('QwenRunner version gate and missing binary (#1044 acceptance 6, 7)', () => {
  it('refuses a Qwen Code older than the minimum with the update command', async () => {
    process.env.QWEN_STUB_VERSION = '0.25.1';
    const { result } = await runOnce();
    expect(result).toMatchObject({ error: expect.stringContaining(`Qwen Code 0.25.1 is older than ${QWEN_MIN_VERSION}`) });
    expect((result as { error: string }).error).toContain('npm i -g @qwen-code/qwen-code');
  });

  it('runs a newer Qwen Code with a quiet "not yet tested" note', async () => {
    process.env.QWEN_STUB_VERSION = '0.26.0';
    const { events, result } = await runOnce();
    expect(result).toHaveProperty('value');
    expect(events).toContainEqual({ type: 'note', message: expect.stringContaining('Qwen Code 0.26.0 is not yet tested') });
    expect(qwenVersionVerdict('0.25.2')).toEqual({ kind: 'supported' });
  });

  it('names the install command when the binary is missing, and starts nothing else', async () => {
    const runner = new QwenRunner({ bin: join(root, 'no-such-qwen'), readSettings: () => SETTINGS });
    const outcome = await runner.startSession({ userPrompt: 'x', cwd: project }).result.then(() => 'resolved', (error: Error) => error.message);
    expect(outcome).toMatch(/not found on PATH — Install Qwen Code \(`npm i -g @qwen-code\/qwen-code`\)/);
  });
});
