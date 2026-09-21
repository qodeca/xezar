import { z } from 'zod';

/**
 * The project-registry family: `GET/POST/PATCH/DELETE /api/v1/projects`, the folder picker
 * (`GET /api/v1/fs/browse`) that feeds it, and the launch-key read.
 *
 * Node-free by construction (see README rule 1) — `zod` and nothing else.
 */

/**
 * Does another xezar serve this project right now, and where (#467, PR 3;
 * `designs/cli-terminal/multi-instance.md` § 6)?
 *
 * Five answers, and each is the result of a CHECK rather than of a remembered value. The stored
 * `projects[].lastListen` is a hint that is stale the moment a process exits, and
 * `BACKWARD_COMPATIBILITY.md` § 9 promises it is "never to be rendered as running without a
 * liveness check of its own" — so it never appears on the wire and is only ever an ADDRESS to
 * probe.
 *
 * - `this` — the project this cockpit itself serves. No probe: it is answering the request.
 * - `running` — `GET /api/v1/health` at the remembered address answered, and it named THIS
 *   project as its `bootProject`. Only this state and `this` carry a `url`.
 * - `running-unknown-address` — a live writer claim in the project's own data directory, but no
 *   address answers as that project. The honest shape of a `--port 0` start, which deliberately
 *   remembers no address at all (§ 3.2): the process is up and this cockpit cannot link to it.
 * - `stopped` — no live claim and no answer. A remembered address alone never reaches `running`.
 * - `checking` — no answer yet. The probe is bounded and runs off the request, so the first read
 *   of a project with a remembered address says so rather than blocking the registry on a socket.
 */
export const projectInstanceStateSchema = z.enum([
  'this',
  'running',
  'running-unknown-address',
  'stopped',
  'checking',
]);
export type ProjectInstanceState = z.infer<typeof projectInstanceStateSchema>;

export const projectInstanceSchema = z.object({
  state: projectInstanceStateSchema,
  /**
   * Where that project's OWN cockpit answers — `http://<host>:<port>/p/<id>/`. Present only with
   * `running`, where a health answer naming that project proved both halves: that something is
   * there, and that it is not this instance (this instance's health names ITS boot project, so
   * its own address can never satisfy the identity check for another project's row).
   *
   * Omitted for `this`, which the design allows and which is the safer of the two readings: the
   * row for the project you are already looking at needs no absolute address, and building one
   * would mean guessing this process's externally reachable spelling from its bind host.
   */
  url: z.string().optional(),
});
export type ProjectInstance = z.infer<typeof projectInstanceSchema>;

/**
 * One `GET /api/v1/projects` registry entry (multi-project spec, step 1.6).
 *
 * Unlike health's id+name pairs this carries the absolute `root`: the registry routes are
 * same-origin, the CORS-open health route is not, and that difference is the reason the two
 * project shapes are deliberately NOT the same type.
 *
 * Deliberately a CLOSED object even though the server's persistence schema
 * (`src/workspace/config.ts`, `workspaceProjectSchema.passthrough()`) keeps unknown keys in the
 * file: passthrough is a durability promise about `~/.xezar/config.json`, not a promise that the
 * API answers arbitrary keys. Modelling it as a loose object here would also be unprovable — see
 * the note on the index signature in `src/server/contract-parity.workspace.test.ts`.
 */
