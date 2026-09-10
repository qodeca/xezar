import { realpathSync, statSync } from 'node:fs';
import { runIdParamSchema } from '@qodeca/xezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { ProjectWriterError } from '../runs/project-writer.ts';
import {
  ProjectContextError,
  type ProjectContext,
  type ProjectContexts,
} from '../server/project-context.ts';
import { PROJECT_ID_RE } from '../workspace/config.ts';
import { RESERVED_PROJECT_IDS } from '../workspace/projects.ts';

/**
 * The MCP session's project binding (#87; F-01, F-16, N-01, N-09, S-03, A-02).
 *
 * A session is bound to exactly ONE project, once, from a TRUSTED source: the id of
 * the project whose socket accepted the connection (D-01 § 1.5 and § 6 — "the trusted
 * connection binding is which socket the peer connected to"). That id is chosen by the
 * service when it opens the socket; nothing a client sends — a tool argument, a
 * project alias, a URL, prompt text, a resource identifier read out of a result —
 * reaches this module as a project selector, because no method below accepts one.
 * Tasks, files and results are data, not authority (N-09).
 *
 * This is deliberately NOT `resolveProjectScope` (server.ts). That resolver reads the
 * project from the REQUEST and maps `default` to the boot project, which is right for
 * the same-origin cockpit and wrong here (requirements § 8: derive identity from the
 * connection, never forward an arbitrary `projectId`). So:
 *
 * - `default` is never a binding. It is a reserved alias, never an allocated slug
 *   (`RESERVED_PROJECT_IDS`), and "whichever project the service booted in" is not a
 *   project. A binding names the registry id itself.
 * - There is no fallback. A bound project that is gone fails closed with its own
 *   reason; nothing here ever resolves the boot project or any other id.
 * - The binding is re-checked on EVERY access, not just at bind time. The context map
 *   caches a built context and would keep handing it out after its folder was deleted
 *   or replaced, so each access re-resolves through `ProjectContexts.context(boundId)`
 *   and then verifies the root is still the very directory the session was bound to
 *   (same realpath, same device and inode). A folder deleted, moved away, swapped for a
 *   symlink or recreated at the same path is `missing-root`, never "carry on".
 *
 * Rejections disclose nothing (N-01). Every error message below is a fixed sentence:
 * it never echoes a client-supplied identifier (which could be another project's id or
 * run id), and never names the bound project's path. `projectId` on the error object
 * is only ever the BOUND project's id, which the leader already knows. This module
 * writes no log line.
 *
 * Scope: binding and scope enforcement only. Occupancy, leases and fencing are D-02
 * (#99); the socket is D-01 (#86); the operations themselves go through the shared
 * service adapter (#89). Releasing or losing a binding touches nothing on
 * `RunManager` (N-05).
 */

/** Why an MCP session cannot act. `unknown-project` / `missing-root` keep the meaning
 *  `ProjectContextError` gives them (404 / 409); `unavailable` is a bound project
 *  whose data another process owns; `not-in-project` is a resource this session
 *  cannot see, whether it belongs to another project or to none. */
export type McpScopeFailure = 'unknown-project' | 'missing-root' | 'unavailable' | 'not-in-project';

/** Fixed, identifier-free sentences — the rejection text is part of the surface (N-01). */
const MESSAGES: Readonly<Record<McpScopeFailure, string>> = {
  'unknown-project': 'this MCP session is not bound to a registered xezar project; reconnect from the project folder',
  'missing-root': 'the project folder this MCP session is bound to is missing; restore it or reconnect from the project folder',
  unavailable: 'the project this MCP session is bound to is in use by another xezar process',
  'not-in-project': 'no such resource in this project',
};

/** The one error this module throws. Carries no client-supplied value. */
export class McpScopeError extends Error {
  constructor(
    readonly reason: McpScopeFailure,
    /** The BOUND project's id — never a foreign or client-supplied one. */
    readonly projectId: string,
  ) {
    super(MESSAGES[reason]);
    this.name = 'McpScopeError';
  }
}

/** What the binding needs from the context map — `ProjectContexts` in production. */
export type McpProjectContextSource = Pick<ProjectContexts, 'context'>;

/** Identity of the directory the session was bound to, captured once at bind time. */
interface RootIdentity {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * The live binding a connection holds. Construct only through `bindMcpSession`.
 * Every read and write an MCP operation makes goes through `project()`, `run()` or
 * `withRun()`; there is no other door to a `ProjectContext` for it.
 */
export class McpSessionBinding {
  // Runtime-private (`#`), not TypeScript `readonly`: a `readonly` property is still
  // writable at runtime, and the binding must not be re-pointable by any code holding it.
  readonly #projectId: string;
  readonly #contexts: McpProjectContextSource;
  readonly #root: RootIdentity;

  private constructor(projectId: string, contexts: McpProjectContextSource, root: RootIdentity) {
    this.#projectId = projectId;
    this.#contexts = contexts;
    this.#root = root;
  }

