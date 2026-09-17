import { existsSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuditActor, AuditResource } from '@qodeca/xezar-contract';
import { AuditTrail, type AuditChannel, type AuditScope } from './mcp/audit-trail.ts';
import { ensureProjectDataIgnored, projectDataDir } from './project-data-paths.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { allocateProjectSlug } from './workspace/projects.ts';

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
 * NO STATE PLANTED IN A FOLDER THAT IS NOT A PROJECT. A registered project gets its `.local/xezar/`
 * created (and ignored) when it has none yet, exactly as a first `serve` would. A folder that is not
 * registered is written to only when its `.local/xezar/` already exists — i.e. xezar already keeps
 * state there (a `run` or `serve` made it). Otherwise the command writes no record and no warning:
 * `xezar projects list` in `$HOME` must not create `~/.local/xezar/`, and a folder with no project
 * state has no audit trail to append to.
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

/** An audit scope, and whether the registry knows the project (which allows creating its data folder). */
export interface CliAuditScope extends AuditScope {
  readonly registered: boolean;
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
    return { projectId, dataDir: projectDataDir(known?.root ?? root), registered: known !== undefined };
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
  const scope = (): Promise<CliAuditScope | undefined> => (invocation ??= invocationScope(repoRoot));
  const write = async (
    settlement: { outcome: 'applied' } | { outcome: 'refused'; reason: string },
    details: CliRecordDetails = {},
    target?: CliAuditScope,
  ): Promise<void> => {
    try {
      const where = target ?? (await scope());
      if (!where) return;
      if (!existsSync(where.dataDir)) {
        if (!where.registered) return;
        ensureProjectDataIgnored(where.dataDir);
        mkdirSync(where.dataDir, { recursive: true, mode: 0o700 });
      }
      const channel = channelFor(where, options.warn);
      if (!channel) return;
      channel.record(
        {
          action: CLI_AUDIT_ACTIONS[command],
          actor: { command },
          ...(details.payload !== undefined ? { payload: details.payload } : {}),
          ...(details.fieldNames ? { fieldNames: details.fieldNames } : {}),
        },
        { ...settlement, ...(details.resource ? { resource: details.resource } : {}) },
      );
    } catch {
      // Best effort by contract: the command's own result never depends on its audit record.
    }
  };
  return {
    command,
    applied: (details, target) => write({ outcome: 'applied' }, details, target),
    refused: (reason, details, target) => write({ outcome: 'refused', reason }, details, target),
    scope,
    async projectScope(projectId) {
      try {
        const known = (await loadWorkspaceConfig()).projects.find((project) => project.id === projectId);
        return known ? { projectId: known.id, dataDir: projectDataDir(known.root), registered: true } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
