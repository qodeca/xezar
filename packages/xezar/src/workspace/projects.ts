import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PROJECT_TAGS_MAX, PROJECT_TAG_MAX_LENGTH } from '@qodeca/xezar-contract';
import type { InstanceMode } from '../cli-settings.ts';
import { forgeKindOfRemote, forgeWebRoot, type ForgeKind } from '../server/forge/index.ts';
import { getRepoInfo } from '../server/git.ts';
import { activeStateLayout, type StateLayout } from '../state-layout.ts';
import {
  mergeWriteWorkspaceConfig,
  loadWorkspaceConfig,
  type WorkspaceProject,
} from './config.ts';
import {
  projectMachineStatePath,
  readProjectMachineState,
  recordProjectOpened,
  warnProjectMachineStateWriteFailure,
} from './project-machine-state.ts';

/**
 * Project registry operations over `~/.xezar/config.json` (spec
 * 2026-07-20-multi-project-workspace, "Project identity" + "Boot flow"):
 *
 * - `registerProject(root)` — realpath-normalize, dedupe by realpath, allocate
 *   a human-readable slug from `basename(root)`. Registration is additive and
 *   goes through the read-modify-write merge, so the worst race outcome
 *   between concurrent `xezar serve` processes is a lost `lastOpenedAt` bump —
 *   never a lost project.
 * - `listProjects()` — registry entries + a cheap per-root status/branch probe
 *   behind a short TTL cache, so a sidebar render never shells `git` N times.
 * - `removeProject(id)` — unregister only. It never touches any file inside
 *   the repo (a project's own state stays in `<repo>/.local/xezar/`).
 */

/**
 * Is the project registry narrowed to exactly ONE project (#600 SP-3.1, SP-3.2)?
 *
 * TWO narrowings answer yes, and they are deliberately different questions:
 *
 * - `XEZ_SINGLE_PROJECT=1` — today's opt-in flag, unchanged. One project, no
 *   project management, GLOBAL state. Strict activation: only the exact string
 *   `1` (`BACKWARD_COMPATIBILITY.md` § Single-project workspace mode).
 * - The PROJECT state layout (#600) — the folder owns its own xezar state, so
 *   its registry is that folder and there is no second project to manage.
 *
 * This is the ONE spelling of "is the registry narrowed", read by all three
 * doors (the HTTP routes, `xezar projects`, the MCP `project_config` tool), so
 * a refusal in one door and a silent no-op in another (#600 BR-6) cannot
 * happen by two predicates drifting apart. It widens each guard's CONDITION and
 * never its EFFECT: an `XEZ_SINGLE_PROJECT=1` refusal keeps its exact status
 * code, message text and exit code, which `single-project-doors.test.ts` pins
 * byte for byte because `BACKWARD_COMPATIBILITY.md` promises them.
 */
export type SingleProjectNarrowing = 'env-flag' | 'project-root';

/**
 * WHICH narrowing is in force, or `null` for the ordinary multi-project
 * workspace. The env flag is asked FIRST and that order is load-bearing: with
 * `XEZ_SINGLE_PROJECT=1` set, every door answers with the exact refusal text,
 * status code, exit code and audit reason it answered with before #600,
 * whichever layout the process resolved. The mode only ever speaks for itself.
 */
export function singleProjectNarrowing(env: NodeJS.ProcessEnv = process.env): SingleProjectNarrowing | null {
  if (env.XEZ_SINGLE_PROJECT === '1') return 'env-flag';
  return activeStateLayout(env).mode === 'project' ? 'project-root' : null;
}

export function singleProjectRegistry(env: NodeJS.ProcessEnv = process.env): boolean {
  return singleProjectNarrowing(env) !== null;
}

