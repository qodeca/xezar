import { existsSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuditActor, AuditResource } from '@qodeca/xezar-contract';
import { AuditTrail, doorAuditWarning, type AuditChannel, type AuditScope } from './mcp/audit-trail.ts';
import { ensureProjectDataIgnored, projectDataDir } from './project-data-paths.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { allocateProjectSlug, findRegistryProject, shouldRegisterProject } from './workspace/projects.ts';

/**
 * The command-line door of the audit trail (#306, part 2) — spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 4 (`cli` row), § 5 and § 9.
 *
 * EVERY valid subcommand writes exactly one record, at its effect boundary, to the audit file of the
 * project it acted on: `applied` once the command started its effect (even if a spawned task or a
 * hosted service later fails), `refused` with a machine reason when it stopped before any effect.
 * `--help`, `--version`, an unknown command and an unknown `projects` word write nothing — they
 * return before any of this, and keep arbitrary caller text out of the action field.
 *
 * WHICH PROJECT. The invocation project is the directory the command runs in: its registry id when
 * it is registered, otherwise the id the registry would give it (`allocateProjectSlug`, the rule the
 * server uses for an unregistered boot project), so resolving it never writes the registry. A
 * `projects` subcommand that names another project writes to THAT project's trail, resolved before
 * the effect (a removal deletes the row that says where the project lives).
 *
 * NO STATE PLANTED IN A FOLDER THAT IS NOT A PROJECT. Any folder `shouldRegisterProject` would accept
 * (every folder except `$HOME` itself and a path inside a xezar task worktree) is a project for this
 * purpose, whether or not it is registered yet or has ever run xezar before: its `.local/xezar/` is
 * created (and ignored) when it has none, exactly as a first `serve` would, and the command writes its
 * one record. A folder `shouldRegisterProject` excludes writes no record and no state, but never
 * silently — it prints the project's one audit warning (the latch every door of that folder shares,
 * with the bounded code `not_a_project_folder` and no path) so a reader can tell "never ran" from
 * "ran without an audit record": `xezar projects list` in `$HOME`
 * must not create `~/.local/xezar/`, but it does warn once on stderr, and a nested `xezar` invocation
 * inside a task worktree warns the same way.
 *
 * WHAT IS KEPT. The canonical command id (`actor.command`), the action, a bounded resource id, the
 * outcome, and for `projects tag` / `projects port` the field name plus a digest — never `argv`, a
 * task text, a path, a tag, a port, a domain, a model, the environment or any output.
 *
 * NEVER FAILS THE COMMAND. Every method resolves; a failure is the trail's one warning.
 */

export type CliCommandId = Extract<AuditActor, { type: 'cli' }>['command'];

/** Canonical action id per command (§ 5). `rm` is `projects.remove`; `projects` alone is `projects.list`. */
export const CLI_AUDIT_ACTIONS: Readonly<Record<CliCommandId, string>> = {
  serve: 'cli.serve',
  run: 'cli.run',
  init: 'cli.init',
  'projects.list': 'cli.projects.list',
  'projects.add': 'cli.projects.add',
  'projects.remove': 'cli.projects.remove',
  'projects.tag': 'cli.projects.tag',
  'projects.port': 'cli.projects.port',
  mcp: 'cli.mcp',
  'server-install': 'cli.serverInstall',
  'server-deploy': 'cli.serverDeploy',
  'server-uninstall': 'cli.serverUninstall',
};

/** The `projects` words and their canonical command. Anything else is not a valid subcommand. */
export const PROJECTS_SUBCOMMANDS: Readonly<Record<string, CliCommandId>> = {
  list: 'projects.list',
  add: 'projects.add',
  remove: 'projects.remove',
  rm: 'projects.remove',
  tag: 'projects.tag',
  port: 'projects.port',
};

export interface CliRecordDetails {
  readonly resource?: AuditResource;
  /** A normalized summary to digest — never persisted as values. */
  readonly payload?: unknown;
  readonly fieldNames?: readonly string[];
}

/**
 * An audit scope, and whether the invocation folder is a project — the same rule
 * `shouldRegisterProject` uses to gate registry auto-registration, true whether or not the folder is
 * registered yet. Unlocks creating its data folder.
 */
export interface CliAuditScope extends AuditScope {
  readonly isProject: boolean;
}

