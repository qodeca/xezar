import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Single-project mode (#600) — WHERE xezar keeps its state, decided once per
 * process and never again.
 *
 * Two layouts exist and there is no third:
 *
 * - **`global`** — the default and the only layout any xezar before 0.16.0 had.
 *   State lives in the per-user home (`~/.xezar`, or `XEZ_HOME`), shared by
 *   every project on the machine, and the project registry inside it is what
 *   makes the cockpit multi-project.
 * - **`project`** — the state lives in the folder itself: `<project>/.xezar`
 *   for configuration, `<project>/.local/xezar` for working files. The real
 *   `~/.xezar` is never opened (BR-2), so a clone of the repository runs with
 *   the settings, accounts and limits the repository carries.
 *
 * **This module is the one resolver (DC-1).** The premortem failure for this
 * feature is half-isolation — one code path still reaching the real home, so
 * two projects quietly share state — and the structural defence is that every
 * state path is derived from a `StateLayout` rather than from `homedir()` at
 * the call site. `homedir()` therefore appears here — `globalStateRoot` and
 * `globalCacheRoot` below — and, outside this module, only where
 * `state-path-scan.test.ts` carries a written reason for it (#600 SP-2.1).
 * That test reads the source text of `packages/xezar/src`, so a new direct
 * `homedir()` or `'.xezar'` join fails the suite by file and line.
 *
 * Zero config holds: nothing has to exist and nothing has to be set. Without
 * `--single-project`, without `--global-layout` and without a `workspace.json`
 * in the folder, every function here answers exactly what xezar answered before
 * it existed.
 */

/** Which of the two layouts is in force. */
export type StateLayoutMode = 'global' | 'project';

/**
 * Every state path xezar resolves, plus the mode that produced them.
 *
 * `projectRoot`, `configPath` and `dataDir` are `null` in the global layout,
 * and that is the honest answer rather than a missing feature: the global
 * layout has no state-root project config (`<repo>/.xezar/config.json` is
 * resolved by `project-kit-paths.ts`, which is unrelated to the per-user home)
 * and no single project whose working directory the layout could name.
 */
export interface StateLayout {
  mode: StateLayoutMode;
  /** The directory holding the state files. Global: `~/.xezar`. Project: `<project>/.xezar`. */
  root: string;
  /** Project layout only: the folder that decided the mode. */
  projectRoot: string | null;
  /**
   * Project layout only: `<project>/.xezar/config.json` — today's project
   * config, keeping today's meaning exactly (FR-2.2). It is the same file
   * `projectKitDir()` already resolves; the layout names it so the first run
   * can create it, not to give it a second meaning.
   */
  configPath: string | null;
  /**
   * The workspace config: global defaults, resource ceilings and the project
   * registry. Global: `~/.xezar/config.json` (unchanged). Project:
   * `<project>/.xezar/workspace.json` — a different NAME because
   * `<project>/.xezar/config.json` is already taken by the project config
   * above, and renaming either would break the other.
   */
  workspacePath: string;
  /**
   * Workspace-level GUI preferences. Global: `~/.xezar/ui-state.json`
   * (unchanged). Project: `<project>/.xezar/workspace-ui.json`.
   *
   * NOT `ui-state.json` in the project layout, deliberately. That name is
   * already claimed by the per-repo runtime file `.local/xezar/ui-state.json`,
   * which `tracked-files.test.ts` asserts must stay gitignored — a guard
   * written after local machine state was nearly committed to a repository
   * about to be made public. A committed `<project>/.xezar/ui-state.json`
   * cannot coexist with it without weakening that guard, so the committed file
   * gets its own name instead (#600 Q2).
   */
  uiStatePath: string;
  /** Agent accounts. `<root>/agent-accounts.json` in both layouts. */
  accountsPath: string;
  /** Project layout only: `<project>/.local/xezar` — the working files that are not committed. */
  dataDir: string | null;
  /**
   * Where xezar caches things it can always fetch again — today the bare clones
   * of team skills repos (`<cacheDir>/skills/<owner>__<name>`) and the
   * skills-update lock beside them.
   *
   * Global: `~/.cache/xez`, byte for byte what `skills-remote.ts` hardcoded
   * before this field existed, `XEZ_HOME` deliberately NOT consulted — moving
   * it would change a working default for every existing user for no reason
   * (AGENTS.md § Zero config). Project: `<project>/.local/xezar/cache`, because
   * a cache is a working file and AC-5 puts the mode's skills inside the
   * project rather than in a directory every other project on the machine
   * shares.
   */
  cacheDir: string;
  /**
   * The directory holding the MCP bridge's unix sockets, one per project.
   *
   * Global: `<root>/ipc`, i.e. `~/.xezar/ipc` — unchanged. Project:
   * `<project>/.local/xezar/ipc`, NOT `<project>/.xezar/ipc`: BR-2 forbids
   * opening the per-user home in the mode, and a socket is a working file that
   * must never land in the committed state directory.
   */
  ipcDir: string;
}

/** The flag that creates the mode's state in the current folder (FR-1.1). */
export const SINGLE_PROJECT_FLAG = '--single-project';

/**
 * The flag that ANSWERS "global" for this launch (#657), even in a folder
 * whose `workspace.json` would otherwise put it in the mode.
 *
 * The missing half of `SINGLE_PROJECT_FLAG`: that one turns the mode ON, and
 * until this one existed there was no input that turned it OFF — a folder that
 * carried the marker was in the mode and the only way out was to move the file.
 * A caller that needs the global layout for one launch (a test harness, a
 * script, a person comparing the two) says so here instead of editing the
 * project's committed state, which is not a thing an unlocked rename can do
 * safely in a checkout another process may be serving.
 */
export const GLOBAL_LAYOUT_FLAG = '--global-layout';

/**
 * The environment counterpart of `GLOBAL_LAYOUT_FLAG`. Strict activation, like
 * its `XEZ_SINGLE_PROJECT` sibling: only the exact string `1` asks for the
 * global layout, and nothing else.
 *
 * `XEZ_HOME` is deliberately NOT consulted for this. It keeps its documented
 * meaning exactly — it relocates the GLOBAL state root, and it neither turns
 * the mode on nor off — so the day a variable moved somebody's state would be a
 * surprise this module refuses to spring.
 */
export const GLOBAL_LAYOUT_ENV = 'XEZ_GLOBAL_LAYOUT';

/** The directory, under the project root, that holds the mode's configuration. */
export const PROJECT_STATE_DIR = '.xezar';

/**
 * The file whose presence IS the mode (FR-1.2). Once `<project>/.xezar` holds
 * it, every `xez` started in that folder is in the mode, flag or no flag —
 * which is the whole point of DC-2: an environment variable can be lost by an
 * IDE, a script or a plain `xez`, and a file in the folder cannot. The one
 * exception is the explicit global input (#657), which is the caller SAYING
 * which layout it wants rather than a variable that quietly stopped deciding.
 */
export const PROJECT_STATE_MARKER = 'workspace.json';

/** Project layout only: where the working files go, relative to the project root. */
const PROJECT_DATA_DIR = join('.local', 'xezar');

/**
 * The per-user cache root — `~/.cache/xez`.
 *
 * `XEZ_HOME` is NOT read here, and that asymmetry with `globalStateRoot` is the
 * behaviour this repository already shipped (`skills-remote.ts` hardcoded
 * `join(homedir(), '.cache', 'xez', …)`), preserved deliberately: this function
 * exists to move the cache in the PROJECT layout, not to move it for the
 * millions of launches that are still global.
 */
function globalCacheRoot(): string {
  return join(homedir(), '.cache', 'xez');
}

/**
 * Refused boot (#600 Q1). `workspace.json` is what makes the folder a
 * single-project root: with it unreadable the mode is not a mode, and
 * degrading to in-memory defaults would silently write the user's state to
 * `~/.xezar` — exactly the violation BR-2 exists to prevent. The other three
 * files keep their established "written, never required" degradation, so this
 * is the single place the mode fails loudly instead of quietly.
 */
export class SingleProjectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingleProjectStateError';
  }
}