/**
 * What the instance mode actually IS for this process (#467, spec § 2.3–2.4).
 *
 * `cli-settings.ts` answers what was REQUESTED and stays pure; this answers what is in
 * force, because the two shipped narrowings above already serve exactly one project and
 * they WIN over the request. Three answers, not two: `narrowed` is its own word so a reader
 * can never mistake "this cockpit serves one project because someone set
 * `XEZ_SINGLE_PROJECT`" for "someone asked for `--instance project`".
 *
 * The narrowing wins in BOTH directions and that is the load-bearing half:
 *
 * - `--instance project` under a narrowing is already satisfied, and the extra half it asks
 *   for — the other projects as links — is precisely what the narrowing removes.
 * - `--instance workspace` under a narrowing can never RE-WIDEN it. Letting it would give
 *   `singleProjectNarrowing` a second, contradicting reader, which is the drift that
 *   function's own comment exists to prevent, and it would make `--instance workspace` a way
 *   to defeat `XEZ_SINGLE_PROJECT` — a promise `BACKWARD_COMPATIBILITY.md` § Single-project
 *   workspace mode makes to someone who set that variable on purpose.
 *
 * Nothing refuses: two compatible-in-spirit settings meeting is not a typo, and AGENTS.md
 * § Zero config forbids failing a boot over one. A bad VALUE still refuses, in `cli-settings.ts`.
 *
 * This is the ONE reader of that question. PR 2's capability, context guard, projects route
 * and boot line all call it rather than re-deriving `resolved.instance` beside a narrowing
 * check of their own.
 */
export type InstanceModeInForce = InstanceMode | 'narrowed';

export function instanceModeInForce(
  resolved: { instance: InstanceMode },
  env: NodeJS.ProcessEnv = process.env,
): InstanceModeInForce {
  return singleProjectNarrowing(env) !== null ? 'narrowed' : resolved.instance;
}

/**
 * The one line a start prints about the instance mode, or `null` for silence (#467, spec § 2.5).
 *
 * Silence is the common case and is deliberate: the default `workspace` mode, and a narrowing
 * nobody argued with, both print nothing, so a start that did not change says nothing new.
 * Exactly two things are worth a line — the new mode being on, and a request this process is
 * knowingly not honouring.
 *
 * Copy follows `designs/cli-terminal/README.md` § 9: sentence case, `xezar` lower case, ` — `
 * between clauses, no contractions. It lives here beside the predicate that decides it, the way
 * `singleProjectRefusalText` lives beside `singleProjectNarrowing` — one subject, one home, so
 * the sentence and the rule it describes cannot drift apart.
 */
export function instanceBootLine(args: {
  /** `instanceModeInForce`'s answer — never a re-derivation of one. */
  mode: InstanceModeInForce;
  /** Which narrowing is in force, for the `narrowed` wording. */
  narrowing: SingleProjectNarrowing | null;
  /** What this invocation asked for — `resolveCliSettings(...).instance`. */
  requested: InstanceMode;
  /** Did anyone actually ASK — a flag, a stored key or the variable — or is this the default? */
  explicit: boolean;
  /** What to call the project this cockpit serves — its registry id. */
  projectName: string;
}): { level: 'info' | 'warn'; message: string } | null {
  const { mode, narrowing, requested, explicit, projectName } = args;
  if (mode === 'project') {
    return {
      level: 'info',
      message:
        `project mode — this cockpit serves ${projectName} only; ` +
        'other projects are links to their own cockpit',
    };
  }
  if (mode === 'narrowed' && narrowing !== null) {
    const because =
      narrowing === 'env-flag'
        ? 'single-project mode is enabled'
        : 'this folder owns its xezar state';
    // A narrowing nobody argued with is not news: the default `workspace` under one prints
    // nothing at all, exactly as it did before this flag existed.
    if (!explicit) return null;
    // An explicit `--instance project` is already satisfied — the extra half it asks for, the
    // other projects as links, is precisely what the narrowing removes — so it is `info` and
    // names the narrowing rather than the mode. An explicit `workspace` is the one request this
    // process is knowingly not honouring, so it is `warn`.
    return requested === 'project'
      ? {
          level: 'info',
          message:
            `--instance project is already in force — ${because}, ` +
            'so this cockpit already serves one project',
        }
      : {
          level: 'warn',
          message:
            `--instance workspace is ignored — ${because}, ` +
            'so this cockpit already serves one project',
        };
  }
  return null;
}

/**
 * The one sentence every door refuses with, for one narrowing and one action.
 *
 * The `env-flag` half is the promised text, byte for byte
 * (`BACKWARD_COMPATIBILITY.md` § Single-project workspace mode); the
 * `project-root` half is its own sentence because "the flag is enabled" would
 * be a lie about a folder that carries no flag. Both name the mode, both are
 * one plain sentence, and both ride the unchanged `{ error }` / stderr shape.
 */