  /** The bound registry id. Fixed for the life of the session; there is no setter. */
  get projectId(): string {
    return this.#projectId;
  }

  /**
   * Bind a session to `trustedProjectId` — the registry id of the project whose socket
   * accepted this connection, as the SERVICE knows it. Never pass anything read from a
   * client frame, a tool argument, a path or a URL here: that value is untrusted by
   * definition, and binding to it is exactly the escape F-01 forbids.
   *
   * Fails closed with `McpScopeError`: `default` and every other reserved alias, a
   * malformed id, an unregistered project and a missing root are all refused — there
   * is no fallback to the boot project. The constructor is private, so this is the
   * only way a binding comes into existence.
   */
  static async bind(contexts: McpProjectContextSource, trustedProjectId: string): Promise<McpSessionBinding> {
    if (
      typeof trustedProjectId !== 'string' ||
      RESERVED_PROJECT_IDS.has(trustedProjectId) ||
      !PROJECT_ID_RE.test(trustedProjectId)
    ) {
      // Not echoed: a malformed binding id is a caller bug, and the message stays fixed.
      throw new McpScopeError('unknown-project', '');
    }
    const ctx = await resolveContext(contexts, trustedProjectId);
    if (ctx.id !== trustedProjectId) throw new McpScopeError('unknown-project', trustedProjectId);
    const root = rootIdentity(ctx.root);
    if (!root) throw new McpScopeError('missing-root', trustedProjectId);
    return new McpSessionBinding(trustedProjectId, contexts, root);
  }

  /**
   * The bound project's context, re-validated on every call. Throws `McpScopeError`
   * when the project is no longer registered, its folder is gone or replaced, or
   * another process owns its data. Never returns any other project's context.
   */
  async project(): Promise<ProjectContext> {
    const ctx = await resolveContext(this.#contexts, this.#projectId);
    // Defence in depth: the map is keyed by id, so this holds today. A context whose
    // id is not the bound id must never be handed to an operation, whatever changes.
    if (ctx.id !== this.#projectId) throw new McpScopeError('unknown-project', this.#projectId);
    const current = rootIdentity(ctx.root);
    if (
      !current ||
      current.realpath !== this.#root.realpath ||
      current.dev !== this.#root.dev ||
      current.ino !== this.#root.ino
    ) {
      throw new McpScopeError('missing-root', this.#projectId);
    }
    return ctx;
  }

  /**
   * One task of the BOUND project, by id. The id is client data: it is shape-checked
   * against the contract's run-id rule and looked up in the bound project's own store
   * only, so another project's id — or any string naming a project, alias, path or
   * URL — reads as `not-in-project`, identically to an id that exists nowhere. The
   * error never repeats the id.
   */
  async run(runId: unknown): Promise<RunRecord> {
    const ctx = await this.project();
    return lookupRun(ctx, runId, this.#projectId);
  }

  /**
   * Gate for an operation on one task: resolves the task in the bound project first
   * and only then runs `operation` with the bound context and that task. A foreign or
   * unknown id is refused before `operation` is called, so it causes no side effect.
   */
  async withRun<T>(runId: unknown, operation: (run: RunRecord, ctx: ProjectContext) => T | Promise<T>): Promise<T> {
    const ctx = await this.project();
    const run = lookupRun(ctx, runId, this.#projectId);
    return operation(run, ctx);
  }
}

/** Bind a session — see `McpSessionBinding.bind`. */
export function bindMcpSession(
  contexts: McpProjectContextSource,
  trustedProjectId: string,
): Promise<McpSessionBinding> {
  return McpSessionBinding.bind(contexts, trustedProjectId);
}

/** Resolve the bound id through the context map, translating its failures. Only ever
 *  called with the bound id — the one place a `ProjectContexts` lookup happens. */
async function resolveContext(contexts: McpProjectContextSource, projectId: string): Promise<ProjectContext> {
  try {
    return await contexts.context(projectId);
  } catch (err) {
    if (err instanceof ProjectContextError) throw new McpScopeError(err.reason, projectId);
    // The writer error names a data directory and a pid; neither may reach a client.
    if (err instanceof ProjectWriterError) throw new McpScopeError('unavailable', projectId);
    throw err;
  }
}

function lookupRun(ctx: ProjectContext, runId: unknown, projectId: string): RunRecord {
  // Dot segments pass the character class but are never run ids; refuse them here so
  // no caller can build a path or URL out of one.
  if (typeof runId !== 'string' || runId === '.' || runId === '..' || !runIdParamSchema.safeParse({ id: runId }).success) {
    throw new McpScopeError('not-in-project', projectId);
  }
  const run = ctx.store.getRun(runId);
  if (!run) throw new McpScopeError('not-in-project', projectId);
  return run;
}

/** Realpath + device/inode of a directory, or null when it is gone or not a directory. */
function rootIdentity(root: string): RootIdentity | null {
  try {
    const realpath = realpathSync(root);
    const stats = statSync(realpath);
    if (!stats.isDirectory()) return null;
    return { realpath, dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}