/**
 * The per-user state root — `~/.xezar`, or `XEZ_HOME` when it is set to a
 * non-empty value. Re-read per call on purpose (`XEZ_HOME` is how tests and
 * containers stay off a real home), and the ONE expression in the repository
 * that joins `homedir()` with `.xezar`.
 */
export function globalStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  // `|| undefined` so an EMPTY XEZ_HOME (e.g. `XEZ_HOME= xezar …`) falls back
  // to the default instead of yielding relative paths in the cwd.
  return (env.XEZ_HOME || undefined) ?? join(homedir(), PROJECT_STATE_DIR);
}

/** The layout every xezar has always had. Derived per call, so `XEZ_HOME` stays live. */
export function globalStateLayout(env: NodeJS.ProcessEnv = process.env): StateLayout {
  const root = globalStateRoot(env);
  return {
    mode: 'global',
    root,
    projectRoot: null,
    configPath: null,
    workspacePath: join(root, 'config.json'),
    uiStatePath: join(root, 'ui-state.json'),
    accountsPath: join(root, 'agent-accounts.json'),
    dataDir: null,
    cacheDir: globalCacheRoot(),
    ipcDir: join(root, 'ipc'),
  };
}

/** The layout for a folder that owns its state. */
export function projectStateLayout(projectRoot: string): StateLayout {
  const root = join(projectRoot, PROJECT_STATE_DIR);
  const dataDir = join(projectRoot, PROJECT_DATA_DIR);
  return {
    mode: 'project',
    root,
    projectRoot,
    configPath: join(root, 'config.json'),
    workspacePath: join(root, PROJECT_STATE_MARKER),
    uiStatePath: join(root, 'workspace-ui.json'),
    accountsPath: join(root, 'agent-accounts.json'),
    dataDir,
    cacheDir: join(dataDir, 'cache'),
    ipcDir: join(dataDir, 'ipc'),
  };
}

