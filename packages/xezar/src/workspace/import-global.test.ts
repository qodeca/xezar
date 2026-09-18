import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalStateLayout, projectStateLayout, type StateLayout } from '../state-layout.ts';
import {
  firstRunImportLine,
  importGlobalSetup,
  isFirstSingleProjectRun,
  runFirstRunImport,
  type ImportAsk,
} from './import-global.ts';

/**
 * #600 piece (d) — the first-run import from the global setup, SP-5.1 to SP-5.3.
 *
 * The global home is a real directory (pinned through `XEZ_HOME`, the variable the global layout
 * has always honoured), holding the three files a user's machine would, so every assertion about
 * "the home is untouched" compares real bytes.
 */
describe('import from the global setup (#600 FR-4)', () => {
  let base: string;
  let home: string;
  let project: string;
  let layout: StateLayout;
  let env: NodeJS.ProcessEnv;

  const GLOBAL_CONFIG = {
    schemaVersion: 1,
    projects: [{ id: 'elsewhere', root: '/repos/elsewhere' }],
    resources: { maxParallel: 5, memoryLimitMb: 3072 },
    agentDefaults: { runner: 'codex' },
    futureKey: { kept: true },
  };
  const GLOBAL_UI = { appearance: { density: 'compact' } };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'xez-import-global-')));
    home = join(base, 'home', '.xezar');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    env = { XEZ_HOME: home };
    layout = projectStateLayout(project);
    writeFileSync(join(home, 'config.json'), `${JSON.stringify(GLOBAL_CONFIG)}\n`);
    writeFileSync(
      join(home, 'agent-accounts.json'),
      `${JSON.stringify({
        accounts: [{ id: 'work', provider: 'claude', configDir: '~/.claude-work', label: 'Work account' }],
        defaults: { claude: 'work' },
        selections: { [project]: { claude: 'work' }, '/repos/elsewhere': { codex: 'other' } },
      })}\n`,
    );
    writeFileSync(join(home, 'ui-state.json'), `${JSON.stringify(GLOBAL_UI)}\n`);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Every file under the home, with its bytes — what "the home is untouched" means. */
  const homeBytes = (): Record<string, string> =>
    Object.fromEntries(readdirSync(home).sort().map((name) => [name, readFileSync(join(home, name), 'utf8')]));

  const projectStateDirContents = (): string[] => (existsSync(layout.root) ? readdirSync(layout.root).sort() : []);

  const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

  describe('SP-5.1 — a first run with no state asks, and writes nothing before the answer', () => {
    it('asks exactly once, naming both folders, while the project holds no state file yet', async () => {
      const seen: Array<{ question: string; filesAtAsk: string[] }> = [];
      const ask: ImportAsk = async (question) => {
        seen.push({ question, filesAtAsk: projectStateDirContents() });
        return false;
      };

      const outcome = await runFirstRunImport(layout, ask, env);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.filesAtAsk).toEqual([]);
      expect(seen[0]!.question).toContain(home);
      expect(seen[0]!.question).toContain(layout.root);
      expect(outcome).toEqual({ kind: 'declined' });
    });

    it('a decline imports nothing and writes nothing', async () => {
      const before = homeBytes();
      await runFirstRunImport(layout, async () => false, env);
      expect(projectStateDirContents()).toEqual([]);
      expect(homeBytes()).toEqual(before);
    });

    it('nobody to ask (no terminal) imports nothing and writes nothing, and the boot says so', async () => {
      const outcome = await runFirstRunImport(layout, async () => null, env);
      expect(outcome).toEqual({ kind: 'no-terminal' });
      expect(projectStateDirContents()).toEqual([]);
      expect(firstRunImportLine(outcome, layout, env)).toBe(
        `  not a terminal, so nothing was imported from your global setup — starting ${layout.root} with defaults`,
      );
    });

    it('a yes copies the three files, without the project list or other folders\' selections', async () => {
      const before = homeBytes();
      const outcome = await runFirstRunImport(layout, async () => true, env);

      expect(outcome.kind).toBe('imported');
      const { projects: _dropped, ...expectedWorkspace } = GLOBAL_CONFIG;
      expect(json(layout.workspacePath)).toEqual(expectedWorkspace);
      expect(json(layout.uiStatePath)).toEqual(GLOBAL_UI);
      expect(json(layout.accountsPath)).toEqual({
        accounts: [{ id: 'work', provider: 'claude', configDir: '~/.claude-work', label: 'Work account' }],
        defaults: { claude: 'work' },
        selections: { [project]: { claude: 'work' } },
      });
      // The import reads the home; it never writes there.
      expect(homeBytes()).toEqual(before);
      expect(firstRunImportLine(outcome, layout, env)).toBe(`  imported 3 file(s) into ${layout.root}`);
    });
  });

  describe('SP-5.2 — a folder that already holds the state is not asked and not imported into', () => {
    it('never calls the ask and changes nothing', async () => {
      mkdirSync(layout.root, { recursive: true });
      writeFileSync(layout.workspacePath, '{"resources":{"maxParallel":2}}\n');
      let asked = 0;

      const outcome = await runFirstRunImport(layout, async () => {
        asked += 1;
        return true;
      }, env);

      expect(outcome).toEqual({ kind: 'not-first-run' });
      expect(asked).toBe(0);
      expect(projectStateDirContents()).toEqual(['workspace.json']);
      expect(readFileSync(layout.workspacePath, 'utf8')).toBe('{"resources":{"maxParallel":2}}\n');
    });

    it('an EMPTY workspace.json is state too — the marker decides, not its contents', () => {
      mkdirSync(layout.root, { recursive: true });
      writeFileSync(layout.workspacePath, '');
      expect(isFirstSingleProjectRun(layout)).toBe(false);
    });

    it('a project config alone (the kit\'s .xezar/config.json) is not state, so the first run still asks', () => {
      mkdirSync(layout.root, { recursive: true });
      writeFileSync(layout.configPath!, '{}\n');
      expect(isFirstSingleProjectRun(layout)).toBe(true);
    });

    it('the global layout is never a first run of the mode', async () => {
      let asked = 0;
      const outcome = await runFirstRunImport(globalStateLayout(env), async () => {
        asked += 1;
        return true;
      }, env);
      expect(outcome).toEqual({ kind: 'not-first-run' });
      expect(asked).toBe(0);
    });
  });

  describe('SP-5.3 — one-way and once: no sync in either direction afterwards', () => {
    it('a later change on either side leaves the other byte-identical', async () => {
      await runFirstRunImport(layout, async () => true, env);
      const projectAfterImport = readFileSync(layout.workspacePath, 'utf8');
      const homeAfterImport = homeBytes();

      // The global side changes: the project does not follow — including on the next boot's
      // first-run step, which is no longer a first run.
      writeFileSync(join(home, 'config.json'), '{"resources":{"maxParallel":9}}\n');
      expect(await runFirstRunImport(layout, async () => true, env)).toEqual({ kind: 'not-first-run' });
      expect(readFileSync(layout.workspacePath, 'utf8')).toBe(projectAfterImport);

      // The project side changes: the home does not follow.
      const homeNow = homeBytes();
      writeFileSync(layout.workspacePath, '{"resources":{"maxParallel":1}}\n');
      writeFileSync(layout.accountsPath, '{}\n');
      expect(homeBytes()).toEqual(homeNow);
      expect(homeNow['agent-accounts.json']).toBe(homeAfterImport['agent-accounts.json']);
    });
  });

  describe('what the import refuses to do', () => {
    it('never overwrites a project file that already exists', () => {
      mkdirSync(layout.root, { recursive: true });
      writeFileSync(layout.accountsPath, '{"accounts":[]}\n');
      const files = importGlobalSetup(layout, env);
      expect(files.find((file) => file.to === layout.accountsPath)?.outcome).toBe('kept-existing');
      expect(readFileSync(layout.accountsPath, 'utf8')).toBe('{"accounts":[]}\n');
    });

    it('skips and names an unreadable global file instead of importing a boot refusal', async () => {
      writeFileSync(join(home, 'config.json'), '{ not json');
      const outcome = await runFirstRunImport(layout, async () => true, env);
      expect(existsSync(layout.workspacePath)).toBe(false);
      expect(firstRunImportLine(outcome, layout, env)).toBe(
        `  imported 2 file(s) into ${layout.root}; skipped unreadable ${join(home, 'config.json')}`,
      );
    });

    it('an empty home imports nothing and says so', async () => {
      rmSync(home, { recursive: true, force: true });
      const outcome = await runFirstRunImport(layout, async () => true, env);
      expect(projectStateDirContents()).toEqual([]);
      expect(firstRunImportLine(outcome, layout, env)).toBe(`  nothing to import from ${home}`);
    });
  });
});
