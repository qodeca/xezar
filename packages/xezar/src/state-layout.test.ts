import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync as realpath, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeStateLayout,
  assertProjectStateUsable,
  globalStateRoot,
  PROJECT_STATE_MARKER,
  projectStateFiles,
  resolveStateLayout,
  setActiveStateLayout,
  SingleProjectStateError,
  stateLayoutBootLine,
} from './state-layout.ts';
import { createProjectStateFiles } from './workspace/config.ts';
import { agentAccountsPath, workspaceConfigPath, workspaceUiStatePath, xezarHomeDir } from './paths.ts';

/**
 * The resolver is a pure function of `(cwd, argv, env)` plus the filesystem
 * those describe, so almost everything here is a temp directory and an
 * assertion on an absolute path (risk R2 in the slicing analysis: "the four
 * state files land in the wrong place, or one of them still lands in the
 * home").
 *
 * The one thing these cases must never do is depend on a layout another file
 * installed: `activeStateLayout()` is process-global by design, so every case
 * that sets it clears it again in `afterEach`.
 */
describe('resolveStateLayout', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(realpath(tmpdir()), 'xez-state-layout-'));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(project, { recursive: true, force: true });
  });

  const marker = (): string => {
    mkdirSync(join(project, '.xezar'), { recursive: true });
    const path = join(project, '.xezar', PROJECT_STATE_MARKER);
    writeFileSync(path, '{}\n', 'utf8');
    return path;
  };

  it('answers the global layout for an ordinary folder with no flag', () => {
    const layout = resolveStateLayout(project, [], { XEZ_HOME: '/tmp/xez-global' });

    expect(layout).toEqual({
      mode: 'global',
      root: '/tmp/xez-global',
      projectRoot: null,
      configPath: null,
      workspacePath: join('/tmp/xez-global', 'config.json'),
      uiStatePath: join('/tmp/xez-global', 'ui-state.json'),
      accountsPath: join('/tmp/xez-global', 'agent-accounts.json'),
      dataDir: null,
      // The cache is `~/.cache/xez` and XEZ_HOME does not move it — the
      // behaviour `skills-remote.ts` already shipped, kept deliberately (#600
      // SP-2.2 pins it from the other side).
      cacheDir: join(homedir(), '.cache', 'xez'),
      ipcDir: join('/tmp/xez-global', 'ipc'),
    });
  });

  it('names every state path inside the project when the flag is given (AC-2)', () => {
    const layout = resolveStateLayout(project, ['--single-project'], {});

    expect(layout).toEqual({
      mode: 'project',
      root: join(project, '.xezar'),
      projectRoot: project,
      configPath: join(project, '.xezar', 'config.json'),
      workspacePath: join(project, '.xezar', 'workspace.json'),
      uiStatePath: join(project, '.xezar', 'workspace-ui.json'),
      accountsPath: join(project, '.xezar', 'agent-accounts.json'),
      dataDir: join(project, '.local', 'xezar'),
      // Working files, so `.local/xezar` rather than the committed `.xezar`.
      cacheDir: join(project, '.local', 'xezar', 'cache'),
      ipcDir: join(project, '.local', 'xezar', 'ipc'),
    });
  });

  it('enters the mode with NO flag once the folder holds workspace.json (SP-1.1, FR-1.2)', () => {
    marker();

    expect(resolveStateLayout(project, [], {}).mode).toBe('project');
    // ...and the flag is not needed a second time, which is the whole of FR-1.1.
    expect(resolveStateLayout(project, ['--single-project'], {}).mode).toBe('project');
  });

  it('is not decided by XEZ_SINGLE_PROJECT (SP-1.3, FR-1.4)', () => {
    // That variable keeps its own meaning — one project, no project
    // management, GLOBAL state. Reading it here would move a user's state the
    // day they set a flag that has never moved anything.
    expect(resolveStateLayout(project, [], { XEZ_SINGLE_PROJECT: '1' }).mode).toBe('global');
  });

  it('leaves the cwd untouched for the env-only row (SP-1.3 falsifier)', () => {
    resolveStateLayout(project, [], { XEZ_SINGLE_PROJECT: '1' });

    expect(readdirSync(project)).toEqual([]);
  });

  it('is not decided by XEZ_HOME either — that relocates the GLOBAL root, it does not create a mode', () => {
    const layout = resolveStateLayout(project, [], { XEZ_HOME: join(project, 'elsewhere') });

    expect(layout.mode).toBe('global');
    expect(layout.root).toBe(join(project, 'elsewhere'));
  });

  it('lets the folder outrank XEZ_HOME (BR-1: the folder decides, not the environment)', () => {
    marker();

    const layout = resolveStateLayout(project, [], { XEZ_HOME: '/tmp/xez-somewhere-else' });

    expect(layout.mode).toBe('project');
    expect(layout.root).toBe(join(project, '.xezar'));
  });

  /**
   * #657 — the missing half of the mode's input: an explicit "global" answer.
   *
   * `--single-project` turns the mode ON and until this input existed nothing
   * turned it OFF, so a folder carrying `workspace.json` was in the mode and the
   * only way out was to move the file. The precedence is stated in
   * `resolveStateLayout` and pinned here: the explicit global input outranks the
   * marker, and nothing else changes.
   */
  it('lets the explicit global flag outrank a present marker', () => {
    marker();

    const layout = resolveStateLayout(project, ['--global-layout'], { XEZ_HOME: '/tmp/xez-global' });

    expect(layout.mode).toBe('global');
    // ...and it resolves the GLOBAL root, so the launch really lands in
    // `XEZ_HOME` rather than in the project's own `.xezar/`.
    expect(layout.root).toBe('/tmp/xez-global');
  });

  it('lets the explicit global environment variable outrank a present marker, and only exact `1` does it', () => {
    marker();

    expect(resolveStateLayout(project, [], { XEZ_GLOBAL_LAYOUT: '1', XEZ_HOME: '/tmp/xez-global' }).mode).toBe(
      'global',
    );
    // Strict activation, the same spelling rule `XEZ_SINGLE_PROJECT` follows: a
    // variable that is merely set must not move anybody's state.
    for (const value of ['0', 'true', 'yes', '']) {
      expect(resolveStateLayout(project, [], { XEZ_GLOBAL_LAYOUT: value }).mode, value).toBe('project');
    }
  });

  it('still enters the mode when the input is absent and the marker is present', () => {
    marker();

    expect(resolveStateLayout(project, [], {}).mode).toBe('project');
  });

  it('still answers the global layout when the input is absent and there is no marker', () => {
    expect(resolveStateLayout(project, [], {}).mode).toBe('global');
  });

  it('wins over --single-project too, because it is the explicit answer to "which layout"', () => {
    expect(resolveStateLayout(project, ['--single-project', '--global-layout'], {}).mode).toBe('global');
  });

  it('changes nothing on disk — the marker is still there, byte for byte', () => {
    const path = marker();

    const layout = resolveStateLayout(project, ['--global-layout'], { XEZ_HOME: '/tmp/xez-global' });

    expect(layout.mode).toBe('global');
    expect(readFileSync(path, 'utf8')).toBe('{}\n');
    expect(readdirSync(join(project, '.xezar'))).toEqual([PROJECT_STATE_MARKER]);
  });

  it('is still overruled by the linked-worktree rule, which no input can turn off (FR-1.3)', () => {
    const worktree = join(project, '.local', 'xezar', 'worktrees', 'abc123');
    mkdirSync(worktree, { recursive: true });

    // Already the global layout, so this pins that the new input adds no way to
    // reach the mode from a task worktree either.
    expect(resolveStateLayout(worktree, ['--global-layout'], {}).mode).toBe('global');
  });

  it('exports the input names the CLI registers and the docs spell, so a rename cannot drift', async () => {
    const module = await import('./state-layout.ts');

    expect(module.GLOBAL_LAYOUT_FLAG).toBe('--global-layout');
    expect(module.GLOBAL_LAYOUT_ENV).toBe('XEZ_GLOBAL_LAYOUT');
  });

  it('never makes the user home a project root, flag or not', () => {
    expect(resolveStateLayout(homedir(), ['--single-project'], {}).mode).toBe('global');
  });

  it('never makes a task-worktree path a project root, flag or not (FR-1.3)', () => {
    const worktree = join(project, '.local', 'xezar', 'worktrees', 'abc123');
    mkdirSync(worktree, { recursive: true });

    expect(resolveStateLayout(worktree, ['--single-project'], {}).mode).toBe('global');
  });

  it('ignores a marker file that sits in a task worktree', () => {
    const worktree = join(project, '.local', 'xezar', 'worktrees', 'abc123');
    mkdirSync(join(worktree, '.xezar'), { recursive: true });
    writeFileSync(join(worktree, '.xezar', PROJECT_STATE_MARKER), '{}\n', 'utf8');

    expect(resolveStateLayout(worktree, [], {}).mode).toBe('global');
  });
});

