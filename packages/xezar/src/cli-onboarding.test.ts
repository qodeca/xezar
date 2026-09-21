import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The onboarding half of the CLI, exercised through the REAL program (#819 items 1a–1c, 9b).
 *
 * `src/index.ts` runs `main()` on import, so these cases spawn it the way a person runs it —
 * which is also the only way to prove the two properties that live in the process rather than in
 * a function: that a launch with no terminal and a flag still imports (nothing here is a TTY), and
 * that `init` prints a package name npm can actually resolve.
 *
 * Every spawn is confined to a temporary folder with its own `XEZ_HOME`, so no case reads or
 * writes the developer's own setup.
 */

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe('CLI onboarding (#819)', () => {
  let base: string;
  let home: string;
  let project: string;

  /** Run the CLI with stdin CLOSED — no terminal, the case a bootstrap script is in. */
  const cli = (...args: string[]): Run => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, '--repo', project, ...args], {
      env: { ...process.env, XEZ_HOME: home, VITEST: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  const stateFile = (name: string): string => join(project, '.xezar', name);
  const machineState = (): Record<string, unknown> => {
    const path = join(project, '.local', 'xezar', 'machine-state.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'xez-cli-onboarding-')));
    home = join(base, 'home', '.xezar');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    execFileSync('git', ['init', '-q', project]);
    writeFileSync(join(home, 'config.json'), `${JSON.stringify({ schemaVersion: 1, resources: { maxParallel: 5 } })}\n`);
    writeFileSync(
      join(home, 'agent-accounts.json'),
      `${JSON.stringify({
        accounts: [{ id: 'work', provider: 'claude', configDir: '/Users/a.person/.claude-work', label: 'a.person@example.com' }],
        defaults: { claude: 'work', codex: 'gone-org' },
      })}\n`,
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('the launch flags (item 1a)', () => {
    it(
      'named break `flag-ignored-without-a-terminal`: --import-global imports with stdin closed (T1.1)',
      () => {
        const run = cli('init', '--single-project', '--import-global');

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain('not a terminal');
        expect(JSON.parse(readFileSync(stateFile('agent-accounts.json'), 'utf8'))).toMatchObject({
          accounts: [expect.objectContaining({ id: 'work' })],
        });
        expect(machineState().globalImport).toBe('imported');
      },
      30_000,
    );

    it(
      'named break `flag-ignored-so-nothing-is-recorded`: --no-import-global imports nothing and records the decline (T1.2)',
      () => {
        const run = cli('init', '--single-project', '--no-import-global');

        expect(run.status).toBe(0);
        expect(JSON.parse(readFileSync(stateFile('agent-accounts.json'), 'utf8'))).toEqual({});
        expect(machineState().globalImport).toBe('declined');
      },
      30_000,
    );

    it(
      'named break `last-wins-parsing`: both flags refuse the launch before anything is written (T1.3)',
      () => {
        const run = cli('init', '--single-project', '--import-global', '--no-import-global');

        expect(run.status).toBe(1);
        expect(run.stderr).toContain('--import-global and --no-import-global contradict each other');
        // Refused means nothing happened: no state folder, no scaffolding, no home read.
        expect(existsSync(join(project, '.xezar'))).toBe(false);
      },
      30_000,
    );

    it(
      'a bootstrap may pass --import-global on every start: the second one is quiet and changes nothing',
      () => {
        expect(cli('init', '--single-project', '--import-global').status).toBe(0);
        const accounts = readFileSync(stateFile('agent-accounts.json'), 'utf8');

        const again = cli('init', '--single-project', '--import-global');

        expect(again.status).toBe(0);
        expect(again.stdout).not.toContain('already has its own xezar setup');
        expect(again.stderr).toBe('');
        expect(readFileSync(stateFile('agent-accounts.json'), 'utf8')).toBe(accounts);
        expect(machineState().globalImport).toBe('imported');
      },
      60_000,
    );
  });

  describe('accounts import-global (item 1b)', () => {
    it(
      'imports after the first run is over, and a second run adds nothing (T1.4, T1.5)',
      () => {
        // The boot the person did not answer: the four files exist, so the prompt never returns.
        expect(cli('init', '--single-project', '--no-import-global').status).toBe(0);

        const first = cli('accounts', 'import-global', '--single-project');
        expect(first.status).toBe(0);
        expect(first.stdout).toContain('+ account work (claude)');
        // A default naming an account nobody has is skipped rather than copied.
        expect(first.stdout).toContain('skipped default account for codex → gone-org');
        // Ids and providers only: no label that looks like an identity, no config folder.
        expect(first.stdout).not.toContain('a.person@example.com');
        expect(first.stdout).not.toContain('/Users/a.person/.claude-work');
        const stored = readFileSync(stateFile('agent-accounts.json'), 'utf8');
        expect(JSON.parse(stored)).toMatchObject({ defaults: { claude: 'work' } });
        expect(machineState().globalImport).toBe('imported');

        const second = cli('accounts', 'import-global', '--single-project');
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('0 account(s) added, 1 left untouched');
        expect(readFileSync(stateFile('agent-accounts.json'), 'utf8')).toBe(stored);
      },
      90_000,
    );

    it('an unknown verb is refused with the usage line', () => {
      const run = cli('accounts', 'list-everything', '--single-project');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('usage: xezar accounts import-global');
    }, 30_000);
  });

  describe('what init ends with (item 9b)', () => {
    it(
      'named break `unscoped-package-name`: the closing lines name the scoped package, never a bare `npx xezar` (T9.3)',
      () => {
        const run = cli('init');

        expect(run.status).toBe(0);
        // `npx xezar` asks the registry for an unscoped package we do not publish: anyone could
        // publish it, and a person following our own closing line would run their code.
        expect(run.stdout).not.toMatch(/npx xezar\b/);
        expect(run.stdout).toContain('Done. Start the cockpit with: npx @qodeca/xezar');
        expect(run.stdout).toContain(
          'Agent accounts are not imported by init. To copy your global accounts into this project, run: npx @qodeca/xezar accounts import-global',
        );
        // In a repository, the setup a team can carry is named too.
        expect(run.stdout).toContain(
          "To keep this project's xezar setup inside the project folder: npx @qodeca/xezar --single-project",
        );
      },
      30_000,
    );

    it(
      'outside a repository the single-project line is left out, because there is nothing to carry',
      () => {
        const plain = join(base, 'plain');
        mkdirSync(plain, { recursive: true });
        const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, '--repo', plain, 'init'], {
          env: { ...process.env, XEZ_HOME: home, VITEST: '', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Done. Start the cockpit with: npx @qodeca/xezar');
        expect(result.stdout).not.toContain('--single-project');
      },
      30_000,
    );
  });
});
