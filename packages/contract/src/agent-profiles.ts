import { z } from 'zod';
import { providerIdSchema, providerStatusSchema } from './workspace.ts';

/**
 * Agent profiles — extra config dirs for a SECOND login of the same agent CLI
 * (`CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`), spec `2026-07-29-agent-profiles`.
 *
 * Workspace-level, so single-mount: `/api/v1/workspace/agent-profiles`. Never project-scoped —
 * an account belongs to the person and the machine, and a second scoped spelling would be a
 * second surface to protect with no consumer. Which account a PROJECT uses rides on
 * `PUT …/agent-profiles/selection` in this same family, because it is stored beside the accounts
 * it names rather than on the project registry (see `src/workspace/agent-accounts.ts`).
 *
 * Node-free by construction (see README rule 1) — `zod` and the sibling contract modules only.
 */

/**
 * The id of the DISCOVERED account — the one `agentHomePaths()` finds from the environment.
 *
 * Reserved: never allocated to a stored account, never written to `~/.xezar/agent-accounts.json`.
 * It is a real, meaningful value on the wire in two places, and they are not the same thing:
 * `PUT …/agent-profiles/selection` takes it (like `null`) to CLEAR a repo back to the discovered
 * account, and `POST /api/v1/runs` takes it as `agentProfile` to mean "this task uses the
 * discovered account, whatever the repo is set to" — which `selectProfile` honours over the repo's
 * selection. Defined here so the cockpit and the server cannot disagree about the spelling.
 */
export const DEFAULT_AGENT_ACCOUNT_ID = 'default';

/**
 * One of the agent's OWN config files, resolved against THIS account's folder.
 *
 * Addressed by the catalog's stable, opaque `id` — never a path the client composes, which is what
 * makes the open route traversal-proof by construction (the same rule `/api/v1/agent-config/:id`
 * follows).
 */
export const agentAccountFileSchema = z.object({
  id: z.string(),
  /** e.g. `settings.json` — the file's own name, since the folder is shown once on the account. */
  label: z.string(),
  /** Absolute, resolved inside this account's config folder. */
  path: z.string(),
  exists: z.boolean(),
});
export type AgentAccountFile = z.infer<typeof agentAccountFileSchema>;

/**
 * One account, as the cockpit sees it.
 *
 * A CLOSED object, on the same terms as `projectListEntrySchema`: `.passthrough()` on the
 * persistence side (`src/workspace/agent-accounts.ts`) is a durability promise about
 * `~/.xezar/agent-accounts.json`, not a promise that the API answers arbitrary keys.
 */