export interface CliAudit {
  readonly command: CliCommandId;
  applied(details?: CliRecordDetails, scope?: CliAuditScope): Promise<void>;
  refused(reason: string, details?: CliRecordDetails, scope?: CliAuditScope): Promise<void>;
  /** The invocation project's scope (resolved once). */
  scope(): Promise<CliAuditScope | undefined>;
  /** A registered project's scope by id — `undefined` when it is not registered. */
  projectScope(projectId: string): Promise<CliAuditScope | undefined>;
}

/** The project resource the invocation project stands for. */
export function projectResource(scope: AuditScope | undefined): AuditResource | undefined {
  return scope ? { kind: 'project', id: scope.projectId } : undefined;
}

/** One trail per project per process, so the one warning is per project. */
const channels = new Map<string, AuditChannel<'cli'> | null>();

function channelFor(scope: AuditScope, warn?: (message: string) => void): AuditChannel<'cli'> | undefined {
  const key = JSON.stringify([scope.projectId, scope.dataDir]);
  if (!channels.has(key)) {
    try {
      channels.set(key, new AuditTrail(scope, warn ? { warn } : {}).channel('cli'));
    } catch {
      channels.set(key, null);
    }
  }
  return channels.get(key) ?? undefined;
}

/** The invocation directory's audit scope: its registry id, or the id the registry would allocate. */
export async function invocationScope(repoRoot: string): Promise<CliAuditScope | undefined> {
  try {
    const root = await realpath(repoRoot).catch(() => resolve(repoRoot));
    const { projects } = await loadWorkspaceConfig();
    const known = projects.find((project) => project.root === root);
    const projectId = known?.id ?? allocateProjectSlug(root, projects.map((project) => project.id));
    const isProject = known !== undefined || (await shouldRegisterProject(root));
    return { projectId, dataDir: projectDataDir(known?.root ?? root), isProject };
  } catch {
    return undefined;
  }
}

export function cliAudit(
  command: CliCommandId,
  repoRoot: string,
  options: { warn?: (message: string) => void } = {},
): CliAudit {
  let invocation: Promise<CliAuditScope | undefined> | undefined;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const doorWarning = doorAuditWarning(warn);
  const scope = (): Promise<CliAuditScope | undefined> => (invocation ??= invocationScope(repoRoot));
  const write = async (
    settlement: { outcome: 'applied' } | { outcome: 'refused'; reason: string },
    details: CliRecordDetails = {},
    target?: CliAuditScope,
  ): Promise<void> => {
    try {
      const where = target ?? (await scope());
      if (!where || !where.isProject) {
        // The one warning of this folder, without the folder: a path is not for logs (#573 m3).
        doorWarning(where?.dataDir, { code: 'not_a_project_folder' });
        return;
      }
      if (!existsSync(where.dataDir)) {
        ensureProjectDataIgnored(where.dataDir);
        mkdirSync(where.dataDir, { recursive: true, mode: 0o700 });
      }
      const channel = channelFor(where, warn);
      if (!channel) return;
      await channel.record(
        {
          action: CLI_AUDIT_ACTIONS[command],
          actor: { command },
          ...(details.payload !== undefined ? { payload: details.payload } : {}),
          ...(details.fieldNames ? { fieldNames: details.fieldNames } : {}),
        },
        { ...settlement, ...(details.resource ? { resource: details.resource } : {}) },
      );
    } catch (err) {
      // Best effort by contract: the command's own result never depends on its audit record, and
      // a record that could not be written says so once (spec § 7.2, A7). The folder and channel
      // setup share the project's one warning with the trail itself, and the error reaches the text
      // only as a bounded code — never its message, which can name a path (#573 m3).
      doorWarning(target?.dataDir ?? (await scope().catch(() => undefined))?.dataDir, err);
    }
  };
  return {
    command,
    applied: (details, target) => write({ outcome: 'applied' }, details, target),
    refused: (reason, details, target) => write({ outcome: 'refused', reason }, details, target),
    scope,
    async projectScope(projectId) {
      try {
        // Layout-aware (#600 review m5): in the project layout the registry is the DERIVED row, so
        // a raw stored-row lookup returned undefined for the boot project and its records lost
        // their scope.
        const known = await findRegistryProject({ id: projectId });
        return known ? { projectId: known.id, dataDir: projectDataDir(known.root), isProject: true } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
