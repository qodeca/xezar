import { z } from 'zod';

/** The agent backends a run can be dispatched to. */
export const runnerSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);
export type Runner = z.infer<typeof runnerSchema>;

/** Git facts about the project root, or `null` when it is not a repository. */
export const repoInfoSchema = z.object({
  root: z.string(),
  branch: z.string(),
  remote: z.string().optional(),
});
export type RepoInfo = z.infer<typeof repoInfoSchema>;

/** One probed CLI behind the Tools menu. */
export const backendCheckSchema = z.object({
  name: z.enum(['claude', 'codex', 'opencode', 'pi', 'gh', 'git']),
  available: z.boolean(),
  version: z.string().optional(),
  hint: z.string().optional(),
});
export type BackendCheck = z.infer<typeof backendCheckSchema>;

export const forgeInfoSchema = z.object({
  kind: z.literal('github'),
  /**
   * Whether the forge is reachable — **absent until the availability probe has warmed**.
   *
   * Health must never pay a `gh` shell-out, so it serves whatever the cache holds. Absent means
   * "not determined yet", which is not the same as `false`, and the cockpit renders the two
   * differently. Declaring it required is what made an earlier hand-written mirror wrong.
   */
  available: z.boolean().optional(),
  reason: z.string().optional(),
});
export type ForgeInfo = z.infer<typeof forgeInfoSchema>;

/** Server-side feature switches the cockpit reads once at boot. */
export const capabilitiesSchema = z.object({
  localHandoff: z.boolean(),
  followups: z.boolean(),
  singleProject: z.boolean(),
  /**
   * `true` means this cockpit is serving a **single-project root** (#600): xezar's settings,
   * accounts and registry live in `<project>/.xezar` and the per-user `~/.xezar` is not opened.
   *
   * Its OWN key rather than a wider reading of `singleProject` above, because the two answer
   * different questions and one of them is not deprecated: `singleProject` is
   * `XEZ_SINGLE_PROJECT=1` — one project and no project management, with GLOBAL state — and it
   * keeps that exact meaning (FR-1.4). The new mode is a separate superset, so a client that
   * cares WHERE the state lives reads this key and nothing else.
   *
   * OPTIONAL, unlike its neighbours, and deliberately: a 0.15.0 server never sends it, and a
   * 0.16.0 cockpit pointed at one must still parse the health payload. Absent reads as `false`
   * — the global layout, which is what every xezar before 0.16.0 had.
   */
  singleProjectRoot: z.boolean().optional(),
  /**
   * Which projects' DATA this one process serves (#467): `project` means it serves the project
   * it started in and nothing else — every other registered project stays VISIBLE and stays
   * manageable, but is reachable only through its own cockpit, and a scoped request for one
   * answers 409 rather than building a context here.
   *
   * Its own key rather than a wider reading of the two above, for the reason they are two keys
   * themselves: `singleProject` and `singleProjectRoot` HIDE the other projects and refuse
   * project management, and this mode does neither. A client that wants to know whether to link
   * out reads this key and nothing else.
   *
   * OPTIONAL, and sent ONLY when it is `project`: a 0.16.0 server never sends it, absent reads
   * as `workspace` — the default, which is what every xezar has done so far — and a `workspace`
   * payload is therefore byte-identical to the one before this key existed. `narrowed` is not on
   * the wire: a narrowed cockpit already says so through `singleProject` / `singleProjectRoot`,
   * and a third spelling of the same fact is what two readers drifting apart is made of.
   */
  instanceMode: z.enum(['project', 'workspace']).optional(),
  /**
   * `true` means `XEZ_AUTOMATIONS=1` opted this server into GitHub automations (#801). Off — the
   * default — the whole feature is absent: no `Automations` nav item anywhere it is rendered, the
   * `/api/v1/…/automations*` family answers `409`, and the workspace scheduler never polls GitHub.
   *
   * REQUIRED for the same reason as `tokenMetrics` below: this server always sends it.
   */
  automations: z.boolean(),
  /**
   * `false` means `XEZ_HIDE_TOKEN_METRICS=1` asks the browser to omit token counts and monetary
   * cost (#481). The telemetry itself still rides in run/event payloads — this is presentation
   * only.
   *
   * REQUIRED, because this server always sends it (`capabilities.ts` computes it from the env on
   * every read) and this contract describes THIS server's wire. The DTO it replaces declared it
   * optional so a newer cockpit could read an OLDER server, which is version skew a contract
   * versioned in lockstep with the server cannot model. That tolerance lives where it belongs, in
   * `web/src/lib/token-metrics.ts`, whose `!== false` read still treats an absent field as
   * visible.
   */
  tokenMetrics: z.boolean(),
  /** Current token-count presentation policy. Required on current servers;
   * older payload tolerance belongs in the browser resolver. */
  tokenUsageMetrics: z.boolean(),
  /** Current backend-reported-cost presentation policy. */
  costMetrics: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * `GET /api/v1/health` — the CORS-open discovery endpoint (BACKWARD_COMPATIBILITY.md §2).
 *
 * Additive fields only: this is the most externally-depended-on JSON in the app.
 */
export const healthResponseSchema = z.object({
  version: z.string(),
  latestVersion: z.string().optional(),
  /** Where the running server came from (#442): `dev` for a source checkout (its package root
   * carries `src/index.ts`), `release` for an installed tarball. Top-level on purpose, not under
   * `capabilities`: it describes the build, not what the server may do. The cockpit's brand tile
   * shows a "D" badge for `dev`; an older server that omits it reads as no badge. */
  channel: z.enum(['release', 'dev']),
  repoRoot: z.string(),
  repo: repoInfoSchema.nullable(),
  checks: z.array(backendCheckSchema),
  defaultRunner: runnerSchema,
  forge: forgeInfoSchema.nullable(),
  capabilities: capabilitiesSchema,
  // Always sent: `workspaceSummary()` returns both unconditionally, and an unreadable workspace
  // degrades to `projects: []` rather than to an absent key. The hand-written DTO declared them
  // optional, which was wider than the server has ever been.
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  bootProject: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