export const projectListEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute, realpath-normalized repo root. */
  root: z.string(),
  addedAt: z.string(),
  lastOpenedAt: z.string(),
  source: z.enum(['local', 'checkout']),
  /** `not-git` is fully usable (degraded single-queue mode); only `missing` blocks. */
  status: z.enum(['ok', 'missing', 'not-git']),
  /** Current branch when cheaply available (omitted e.g. on an unborn HEAD). */
  branch: z.string().optional(),
  /** Which forge this project's remote belongs to (#698) — classified server-side from the
   *  remote URL alone. Gates the project group's GitHub nav item; omitted = no forge remote. */
  forge: z.literal('github').optional(),
  /**
   * The remote's web root, `https://github.com/owner/repo`. Rebuilt server-side from the parsed
   * remote rather than passed through, so a remote carrying credentials cannot leak into the
   * cockpit. Omitted when the project has no forge remote.
   *
   * It exists for the cross-project surfaces: a run often knows a PR or issue only by NUMBER, and
   * the global Tasks page has one row per project, so it cannot use any single repo's base the
   * way a project-scoped view can. With this, every reference it shows is a link.
   */
  repoUrl: z.string().optional(),
  /** Per-project cap on concurrently running tasks (spec 2026-07-22). Omitted = inherit the
   *  workspace `resources.maxParallel`; a number pins this project. */
  maxParallel: z.number().optional(),
  /**
   * Free-form labels grouping CONNECTED repositories — a `storefront` tag on the API, the web
   * app and the design system says those three are one piece of work spread over three repos.
   * The global Tasks page (`/tasks`) filters and groups by them.
   *
   * Omitted rather than `[]` when a project has none, exactly like `maxParallel`: the registry
   * stores nothing for a project nobody has tagged, and an empty array on the wire would make
   * "never tagged" indistinguishable from "tagged, then emptied" for no gain. Normalized
   * server-side (trimmed, deduped case-insensitively, sorted), so a consumer may compare them
   * directly.
   */
  tags: z.array(z.string()).optional(),
  /**
   * Does another xezar serve this project, and where (#467, PR 3)? DERIVED per request, never
   * stored: `projects[].cli.port` and `projects[].lastListen` stay in `~/.xezar/config.json` and
   * are stripped before this shape is built (`toProjectListEntry`), because a terminal setting
   * and a stale address hint are not the cockpit's answer to "which other projects run".
   *
   * **Omitted, never null, when it is unknown**, which is exactly one case: a hosted cockpit
   * (`capabilities.localHandoff === false`), which never probes another port and can see no
   * writer claim on a machine it does not run on. Absent is the honest spelling of "this server
   * did not look" — `JSON.stringify` drops an absent key, so a `null` here would be a value the
   * route does not send (AGENTS.md § The HTTP API), and it would also be a THIRD thing for the
   * cockpit to tell apart from `checking` and `stopped`.
   */
  instance: projectInstanceSchema.optional(),
});
export type ProjectListEntry = z.infer<typeof projectListEntrySchema>;

/**
 * A frame's `data` on the `project-instances` WebSocket topic (`/api/v1/ws`, #796): the same
 * derived `instance` answer `GET /api/v1/projects` attaches to each row, keyed by registry project
 * id, for every project this server answers for.
 *
 * It exists because that answer is the one field of a registry row that changes WITHOUT this
 * cockpit doing anything: another process on this machine starts or stops, and nothing on the
 * workspace event stream fires — the registry itself did not change. A page-load read therefore
 * freezes, which is exactly #796: the first read of a project with a remembered address is
 * `checking` by design (see `projectInstanceStateSchema`), so a cockpit opened the moment `xez`
 * boots renders every other row as `checking…` and, with nothing re-asking, keeps saying it.
 *
 * Every project in the answer is in every frame, so a row missing from one it was in is never
 * "no news" — the whole map replaces the previous one. The cockpit validates each frame with this
 * schema and ignores one that does not parse.
 *
 * `{}` is the honest empty answer, and the only thing a HOSTED server ever publishes: it makes no
 * outbound probe and sees no writer claim, the same reason `instance` is absent from its rows.
 *
 * It keeps the hub's DEFAULT trust (`loopbackReadable` is not set): a `url` names another local
 * port, and which projects this machine has open is not something a foreign local page may read.
 */
export const projectInstancesTopicSchema = z.object({
  projects: z.record(z.string(), projectInstanceSchema),
});
export type ProjectInstancesTopic = z.infer<typeof projectInstancesTopicSchema>;

/** `GET /api/v1/projects` — the workspace registry. Workspace-level: never 404s, never scoped.
 *  An unreadable workspace degrades to `projects: []` plus the default `projectsDir`, so all
 *  three keys are always present. */
export const projectsResponseSchema = z.object({
  projects: z.array(projectListEntrySchema),
  bootProject: z.string(),
  projectsDir: z.string(),
});
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

/**
 * `POST /api/v1/projects` (multi-project spec, step 4.2) — what the folder-browser dialog gets
 * back. `error` is present ONLY on the 409 (already registered), where `project` is the EXISTING
 * entry: the dialog navigates to it rather than dead-ending on a duplicate.
 */
export const registerProjectResponseSchema = z.object({
  project: projectListEntrySchema,
  error: z.string().optional(),
});
export type RegisterProjectResponse = z.infer<typeof registerProjectResponseSchema>;

/**
 * `DELETE /api/v1/projects/:projectId` (multi-project spec, step 4.4) — Settings → Projects'
 * per-row Remove. Deregistration ONLY: the server never touches anything under the project root,
 * so this is a registry edit and nothing else. The interesting failures are 409s (the project has
 * running tasks, or it is the project this server booted in), whose `{ error }` the pane shows
 * verbatim.
 */
export const removeProjectResponseSchema = z.object({
  removed: z.literal(true),
  id: z.string(),
});
export type RemoveProjectResponse = z.infer<typeof removeProjectResponseSchema>;