/**
 * Is `dir` a LINKED git worktree — a second checkout of a repository whose real
 * git directory lives elsewhere (FR-1.3)?
 *
 * A linked worktree is never a single-project root, and the reason is not
 * tidiness: every xezar task worktree under `.local/xezar/worktrees/` is one,
 * so a mode that entered there would give each running task its own copy of
 * the settings, accounts and registry the task is supposed to be running
 * against.
 *
 * Cheap first, git second. A main checkout's `.git` is a DIRECTORY, and that
 * answers the question with one `stat` — no subprocess on the path an ordinary
 * launch takes. Only a `.git` FILE (a linked worktree, or a submodule, which
 * is not one) is ambiguous, and only then is git asked. A `.git` file whose
 * git cannot answer is treated as a worktree: refusing the mode is the
 * conservative direction, because entering it wrongly splits a task's state.
 */
export function isLinkedWorktree(dir: string): boolean {
  const dotGit = join(dir, '.git');
  let entry;
  try {
    entry = statSync(dotGit);
  } catch {
    return false; // no `.git` at all — not a repository, so not a linked worktree
  }
  if (entry.isDirectory()) return false;
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [gitDir, commonDir] = out.trim().split('\n');
    if (!gitDir || !commonDir) return true;
    return resolve(gitDir) !== resolve(commonDir);
  } catch {
    return true;
  }
}

/** The user's own home directory is never a project (the rule `shouldRegisterProject` already applies). */
function isUserHome(dir: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(dir) === real(homedir());
}

/**
 * Anything under a xezar task worktree directory, checked on the path itself so
 * a copied-out worktree with no usable `.git` is refused too. Belt to
 * `isLinkedWorktree`'s braces: those two answer the same question by different
 * means, and FR-1.3 names this path explicitly.
 */
function isInsideTaskWorktree(dir: string): boolean {
  return `${resolve(dir)}${sep}`.includes(`${sep}.local${sep}xezar${sep}worktrees${sep}`);
}