describe('globalStateRoot', () => {
  it('is ~/.xezar by default', () => {
    expect(globalStateRoot({})).toBe(join(homedir(), '.xezar'));
  });

  it('honours XEZ_HOME, and treats an empty value as absent', () => {
    expect(globalStateRoot({ XEZ_HOME: '/tmp/pinned' })).toBe('/tmp/pinned');
    expect(globalStateRoot({ XEZ_HOME: '' })).toBe(join(homedir(), '.xezar'));
  });
});

describe('the active layout drives every state path (DC-1)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(realpath(tmpdir()), 'xez-state-active-'));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(project, { recursive: true, force: true });
  });

  it('starts global, so a process that never sets it behaves exactly as before', () => {
    expect(activeStateLayout({ XEZ_HOME: '/tmp/pinned' }).mode).toBe('global');
    expect(workspaceConfigPath({ XEZ_HOME: '/tmp/pinned' })).toBe('/tmp/pinned/config.json');
  });

  it('redirects the three workspace state files once a project layout is installed', () => {
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], {}));

    expect(workspaceConfigPath()).toBe(join(project, '.xezar', 'workspace.json'));
    expect(workspaceUiStatePath()).toBe(join(project, '.xezar', 'workspace-ui.json'));
    expect(agentAccountsPath()).toBe(join(project, '.xezar', 'agent-accounts.json'));
  });

  it('keeps xezarHomeDir answering the PER-USER home in the mode (FR-8.2)', () => {
    // The host-install records (`server.json`, `server-instances/`, the install
    // lock) describe the machine rather than the project and stay there. They
    // hang off this helper, so it must not follow the project.
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], {}));

    expect(xezarHomeDir({ XEZ_HOME: '/tmp/pinned' })).toBe('/tmp/pinned');
    expect(xezarHomeDir({})).toBe(join(homedir(), '.xezar'));
  });

  it('is cleared, not stored, by a global layout — so XEZ_HOME stays live per call', () => {
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], {}));
    setActiveStateLayout(resolveStateLayout(project, [], {}));

    expect(workspaceConfigPath({ XEZ_HOME: '/tmp/a' })).toBe('/tmp/a/config.json');
    expect(workspaceConfigPath({ XEZ_HOME: '/tmp/b' })).toBe('/tmp/b/config.json');
  });
});