export function singleProjectRefusalText(narrowing: SingleProjectNarrowing, action: string): string {
  return narrowing === 'env-flag'
    ? `single-project mode is enabled; ${action} is disabled`
    : `this project owns its xezar state; ${action} is disabled`;
}

/**
 * Slugs the allocator must never hand out: `default` is the reserved alias
 * for the boot project, the rest are the cockpit shell's own top-level path
 * segments. A repo named `default/` becomes `default-2` and can never shadow
 * the alias or a route.
 */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set([
  'default',
  'new',
  'settings',
  'api',
  'p',
  'assets',
]);

/** Slug length cap — mirrors `PROJECT_ID_RE` (1 head char + up to 63 more). */
const SLUG_MAX = 64;

/**
 * `basename(root)` → slug base: lowercase, runs of `[^a-z0-9-]` become one
 * `-`, edge dashes trimmed so the result matches `^[a-z0-9][a-z0-9-]{0,63}$`.
 * A degenerate basename (e.g. `日本語/`) falls back to `project` rather than
 * ever escaping the slug shape.
 */
function slugBase(root: string): string {
  const base = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
  return base || 'project';
}

/**
 * Allocate a unique slug for `root`: the slug base, deduplicated against
 * `taken` ids AND the reserved ids with a numeric suffix (`api`, `api-2`,
 * `api-3`, …). Suffixed candidates stay within the 64-char cap by truncating
 * the base, never the suffix.
 */
export function allocateProjectSlug(root: string, taken: Iterable<string>): string {
  const used = new Set<string>(RESERVED_PROJECT_IDS);
  for (const id of taken) used.add(id);
  const base = slugBase(root);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Realpath-normalize a root: resolves symlinks and drops trailing slashes, so
 * every spelling of the same directory dedupes to one registry entry. A path
 * that cannot be realpath'd (doesn't exist yet, unreadable) degrades to plain
 * `resolve()` — registration callers guard existence; this module never throws
 * over it.
 */
async function normalizeRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

/** True when `path` sits inside a xezar task worktree (`…/.local/xezar/worktrees/…`). */
function isInsideTaskWorktree(path: string): boolean {
  return `${path}${sep}`.includes(`${sep}.local${sep}xezar${sep}worktrees${sep}`);
}

/**
 * Registration guard (spec 2026-07-20-multi-project-workspace, "Boot flow"):
 * auto-registration is suppressed — the process still serves the folder
 * normally, it just doesn't pollute the registry — when the resolved
 * `repoRoot` is:
 *
 * - inside any `…/.local/xezar/worktrees/…` path (task worktrees and nested
 *   `xez` invocations — the same nesting reality the `XEZ_TODOS_FILE=''`
 *   guard in `workflows/run.ts` acknowledges), checked on both the raw and
 *   realpath'd spelling so neither a symlinked prefix nor a literal one
 *   slips through; or
 * - the user's home directory itself (realpath-compared, so a symlinked
 *   `$HOME` still matches).
 */
export async function shouldRegisterProject(repoRoot: string): Promise<boolean> {
  const real = await normalizeRoot(repoRoot);
  if (isInsideTaskWorktree(real) || isInsideTaskWorktree(resolve(repoRoot))) return false;
  const home = await normalizeRoot(homedir());
  return real !== home;
}

/**
 * Register `root` in the workspace registry (idempotent). Known root (by
 * realpath) → bump its `lastOpenedAt` and return the existing entry, id and
 * all. Unknown → allocate a slug and append a new entry via merge-write.
 *
 * In the PROJECT layout this writes NOTHING into the committed
 * `<project>/.xezar/workspace.json` (#600 defect A). The registry there is one
 * row derived from the folder, and `projectLayoutRow` already derives it — so
 * registration records only the per-machine launch stamp, in the working file
 * `project-machine-state.ts` owns under `<project>/.local/xezar/`, and answers
 * the derived row. Without this the committed file was rewritten with
 * `lastOpenedAt` on every launch, and a clone at another path added a row
 * carrying its own absolute path, so `git status` was dirty after every start.
 */
