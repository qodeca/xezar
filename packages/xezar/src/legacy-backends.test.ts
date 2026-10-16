import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_DIR_RM_OPTIONS } from '../test/helpers/platform.ts';
import {
  bootLegacyBackendFiles,
  findLegacyBackendValues,
  legacyBackendMessage,
  projectLegacyBackendFiles,
  scanLegacyBackends,
} from './legacy-backends.ts';
import { globalStateLayout } from './state-layout.ts';

/**
 * #1046: xezar refuses to `serve` or `run` while a saved setting or task record still names a
 * removed agent (pi, OpenCode), lists each file and field, and changes nothing.
 */

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');

let base: string;
let home: string;
let project: string;

const write = (file: string, value: unknown): string => {
  mkdirSync(join(file, '..'), { recursive: true });
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(file, text);
  return text;
};

const runsFile = (): string => join(project, '.local', 'xezar', 'runs.json');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'xez-legacy-backends-')));
  home = join(base, 'home', '.xezar');
  project = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  write(join(home, 'config.json'), { schemaVersion: 1 });
});

afterEach(() => {
  rmSync(base, TEST_DIR_RM_OPTIONS);
});

describe('findLegacyBackendValues', () => {
  it('names each agent-valued key and each per-agent map key that is pi or opencode', () => {
    const document = {
      defaultRunner: 'opencode',
      defaultModels: { claude: 'sonnet', pi: 'anthropic/claude', opencode: 'x/y' },
      runs: [
        { id: 'a', runner: 'claude', steps: [{ backend: 'codex' }] },
        { id: 'b', runner: 'pi', steps: [{ backend: 'qwen' }, { backend: 'pi' }] },
      ],
      accounts: [{ id: 'w', provider: 'opencode' }],
      selections: { pi: 'w' },
      leader: { client: 'opencode' },
    };
    expect(findLegacyBackendValues(document, 'f.json')).toEqual([
      { file: 'f.json', field: 'defaultRunner', value: 'opencode', kind: 'value' },
      { file: 'f.json', field: 'defaultModels.pi', value: 'pi', kind: 'key' },
      { file: 'f.json', field: 'defaultModels.opencode', value: 'opencode', kind: 'key' },
      { file: 'f.json', field: 'runs[1].runner', value: 'pi', kind: 'value', itemId: 'b' },
      { file: 'f.json', field: 'runs[1].steps[1].backend', value: 'pi', kind: 'value', itemId: 'b' },
      { file: 'f.json', field: 'accounts[0].provider', value: 'opencode', kind: 'value', itemId: 'w' },
      { file: 'f.json', field: 'selections.pi', value: 'pi', kind: 'key' },
      { file: 'f.json', field: 'leader.client', value: 'opencode', kind: 'value' },
    ]);
  });

  it('ignores the words anywhere else: prompts, names, other keys', () => {
    const document = { prompt: 'use pi and opencode', name: 'pi', runner: 'qwen', models: { qwen: 'pi' }, other: { pi: 1 } };
    expect(findLegacyBackendValues(document, 'f.json')).toEqual([]);
  });
});

describe('scanLegacyBackends', () => {
  it('reads runs.json, the project config and workflow YAML, and changes no byte', () => {
    const runs = write(runsFile(), { runs: [{ id: 'r1', runner: 'pi', steps: [] }] });
    const config = write(join(project, '.xezar', 'config.json'), { defaultRunner: 'opencode' });
    const workflow = write(join(project, '.xezar', 'workflows', 'review.yaml'), 'name: review\nsteps:\n  - id: one\n    runner: claude\n  - id: two\n    runner: pi\n');
    const found = scanLegacyBackends(projectLegacyBackendFiles(project));
    expect(found).toEqual([
      { file: join(project, '.xezar', 'config.json'), field: 'defaultRunner', value: 'opencode', kind: 'value' },
      { file: runsFile(), field: 'runs[0].runner', value: 'pi', kind: 'value', itemId: 'r1' },
      { file: join(project, '.xezar', 'workflows', 'review.yaml'), field: 'steps[1].runner', value: 'pi', kind: 'value', itemId: 'two' },
    ]);
    expect(readFileSync(runsFile(), 'utf8')).toBe(runs);
    expect(readFileSync(join(project, '.xezar', 'config.json'), 'utf8')).toBe(config);
    expect(readFileSync(join(project, '.xezar', 'workflows', 'review.yaml'), 'utf8')).toBe(workflow);
  });

  it('reads every JSON state file in the data folder and its mcp folder, and the global UI state', () => {
    write(join(project, '.local', 'xezar', 'ui-state.json'), { composer: { runner: 'pi' } });
    write(join(project, '.local', 'xezar', 'mcp', 'leader-cursors.json'), { leader: { client: 'opencode' } });
    write(join(home, 'ui-state.json'), { agentDefaults: { runner: 'opencode' } });
    const layout = globalStateLayout({ XEZ_HOME: home });
    expect(scanLegacyBackends(bootLegacyBackendFiles(layout, project))).toEqual([
      { file: join(home, 'ui-state.json'), field: 'agentDefaults.runner', value: 'opencode', kind: 'value' },
      { file: join(project, '.local', 'xezar', 'ui-state.json'), field: 'composer.runner', value: 'pi', kind: 'value' },
      { file: join(project, '.local', 'xezar', 'mcp', 'leader-cursors.json'), field: 'leader.client', value: 'opencode', kind: 'value' },
    ]);
  });

  it('skips missing and unreadable files: their own loaders report them', () => {
    write(runsFile(), '{ not json');
    expect(scanLegacyBackends([...projectLegacyBackendFiles(project), join(base, 'nowhere.json')])).toEqual([]);
  });

  it('also scans every project the workspace registry names', () => {
    const other = join(base, 'other');
    write(join(other, '.local', 'xezar', 'automations.json'), { automations: [{ task: { runner: 'opencode' } }] });
    write(join(home, 'config.json'), { schemaVersion: 1, projects: [{ id: 'other', root: other }] });
    write(join(home, 'agent-accounts.json'), { accounts: [{ id: 'p', provider: 'pi' }] });
    const layout = globalStateLayout({ XEZ_HOME: home });
    expect(scanLegacyBackends(bootLegacyBackendFiles(layout, project))).toEqual([
      { file: join(home, 'agent-accounts.json'), field: 'accounts[0].provider', value: 'pi', kind: 'value', itemId: 'p' },
      { file: join(other, '.local', 'xezar', 'automations.json'), field: 'automations[0].task.runner', value: 'opencode', kind: 'value' },
    ]);
  });
});