/**
 * Resolve the layout for a launch (FR-1.2, FR-1.3).
 *
 * `cwd` is the folder xezar was asked to operate on, `argv` the arguments after
 * the executable, `env` the environment. Pure and synchronous: nothing is
 * created, nothing is written, and the answer depends on nothing but its three
 * inputs and the filesystem they describe — which is what lets it run at the
 * very first point of the boot, before anything reads state.
 *
 * The order is load-bearing, and it is stated HERE and nowhere else:
 *
 * 1. A linked worktree, anything under `.local/xezar/worktrees/`, and `$HOME`
 *    itself are never single-project roots — no input overrides this.
 * 2. An explicit GLOBAL input (`GLOBAL_LAYOUT_FLAG`, or `GLOBAL_LAYOUT_ENV` set
 *    to `1`) answers "global" for this launch, and it outranks the marker. It
 *    is also the one input that outranks `SINGLE_PROJECT_FLAG`: a caller that
 *    asks for both is contradicting itself, and the explicit answer to "which
 *    layout" is the more specific of the two.
 * 3. A folder already holding `workspace.json` is in the mode, flag or not.
 * 4. Otherwise the flag, and only the flag, creates the mode.
 *
 * `XEZ_SINGLE_PROJECT` is deliberately NOT consulted. It keeps today's exact
 * meaning — one project, no project management, GLOBAL state — and the new mode
 * is a separate superset of it (FR-1.4). Reading it here would move a user's
 * state the day they set a variable that has never moved anything.
 */
export function resolveStateLayout(
  cwd: string,
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): StateLayout {
  const projectRoot = resolve(cwd);
  if (isLinkedWorktree(projectRoot) || isInsideTaskWorktree(projectRoot) || isUserHome(projectRoot)) {
    return globalStateLayout(env);
  }
  if (globalLayoutAsked(argv, env)) return globalStateLayout(env);
  const layout = projectStateLayout(projectRoot);
  if (existsSync(layout.workspacePath)) return layout;
  return argv.includes(SINGLE_PROJECT_FLAG) ? layout : globalStateLayout(env);
}

/**
 * Is this launch explicitly asking for the global layout (#657)? The one
 * spelling of that question, so a second reader cannot disagree with
 * `resolveStateLayout` about what the input means.
 */
function globalLayoutAsked(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes(GLOBAL_LAYOUT_FLAG) || env[GLOBAL_LAYOUT_ENV] === '1';
}

/**
 * The PROJECT layout in force for this process, or `null` when the global one
 * is (which is the default, and what every library consumer and every test that
 * never calls the setter gets).
 *
 * Only a project layout is stored, and that asymmetry is deliberate: the global
 * layout must stay derived per call so `XEZ_HOME` remains live — several tests
 * and `mergeWriteWorkspaceConfig`'s one-resolution rule depend on a mid-flight
 * change being visible — while the project layout is decided by a folder that
 * cannot change under a running process.
 */
let activeProjectLayout: StateLayout | null = null;

/** The layout every state path resolves through. Global unless a boot set a project layout. */
export function activeStateLayout(env: NodeJS.ProcessEnv = process.env): StateLayout {
  return activeProjectLayout ?? globalStateLayout(env);
}

/**
 * Install the resolved layout for the rest of the process. Called ONCE, from
 * the CLI boot, before anything reads state. A global layout clears the stored
 * one rather than storing it (see `activeProjectLayout`), so passing the result
 * of `resolveStateLayout` is always correct whichever mode it answered.
 */
export function setActiveStateLayout(layout: StateLayout | null): void {
  activeProjectLayout = layout && layout.mode === 'project' ? layout : null;
}

/**
 * Refuse the boot when a project root's `workspace.json` cannot be trusted
 * (#600 Q1, BR-3 "a clone either runs identically or fails loudly"). Silent in
 * the global layout, and silent for the other three files — they keep their
 * existing degrade-with-one-warning contracts.
 *
 * "Corrupt" is exactly "not a JSON object", because every field of the
 * workspace schema is optional with a `.catch`, so no other content can fail to
 * load. An EMPTY file is the user's own state (the same reading
 * `loadWorkspaceConfig` takes) and is not corrupt.
 */
