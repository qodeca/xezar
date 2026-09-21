import { z } from 'zod';
import { type Runner, runnerSchema } from './health.ts';

/**
 * The workspace + settings families: `~/.xezar/config.json`'s settings slice, both GUI-pref bags
 * (per-repo and workspace), the per-repo agent knobs, provider auth status, the host model
 * catalog, the skills-update state, and the "Open in…" targets.
 *
 * Node-free by construction (see README rule 1) — `zod` and the sibling contract modules only.
 */

// ---- workspace settings (`GET/PUT /api/v1/workspace/config`) --------------------------------

/**
 * The instance-mode vocabulary (#467), spelled once for both directions of this file. It is the
 * same pair `capabilities.instanceMode` uses (`health.ts`) and is deliberately NOT imported from
 * there: that key is optional and sent only for `project`, while these are a stored value, a
 * resolved value and a third answer the capability never carries.
 */
const instanceModeSchema = z.enum(['project', 'workspace']);

/**
 * The three presentation vocabularies of the same stored `cli` object (#467, PR 5 — owner decision
 * D-5, 2026-09-20). Spelled here because the contract cannot import the server; `cli-settings.ts`
 * owns the runtime copy (`OUTPUT_MODES`, `COLOR_MODES`, `LOG_LEVELS`) and
 * `workspace-api.test.ts` fails the day the two lists differ. Exported for that test only.
 */
export const cliOutputModeSchema = z.enum(['auto', 'lines', 'rich']);
export const cliColorModeSchema = z.enum(['auto', 'always', 'never']);
export const cliLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
/** Which layer decides what the NEXT start resolves: a stored key, a variable, or the default. */
const cliValueSourceSchema = z.enum(['stored', 'env', 'default']);

/**
 * `GET/PUT /api/v1/workspace/config` — the settings slice of `~/.xezar/config.json` (step 2.7).
 *
 * Global knobs only: the registry itself is `GET /api/v1/projects`, and `schemaVersion` (a
 * migration cursor, not a setting) is deliberately absent. `resources` is the workspace's
 * host-protection budget — the ONLY effective `maxParallel`/`memoryLimitMb` since Phase 2;
 * `worktreeRetentionDefault` seeds projects that set none.
 *
 * `composerDefaults` and every `resources` key are REQUIRED: `workspaceConfigBody`
 * (src/server/server.ts:1888) materializes all of them from schema defaults on every answer,
 * including the degraded path. The hand-written DTO declared `composerDefaults`,
 * `resources.maxMonitoringSessions` and `resources.monitoringWakeIntervalMinutes` optional, which
 * was wider than the server has ever been.
 */