describe('createProjectStateFiles (AC-2, AC-4)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(realpath(tmpdir()), 'xez-state-create-'));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(project, { recursive: true, force: true });
  });

  it('creates exactly the four files, and nothing else, under <project>/.xezar', () => {
    const layout = resolveStateLayout(project, ['--single-project'], {});

    createProjectStateFiles(layout);

    expect(readdirSync(layout.root).sort()).toEqual([
      'agent-accounts.json',
      'config.json',
      'workspace-ui.json',
      'workspace.json',
    ]);
    // Working files are the other directory's business; the first run must not
    // put one in `.xezar` and must not pre-create `.local/xezar` either.
    expect(readdirSync(project).sort()).toEqual(['.xezar']);
  });

  it('writes each file as an empty object, so every loader sees its zero-config default', () => {
    const layout = resolveStateLayout(project, ['--single-project'], {});

    createProjectStateFiles(layout);

    for (const path of projectStateFiles(layout)) {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
    }
  });

  it('never overwrites a file a clone brought with it (AC-4)', () => {
    const layout = resolveStateLayout(project, ['--single-project'], {});
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.workspacePath, '{"resources":{"maxParallel":9}}\n', 'utf8');

    createProjectStateFiles(layout);

    expect(JSON.parse(readFileSync(layout.workspacePath, 'utf8'))).toEqual({
      resources: { maxParallel: 9 },
    });
  });

  it('does nothing at all in the global layout', () => {
    createProjectStateFiles(resolveStateLayout(project, [], {}));

    expect(readdirSync(project)).toEqual([]);
  });
});