export function assertProjectStateUsable(layout: StateLayout): void {
  if (layout.mode !== 'project') return;
  const linkRefusal = projectStateDirRefusal(layout);
  if (linkRefusal !== null) throw new SingleProjectStateError(`single-project state ${linkRefusal}`);
  const path = layout.workspacePath;
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SingleProjectStateError(
        `single-project state ${path} cannot be read (${message}) — fix the file or its permissions; ` +
          'xezar will not fall back to your global setup, because that would run this project with different settings.',
      );
    }
    if (raw.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SingleProjectStateError(
          `single-project state ${path} is not valid JSON (${message}) — repair it or delete it to start fresh; ` +
            'xezar will not fall back to your global setup, because that would run this project with different settings.',
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SingleProjectStateError(
          `single-project state ${path} is not a JSON object — repair it or delete it to start fresh; ` +
            'xezar will not fall back to your global setup, because that would run this project with different settings.',
        );
      }
    }
    assertWritable(path, `single-project state ${path} is not writable`);
  }
  // The DIRECTORY, not only the file: every state write stages through a
  // per-writer tmp file and renames it into place, so a writable file inside a
  // read-only directory still cannot be updated. Probe the deepest existing
  // one — `<project>/.xezar` when it exists, the project root on a first run.
  const dir = existsSync(layout.root) ? layout.root : layout.projectRoot!;
  assertWritable(dir, `single-project state in ${dir} is not writable`);
}

function assertWritable(path: string, what: string): void {
  try {
    accessSync(path, constants.W_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SingleProjectStateError(
      `${what} (${message}) — fix the permissions; xezar will not fall back to your global setup, ` +
        'because that would run this project with different settings.',
    );
  }
}

/**
 * The four configuration files a first run creates, in the order AC-2 lists
 * them. The creation itself lives in `workspace/config.ts`, with the atomic
 * writer it shares with every other state write — this module stays a leaf
 * that imports nothing but node builtins, which is what keeps it importable
 * from `paths.ts` without a cycle.
 */
/**
 * Why `<project>/.xezar` must not be written, or `null` when it may (#612 review M1).
 *
 * Every state write resolves its path through the layout, and the layout's paths
 * are `resolve()`d, never `realpath`ed — so a repository that commits `.xezar` as a
 * symbolic link would choose where xezar writes this machine's settings and account
 * list. The folder is refused when it IS a link, or when its real path is not
 * inside the project's real path. An absent folder is fine: it is created fresh,
 * as a real directory, by the first write.
 */
export function projectStateDirRefusal(layout: StateLayout): string | null {
  if (layout.mode !== 'project' || layout.projectRoot === null) return null;
  const dir = layout.root;
  let isLink: boolean;
  try {
    isLink = lstatSync(dir).isSymbolicLink();
  } catch {
    return null;
  }
  const never = 'xezar writes this project\'s state only into a real folder inside the project, never through a link';
  if (isLink) return `folder ${dir} is a symbolic link — ${never}`;
  try {
    const realProject = realpathSync(layout.projectRoot);
    if (!realpathSync(dir).startsWith(`${realProject}${sep}`)) return `folder ${dir} resolves outside ${realProject} — ${never}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `folder ${dir} cannot be resolved (${message}) — ${never}`;
  }
  return null;
}

/** Is `path` itself a symbolic link? `false` when it does not exist. */
export function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function projectStateFiles(layout: StateLayout): readonly string[] {
  if (layout.mode !== 'project') return [];
  return [layout.configPath!, layout.workspacePath, layout.accountsPath, layout.uiStatePath];
}

/**
 * The one boot line that names the mode and the state folder (FR-9.1), or
 * `null` in the global layout, which prints nothing new.
 *
 * One line, one call site. Which folder the settings came from is the single
 * fact a person needs to tell this mode from the global one, so it is not part
 * of the banner `--quiet` suppresses.
 */
export function stateLayoutBootLine(layout: StateLayout): string | null {
  if (layout.mode !== 'project') return null;
  return `  single-project mode — settings in ${layout.root}, working files in ${layout.dataDir}`;
}
