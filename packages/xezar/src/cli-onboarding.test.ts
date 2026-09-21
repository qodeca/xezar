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

/**
 * The bare, unscoped command the closing lines must never print. npm has no package by that name,
 * so anyone could publish it and a person following our own line would run their code; the scoped
 * name is the one the install actually resolves. Spelled with `\s+` so this guard's own source
 * does not carry the literal it bans.
 */
const BARE_UNSCOPED = /\bnpx\s+xezar\b/;

describe('CLI onboarding (#819)', () => {
  let base: string;
  let home: string;
  let project: string;

  /**
   * The spawn every case uses, with stdin CLOSED — no terminal, the case a bootstrap script is in.
   * Each case needs its own project folder: the first-run import and `init` both change a folder
   * for good, so a second command in the same one meets a set-up project instead. `env` is spread
   * over the pinned home, and `timeoutMs` is opt-in so a spawn that hangs fails the case instead of
   * hanging the suite.
   */
  const cliIn = (
    repo: string,
    args: readonly string[],
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Run => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, '--repo', repo, ...args], {
      env: { ...process.env, XEZ_HOME: home, VITEST: '', NO_COLOR: '1', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  /** The same spawn against the fixture project. */
  const cli = (...args: string[]): Run => cliIn(project, args);

  /** A fresh git project: the import and `init` both change a folder for good. */
  const freshProject = (name: string): string => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    return dir;
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
      'named break `flag-door-copies-a-dangling-default`: --import-global drops a default naming no account, and names the handle (P2-AC8, P2-AC9)',
      () => {
        const run = cli('init', '--single-project', '--import-global');

        expect(run.status).toBe(0);
        // The fixture's global file carries `defaults: { claude: 'work', codex: 'gone-org' }` and no
        // `gone-org` account: the flag door must not copy that id into the project file.
        const stored = JSON.parse(readFileSync(stateFile('agent-accounts.json'), 'utf8')) as {
          defaults: Record<string, string>;
        };
        expect(stored.defaults).toEqual({ claude: 'work' });
        // A program reading this output cannot tell "a default was skipped" from "there was
        // nothing to skip" unless the handle is named.
        expect(run.stdout).toContain('skipped a default naming gone-org, which no account matches');
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
        // A default naming an account nobody has is skipped rather than copied, and named in the
        // one line both doors print (#824).
        expect(first.stdout).toContain('skipped a default naming gone-org, which no account matches');
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

    it(
      'a folder whose global setup holds no accounts records nothing, so the door stays open (T1.6)',
      () => {
        // The boot the person did not answer, and then the global accounts file disappears: the
        // command has nothing to copy.
        expect(cli('init', '--single-project', '--no-import-global').status).toBe(0);
        expect(machineState().globalImport).toBe('declined');
        rmSync(join(home, 'agent-accounts.json'), { force: true });

        const run = cli('accounts', 'import-global', '--single-project');

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('your global setup holds no agent accounts — nothing was changed');
        // Nothing was imported, so the state must not claim an import happened: `imported` would
        // silence the one line that still points at this command, and an account created in the
        // global setup later would never be copied in.
        expect(machineState().globalImport).toBe('declined');
        expect(cli('init', '--single-project', '--import-global').stdout).toContain(
          'copy your global agent accounts in with',
        );
      },
      60_000,
    );

    it('an unknown verb is refused with the usage line', () => {
      const run = cli('accounts', 'list-everything', '--single-project');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('usage: xezar accounts import-global');
    }, 30_000);
  });

  describe('a command that owns its stdout (F7)', () => {
    const SKIP_LINE = 'skipped a default naming gone-org, which no account matches';
    const machineStateOf = (repo: string): Record<string, unknown> => {
      const path = join(repo, '.local', 'xezar', 'machine-state.json');
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
    };

    it(
      'named break `skip-line-on-the-protocol-channel`: mcp and lease keep the skip line off their stdout, and the ordinary boot still prints it (P2-AC9)',
      () => {
        // The ordinary boot prints it. F7 is about routing the line off a channel that is not the
        // boot's, never about deleting it.
        const boot = cliIn(freshProject('boot'), ['projects', '--single-project', '--import-global'], {
          timeoutMs: 30_000,
        });
        expect(boot.status).toBe(0);
        expect(boot.stdout).toContain(SKIP_LINE);

        // `mcp` speaks JSON-RPC on stdout: a human line before the handshake is a protocol error,
        // not a banner. The launch really did the import, so the line existed to be printed.
        const mcpRepo = freshProject('mcp');
        const mcp = cliIn(mcpRepo, ['--single-project', '--import-global', 'mcp'], { timeoutMs: 30_000 });
        expect(mcp.status).toBe(0);
        expect(machineStateOf(mcpRepo).globalImport).toBe('imported');
        expect(mcp.stdout).not.toContain(SKIP_LINE);
        expect(mcp.stdout).not.toContain('gone-org');
        expect(mcp.stdout).toBe('');

        // `lease` hands its stdout to the command it wraps — BACKWARD_COMPATIBILITY.md §1 promises
        // `lease gates` writes nothing there. HOME is pinned as well, because the gate slot locks
        // are machine-wide by design (`gateLeaseDir()`): without this the case would queue behind a
        // real gate run, including the one running this suite, for up to the lease's 20-minute bound.
        const leaseRepo = freshProject('lease');
        const lease = cliIn(
          leaseRepo,
          [
            '--single-project',
            '--import-global',
            'lease',
            'gates',
            '--',
            process.execPath,
            '-e',
            'process.stdout.write("wrapped\\n")',
          ],
          { env: { HOME: join(base, 'lease-home') }, timeoutMs: 30_000 },
        );
        expect(lease.status).toBe(0);
        expect(machineStateOf(leaseRepo).globalImport).toBe('imported');
        expect(lease.stdout).toBe('wrapped\n');
        expect(lease.stderr).not.toContain(SKIP_LINE);
      },
      90_000,
    );
  });

  describe('init after the same launch imported (#825)', () => {
    const ACCOUNTS_LINE = 'Agent accounts are not imported by init.';

    it(
      'named break `contradicting-init-closing-line`: --import-global drops the accounts line, and a launch that imported nothing keeps it',
      () => {
        const imported = cliIn(freshProject('init-flag'), ['init', '--single-project', '--import-global'], {
          timeoutMs: 30_000,
        });
        expect(imported.status).toBe(0);
        // The run says what it did …
        expect(imported.stdout).toContain('imported');
        expect(imported.stdout).toContain('Done. Start the cockpit with:');
        // … and does not then tell the person to run the command it just ran.
        expect(imported.stdout).not.toContain(ACCOUNTS_LINE);
        expect(imported.stdout).not.toContain('accounts import-global');

        // No flag and no terminal: nothing was imported, so the line is still the truth.
        const asked = cliIn(freshProject('init-ask'), ['init', '--single-project'], { timeoutMs: 30_000 });
        expect(asked.status).toBe(0);
        expect(asked.stdout).toContain(ACCOUNTS_LINE);

        // Declined: nothing was imported either.
        const declined = cliIn(freshProject('init-declined'), ['init', '--single-project', '--no-import-global'], {
          timeoutMs: 30_000,
        });
        expect(declined.status).toBe(0);
        expect(declined.stdout).toContain(ACCOUNTS_LINE);
      },
      90_000,
    );
  });

  describe('what init ends with (item 9b)', () => {
    it(
      'named break `unscoped-package-name`: the closing lines name the scoped package, never a bare unscoped npm name (T9.3)',
      () => {
        const run = cli('init');

        expect(run.status).toBe(0);
        // The bare unscoped name asks the registry for a package we do not publish: anyone could
        // publish it, and a person following our own closing line would run their code.
        expect(run.stdout).not.toMatch(BARE_UNSCOPED);
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