describe('legacyBackendMessage', () => {
  it('lists every file and field and says how to fix it', () => {
    const message = legacyBackendMessage([
      { file: '/p/.local/xezar/runs.json', field: '[0].runner', value: 'pi', kind: 'value', itemId: 'r1' },
      { file: '/p/.xezar/config.json', field: 'defaultRunner', value: 'opencode', kind: 'value' },
      { file: '/p/.xezar/config.json', field: 'defaultModels.pi', value: 'pi', kind: 'key' },
    ]);
    expect(message).toBe(
      [
        'xezar did not start: saved settings or task records still name an agent that xezar no longer runs (pi or OpenCode).',
        'Found 3 values in 2 files:',
        '  /p/.local/xezar/runs.json: [0].runner = "pi", in the item with id "r1"',
        '  /p/.xezar/config.json: defaultRunner = "opencode"',
        '  /p/.xezar/config.json: defaultModels.pi (a "pi" entry)',
        'Fix: change each value to qwen, claude or codex, or remove it. Then start xezar again.',
        'xezar changed nothing. The xezar guide page "Moving from pi or OpenCode to Qwen Code" shows each step.',
      ].join('\n'),
    );
  });
});

describe('the boot refusal, through the real program', () => {
  const cli = (args: readonly string[]) => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, '--repo', project, ...args], {
      env: { ...process.env, XEZ_HOME: home, XEZ_DRY_RUN: '1', VITEST: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  it('`serve` refuses while a stored pi value remains, names the file, and leaves it unchanged', () => {
    const runs = write(runsFile(), { runs: [{ id: 'r1', runner: 'pi', steps: [{ id: 's', backend: 'pi' }] }] });
    const result = cli(['serve', '--no-open', '--port', '0']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('xezar did not start');
    expect(result.stderr).toContain(`${runsFile()}: runs[0].runner = "pi", in the item with id "r1"`);
    expect(result.stderr).toContain(`${runsFile()}: runs[0].steps[0].backend = "pi", in the item with id "r1"`);
    expect(readFileSync(runsFile(), 'utf8')).toBe(runs);
  }, 90_000);

  it('`run` refuses while a stored opencode value remains in the project config', () => {
    const config = write(join(project, '.xezar', 'config.json'), { defaultRunner: 'opencode' });
    const result = cli(['run', 'say hello']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${join(project, '.xezar', 'config.json')}: defaultRunner = "opencode"`);
    expect(readFileSync(join(project, '.xezar', 'config.json'), 'utf8')).toBe(config);
  }, 90_000);

  it('a clean project is not refused: the launch goes on to the command itself', () => {
    write(join(project, '.xezar', 'config.json'), { defaultRunner: 'claude' });
    write(runsFile(), { runs: [{ id: 'r1', runner: 'qwen', steps: [{ id: 's', backend: 'qwen' }] }] });
    // An unknown workflow is refused by `run` itself, AFTER the boot check: reaching that refusal
    // proves the check let the launch through, without starting an agent.
    const result = cli(['run', '--workflow', 'no-such-workflow', 'say hello']);
    expect(result.stderr).not.toContain('xezar did not start');
    expect(result.stderr).toContain('unknown workflow: no-such-workflow');
  }, 90_000);
});