export async function registerProject(
  root: string,
  source: 'local' | 'checkout' = 'local',
): Promise<WorkspaceProject> {
  const real = await normalizeRoot(root);
  const now = new Date().toISOString();
  if (activeStateLayout().mode === 'project') {
    // Best-effort: a read-only `.local` must not fail a boot over a display
    // fact, the same contract the port memory has always had. The failure is
    // reported ONCE per process (#649) — silence here used to be the only
    // signal that the launch would not be remembered, which is exactly what
    // made it undiagnosable.
    try {
      await recordProjectOpened(now);
    } catch (error) {
      warnProjectMachineStateWriteFailure(projectMachineStatePath(), error);
    }
    return projectLayoutRow((await loadWorkspaceConfig()).projects, real);
  }
  let entry: WorkspaceProject | undefined;
  await mergeWriteWorkspaceConfig((config) => {
    const existing = config.projects.find((p) => p.root === real);
    if (existing) {
      existing.lastOpenedAt = now;
      entry = existing;
      return;
    }
    entry = {
      id: allocateProjectSlug(real, config.projects.map((p) => p.id)),
      root: real,
      name: basename(real),
      addedAt: now,
      lastOpenedAt: now,
      source,
    };
    config.projects.push(entry);
  });
  // The mutator always runs, so `entry` is always set — this satisfies TS.
  if (!entry) throw new Error('registerProject: merge-write did not run the mutator');
  return entry;
}

/**
 * The ONE spelling rule for project tags — applied on every write, never on read.
 *
 * Trimmed, empties dropped, over-long ones truncated, deduped CASE-INSENSITIVELY (the first
 * spelling wins, so `Storefront` typed before `storefront` keeps its capital), capped at
 * `PROJECT_TAGS_MAX`, and sorted so two projects tagged with the same set store and render the
 * same list. Case-insensitive dedupe is what makes tags usable as a grouping key: `API` and `api`
 * grouping into two columns of the same thing is the whole failure this prevents.
 *
 * Returns `undefined` — never `[]` — for an empty result, because the registry stores nothing for
 * an untagged project and `delete entry.tags` is what the writers then do.
 */