/** `PATCH /api/v1/projects/:projectId` — the updated entry, the same shape `GET /api/v1/projects`
 *  attaches (the handler re-probes `status`/`branch` so one project has one shape). */
export const updateProjectResponseSchema = z.object({
  project: projectListEntrySchema,
});
export type UpdateProjectResponse = z.infer<typeof updateProjectResponseSchema>;

/** Bounds for one tag and for a project's tag list. Named because three places must agree: this
 *  schema, the registry schema that must never `.catch` away a value this accepts
 *  (`workspaceProjectSchema` in the service), and the settings editor that refuses input early. */
export const PROJECT_TAG_MAX_LENGTH = 32;
export const PROJECT_TAGS_MAX = 20;

/**
 * `PATCH /api/v1/projects/:projectId` body — the two per-project registry fields the cockpit
 * edits. Each key is optional and a body may carry either or both: a PATCH names the fields it
 * changes, and an absent key must stay distinguishable from one set to `null` (which CLEARS). A
 * `{ maxParallel }`-only body — every pre-tags client sends exactly that — therefore still means
 * what it always did. An EMPTY body is still refused, as it was before tags existed: a request
 * that names no field is a mistake, and answering 200 to it would report a change that never
 * happened (and cost a full config rewrite to do nothing).
 *
 * - `maxParallel` (spec 2026-07-22-per-project-concurrency): `null` clears the override back to
 *   "inherit the workspace cap"; an integer `1..16` pins it. The bounds mirror
 *   `workspaceProjectSchema` exactly, so a value this schema accepts can never be degraded away
 *   by the next load's `.catch`.
 * - `tags`: the whole list, replaced wholesale — there is no add-one/remove-one spelling,
 *   because the editor always knows the full set and a merge protocol would only add a way for
 *   two tabs to disagree. `null` and `[]` both clear it; the server normalizes before storing.
 *
 * Deliberately NOT where the agent-account selection lives — that is
 * `PUT /api/v1/workspace/agent-profiles/selection`, stored beside the accounts it names.
 */
export const updateProjectInputSchema = z
  .object({
    maxParallel: z.number().int().min(1).max(16).nullable().optional(),
    tags: z
      .array(z.string().trim().min(1).max(PROJECT_TAG_MAX_LENGTH))
      .max(PROJECT_TAGS_MAX)
      .nullable()
      .optional(),
  })
  .refine(
    (body) => body.maxParallel !== undefined || body.tags !== undefined,
    'specify maxParallel or tags',
  );
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

/**
 * `POST /api/v1/projects/checkout` (multi-project spec, step 4.3) — the clone-from-GitHub body.
 * `name` defaults server-side to the repo name; `checkoutId` is the cockpit's own correlation
 * token, echoed on every `checkout-progress` event so two tabs cloning at once never render each
 * other's progress.
 */
export const checkoutProjectInputSchema = z.object({
  url: z.string().trim().min(1).max(512),
  name: z.string().trim().max(128).optional(),
  checkoutId: z.string().trim().max(128).optional(),
});
export type CheckoutProjectInput = z.infer<typeof checkoutProjectInputSchema>;

/** One directory in a `GET /api/v1/fs/browse` listing (multi-project spec, step 4.1). `path` is
 *  absolute — same-origin route, like `ProjectListEntry.root`. */
export const fsBrowseDirSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Has a `.git` entry — drives the "git" badge. A non-repo folder is still selectable. */
  isRepo: z.boolean(),
});
export type FsBrowseDir = z.infer<typeof fsBrowseDirSchema>;

/** `GET /api/v1/fs/browse?path=` — the folder picker's listing. Rooted at the independently
 *  configured browse root, directories only. */
export const fsBrowseResponseSchema = z.object({
  /** The realpath'd directory actually listed — never the spelling asked for, so the breadcrumb
   *  shows where the picker really is. */
  path: z.string(),
  /** `null` AT the browse root: there is no "up" out of it, and the dialog must render no parent
   *  row rather than one that 400s. */
  parent: z.string().nullable(),
  dirs: z.array(fsBrowseDirSchema),
  /** True when the listing was capped server-side — surfaced honestly instead of showing a
   *  silently short list. */
  truncated: z.boolean(),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

/** `GET /api/v1/launch-key` — the bookmarklet auto-start secret (spec 011). Fetched to COMPARE
 *  against the `?key=` query param and to bake into the `javascript:` links the Settings → Skills
 *  bookmarklet panel generates. The value never renders as text, never logs, and never goes back
 *  into the address bar. */
export const launchKeyResponseSchema = z.object({
  key: z.string(),
});
export type LaunchKeyResponse = z.infer<typeof launchKeyResponseSchema>;
