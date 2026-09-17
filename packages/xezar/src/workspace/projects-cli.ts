import { projectDataDir } from '../project-data-paths.ts';
import { projectResource, type CliAudit } from '../cli-audit.ts';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePortValue, PORT_MAX, PORT_MIN } from '../cli-settings.ts';
import { workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import {
  listProjects,
  normalizeProjectTags,
  registerProject,
  removeProject,
  shouldRegisterProject,
} from './projects.ts';

/**
 * `xezar projects` (spec 2026-07-20-multi-project-workspace, step 5.2) — the
 * terminal twin of Settings → Projects, for the operator who is on a server (or
 * an ssh session) and has no cockpit in front of them.
 *
 * It talks to `~/.xezar/config.json` through `./projects.js` directly, NOT over
 * HTTP: the whole point is that it works with no server running, on a box where
 * the cockpit is behind an nginx login. `XEZ_HOME` therefore selects which
 * workspace it operates on, exactly as it does for `serve`.
 */

export interface ProjectsCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: ProjectsCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  xezar projects [list]        list the registered projects
  xezar projects add [<dir>]   register a folder (default: --repo, else cwd)
  xezar projects remove <id>   drop a registry entry (the repo is untouched)
  xezar projects tag <id> [<tag>…]
                               set the grouping tags of a project (none clears them)
  xezar projects port <id> [<port>]
                               pin the cockpit port of a project (none clears it)

  add/remove/tag/port are unavailable when XEZ_SINGLE_PROJECT=1`;

const SINGLE_PROJECT_ADD_ERROR = 'single-project mode is enabled; adding projects is disabled';
const SINGLE_PROJECT_REMOVE_ERROR = 'single-project mode is enabled; removing projects is disabled';
const SINGLE_PROJECT_EDIT_ERROR = 'single-project mode is enabled; editing projects is disabled';

/**
 * Run one `projects` subcommand. Returns the process exit code (0 ok, 1 for a
 * usage error, an unknown id, or a folder the registration guards refuse) so
 * `src/index.ts` can assign it to `process.exitCode` like every other command.
 */
export async function runProjectsCommand(
  args: string[],
  opts: {
    defaultRoot: string;
    bootProjectId?: string;
    env?: NodeJS.ProcessEnv;
    io?: ProjectsCommandIo;
    /** The `cli` audit door for this subcommand (#306 part 2) — absent for an unknown word. */
    audit?: CliAudit;
  },
): Promise<number> {
  const io = opts.io ?? defaultIo;
  const audit = opts.audit;
  const singleProject = (opts.env ?? process.env).XEZ_SINGLE_PROJECT === '1';
  const [sub = 'list', ...rest] = args;
  switch (sub) {
    case 'list': {
      const code = await listCommand(io, singleProject, opts.bootProjectId);
      // The owner's explicit exception to "reads never": every subcommand is recorded, and the
      // record keeps neither the listed roots nor how many there were.
      await audit?.applied({ resource: projectResource(await audit.scope()) });
      return code;
    }
    case 'add':
      if (singleProject) {
        io.error(SINGLE_PROJECT_ADD_ERROR);
        await audit?.refused('single_project_mode');
        return 1;
      }
      return addCommand(rest[0] ? resolve(rest[0]) : opts.defaultRoot, io, audit);
    case 'remove':
    case 'rm':
      if (singleProject) {
        io.error(SINGLE_PROJECT_REMOVE_ERROR);
        await audit?.refused('single_project_mode');
        return 1;
      }
      return removeCommand(rest[0], io, audit);
    case 'tag':
      if (singleProject) {
        io.error(SINGLE_PROJECT_EDIT_ERROR);
        await audit?.refused('single_project_mode');
        return 1;
      }
      return tagCommand(rest[0], rest.slice(1), io, audit);
    case 'port':
      if (singleProject) {
        io.error(SINGLE_PROJECT_EDIT_ERROR);
        await audit?.refused('single_project_mode');
        return 1;
      }
      return portCommand(rest[0], rest[1], io, audit);
    default:
      io.error(`unknown projects subcommand: ${sub}\n`);
      io.error(USAGE);
      return 1;
  }
}

/** `ok` shows the branch when git could name one; the other states say why. */
function statusLabel(entry: { status: string; branch?: string }): string {
  if (entry.status === 'missing') return 'missing';
  if (entry.status === 'not-git') return 'not a git repo';
  return entry.branch ?? 'ok';
}

/** Same ✓/✗ vocabulary the `serve` banner uses for its environment checks. */
function statusMark(status: string): string {
  return status === 'missing' ? '✗' : status === 'not-git' ? '·' : '✓';
}

async function listCommand(
  io: ProjectsCommandIo,
  singleProject: boolean,
  bootProjectId?: string,
): Promise<number> {
  const projects = bootProjectId
    ? await listProjects({ projectId: bootProjectId })
    : singleProject
      ? []
      : await listProjects();
  if (projects.length === 0) {
    io.log('\n  no projects registered yet');
    io.log('  start the cockpit in a repo (npx xezar) or add one: xezar projects add <dir>\n');
    return 0;
  }
  const idWidth = Math.max(...projects.map((p) => p.id.length));
  const labelWidth = Math.max(...projects.map((p) => statusLabel(p).length));
  io.log('');
  for (const project of projects) {
    const label = statusLabel(project).padEnd(labelWidth);
    // Tags trail the path rather than taking a column of their own: most projects have none,
    // and a mostly-empty column would cost every row width to say nothing.
    const tags = project.tags?.length ? `  [${project.tags.join(' ')}]` : '';
    io.log(`  ${statusMark(project.status)} ${project.id.padEnd(idWidth)}  ${label}  ${project.root}${tags}`);
  }
  io.log(`\n  ${projects.length} project(s) — registry: ${workspaceConfigPath()}\n`);
  return 0;
}

async function addCommand(root: string, io: ProjectsCommandIo, audit?: CliAudit): Promise<number> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    io.error(`not a directory: ${root}`);
    await audit?.refused('not_a_directory');
    return 1;
  }
  // Same guards `serve`/`run` apply at boot: a task worktree or `$HOME` itself
  // is served happily but never registered, and asking for it explicitly does
  // not buy an exemption.
  if (!(await shouldRegisterProject(root))) {
    io.error(`refusing to register ${root} — xezar task worktrees and your home directory are not projects`);
    await audit?.refused('not_registrable');
    return 1;
  }
  const known = new Set((await loadWorkspaceConfig()).projects.map((p) => p.id));
  const entry = await registerProject(root);
  // Registration dedupes by realpath, so a second `add` of the same folder
  // (or a symlink to it) reports the entry that already exists.
  io.log(known.has(entry.id) ? `  = ${entry.id} (already registered)  ${entry.root}` : `  + ${entry.id}  ${entry.root}`);
  const target = { projectId: entry.id, dataDir: projectDataDir(entry.root), isProject: true };
  await audit?.applied({ resource: projectResource(target) }, target);
  return 0;
}

async function removeCommand(id: string | undefined, io: ProjectsCommandIo, audit?: CliAudit): Promise<number> {
  if (!id) {
    io.error(USAGE);
    await audit?.refused('missing_argument');
    return 1;
  }
  // Resolved BEFORE the removal: afterwards no row says where this project's trail lives.
  const target = await audit?.projectScope(id);
  // Unlike `DELETE /api/projects/:projectId`, there is no boot-project refusal
  // here: that rule exists because a running server would break its own
  // sidebar, and the CLI runs with no server and no boot project. Removing the
  // repo you normally serve is therefore allowed — and self-healing, since the
  // next `xezar serve` in it registers it again (said in the note below).
  if (!(await removeProject(id))) {
    io.error(`unknown project: ${id}`);
    await audit?.refused('unknown_project');
    return 1;
  }
  await audit?.applied({ resource: { kind: 'project', id } }, target);
  io.log(`  - ${id} (registry entry only — the repo and its .local/xezar/ are untouched)`);
  return 0;
}

/**
 * `xezar projects tag <id> [<tag>…]` — the terminal twin of the Tags cell in
 * Settings → Projects.
 *
 * Replaces the WHOLE list, like the PATCH route does, and for the same reason:
 * the caller always knows the full set, and an add-one/remove-one grammar would
 * be a merge protocol with no one to merge against. No tags at all clears them.
 * Normalization is the shared `normalizeProjectTags`, so a tag typed here and a
 * tag typed in the cockpit are stored identically.
 */
async function tagCommand(
  id: string | undefined,
  tags: string[],
  io: ProjectsCommandIo,
  audit?: CliAudit,
): Promise<number> {
  if (!id) {
    io.error(USAGE);
    await audit?.refused('missing_argument');
    return 1;
  }
  const normalized = normalizeProjectTags(tags);
  let known = false;
  await mergeWriteWorkspaceConfig((config) => {
    const entry = config.projects.find((project) => project.id === id);
    if (!entry) return;
    known = true;
    // Mutated in place so `.passthrough()` keys on the entry survive, and the key
    // is DELETED rather than set to `[]`: an untagged project stores nothing.
    if (normalized === undefined) delete entry.tags;
    else entry.tags = normalized;
  });
  if (!known) {
    io.error(`unknown project: ${id}`);
    await audit?.refused('unknown_project');
    return 1;
  }
  // The field name and a digest of the normalized list — never a tag string (spec § 5).
  await audit?.applied(
    { resource: { kind: 'project', id }, fieldNames: ['tags'], payload: { tags: normalized ?? [] } },
    await audit.projectScope(id),
  );
  io.log(
    normalized === undefined
      ? `  = ${id} (no tags)`
      : `  = ${id}  [${normalized.join(' ')}]`,
  );
  return 0;
}

/**
 * `xezar projects port <id> [<port>]` (#467) — the ONLY writer of `projects[].cli.port`.
 *
 * That key is a person's deliberate choice of port for a project, which is exactly why a
 * start never writes it: `--port` and `XEZ_PORT` are instructions for one launch, and
 * persisting them would silently promote a one-off into configuration. Omitting the port
 * clears the preference, the same grammar `tag` uses for clearing tags.
 *
 * A port that is not a port is refused here rather than stored, so the value in the file is
 * always one the resolver will accept — the same rule `normalizeProjectTags` follows for tags.
 */
async function portCommand(
  id: string | undefined,
  port: string | undefined,
  io: ProjectsCommandIo,
  audit?: CliAudit,
): Promise<number> {
  if (!id) {
    io.error(USAGE);
    await audit?.refused('missing_argument');
    return 1;
  }
  let value: number | undefined;
  if (port !== undefined) {
    const parsed = parsePortValue(port);
    if (parsed === null) {
      io.error(`port must be a whole number from ${PORT_MIN} to ${PORT_MAX} — got “${port}”.`);
      await audit?.refused('invalid_port');
      return 1;
    }
    value = parsed;
  }
  let known = false;
  await mergeWriteWorkspaceConfig((config) => {
    const entry = config.projects.find((project) => project.id === id);
    if (!entry) return;
    known = true;
    // In place, so `.passthrough()` keys survive; the key is DELETED rather than set to a
    // sentinel, because "no preference" is an absent key everywhere else in this file.
    if (value === undefined) {
      if (entry.cli) delete entry.cli.port;
      // An empty `cli` object carries no information — drop it rather than leave `{}` behind.
      if (entry.cli && Object.keys(entry.cli).length === 0) delete entry.cli;
    } else {
      entry.cli = { ...(entry.cli ?? {}), port: value };
    }
  });
  if (!known) {
    io.error(`unknown project: ${id}`);
    await audit?.refused('unknown_project');
    return 1;
  }
  // The field name and a digest of the value — never the port itself (spec § 5).
  await audit?.applied(
    { resource: { kind: 'project', id }, fieldNames: ['port'], payload: { port: value ?? null } },
    await audit.projectScope(id),
  );
  io.log(
    value === undefined
      ? `  = ${id} (no port set — it starts from its remembered port, then 4321)`
      : `  = ${id}  port ${value}`,
  );
  return 0;
}