export function normalizeProjectTags(tags: readonly string[] | null | undefined): string[] | undefined {
  if (!tags) return undefined;
  const bySpelling = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.trim().slice(0, PROJECT_TAG_MAX_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!bySpelling.has(key)) bySpelling.set(key, tag);
    if (bySpelling.size >= PROJECT_TAGS_MAX) break;
  }
  const normalized = [...bySpelling.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export type ProjectStatus = 'ok' | 'missing' | 'not-git';

export interface ProjectListEntry extends WorkspaceProject {
  /** `missing` = root gone/unreadable; `not-git` = exists but no `.git`. */
  status: ProjectStatus;
  /** Current branch when cheaply available (omitted e.g. on an unborn HEAD). */
  branch?: string;
  /** Which forge the root's remote belongs to (#698) — classified from the
   *  remote URL alone, no `gh` probe. Omitted when there is no forge remote.
   *  The sidebar gates each project group's GitHub tab on this, instead of on
   *  the boot folder's health-level forge answer. */
  forge?: ForgeKind;
  /** The remote's web root (`https://github.com/owner/repo`), rebuilt from the
   *  parsed remote so it can never carry credentials. What lets a cross-project
   *  surface link a reference the run knows only by NUMBER — the global Tasks
   *  page has one row per project and so cannot use any single repo's base. */
  repoUrl?: string;
}

interface RootProbe {
  status: ProjectStatus;
  branch?: string;
  forge?: ForgeKind;
  repoUrl?: string;
}

/** Probe TTL — long enough to coalesce a burst of sidebar renders, short
 *  enough that a deleted repo shows as `missing` on the next real look. */
const PROBE_TTL_MS = 5_000;
const probeCache = new Map<string, { at: number; probe: RootProbe }>();

/** Test hook: drop cached probes so status changes are visible immediately. */
export function clearProjectProbeCache(): void {
  probeCache.clear();
}

async function computeProbe(root: string): Promise<RootProbe> {
  try {
    if (!(await stat(root)).isDirectory()) return { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
  try {
    // `.git` may be a dir (normal clone) or a file (worktree/submodule) —
    // a bare stat covers both without shelling out.
    await stat(join(root, '.git'));
  } catch {
    return { status: 'not-git' };
  }
  // Branch and forge are best-effort garnish: getRepoInfo never throws (null
  // on e.g. an unborn HEAD), and a repo without either is still status ok.
  const info = await getRepoInfo(root);
  const forge = forgeKindOfRemote(info?.remote);
  // Free: `getRepoInfo` already ran for the branch, and the remote is already parsed for `forge`.
  const repoUrl = forgeWebRoot(info?.remote);
  return {
    status: 'ok',
    ...(info?.branch ? { branch: info.branch } : {}),
    ...(forge ? { forge } : {}),
    ...(repoUrl ? { repoUrl } : {}),
  };
}

async function probeRoot(root: string): Promise<RootProbe> {
  const cached = probeCache.get(root);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
  const probe = await computeProbe(root);
  probeCache.set(root, { at: Date.now(), probe });
  return probe;
}

/**
 * The ONE place a registry entry becomes an API entry (#467). Every route that answers with
 * a project goes through it — `GET /projects`, `POST /projects` and `PATCH /projects/:id` —
 * so the wire shape cannot differ between them.
 *
 * What it does beyond the spread: it DROPS the CLI keys. `cli.port` is a terminal preference
 * and `lastListen` is an address hint that is stale the moment the process that wrote it
 * exits, and the registry schema is `.passthrough()`, so without this both would ride onto
 * the wire as undeclared fields the contract does not describe. The cockpit's answer to
 * "which other projects run, and where" is the DERIVED `instance?` field of the switcher
 * design, not these raw values.
 */
export function toProjectListEntry(
  project: WorkspaceProject,
  probe: RootProbe,
): ProjectListEntry {
  const { cli: _cli, lastListen: _lastListen, ...rest } = project;
  return { ...rest, ...probe };
}

/**
 * One root's `status` (+`branch`) through the same TTL cache `listProjects`
 * uses. Exported for `POST /api/projects` (step 4.2): the register route
 * answers with the freshly registered entry and must hand the cockpit the
 * SAME shape the list route does — one project, one shape, whichever route
 * produced it.
 */
export async function probeProjectStatus(
  root: string,
): Promise<Pick<ProjectListEntry, 'status' | 'branch' | 'forge' | 'repoUrl'>> {
  return probeRoot(root);
}

/**
 * Registry entries in stored order, each with its `status` (+`branch` when
 * available). Probes run concurrently and are TTL-cached per root. A
 * `missing` project is only ever *listed* — callers must never instantiate a
 * context for it.
 */
export interface ProjectListSelector {
  /** Return only this registry id without mutating or pruning other rows. */
  projectId: string;
}

/**
 * The ONE row the project layout's registry has (#600 SP-3.1): the folder that
 * owns the state, and nothing else.
 *
 * The stored row wins when there is one, so the id, name, tags and per-project
 * cap a person set survive. When there is none — a first run, or a
 * `workspace.json` a clone carries without one — the row is DERIVED from the
 * folder rather than left absent, because the mode's answer to "which projects
 * are there" is never "none": the folder is the project. The derived id is
 * allocated against the STORED ids, the same taken-set `resolveBootProject` and
 * the boot registration use, so a foreign row holding this folder's slug cannot
 * make the derived row and the boot identity disagree (#600 defect B) — which
 * is what dropped the only row from `/api/v1/projects` and left health naming a
 * different id.
 *
 * Per-machine facts (`lastOpenedAt`, `lastListen`) are overlaid from the working
 * file `project-machine-state.ts` owns, so the committed `workspace.json` holds
 * none of them (#600 defect A).
 *
 * Rows for OTHER roots are ignored rather than deleted. They can only come from
 * a `workspace.json` written on another machine, where their absolute paths mean
 * nothing; dropping them from the listing is what SP-3.1 asks for, and rewriting
 * someone's committed file to enforce it is not (§ non-goals: no migration, no
 * conversion).
 */
async function projectLayoutRow(
  stored: readonly WorkspaceProject[],
  projectRoot: string,
  layout: StateLayout = activeStateLayout(),
): Promise<WorkspaceProject> {
  const real = await normalizeRoot(projectRoot);
  const existing = stored.find((project) => project.root === real);
  // Per-machine facts are overlaid from the working file, never from the
  // committed one (#600 defect A): the stored row keeps identity (id, name,
  // tags, cap) and the machine keeps its own stamps.
  const machine = readProjectMachineState(layout);
  const row = existing ?? {
    id: allocateProjectSlug(real, stored.map((project) => project.id)),
    root: real,
    name: basename(real),
    // `addedAt` is a fact about THIS machine's first registration, so a DERIVED
    // row reads it from the working file and only falls back to the process
    // stamp when nothing was recorded yet (#600 review m1). A STORED row keeps
    // its committed `addedAt`, which is what a teammate inherits.
    addedAt: machine.addedAt ?? DERIVED_AT,
    lastOpenedAt: DERIVED_AT,
    source: 'local' as const,
  };
  return {
    ...row,
    ...(machine.lastOpenedAt !== undefined ? { lastOpenedAt: machine.lastOpenedAt } : {}),
    ...(machine.lastListen !== undefined ? { lastListen: machine.lastListen } : {}),
  };
}

/**
 * The timestamp a DERIVED row carries, minted once per process rather than per
 * read. A listing is a read, and a read that answers a different `addedAt` every
 * time makes the cockpit's cache see a changed row on every poll. Nothing is
 * claimed by it beyond "this process first saw the folder now".
 *
 * In the project layout a row stays derived for the folder's whole life, because
 * registration writes nothing there (#600 defect A) — so a derived `addedAt`
 * comes from `machine-state.json` when this machine has registered the folder
 * before, and only falls back to this process stamp otherwise (#600 review m1).
 * `lastOpenedAt` is likewise from the machine state file, so "Last opened"
 * survives a restart.
 */
const DERIVED_AT = new Date().toISOString();

export async function listProjects(selector?: ProjectListSelector): Promise<ProjectListEntry[]> {
  const rows = await registryRows(selector);
  return Promise.all(
    rows.map(async (project) => toProjectListEntry(project, await probeRoot(project.root))),
  );
}

/**
 * The registry rows this process answers with, before the per-root status probe:
 * the project layout's ONE derived row, or the stored registry. Shared by
 * `listProjects` and health's `workspaceSummary` so the two doors can never
 * name different ids for the same folder (#600 defect B).
 *
 * The mode's registry is derived from the folder, so it is exactly one row
 * before any selector narrows it further — and a selector naming a project
 * this folder is not still answers nothing, which is what keeps a scoped
 * `/api/v1/p/<other>/…` request a 404 rather than the boot project.
 *
 * `layout` defaults to the process's own. Only the MCP bridge passes one: it
 * re-resolves its folder's layout on every session open without installing it
 * process-wide (#819 item 5), and reads the registry of THAT layout.
 */
export async function registryRows(
  selector?: ProjectListSelector,
  layout: StateLayout = activeStateLayout(),
): Promise<WorkspaceProject[]> {
  const config = await loadWorkspaceConfig(layout.workspacePath);
  const rows = layout.mode === 'project'
    ? [await projectLayoutRow(config.projects, layout.projectRoot!, layout)]
    : config.projects;
  return selector ? rows.filter((project) => project.id === selector.projectId) : rows;
}

/**
 * The ONE layout-aware lookup into the registry (#600 review M1/M2/m5).
 *
 * In the project layout the registry is the DERIVED row, so a raw
 * `loadWorkspaceConfig().projects.find(...)` finds nothing for the folder that
 * owns its state: the MCP service refused to start, the agent-account
 * selection 404'd for the boot project, and CLI audit records lost their
 * project scope. Every reader that needs a project row by id or by realpath
 * goes through here instead, so the two layouts answer the same question the
 * same way.
 *
 * `root` is compared as given — callers pass a realpath'd path, the same
 * spelling `registerProject` dedupes on. `layout` is `registryRows`'s.
 */
export async function findRegistryProject(
  query: { id: string } | { root: string },
  layout?: StateLayout,
): Promise<WorkspaceProject | undefined> {
  const rows = await registryRows(undefined, layout);
  return 'id' in query
    ? rows.find((project) => project.id === query.id)
    : rows.find((project) => project.root === query.root);
}

/**
 * Remove `id` from the registry. Returns false when no such entry exists.
 * Pure unregistration: nothing inside the repo (worktrees, `.local/xezar/`,
 * run history) is touched — re-registering the same root later gets a fresh
 * slug but finds all its state intact.
 */
export async function removeProject(id: string): Promise<boolean> {
  let removed = false;
  await mergeWriteWorkspaceConfig((config) => {
    const next = config.projects.filter((p) => p.id !== id);
    removed = next.length !== config.projects.length;
    config.projects = next;
  });
  return removed;
}