describe('assertProjectStateUsable (#600 Q1)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(realpath(tmpdir()), 'xez-state-usable-'));
  });

  afterEach(() => {
    // A case that made the directory read-only has to hand it back, or the
    // cleanup below cannot remove it.
    try {
      chmodSync(join(project, '.xezar'), 0o700);
    } catch {
      // never existed — nothing to restore
    }
    setActiveStateLayout(null);
    rmSync(project, { recursive: true, force: true });
  });

  const layoutFor = (): ReturnType<typeof resolveStateLayout> =>
    resolveStateLayout(project, ['--single-project'], {});

  it('passes for a first run in a writable folder', () => {
    expect(() => assertProjectStateUsable(layoutFor())).not.toThrow();
  });

  it('passes for a readable workspace.json', () => {
    const layout = layoutFor();
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.workspacePath, '{"schemaVersion":1}\n', 'utf8');

    expect(() => assertProjectStateUsable(layout)).not.toThrow();
  });

  it('accepts an EMPTY workspace.json — that is the user’s own state, not corruption', () => {
    const layout = layoutFor();
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.workspacePath, '', 'utf8');

    expect(() => assertProjectStateUsable(layout)).not.toThrow();
  });

  it('refuses the boot for a corrupt workspace.json, naming the file', () => {
    const layout = layoutFor();
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.workspacePath, '{not json', 'utf8');

    expect(() => assertProjectStateUsable(layout)).toThrow(SingleProjectStateError);
    expect(() => assertProjectStateUsable(layout)).toThrow(layout.workspacePath);
    // Refusing is the point: degrading would run this project off ~/.xezar.
    expect(() => assertProjectStateUsable(layout)).toThrow(/will not fall back to your global setup/);
  });

  it('refuses a workspace.json that parses but is not an object', () => {
    const layout = layoutFor();
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.workspacePath, '[1,2,3]', 'utf8');

    expect(() => assertProjectStateUsable(layout)).toThrow(/is not a JSON object/);
  });

  it('refuses an unwritable state directory', () => {
    const layout = layoutFor();
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.workspacePath, '{}', 'utf8');
    chmodSync(layout.root, 0o500);

    expect(() => assertProjectStateUsable(layout)).toThrow(SingleProjectStateError);
  });

  it('says nothing about the global layout — the other three files keep their own contracts', () => {
    const layout = resolveStateLayout(project, [], {});

    expect(() => assertProjectStateUsable(layout)).not.toThrow();
  });
});

describe('stateLayoutBootLine (FR-9.1, SP-1.7)', () => {
  it('is one line naming the mode and both folders', () => {
    const layout = resolveStateLayout('/repos/shop', ['--single-project'], {});
    const line = stateLayoutBootLine(layout);

    expect(line).not.toBeNull();
    expect(line!.split('\n')).toHaveLength(1);
    expect(line).toContain('single-project mode');
    expect(line).toContain(join('/repos/shop', '.xezar'));
    expect(line).toContain(join('/repos/shop', '.local', 'xezar'));
  });

  it('prints nothing in the global layout', () => {
    expect(stateLayoutBootLine(resolveStateLayout('/repos/shop', [], {}))).toBeNull();
  });

  it('has exactly one call site, so the boot can print neither zero lines nor two', () => {
    // SP-1.7's falsifier is "zero lines, or more than one". The producer above
    // pins the CONTENT; this pins the count, which no behavioural assertion on
    // one boot can do.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const calls = source.match(/stateLayoutBootLine\(/g) ?? [];

    expect(calls).toHaveLength(1);
  });
});