export const agentProfileSchema = z.object({
  /** `default` for the discovered profile, else the stored slug. */
  id: z.string(),
  provider: providerIdSchema,
  label: z.string(),
  /** As the user wrote it — a literal `~` is preserved, matching `browseRoot`/`projectsDir`. */
  configDir: z.string(),
  /** Expanded absolute path. Same-origin route, like `ProjectListEntry.root`. */
  path: z.string(),
  /** False for a dir the CLI has not created yet — legitimate, and NOT a reason to fall back
   *  to another account at run time (that would silently bill the wrong subscription). */
  exists: z.boolean(),
  /** Whether the dir carries this agent's own marker files. ADVISORY: an unrecognised dir is
   *  still accepted, because "add profile → Connect → the CLI creates it" is the real flow. */
  looksValid: z.boolean(),
  /** True for the profile xezar discovers from the environment. Never stored, never deletable. */
  isDefault: z.boolean(),
  /** This account's own authentication state — two Claude logins answer independently.
   *
   *  **Absent until the probe has warmed.** Every probe shells out to an agent CLI, and this
   *  listing refuses to pay that (it would be one spawn per provider plus one per account, on
   *  every cold load); it serves only what is already cached, exactly as `GET /api/v1/health`
   *  serves a cached forge answer. Absent means "not determined yet" — NOT `unknown`, which is a
   *  real probe result — and the cockpit fills it in from `…/:id/status`. */
  status: providerStatusSchema.optional(),
  /** This agent's own user-scope config files, resolved inside THIS account's folder — so a
   *  second login's `settings.json` is the one you open, not the default account's. */
  files: z.array(agentAccountFileSchema),
  /** The ONE account per provider that the listing's subject runs under (#819 PR 9): in
   *  single-project mode this project's selection, else the machine-wide default, else the
   *  discovered account — `selectProfile`'s own order, a dangling id included, so the cockpit never
   *  re-derives it. In the global layout there is no project, so it is the machine-wide default.
   *
   *  Set by the LISTING only; the per-account write answers (`POST`/`PATCH`) omit it, because one
   *  row cannot say which of its siblings is in use. Optional so a consumer that predates it
   *  compiles unchanged. */
  selected: z.boolean().optional(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * Whether an account label reads as a person's identity — today, anything with an `@`, the rule the
 * MCP door already applies before it echoes a label (#819 PR 5, `get_account`).
 *
 * Defined here so the cockpit and the server answer the same question with the same rule instead
 * of a second regex (#819 PR 9 design § 8): a surface that prints a label collapsed calls this and
 * shows "Name hidden" instead. The label itself is still in the listing — identity is withheld from
 * the page, and "Show details" is the one opt-in door to it.
 */
export function looksLikeAccountIdentity(label: string): boolean {
  return label.includes('@');
}

/**
 * How to address one account in the per-account routes (`…/:id/details`, `…/:id/open`).
 *
 * Every DISCOVERED account shares `id: "default"` — that spelling is load-bearing in the selection
 * routes, where it means "back to the discovered account" — so it cannot identify which agent's
 * default is meant. These two routes therefore take `default:<provider>` for a discovered account
 * and the stored slug otherwise. Defined once, here, so the client and the server cannot disagree
 * about the encoding; still opaque, still not a path.
 */
export function agentAccountRouteId(profile: Pick<AgentProfile, 'id' | 'provider' | 'isDefault'>): string {
  return profile.isDefault ? `default:${profile.provider}` : profile.id;
}

/**
 * Why a committed account cannot run on this machine — single-project mode (#600 FR-6, BR-4).
 *
 * ONE sentence, two surfaces: the Settings row shows it after "Unavailable", and a task that asks
 * for the account is refused with it, prefixed by the account's name
 * ({@link unavailableAgentAccountRefusal}). Both are built here so the two can never drift — a
 * person who reads the refusal must recognise the row it came from. `configDir` is shown as the
 * repository carries it (`~/.claude-work`), because that is the spelling a person can find in
 * `.xezar/agent-accounts.json`.
 *
 * The remedy is the local one. Over a hosted connection the accounts pane renders no rows at all
 * (it is refused there as a whole), so the hosted wording of the copy deck has no surface yet.
 */
export function unavailableAgentAccountReason(configDir: string): string {
  return (
    `this account's folder does not exist on this machine: ${configDir}. ` +
    'Connect signs in and creates it, or pick another account for the task.'
  );
}

/** The task refusal for an unavailable account: its name, then {@link unavailableAgentAccountReason}. */
export function unavailableAgentAccountRefusal(label: string, configDir: string): string {
  return `Agent account “${label}” is unavailable — ${unavailableAgentAccountReason(configDir)}`;
}

/** One project's account choice, per provider. An absent key = the discovered account. */
export const agentAccountSelectionSchema = z.object({
  claude: z.string().optional(),
  codex: z.string().optional(),
  opencode: z.string().optional(),
  pi: z.string().optional(),
});
export type AgentAccountSelection = z.infer<typeof agentAccountSelectionSchema>;

/**
 * A stored reference that names no account (issue #819 item 2) — a `defaults.<provider>` or a
 * project selection whose account has since been deleted, or that never existed because the file
 * was hand-edited.
 *
 * ADVISORY, and that is the whole design. Run resolution keeps its silent fall back to the
 * discovered account (`selectProfile`): a dangling reference names no account, so the default is
 * the only safe answer and zero config still means "degrade, never fail". What was missing was any
 * way to SAY that the stored choice has no effect — so it is reported here, and nothing about
 * resolution changes.
 */
export const agentAccountProblemSchema = z.object({
  /** The only kind today, spelled as a literal so the discriminant cannot widen to `string`. */
  kind: z.literal('unknown-account'),
  /** Which map the dangling handle came from — the machine-wide default, or one project's
   *  selection. The two are cleared by different writes, so a surface has to be able to tell. */
  where: z.enum(['defaults', 'selection']),
  /** The provider the dangling reference was stored FOR. An id that is known for a DIFFERENT
   *  provider is reported too, because it names no account of this one. */
  provider: providerIdSchema,
  /** The stored string as written, so a surface can name it back to the person who chose it. */
  handle: z.string(),
});
export type AgentAccountProblem = z.infer<typeof agentAccountProblemSchema>;

/**
 * `GET /api/v1/workspace/agent-profiles` — every account, discovered defaults first.
 *
 * `editable` is false in hosted mode (`XEZ_REMOTE`), where the whole family is refused: defining
 * a profile points an agent at a local directory, and the listing echoes absolute paths carrying
 * the username. Same posture as `PUT /api/v1/agent-config/:id`.
 */
export const agentProfilesResponseSchema = z.object({
  editable: z.boolean(),
  profiles: z.array(agentProfileSchema),
  /** Providers that can carry more than one account at all — what "Add account" is offered for.
   *  OpenCode is absent: its credentials live in a SQLite DB behind a separate `OPENCODE_DB`, so
   *  a config-dir profile would swap settings while still billing the other account. */
  profileCapableProviders: z.array(providerIdSchema),
  /** Which account each project uses, keyed by the project's realpath'd ROOT.
   *
   *  Served here rather than on `GET /api/v1/projects` because it is stored beside the accounts it
   *  names (`~/.xezar/agent-accounts.json`) — one file, so deleting an account and scrubbing every
   *  reference to it is one atomic write, and neither can be dropped by a xezar version that never
   *  heard of accounts. Empty in hosted mode, where the whole family is withheld. */
  selections: z.record(z.string(), agentAccountSelectionSchema),
  /** The machine-wide fallback account per provider, used by any repo that has chosen none. */
  defaults: agentAccountSelectionSchema,
  /** Stored references that name no account — a dangling `defaults.<provider>` or a project
   *  selection whose account is gone.
   *
   *  OPTIONAL on purpose, so the addition stays ADDITIVE in the typed sense as well as on the wire:
   *  a consumer that predates this key (the cockpit's own fixtures, a third-party client) compiles
   *  and behaves unchanged. The listing ALWAYS fills it in today — `[]` for a clean or unread
   *  store, `[]` in hosted mode — which the listing tests pin, so the wire carries it in practice.
   *
   *  ADVISORY: run resolution still falls back to the discovered account for an unknown id, which
   *  is why this is reported rather than enforced. */
  problems: z.array(agentAccountProblemSchema).optional(),
});
export type AgentProfilesResponse = z.infer<typeof agentProfilesResponseSchema>;

/**
 * `PUT /api/v1/workspace/agent-profiles/selection` — point one project's provider at an account.
 *
 * `profileId: null` (and the reserved `"default"`) clear it back to the discovered account, stored
 * as absence. An id that does not exist, or belongs to another provider, is a 400 — never silently
 * degraded, because a typo the route accepted would quietly run the project on the wrong account.
 */
export const selectAgentProfileInputSchema = z.strictObject({
  /**
   * Registry slug, or the reserved `default` boot alias. Resolved to a root server-side.
   *
   * `null` targets the MACHINE-WIDE default instead of one repo — the account a repo that has
   * chosen nothing uses, so a second login is set up once rather than per checkout. A repo's own
   * choice always wins over it, which is what keeps this a default and not an override.
   */
  projectId: z.string().min(1).max(64).nullable(),
  provider: providerIdSchema,
  profileId: z.string().max(64).nullable(),
});
export type SelectAgentProfileInput = z.infer<typeof selectAgentProfileInputSchema>;

/** The selection map after the write — the same shape the listing carries. */
export const agentProfileSelectionsResponseSchema = z.object({
  selections: z.record(z.string(), agentAccountSelectionSchema),
  /** The machine-wide fallback, for repos with no selection of their own. */
  defaults: agentAccountSelectionSchema,
});
export type AgentProfileSelectionsResponse = z.infer<typeof agentProfileSelectionsResponseSchema>;


/** `GET /api/v1/workspace/agent-profiles/:id/status` — one account's auth state, probed for real.
 *  `?refresh=1` drops this account's cached answer and re-probes. Kept off the listing so a cold
 *  load pays no CLI spawn. */
export const agentAccountStatusResponseSchema = z.object({ status: providerStatusSchema });
export type AgentAccountStatusResponse = z.infer<typeof agentAccountStatusResponseSchema>;

/**
 * `GET /api/v1/workspace/agent-profiles/:id/details` — who this account is signed in as.
 *
 * A SEPARATE, on-demand route rather than a field on the listing, and that is the whole point of
 * "hidden by default": if the listing carried an email, hiding it in the UI would be theatre — it
 * would already be in the response, the query cache and devtools. It is fetched only when the user
 * asks, is refused in hosted mode, and is never logged or persisted.
 *
 * `fields` is a labelled list rather than a fixed shape because what an agent knows about its own
 * login differs; inventing an empty "Organization" for one that has no such concept would be a
 * worse answer than omitting the row. `available: false` carries a `reason` in the user's terms.
 */
export const agentAccountDetailsResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type AgentAccountDetailsResponse = z.infer<typeof agentAccountDetailsResponseSchema>;

/**
 * `POST /api/v1/workspace/agent-profiles/:id/open` — hand one of this account's config files (or
 * the folder itself) to a local app.
 *
 * `file` is a catalog id from the account's own `files`, or `folder` for the config dir. `target`
 * is an `/api/v1/open-targets` id — an editor, or the file manager for `folder` — and omitted means
 * the OS default handler.
 *
 * Two target families are refused with a 400 rather than silently misbehaving: `terminal` for a
 * FILE (it would `cd` into it) and any `cli:<runner>` handoff (it would start an agent session
 * inside the config folder). An unknown/undetected target is a 400 too.
 */
export const openAgentAccountFileInputSchema = z.strictObject({
  file: z.string().min(1).max(200),
  target: z.string().min(1).max(64).optional(),
});
export type OpenAgentAccountFileInput = z.infer<typeof openAgentAccountFileInputSchema>;

/** `POST …/open` — what was opened, so the UI can say so rather than guess. */
export const openAgentAccountFileResponseSchema = z.object({
  opened: z.literal(true),
  path: z.string(),
});
export type OpenAgentAccountFileResponse = z.infer<typeof openAgentAccountFileResponseSchema>;

/**
 * `POST /api/v1/workspace/agent-profiles` — the id is allocated server-side from the label.
 *
 * STRICT, and validated by the route as middleware since #677 B5: this schema and the twin the
 * route used to declare in `server.ts` are one definition now, so the MCP door's `create_account`
 * takes its key set from the same place the route validates against rather than from a hand-copied
 * list. The bounds mirror `agentProfileSchema` in `src/workspace/config.ts` exactly, so a value
 * this accepts can never be degraded away by the next load's `.catch`.
 */
export const createAgentProfileInputSchema = z.strictObject({
  provider: providerIdSchema,
  label: z.string().trim().max(200).optional(),
  /** Stored as written; validated absolute after `~` expansion, server-side. */
  configDir: z.string().trim().min(1).max(4096),
});
export type CreateAgentProfileInput = z.infer<typeof createAgentProfileInputSchema>;

/**
 * `POST` / `PATCH /api/v1/workspace/agent-profiles/:id` — the affected row.
 *
 * Answered WITHOUT waiting for a probe, like the listing: `status` is absent and the server kicks
 * the re-learn off behind the response, so adding an account does not block on a CLI spawn. The
 * pane's own request for that row joins the same in-flight probe rather than starting a second.
 */
export const agentProfileResponseSchema = z.object({ profile: agentProfileSchema });
export type AgentProfileResponse = z.infer<typeof agentProfileResponseSchema>;

/**
 * `PATCH /api/v1/workspace/agent-profiles/:id` — partial; absent keys stay untouched.
 *
 * The refinement travelled WITH the schema when #677 B5 moved it out of `server.ts`: an empty body
 * is a 400 (`send label or configDir`) rather than a 200 for a change that never happened, and it
 * is behaviour a TYPE cannot carry, so it lives here beside the keys it guards. `.shape` survives
 * a zod 4 refinement, which is what lets the request-parity guard still read the key set.
 */
export const updateAgentProfileInputSchema = z
  .strictObject({
    label: z.string().trim().max(200).optional(),
    configDir: z.string().trim().min(1).max(4096).optional(),
  })
  .refine((value) => value.label !== undefined || value.configDir !== undefined, 'send label or configDir');
export type UpdateAgentProfileInput = z.infer<typeof updateAgentProfileInputSchema>;

/** `DELETE /api/v1/workspace/agent-profiles/:id` — deregistration only; the directory is never
 *  touched. Projects that referenced it fall back to the discovered default. */
export const removeAgentProfileResponseSchema = z.object({
  removed: z.literal(true),
  id: z.string(),
});
export type RemoveAgentProfileResponse = z.infer<typeof removeAgentProfileResponseSchema>;