export const workspaceConfigResponseSchema = z.object({
  /** Root exposed by the Add-project directory browser — stored as written (`~` kept). */
  browseRoot: z.string(),
  /** Checkout root for GUI-cloned projects — stored as written (`~` kept). */
  projectsDir: z.string(),
  /** Stored override; `null` means inherit `XEZ_SKILLS_AUTO_UPDATE`, then true. */
  skillsAutoUpdate: z.boolean().nullable(),
  effectiveSkillsAutoUpdate: z.boolean(),
  /** Stored follow-up Inbox override (F); `null` = no stored key, `XEZ_FOLLOWUPS` decides. */
  followups: z.boolean().nullable(),
  /** What `followups` + the env actually resolve to right now — what the cockpit shows. */
  effectiveFollowups: z.boolean(),
  /** Stored extra agent env-passthrough names (F); `null` = no stored key,
   *  `XEZ_ENV_PASSTHROUGH` decides. `[]` is a real stored "forward nothing". */
  agentEnvPassthrough: z.array(z.string()).nullable(),
  /** What `agentEnvPassthrough` + the env actually resolve to right now. */
  effectiveAgentEnvPassthrough: z.array(z.string()),
  composerDefaults: z.object({
    autonomous: z.boolean().nullable(),
    worktree: z.boolean().nullable(),
    /** `'source-dependent'` when no `XEZ_AUTONOMOUS_DEFAULT` pins it either way. */
    inheritedAutonomous: z.union([z.boolean(), z.literal('source-dependent')]),
    inheritedWorktree: z.boolean(),
  }),
  resources: z.object({
    maxParallel: z.number(),
    maxMonitoringSessions: z.number(),
    monitoringWakeIntervalMinutes: z.number().nullable(),
    /** Resume a run a provider usage limit stopped, once the limit resets. Default `true`. */
    autoResumeOnUsageLimit: z.boolean(),
    /** Wall clock for a session parked at `waiting`, in minutes; `null` = never close on
     *  idle. Default 15. */
    idleTimeoutMinutes: z.number().nullable(),
    memoryLimitMb: z.number().nullable(),
    /** The host-derived ceiling an ABSENT `memoryLimitMb` falls back to (B1) — reported so
     *  the settings pane can name the machine's own default instead of guessing it. */
    memoryLimitDefaultMb: z.number(),
    worktreeRetentionDefault: z.number(),
    /**
     * How many gate runs may hold the machine-wide gate lease at once (#672).
     *
     * EFFECTIVE, never "stored or null": the file key is optional and an absent one derives 1,
     * and since there is no `null`/unlimited spelling, absent and an explicit `1` are the same
     * behaviour. Reporting one number therefore loses nothing a caller could act on — unlike
     * `memoryLimitMb`, where `null` is a real third answer and the pane has to see it.
     */
    gateSlots: z.number(),
  }),
  /**
   * What a repo that has set none of its own runs (spec 2026-07-29-agent-profiles).
   *
   * Both keys are OPTIONAL on the wire, and that is load-bearing rather than lax: absent means
   * "this machine has no opinion, the built-in default applies", and it has to stay distinguishable
   * from a value someone chose or the fallback collapses into "always claude". Consulted only where
   * the repo's own `.xezar/config.json` is silent — a repo that chose is never overruled.
   */
  agentDefaults: z.object({
    runner: runnerSchema.optional(),
    models: z.object({
      claude: z.string().optional(),
      codex: z.string().optional(),
      opencode: z.string().optional(),
      pi: z.string().optional(),
    }).optional(),
  }),
  /**
   * The workspace-wide `cli` settings this cockpit can edit (#467, PR 5): the instance mode — WHICH
   * projects one process serves — and the three terminal presentation keys stored beside it. Each
   * key comes as the same triple: the stored value (`null` = never chosen), what the NEXT plain
   * start resolves from the file and the environment, and which layer that answer came from.
   * `…Source` is what lets the pane name an environment variable only when one really decides,
   * rather than whenever nothing is stored (design review B-1 on PR #798).
   *
   * Two fields describe THIS process rather than the file, and both were settled at boot.
   * `inForce` is not decoration: `XEZ_SINGLE_PROJECT` and a folder that owns its xezar state
   * narrow this cockpit and BEAT the setting, so a pane that rendered only the stored value would
   * tell a narrowed user `workspace` while the process serves one project. `narrowing` says WHICH
   * of the two is in force (`null` unless `inForce` is `narrowed`), because they are not the same
   * situation for a person (B-2): under `XEZ_SINGLE_PROJECT` the stored value is written to the
   * machine's file and a start elsewhere reads it, while a folder that owns its state writes to
   * its own file and is narrowed again at every start, so the setting can never take effect there.
   *
   * Required, like `composerDefaults` and `resources`: the server materializes every key on every
   * answer, degraded path included, so a client never has to guess.
   */
  cli: z.object({
    /** The stored `cli.instance`; `null` = no stored key, so `XEZ_INSTANCE` then the default decides. */
    instance: instanceModeSchema.nullable(),
    /** Stored + `XEZ_INSTANCE` + the `workspace` default, resolved — what the NEXT start will use. */
    effectiveInstance: instanceModeSchema,
    instanceSource: cliValueSourceSchema,
    /** What this process is actually doing, narrowings included. */
    inForce: z.enum(['project', 'workspace', 'narrowed']),
    /** Which narrowing makes `inForce` `narrowed`; `null` when none does. */
    narrowing: z.enum(['env-flag', 'project-root']).nullable(),
    output: cliOutputModeSchema.nullable(),
    effectiveOutput: cliOutputModeSchema,
    outputSource: cliValueSourceSchema,
    color: cliColorModeSchema.nullable(),
    effectiveColor: cliColorModeSchema,
    /** `no-color`: a non-empty `NO_COLOR` outranks the stored key, as it does at a real start. */
    colorSource: z.enum(['stored', 'env', 'no-color', 'default']),
    logLevel: cliLogLevelSchema.nullable(),
    effectiveLogLevel: cliLogLevelSchema,
    logLevelSource: cliValueSourceSchema,
  }),
});
export type WorkspaceConfigResponse = z.infer<typeof workspaceConfigResponseSchema>;

/**
 * `PUT /api/v1/workspace/config` body — partial: absent keys stay untouched. A rejected workspace
 * root (not writable) 400s with the reason and persists NOTHING, resources included, so callers
 * may send both in one request only if they want that atomicity. Bounds mirror
 * `src/workspace/config.ts` exactly, so a value this schema accepts can never be degraded away by
 * the next load's `.catch`.
 *
 * THIS is what the route's `jsonZodValidator` middleware validates with (#677 wave 1); the server
 * declares no copy. The key ORDER is part of the wire behaviour and not cosmetic: a body with two
 * bad fields answers one `{ error }` string built by joining the zod issues in shape order, so
 * `resources` stays ahead of `agentDefaults` exactly as the deleted server copy had it.
 *
 * THE SHAPE IS STRICT AT EVERY LEVEL (#677 wave 2 B1 — review m1 and QA case H). It used to be a
 * plain `z.object` throughout, and only the MCP tool narrowed its own copy with `.strict()`. Two
 * asymmetries followed, and both answered 200 for a change that never happened: the route
 * accepted an unknown TOP-LEVEL key (`{ nonsenseKey: 123 }`) that the MCP door refused, and BOTH
 * doors accepted a misspelt NESTED key (`{ resources: { maxParalel: 9 } }`). A misspelt limit is
 * a caller's mistake, and a partial patch has no other way to tell them: the key they meant is
 * simply absent. Strictness belongs HERE rather than at either door, because this is the one
 * schema both of them validate with — which is what makes the two answers identical instead of
 * merely similar. No cockpit body carries an extra key at any level: every `putWorkspaceConfig`
 * call site sends a `SetWorkspaceConfigInput` literal.
 */
export const setWorkspaceConfigInputSchema = z.strictObject({
  browseRoot: z.string().trim().min(1).max(4096).optional(),
  projectsDir: z.string().trim().min(1).max(4096).optional(),
  skillsAutoUpdate: z.boolean().nullable().optional(),
  /** Stored Inbox override (F): `null` clears the key back to the `XEZ_FOLLOWUPS` default. */
  followups: z.boolean().nullable().optional(),
  /** Stored env-passthrough names (F): `null` clears the key back to the
   *  `XEZ_ENV_PASSTHROUGH` default; `[]` stores a real "forward nothing". */
  agentEnvPassthrough: z.array(z.string().trim().min(1).max(200)).max(64).nullable().optional(),
  composerDefaults: z
    .strictObject({
      autonomous: z.boolean().nullable().optional(),
      worktree: z.boolean().nullable().optional(),
    })
    .optional(),
  resources: z
    .strictObject({
      maxParallel: z.number().int().min(1).max(16).optional(),
      maxMonitoringSessions: z.number().int().min(0).max(16).optional(),
      monitoringWakeIntervalMinutes: z.number().int().min(1).max(60).nullable().optional(),
      autoResumeOnUsageLimit: z.boolean().optional(),
      /** `null` = never close an idle session; a number is minutes (1 to 1440). */
      idleTimeoutMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
      worktreeRetentionDefault: z.number().int().min(0).max(1000).optional(),
      /**
       * Concurrent gate runs allowed by the machine-wide gate lease (#672).
       *
       * A number is a stored choice, 1 to 16 — there is still no "unlimited" spelling, and 16 is
       * the way to say "never binds". `null` is NOT that third value: it CLEARS the key, the way
       * `followups` and `agentDefaults.runner` clear theirs, so the derived `DEFAULT_GATE_SLOTS`
       * applies again and nothing a user never chose is left on disk (#672 G4). A partial patch
       * has no other way to say "delete this key", and the cockpit's cleared Gate-slots field
       * means exactly that — never `0` (out of range) and never a materialised `1`.
       */
      gateSlots: z.number().int().min(1).max(16).nullable().optional(),
    })
    .optional(),
  /** Machine-wide agent defaults. `null` on a key CLEARS it back to "no opinion", which a bare
   *  absent key cannot say in a partial patch. */
  agentDefaults: z
    .strictObject({
      runner: runnerSchema.nullable().optional(),
      models: z
        .strictObject({
          claude: z.string().trim().min(1).max(200).nullable().optional(),
          codex: z.string().trim().min(1).max(200).nullable().optional(),
          opencode: z.string().trim().min(1).max(200).nullable().optional(),
          pi: z.string().trim().min(1).max(200).nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * The workspace-wide `cli` settings (#467, PR 5). LAST in the shape on purpose: the `{ error }`
   * string of a multi-issue body is built by joining zod issues in shape order, so adding a key
   * anywhere earlier would reword an existing two-bad-field message.
   *
   * `null` on any key CLEARS the stored key back to its environment variable and then the default
   * — the documented meaning `followups`, `skillsAutoUpdate` and `agentDefaults` already carry. A
   * key the body does not name, and a body that does not name `cli` at all, must leave the stored
   * value byte-identical on disk: `cli` is `.optional()` with no default in the workspace schema,
   * and materializing it on every write would turn "never chosen" into "chosen", which is the
   * distinction the whole tri-state rests on.
   *
   * `output`, `color` and `logLevel` joined `instance` by the owner's decision D-5 (2026-09-20):
   * the three presentation keys already live in the same stored object and are read at the same
   * moment — a start — so one section edits all four.
   */
  cli: z
    .strictObject({
      instance: instanceModeSchema.nullable().optional(),
      output: cliOutputModeSchema.nullable().optional(),
      color: cliColorModeSchema.nullable().optional(),
      logLevel: cliLogLevelSchema.nullable().optional(),
    })
    .optional(),
});
export type SetWorkspaceConfigInput = z.infer<typeof setWorkspaceConfigInputSchema>;

// ---- GUI prefs — the two open bags ----------------------------------------------------------

/** Settings → Appearance: accent + density + reading width. ONE shape for both ui-state files —
 *  per-repo (the legacy home, kept so an older xezar in the same repo still honours it) and
 *  workspace (`~/.xezar/ui-state.json`, its post-migration home). The server imports this schema
 *  for the per-repo route; never declare a second copy there (#424 step 4).
 *
 *  Every key is `.optional()` so an older ui-state.json parses unchanged, but each one must be
 *  listed HERE: the enclosing ui-state schemas are open at the top level only, so an unlisted key
 *  inside `appearance` is stripped by zod and then wiped from the file by the shallow
 *  merge-on-write. The cockpit adopts the PUT response as authoritative, so a stripped key does
 *  not merely fail to persist — it visibly reverts the control the user just touched. Adding an
 *  appearance preference means adding it here in the same change.
 *
 *  `density`: `roomy` is 5px per spacing unit, `comfortable` the 4px default, `compact` 3.5px,
 *  `ultra` ("Compact for real") 3px — the `:root[data-density]` blocks in the cockpit's index.css. */
export const appearanceSchema = z.object({
  accent: z.enum(['lime', 'violet']).optional(),
  density: z.enum(['roomy', 'comfortable', 'compact', 'ultra']).optional(),
  width: z.enum(['narrow', 'wide']).optional(),
});

const taskTableUiStateSchema = z.looseObject({
  /** Explicit user choices only. Missing ids keep the registry-owned default. */
  expandedColumns: z.record(z.string(), z.boolean()).optional(),
});

/**
 * `GET/PUT /api/v1/ui-state` — the per-repo GUI prefs in `.local/xezar/ui-state.json`.
 *
 * An OPEN bag on purpose (BACKWARD_COMPATIBILITY.md §3): unknown keys round-trip untouched, so a
 * newer cockpit's prefs survive an older server and a future pref needs no server change. Hence
 * `z.looseObject`, not a closed object — the keys below are the ones the server's schema *names*,
 * never the ones it *permits*. The write side caps the TOP-LEVEL key count at 200 (#429); that cap
 * is a request-body refinement in `src/server/server.ts` (`capUiStateKeys`, :756) and is not part
 * of the response shape.
 *
 * `notifications` is deliberately NOT here: it moved to `WorkspaceUiState` at step 3.5 and the
 * per-repo schema (src/server/server.ts:550) has not named it since. The hand-written DTO still
 * listed it, which made it wider than the route.
 */
export const uiStateSchema = z.looseObject({
  /** What the last started run used. `null` is a VALUE, not an absence: it records a run that
   *  chose neither a skill nor a workflow (the plain built-in `quick-task`), which the composer
   *  can now express since the source picker grew an empty state. Absent still means "no
   *  run has been recorded here" — a cockpit reading either one selects nothing. */
  lastTask: z
    .object({ source: z.enum(['workflow', 'skill']), ref: z.string() })
    .nullable()
    .optional(),
  /** Most-recently-run sources, newest first (deduped, capped). Feeds the composer picker's
   *  recency sort. */
  recentSources: z
    .array(z.object({ source: z.enum(['workflow', 'skill']), ref: z.string() }))
    .optional(),
  /** The last worktree choice for a single-skill run. Absent → the default (isolated worktree). */
  lastWorktree: z.boolean().optional(),
  /** The last autonomous choice — remembered like `lastWorktree`. Absent → off. */
  lastAutonomous: z.boolean().optional(),
  /** Whether new runs should ask agents to append follow-up work. Absent → on. */
  lastGenerateFollowups: z.boolean().optional(),
  /** Skill selection frequency (#408): name → times chosen, across BOTH composers. */
  skillUsage: z.record(z.string(), z.number()).optional(),
  runsView: z.enum(['list', 'table']).optional(),
  /** The GitHub tab's last-selected sub-tab (#417). Absent → issues. */
  githubView: z.enum(['issues', 'prs']).optional(),
  /** Settings → Appearance. The theme itself stays in localStorage (`xez-theme`) — it must
   *  pre-paint, and it is per-browser by design. */
  appearance: appearanceSchema.optional(),
  /** Follow-up prompt templates (#413). Absent → the built-in defaults; present (even `[]`) is
   *  the user's own edited list. `skills` are the skill names the template auto-applies for. */
  promptTemplates: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        text: z.string(),
        skills: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  /** The team skills promo banner (#391), dismissed for good. Legacy — the banner is
   *  gone, replaced by `WorkspaceUiState.importedSkills`; retained so old files round-trip. */
  dismissedSkillsBanner: z.boolean().optional(),
});
export type UiState = z.infer<typeof uiStateSchema>;

/**
 * `GET/PUT /api/v1/workspace/ui-state` — cross-project GUI prefs in `~/.xezar/ui-state.json`
 * (multi-project spec, step 2.7).
 *
 * The same open bag as its per-repo twin above, and open for the same reason. The PUT merges
 * SHALLOWLY at the top level server-side, so a writer must send the whole `sidebar` object (or the
 * whole `importedSkills` array), never a leaf.
 */
export const workspaceLastLocationSchema = z.strictObject({
  projectId: z.string().min(1).max(64),
  pathname: z.string().min(1).max(2048).startsWith('/p/'),
  search: z.string().max(4096).startsWith('?').optional(),
  hash: z.string().max(2048).startsWith('#').optional(),
});
export type WorkspaceLastLocation = z.infer<typeof workspaceLastLocationSchema>;

export const workspaceUiStateSchema = z.looseObject({
  /** LEGACY — the sidebar's per-project collapse map (step 3.3). Still accepted and still
   *  round-tripped so an older cockpit sharing this home keeps working, but the current cockpit
   *  neither reads nor writes it: which groups are shut describes the WINDOW, not the workspace,
   *  so it lives in that browser's localStorage (`packages/web/src/lib/sidebar-collapse.ts`).
   *  One shared answer meant a phone collapsing a group collapsed it on the desktop too. */
  sidebar: z
    .looseObject({ collapsed: z.record(z.string(), z.boolean()).optional() })
    .optional(),
  /** Dismissed runtime-auth incident IDs, keyed by provider. An ID is only dismissed until the
   *  provider reports a different incident, so this stays workspace-global with the browser
   *  rather than one project checkout. */
  dismissedProviderAuthFailures: z
    .object({
      claude: z.string().optional(),
      codex: z.string().optional(),
      opencode: z.string().optional(),
      pi: z.string().optional(),
    })
    .optional(),
  /** Settings → Appearance, GLOBAL since step 3.5: accent + density describe the person at the
   *  keyboard, not a repo. */
  appearance: appearanceSchema.optional(),
  /** Settings → Notifications, GLOBAL since step 3.5 — one answer for the whole workspace, since
   *  the delivering browser is one browser whichever project you are looking at. */
  notifications: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  /** Desktop Tasks-table density, shared across every project in this workspace. */
  taskTable: taskTableUiStateSchema.optional(),
  /** LEGACY, exactly like `sidebar` above — the last settled project-scoped page, restored when
   *  entering at the exact bare root. The shape is unchanged and still accepted, but the current
   *  cockpit keeps it in localStorage (`packages/web/src/lib/last-location.ts`): stored here, the
   *  last client to navigate decided where every OTHER client's next launch landed. */
  lastLocation: workspaceLastLocationSchema.optional(),
  /** The user's curated selection of default (vendor) skills. Tri-state: ABSENT means "not
   *  curated", so every default skill shows; a PRESENT array (even `[]`) means only those names
   *  show from that repo. */
  importedSkills: z.array(z.string()).optional(),
});
export type WorkspaceUiState = z.infer<typeof workspaceUiStateSchema>;

const WORKSPACE_UI_STATE_MAX_KEYS = 200;
const TASK_TABLE_MAX_COLUMNS = 50;

/**
 * `PUT /api/v1/workspace/ui-state` body. The response remains an open, tolerant bag so data from
 * a newer cockpit survives an older server; this write-side schema adds bounded known fields so
 * the current cockpit cannot grow the user-owned file without limit.
 */
export const setWorkspaceUiStateInputSchema = z
  .looseObject({
    ...workspaceUiStateSchema.shape,
    sidebar: z
      .looseObject({
        collapsed: z
          .record(z.string().min(1).max(64), z.boolean())
          .refine((map) => Object.keys(map).length <= WORKSPACE_UI_STATE_MAX_KEYS, {
            message: `sidebar.collapsed must have at most ${WORKSPACE_UI_STATE_MAX_KEYS} entries`,
          })
          .optional(),
      })
      .optional(),
    dismissedProviderAuthFailures: z
      .strictObject({
        claude: z.string().min(1).max(128).optional(),
        codex: z.string().min(1).max(128).optional(),
        opencode: z.string().min(1).max(128).optional(),
        pi: z.string().min(1).max(128).optional(),
      })
      .optional(),
    importedSkills: z
      .array(z.string().min(1).max(200))
      .max(WORKSPACE_UI_STATE_MAX_KEYS)
      .optional(),
    taskTable: taskTableUiStateSchema
      .extend({
        expandedColumns: z
          .record(z.string().min(1).max(64), z.boolean())
          .refine((map) => Object.keys(map).length <= TASK_TABLE_MAX_COLUMNS, {
            message: `taskTable.expandedColumns must have at most ${TASK_TABLE_MAX_COLUMNS} entries`,
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length > WORKSPACE_UI_STATE_MAX_KEYS) {
      ctx.addIssue({
        code: 'custom',
        message: `ui-state has too many keys (max ${WORKSPACE_UI_STATE_MAX_KEYS})`,
      });
    }
  });
export type SetWorkspaceUiStateInput = z.infer<typeof setWorkspaceUiStateInputSchema>;

// ---- per-repo agent knobs (`GET/PUT /api/v1/config`) ----------------------------------------

/** Per-runner default model preset (Settings → Agents): the composer preselects this model id for
 *  the runner. Absent = auto (the runner decides). Keyed by runner name rather than derived from
 *  `runnerSchema` because the server's own `defaultModels` object (src/config.ts:92) is spelled
 *  the same way — one key per runner, each independently optional. */
export const runnerModelsSchema = z.object({
  claude: z.string().optional(),
  codex: z.string().optional(),
  opencode: z.string().optional(),
  pi: z.string().optional(),
});
export type RunnerModels = z.infer<typeof runnerModelsSchema>;

/** `GET /api/v1/config` — every Settings → Agents knob in one read. */
export const configResponseSchema = z.object({
  baseBranch: z.string().nullable(),
  defaultRunner: runnerSchema,
  systemPrompt: z.string().nullable(),
  defaultModels: runnerModelsSchema,
  /** True when native coding-agent settings are authoritative and model picks are read-only. */
  modelsLocked: z.boolean(),
  /** How many tasks run at once (1–16). */
  maxParallel: z.number(),
  /** Per-task memory ceiling in MiB (whole process tree); null = no limit. */
  memoryLimitMb: z.number().nullable(),
  /** Keep the last N finished worktrees on disk (#483); 0 = unlimited. Older ones are reclaimed
   *  (directory only — branch kept, so work is recoverable). */
  worktreeRetention: z.number(),
  /** Live title updates: null = no config key, the `XEZ_TITLE_UPDATES` env default (ON) decides. */
  liveTitleUpdates: z.boolean().nullable(),
  /** Optional review gate (#489): null = no config key, the `XEZ_REVIEW_GATE` env default (OFF)
   *  decides. */
  reviewGate: z.boolean().nullable(),
  /** Model the chain planner runs on (Claude aliases only; other backends pick their own).
   *  Always materialized — the file schema defaults it to `sonnet` (E). */
  plannerModel: z.string(),
  /** Model the task namer runs on, same rule as `plannerModel`. Defaults to `haiku` (E). */
  namerModel: z.string(),
  /** Team skill sources (E). Always materialized: the file schema defaults it to the shared
   *  catalog, and `[]` is a real "no team skills" choice. */
  skillsRepos: z.array(z.object({ repo: z.string(), ref: z.string() })),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

/** The `PUT /api/v1/config` answer: the same shape GET serves (`configAnswer` builds both). */
export const setConfigResponseSchema = configResponseSchema;
export type SetConfigResponse = z.infer<typeof setConfigResponseSchema>;

/**
 * `PUT /api/v1/config` body (Settings → Agents; the Repo tab's base-branch picker).
 * `baseBranch: null` clears the setting back to "follow checked-out branch"; `systemPrompt` and
 * per-runner `defaultModels` entries clear on `null` (or `''`) too. Merged into the raw
 * config.json server-side — `defaultModels` merges per runner, so one write never clobbers
 * another runner's preset.
 *
 * THE route's own validator (`jsonZodValidator` middleware on `PUT /config`) and the MCP's
 * `project_config` `set_config` argument are both this schema — there is no second copy to drift
 * against, and `contract-parity.requests.test.ts` plus
 * `mcp/tools/project-config.request-parity.test.ts` pin both halves.
 */
export const setConfigInputSchema = z.object({
  baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
  defaultRunner: runnerSchema.optional(),
  /** The custom message is the WIRE text: `PUT /api/v1/config` answers
   *  `{"error":"systemPrompt: must be at most 20000 characters"}` and the cockpit renders it
   *  verbatim in a toast. It travelled with the schema when the route stopped declaring its own
   *  copy (#677 wave 1), so the 400 text is unchanged. */
  systemPrompt: z.string().trim().max(20_000, 'must be at most 20000 characters').nullable().optional(),
  defaultModels: z
    .object({
      claude: z.string().trim().max(200).nullable().optional(),
      codex: z.string().trim().max(200).nullable().optional(),
      opencode: z.string().trim().max(200).nullable().optional(),
      pi: z.string().trim().max(200).nullable().optional(),
    })
    .optional(),
  maxParallel: z.number().int().min(1).max(16).optional(),
  /** null or 0 clears the ceiling back to "no limit". */
  memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
  /** Keep last N finished worktrees (#483); 0 = unlimited, null clears back to the default (10). */
  worktreeRetention: z.number().int().min(0).max(1000).nullable().optional(),
  /** null clears the key back to the env-default behavior. */
  liveTitleUpdates: z.boolean().nullable().optional(),
  /** null clears the key back to the env-default behavior (OFF). */
  reviewGate: z.boolean().nullable().optional(),
  /** `null` clears the key back to the schema default (`sonnet`). */
  plannerModel: z.string().trim().min(1).max(200).nullable().optional(),
  /** `null` clears the key back to the schema default (`haiku`). */
  namerModel: z.string().trim().min(1).max(200).nullable().optional(),
  /** `null` clears the key back to the default catalog; `[]` disables team skills. */
  skillsRepos: z
    .array(
      z.object({
        repo: z.string().trim().min(1).max(500),
        ref: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .max(32)
    .nullable()
    .optional(),
});
export type SetConfigInput = z.infer<typeof setConfigInputSchema>;

// ---- skills updates (`/api/v1/workspace/skills-update`) --------------------------------------

export const skillsUpdateStatusSchema = z.enum([
  'idle',
  'checking',
  'available',
  'updating',
  'current',
  'unavailable',
  'error',
]);
export type SkillsUpdateStatus = z.infer<typeof skillsUpdateStatusSchema>;

export const skillsUpdateScopeStateSchema = z.object({
  scope: z.enum(['project', 'global']),
  status: skillsUpdateStatusSchema,
  available: z.boolean(),
  skills: z.array(z.string()),
  checkedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  reason: z.string().optional(),
});
export type SkillsUpdateScopeState = z.infer<typeof skillsUpdateScopeStateSchema>;

/**
 * The team-skills CATALOG version (#744) — a different mechanism from the `npx skills` state
 * above, and deliberately a separate block rather than a field on it. `up-to-date` and
 * `update-available` compare two commits of the same bare clone; `unknown` covers every
 * degraded case (no clone yet, an unresolvable ref, git unavailable) and is the zero-config
 * default on a cold machine, never an error.
 */
/**
 * `stale-check` is its own word rather than a shade of `unknown` (#747, design review B-1): the two
 * commits ARE known and identical, and what has aged past the passive-fetch window is the CHECK. A
 * reader told "version unknown" under two printed versions reads a contradiction, so the six-hour
 * policy stays in one place — `compareState` — and the surface gets a state it can name.
 *
 * `never-checked` is the same argument one step further (#752, code review M1 / design review B-1):
 * the two commits are known and identical, and this machine has NO successful upstream check on
 * record at all (`fetchedAt === null`, or a timestamp that cannot be read). Folding it into
 * `unknown` is what made a surface say "these two versions share no history" about one commit
 * compared with itself — `unknown` means the comparison genuinely could not be made (no clone, an
 * unresolvable ref, git unavailable, one side unreadable, two commits with no shared history), and
 * a state the server can name is what keeps the cockpit and the MCP `check_skill_updates` answer on
 * one source of truth instead of each re-deriving the cause from `fetchedAt` plus two shas.
 */
export const skillsCatalogStateSchema = z.enum([
  'up-to-date',
  'update-available',
  'stale-check',
  'never-checked',
  'unknown',
]);
export type SkillsCatalogState = z.infer<typeof skillsCatalogStateSchema>;

/** One commit of a skills catalog, ready to render as `<tag> (<shortCommit>, <date>)`.
 *  `tag` is absent — not null — when no tag is reachable, so `JSON.stringify` drops the key. */
export const skillsCatalogCommitSchema = z.object({
  commit: z.string(),
  shortCommit: z.string(),
  /** The commit date as `YYYY-MM-DD` (from git's `%cI`). */
  date: z.string(),
  /** The nearest reachable tag NAME — never `git describe`'s `v1.1.0-1-g769ebc7` form (#747,
   *  design review NB-1), which repeats the hash and only a git user can read. */
  tag: z.string().optional(),
  /** How many commits this one is after `tag`, so a surface can say it in words ("1 commit after
   *  v1.1.0"). Absent — not 0 — when the tag is exact, so `JSON.stringify` drops the key. */
  commitsSinceTag: z.number().int().optional(),
});
export type SkillsCatalogCommit = z.infer<typeof skillsCatalogCommitSchema>;

/**
 * One configured skills source and the two commits that answer "which catalog am I serving?".
 * `installed` is the commit the served catalog was listed at; `available` is the same clone's
 * head as of the last successful fetch — i.e. upstream as THIS MACHINE last saw it, never a
 * live upstream read (no new network path). `fetchedAt` is when that last fetch succeeded.
 */
export const skillsCatalogVersionSchema = z.object({
  repo: z.string(),
  ref: z.string(),
  state: skillsCatalogStateSchema,
  installed: skillsCatalogCommitSchema.optional(),
  available: skillsCatalogCommitSchema.optional(),
  fetchedAt: z.string().nullable(),
});
export type SkillsCatalogVersion = z.infer<typeof skillsCatalogVersionSchema>;

/** `GET /api/v1/workspace/skills-update` (and the check/apply POSTs) — the merged project+global
 *  skills-update state. `autoUpdateEnabled`/`inherited` are re-stamped from the workspace config
 *  on the way out (`skillsUpdateResponse`, src/server/server.ts:1818), and `catalog` is read
 *  there too (#744) — the service below knows nothing about the team-skills clone. */
export const skillsUpdateStateSchema = z.object({
  status: skillsUpdateStatusSchema,
  available: z.boolean(),
  autoUpdateEnabled: z.boolean(),
  inherited: z.boolean(),
  checkedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  scopes: z.array(skillsUpdateScopeStateSchema),
  needsUpgradeNotes: z.boolean(),
  catalog: z.array(skillsCatalogVersionSchema),
});
export type SkillsUpdateState = z.infer<typeof skillsUpdateStateSchema>;

// ---- provider auth (`/api/v1/providers/*`) ---------------------------------------------------

/** The agent backends are the providers — one alias, never a second enum. */
export const providerIdSchema = runnerSchema;
export type ProviderId = Runner;

/** Coarse host authentication state. Credentials, account identity, and raw CLI output never
 *  cross this boundary. */
export const providerConnectionStateSchema = z.enum([
  'connected',
  'disconnected',
  'not-installed',
  'unknown',
]);
export type ProviderConnectionState = z.infer<typeof providerConnectionStateSchema>;

/**
 * One provider row.
 *
 * `enabled` is OPTIONAL: `ProviderAuth.status()` (src/core/provider-auth.ts:12) builds rows
 * without it and only `applyProviderEnablement` stamps it in, so the type the routes answer keeps
 * the key optional. The hand-written DTO declared it required — narrower than the route.
 */
export const providerStatusSchema = z.object({
  provider: providerIdSchema,
  status: providerConnectionStateSchema,
  enabled: z.boolean().optional(),
  hint: z.string().optional(),
  authFailureId: z.string().optional(),
  /** Which agent account this row describes (spec 2026-07-29-agent-profiles). ABSENT on
   *  `GET /api/v1/providers/status`, which deliberately keeps answering exactly one row per
   *  provider — the discovered default — so an older client sees no change at all. Per-account
   *  rows are carried by `GET /api/v1/workspace/agent-profiles` instead. */
  profileId: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

/** `GET /api/v1/providers/status`, and the answer of the enabled/retry mutators. */
export const providerStatusResponseSchema = z.object({
  providers: z.array(providerStatusSchema),
});
export type ProviderStatusResponse = z.infer<typeof providerStatusResponseSchema>;

/**
 * `PUT /api/v1/providers/:provider/enabled` body (#677 wave 2 B4). One definition, validated by
 * the route as middleware and re-used by the MCP door's `set_provider_enabled` for its key set —
 * the two used to be a schema in `server.ts` and a hand-written twin would have been the second
 * copy AGENTS.md § The HTTP API forbids. Strict: an unknown key is a 400, not a silently dropped
 * field, because "the provider is off now" must never be answered for a body that said something
 * else.
 */
export const setProviderEnabledInputSchema = z.strictObject({ enabled: z.boolean() });
export type SetProviderEnabledInput = z.infer<typeof setProviderEnabledInputSchema>;

/**
 * `POST /api/v1/providers/:provider/retry` body (#677 wave 2 B4). `authFailureId` names the
 * incident the caller actually observed, so a stale retry cannot erase a rejection that arrived
 * after recovery began (`ProviderAuthService.clearRuntimeAuthFailure`).
 */
export const retryProviderInputSchema = z.strictObject({ authFailureId: z.string().min(1).max(128) });
export type RetryProviderInput = z.infer<typeof retryProviderInputSchema>;

/** `POST /api/v1/providers/connect` — either a terminal was handed the login command, or the
 *  provider turned out to be connected already. Every other outcome is a 409/500 carrying the
 *  same `command` for the clipboard fallback. */
export const providerConnectResponseSchema = z.discriminatedUnion('opened', [
  z.object({ opened: z.literal(true), command: z.string() }),
  z.object({ opened: z.literal(false), connected: z.literal(true), command: z.string() }),
]);
export type ProviderConnectResponse = z.infer<typeof providerConnectResponseSchema>;

// ---- host model catalog (`GET /api/v1/models`) -----------------------------------------------

/**
 * The runners whose model list is discovered from the host rather than hard-coded: Codex through
 * its app-server protocol, OpenCode through its own `models` listing (#794), Claude through the
 * CLI's `list_models` control request (#784), pi by reading its own `models.json` (#152). A
 * runner absent here has no discovery path and 400s, so the client compiles against exactly what
 * the route accepts. One definition, used by the route's query validator and by the cockpit's
 * picker.
 *
 * Every runner xezar ships is now listed. That is the invariant worth keeping rather than a
 * coincidence: a picker entry with no discovery falls back to hard-coded vendor ids, which is
 * how pi came to offer three models its host could not run (#152).
 */
export const modelDiscoveryRunnerSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);
export type ModelDiscoveryRunner = z.infer<typeof modelDiscoveryRunnerSchema>;
export const MODEL_DISCOVERY_RUNNERS: readonly ModelDiscoveryRunner[] =
  modelDiscoveryRunnerSchema.options;

/** True when `runner` has a host-discovered catalog (and therefore a `/models` answer). */
export function runnerDiscoversModels(runner: Runner): runner is ModelDiscoveryRunner {
  return (MODEL_DISCOVERY_RUNNERS as readonly string[]).includes(runner);
}

export const runnerModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});
export type RunnerModelOption = z.infer<typeof runnerModelOptionSchema>;

/** `GET /api/v1/models?runner=claude|codex|opencode|pi` — the models discovered from that runner's
 *  own host installation, plus how fresh the answer is. Never an error: an unavailable CLI
 *  degrades to `source: 'unavailable'` with a `reason`. */
export const runnerModelCatalogResponseSchema = z.object({
  runner: runnerSchema,
  models: z.array(runnerModelOptionSchema),
  source: z.enum(['live', 'cache', 'unavailable']),
  stale: z.boolean(),
  reason: z.string().optional(),
});
export type RunnerModelCatalogResponse = z.infer<typeof runnerModelCatalogResponseSchema>;

// ---- "Open in…" targets (`GET /api/v1/open-targets`) -----------------------------------------

/** A local app a worktree can be opened in (#open-in): editor, file manager, or terminal. */
export const openTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** A stable icon key (#361) the UI maps to a concrete icon. Optional: an older server omitting
   *  it just renders the generic fallback icon. */
  icon: z.string().optional(),
});
export type OpenTarget = z.infer<typeof openTargetSchema>;

/** `GET /api/v1/open-targets` — the detected local apps; empty in hosted mode (XEZ_REMOTE). */
export const openTargetsResponseSchema = z.object({
  targets: z.array(openTargetSchema),
});
export type OpenTargetsResponse = z.infer<typeof openTargetsResponseSchema>;

/**
 * `POST /api/v1/open-in` — open THIS PROJECT'S root in a detected app (Settings → the project
 * folder row). The path is never sent: it is the scoped project's own registered root, resolved
 * server-side, so the route has no traversal surface at all. `target` is an
 * `/api/v1/open-targets` id; unlike the run route there is no `default`/`cli:` handling, because
 * a repo root is a directory and an agent CLI belongs in a task worktree.
 */
export const openProjectInSchema = z.object({
  // A short bound (#429): matched against a downstream allowlist, so an app id is never long.
  target: z.string().trim().min(1, 'target required').max(200),
});
export type OpenProjectInRequest = z.infer<typeof openProjectInSchema>;

/** The 200 for the above — `opened` is a literal because every failure is a 409 with `{ error }`,
 *  so a `false` would be unreachable and would only invite a client to branch on it. */
export const openProjectInResponseSchema = z.object({
  opened: z.literal(true),
  path: z.string(),
});
export type OpenProjectInResponse = z.infer<typeof openProjectInResponseSchema>;
