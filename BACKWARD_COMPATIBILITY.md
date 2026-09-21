# Backward compatibility — protected surfaces

xezar is a published npm CLI (`@qodeca/xezar`, currently 0.x) whose state lives as plain files inside users' repos. Users upgrade with `npm install -g @qodeca/xezar@latest` against `.local/xezar/` directories written by older versions, and they script the CLI and hand-edit the files — the README promises "plain JSON, NDJSON and Markdown you can `cat` and fix by hand." That promise is the compatibility contract.

**Lineage (accurate, not renamed).** This tool shipped earlier under a different product name, Cezar, from three earlier npm identities: `@pat-lewczuk/cezar` (0.1.x), then the pre-rename scoped package with an unscoped `cezar-cli` alias (up to 0.10.1). Those packages still exist on the registry and are left exactly as they are. `@qodeca/xezar` 0.10.1 is the same codebase under a new product identity — see [The Xezar rename](#the-xezar-rename--a-deliberate-clean-break-0101) below. Historical package names in this document and in the CHANGELOG are provenance. Pre-rename issue numbers retained as historical evidence are written `pre-rename issue N`; a bare `#n` refers to `qodeca/xezar`.

**General rule for every surface below:** additive changes (new optional field, new flag, new route) are fine; anything that makes an existing input rejected, an existing output disappear, or an existing file unreadable is breaking. While the package is 0.x, a breaking change requires: a deprecation note in the README + CHANGELOG, a migration path (code that reads the old shape, or a documented manual fix), and a **minor** version bump called out as breaking. From 1.0 on, breaking = major bump.

## 1. CLI commands, flags and exit codes (`packages/xezar/src/index.ts`)

- **Bins:** `xezar` and `xez` (both in `package.json` `bin`). Removing either alias is breaking.
- **Commands:** bare invocation = `serve` (cockpit); `xezar run "<task>"`; `xezar init`; `xezar mcp` (the stdio MCP bridge a coding agent starts); `xezar server-install` / `server-deploy` / `server-uninstall` (the hosted-instance provisioner).
- **`xezar projects` subcommands:** `list` (the default), `add`, `remove`/`rm`, `tag`, `port`. `tag <id> [<tag>…]` replaces a project's grouping tags wholesale; naming none clears them. `port <id> [<port>]` (#467) pins the cockpit port of a project; naming none clears it. Both are refused in single-project mode.
- **Flags:** `-p/--port` (see the port precedence in [Remembered ports](#per-project-port-memory-and-cli-output-settings--deliberate-0160-467) — it is no longer "default 4321" flat, and it still auto-picks the next free port), `--output <auto|lines|rich>`, `--color <auto|always|never>`, `--log-level <debug|info|warn|error>`, `-q/--quiet` (all four #467: accepted and resolved now, consumed by the renderer), `--repo <dir>`, `--workflow <name>` (default `quick-task`), `--model <model>`, `--no-open`, `-h/--help`, `-v/--version` (prints the bare package version to stdout, exits 0, runs before any repo or `~/.xezar` lookup), `--single-project` (#600 — see [Single-project ROOT mode](#single-project-root-mode--the-folder-owns-the-state-0160-600); needed only the first time, and every command accepts it), `--instance <project|workspace>` (#467 — unreleased; ships in 0.17.0: WHICH projects' data one process serves, see [Instance mode](#instance-mode--which-projects-one-process-serves-0170-467); `workspace` is the default and is unchanged), `--global-layout` (#657 — unreleased; ships in 0.17.0; the explicit counterpart of `--single-project`: it resolves the GLOBAL layout for that launch even in a folder that carries `.xezar/workspace.json`, outranks the marker, and writes nothing), plus the `server-*` flags `--platform`, `--domain`, `--bind-host`, `--external-proxy`, `--yes`, `--reconfigure <name>`, `--reinstall`.
- **Exit codes:** `run` exits 0 on `done` **and** `review` (spec 009 — headless runs must not hang on the review gate), 1 on `failed`/`cancelled`/unknown workflow. CI scripts depend on this. A flag or `XEZ_*` value that is not a legal value exits 1 **before** the registry is read, the project writer is claimed or any port is bound, and names the accepted values.
- **Env vars:** `XEZ_DRY_RUN`, `XEZ_AGENT_MODELS_LOCKED`, `XEZ_APPROVAL_GATE`, `XEZ_FOLLOWUPS`, `XEZ_HIDE_TOKEN_USAGE`, `XEZ_HIDE_COST`, `XEZ_HIDE_TOKEN_METRICS`, `XEZ_CLAUDE_BIN`, `XEZ_CODEX_BIN`, `XEZ_OPENCODE_BIN`, `XEZ_PI_BIN`, `XEZ_AGENT_TMPDIR`, `XEZ_PORT`, `XEZ_OUTPUT`, `XEZ_COLOR`, `XEZ_LOG_LEVEL`, `XEZ_QUIET`, `XEZ_INSTANCE`, `NO_COLOR`, `GITHUB_TOKEN`. Every other `XEZ_*` variable documented in `.env.example` is also protected, except those under its testing / internal section; that file is the env contract’s single documentation surface (AGENTS.md § Zero config).
  - `XEZ_AGENT_TMPDIR` (pre-rename issue 785) is an **opt-out** for a changed default, not a new feature switch: spawned agents now receive `TMPDIR`/`TEMP`/`TMP` pointing at this run's own `.local/xezar/tmp/<runId>` instead of the host's values, which the least-privilege env used to forward verbatim. An exact `0` restores the host `TMPDIR` **and** skips the new pre-spawn writability check — the behaviour before pre-rename issue 785, not merely its environment, so a run that used to start still starts. Removing that opt-out, weakening it to cover only the variables, or changing which spelling disables it, is breaking and takes the deprecation path below. The host `TMPDIR` is still forwarded unchanged to every process xezar spawns that is *not* an agent session.

Breaking: renaming/removing a command, flag, alias or env var; changing a default (port, workflow); changing `run` exit-code semantics. Required path: keep the old spelling as a deprecated alias for at least one minor release, print a one-line deprecation warning, document the replacement.

## 2. HTTP API of the cockpit server (`packages/xezar/src/server/server.ts`)

**Every route lives under `/api/v1`.** The unversioned `/api/*` surface was REMOVED (see the breaking entry in CHANGELOG.md): the paths below are the real URLs; the project-scoped ones also answer at `/api/v1/p/<projectId>/<path>`. A future `v2` mounts beside `v1` rather than editing these paths.

Consumed by the bundled React cockpit (`packages/xezar/web/dist`, shipped in lockstep — low risk) and by anyone scripting `localhost:4321`. Saved bookmarklets do NOT call the API — since GitHub's CSP blocked cross-origin probes they only open a page URL (`packages/web/src/lib/bookmarklet.ts`), which is why removing the unversioned surface did not break them.

What is protected now: **the shape of each route under `/api/v1`**, the three-way scope aliasing, and the SSE event vocabulary. Removing or renaming a route, or changing a response shape, is breaking exactly as before. Routes:

- Static/GUI: `GET /` and every SPA shell route, `/new` (bookmarklet deep-link, query `?skill=&ref=&auto=&key=`), `/assets/:file`, `/xezar.svg`
- Meta: `GET /api/v1/health` (the **only** CORS-open route — bookmarklets probe it cross-origin; its shape `{version, latestVersion, channel, repoRoot, repo, checks, defaultRunner, forge, capabilities, projects, bootProject}` is the most externally-depended-on JSON in the app; `forge` is the boot project's forge classification and is `null` when the remote parses to no known host; `capabilities` gains the optional `instanceMode` of #467, sent ONLY when it is `project`, so a `workspace` payload is byte-identical to a 0.16.0 one and absent reads as `workspace`), `GET /api/v1/launch-key`
  - `repoRoot` is the absolute checkout path in local mode (the shape the saved bookmarklets read) but only the checkout's **basename** in hosted mode (`XEZ_REMOTE`), where health is CORS-open off the loopback and the absolute path would leak the developer's username (pre-rename issue 431). Always present, always a string — but a hosted consumer must not treat it as a filesystem path.
  - Additive for #442: `channel: "release" | "dev"`, top-level and always present (never under `capabilities`). `dev` means the server runs from a source checkout (its package root has `src/index.ts`); an installed tarball says `release`, and a failed check says `release` too. The cockpit badges its logo only for `dev`, and reads an absent field (an older server) as no badge. Every pre-existing health field stays byte-identical, and `version` is not suffixed.
  - Additive since the multi-project workspace: `projects: [{id, name}]` + `bootProject` enumerate the per-user registry (section 9). **`projects[].root` is deliberately absent** — health is the CORS-open route, and a per-project absolute path would reintroduce the pre-rename issue 431 username leak once per registered project; absolute roots live on the same-origin `GET /api/v1/projects` instead. Every pre-existing health field stays byte-identical; an unreadable registry degrades to `projects: []`, never an error.
  - Additive for #600: `capabilities.singleProjectRoot`, an **optional** boolean sent only when it is `true`. It says this cockpit is serving a folder that owns its own xezar state (`<project>/.xezar`, `~/.xezar` not opened). It is a SEPARATE key from `capabilities.singleProject`, which keeps its exact meaning and is not deprecated; a consumer that wants to know WHERE the state lives reads this one. It is the first optional capability, and deliberately so: a 0.15.0 server never sends it, so a 0.16.0 client must read an absent value as `false` (the global layout) rather than fail to parse. A global-layout 0.16.0 payload is byte-identical to a 0.15.0 one.
  - Additive for pre-rename issue 737: `capabilities.tokenUsageMetrics` and `capabilities.costMetrics` independently control raw input/output token and reported-cost presentation. Current servers always send both booleans; newer clients fall back to the legacy `tokenMetrics` value (and then visible) for older servers. `tokenMetrics` remains as the fail-closed combined value `tokenUsageMetrics && costMetrics`, so an older cockpit never reveals a dimension a deployment hid. All three flags are presentation-only — run and event telemetry remain unchanged.
- Workspace: `GET/POST /api/v1/projects`, `PATCH /api/v1/projects/:projectId`, `DELETE /api/v1/projects/:projectId`, `POST /api/v1/projects/checkout`, `GET /api/v1/fs/browse`, `GET /api/v1/models`, `GET /api/v1/providers/status`, `POST /api/v1/providers/connect`, `PUT /api/v1/providers/:provider/enabled`, `POST /api/v1/providers/:provider/retry` — the registered-project, filesystem, host model-catalog, and provider-authentication surface. The projects GET shape is `{projects: [{id, name, root, addedAt, lastOpenedAt, source, status, branch?, forge?, repoUrl?, maxParallel?, tags?}], bootProject, projectsDir}` (`status`: `ok`/`missing`/`not-git`; `branch` only when cheaply readable; `forge?` is the additive per-project forge classification (pre-rename issue 698) — `'github'` when the root's remote parses to a known forge host, omitted otherwise, so an old consumer that ignores it sees no change; `maxParallel?` is the additive per-project concurrency cap — omitted means "inherit the workspace cap", so an old consumer that ignores it sees no change; `repoUrl?` is the additive, credential-free web root of the project's remote (`https://github.com/owner/repo`, rebuilt from the PARSED remote so a token in it can never reach a client), which is what lets a cross-project surface link a reference the run knows only by number; `tags?` is the additive grouping-label list the global Tasks page filters and groups by — normalized (trimmed, deduped case-insensitively, sorted) and **omitted rather than `[]`** for an untagged project, so an old consumer that ignores it sees no change; `instance?` (#467, 0.17.0) is the additive DERIVED liveness answer `{state, url?}` described under [Instance mode](#instance-mode--which-projects-one-process-serves-0170-467) — checked per request, never read from the stored `lastListen` hint, and **omitted rather than null** when this server did not look, which is hosted mode). `PATCH /api/v1/projects/:projectId` is additive and **per-key**: body `{maxParallel?: 1..16 | null, tags?: string[] | null}`, each field applied ONLY when the body names it, so the pre-tags `{maxParallel}` body still means exactly what it always did and a tags-only body cannot clear a concurrency ceiling. `null` clears either (an empty `tags` array clears too); an empty body is refused with a 400, as it always was. The answer is `{project}` in the same entry shape. **The agent-account selection is deliberately NOT here** — it lives in `~/.xezar/agent-accounts.json` and is written through `PUT /api/v1/workspace/agent-profiles/selection`, so this route and the project registry are untouched by that feature. Same-origin only — no CORS, which is exactly what licenses the absolute `root`s that health must never carry. The list never 404s: an empty or unreadable registry answers `projects: []`.
  - **Narrowed by EITHER single-project narrowing (#600, part 3).** The five refusals this family
    has answered since 2026-07-21 — `POST /api/v1/projects`, `POST /api/v1/projects/checkout`,
    `PATCH /api/v1/projects/:projectId`, `DELETE /api/v1/projects/:projectId` and
    `GET /api/v1/fs/browse`, each `409 {error}` before any side effect — now fire for
    `XEZ_SINGLE_PROJECT=1` **or** a folder that owns its own xezar state. The CONDITION widened; the
    EFFECT did not. With the environment flag set, the status code, the `{error}` shape and the
    sentence (`single-project mode is enabled; <action> is disabled`) are byte-identical to what they
    have always been, and `packages/xezar/src/server/single-project-doors.test.ts` pins them. The
    state layout refuses with its own sentence (`this project owns its xezar state; <action> is
    disabled`), because claiming a flag is enabled in a folder that carries none would be untrue; the
    status and shape are the same. `GET /api/v1/projects` is narrowed the same way and answers
    exactly ONE row — the folder — whatever a committed `workspace.json` names; rows for other roots
    are ignored on read and never edited or deleted. Breaking: changing either status, either
    sentence or the `{error}` shape; letting any of the five apply an effect in either narrowing; or
    answering more than one project row in the state layout.
- Agent accounts (additive): `GET/POST /api/v1/workspace/agent-profiles`, `PATCH /api/v1/workspace/agent-profiles/:id`, `DELETE /api/v1/workspace/agent-profiles/:id`, `PUT /api/v1/workspace/agent-profiles/selection` — extra config dirs for a second login of the same agent CLI (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `PI_CODING_AGENT_DIR`; pi joined on 2026-09-12, #329 — the entry that said it had no such variable was wrong). Workspace-level and single-mount. `GET` answers `{editable, profiles: [{id, provider, label, configDir, path, exists, looksValid, isDefault, status?, files}], profileCapableProviders, selections, defaults}` (`files` is that agent's user-scope config files resolved inside THAT account's folder). **`status` is absent until the probe has warmed** and the listing never spawns a CLI to fill it — each probe is a shell-out to an agent CLI, one per provider plus one per account, which cost 2.5s on a real machine with four accounts. Absent means "not determined yet", which is NOT the same as the `unknown` a real probe can return; `GET …/:id/status` (optionally `?refresh=1`) is what actually probes, and the cockpit fills each row in from it. Provider auth for every account is warmed once at boot and kept in memory; reads are stale-while-revalidate (an expired answer is refreshed behind the response, never in front of it), a connected answer stands for minutes and a not-connected one is re-checked within a minute so a terminal login is noticed, the run gate re-verifies a provider before refusing, and anything xezar can observe (opening a login, repointing/removing an account, a runtime rejection) invalidates it explicitly, discovered defaults first (`id: "default"`, never stored, never deletable); `selections` maps a project's realpath'd ROOT to `{claude?, codex?, opencode?, pi?}`, and `defaults` is the same per-provider shape read as the machine-wide fallback for any repo that has chosen nothing (a repo's own selection always wins, which is what keeps it a default rather than an override). **Writing is a local-machine capability**: every mutator answers 409 in hosted mode (`XEZ_REMOTE`) and `GET` answers `{editable: false, profiles: [], selections: {}, defaults: {}}` there — the listing echoes absolute paths carrying the username, the same disclosure `/api/v1/health` trims. `DELETE` is deregistration only: the directory is never touched, and every selection referencing the removed id is scrubbed in the same atomic write.
  - Per-account reads: `GET /api/v1/workspace/agent-profiles/:id/status`, `GET /api/v1/workspace/agent-profiles/:id/details` and `POST /api/v1/workspace/agent-profiles/:id/open`. Both address the DISCOVERED account as `default:<provider>` (a bare `default` cannot say which agent, and that spelling is reserved by the selection routes). `details` answers `{available, reason?, fields: [{label, value}]}` read from the account's own files — Claude's `.claude.json` `oauthAccount`, Codex's `auth.json` `id_token` claims, and (additive, 2026-09-12, #329) pi's `auth.json` provider KEYS plus each entry's `type`, since that file carries no identity at all and its non-secret credential metadata is the only thing that tells two pi accounts apart — by **named field only**: the same files hold API keys and refresh tokens, and nothing is passed through, spread or stringified from a parsed vendor object. The per-provider answer is an exhaustive `Record<ProviderId, …>`: before #329 an unnamed provider fell through to OpenCode's "login lives outside the config folder" refusal, so a pi account was answered with a sentence about a different product. It is a SEPARATE route rather than a field on the listing on purpose, so identity is absent from the page until a user asks for it; it is never logged and never persisted. `open` takes `{file, target?}` where `file` is a **catalog id** from that account's own `files` (or the keyword `folder`) — never a path, so the route has no traversal surface — and `target` an `/api/v1/open-targets` id, absent meaning the OS default handler. A file the agent has not written yet answers 409 rather than a false success. Both are localHandoff-gated like the rest of the family.
  - **State file:** `~/.xezar/agent-accounts.json`, deliberately NOT a key in `config.json`. Its own file is what makes a xezar downgrade safe: a version that has never heard of accounts does not open it, so it cannot drop them — whereas living in `config.json` made their survival depend on a `.passthrough()` in that version's schema, and failed outright whenever any version could not parse `config.json` (it degrades to defaults, and its next merge-write persists them). Accounts written by the branch that first shipped them inside `config.json` are imported once, non-destructively: `config.json` keeps its keys so an older xezar sharing the home reads what it always read.
  - `GET /api/v1/providers/status` is UNCHANGED: it still answers exactly one row per provider — the discovered default. Its rows gained an optional `profileId`, which that route never sends; per-account rows are carried by the agent-profiles listing instead. `POST /api/v1/providers/connect` accepts an additive optional `profileId` (absent = the default account).
  - **OpenCode native configuration detection:** response shapes and state values are unchanged. After a valid zero-credential `opencode auth list` result, the probe also runs `opencode models`. A successful recognized model listing yields `connected`; an empty listing yields `disconnected`; failed, malformed or timed-out discovery yields `unknown`. `connected` is preflight configuration evidence, not proof of reachable inference or valid credentials for every model. A runtime authentication failure still overrides it. With a configured model and no runtime rejection, Connect returns the existing `{opened: false, connected: true, command}` response without launching a terminal. CLI output and model IDs are not added to the provider-status payload.
- Workspace settings: `GET/PUT /api/v1/workspace/config` — the settings slice of `~/.xezar/config.json` (section 9), shape `{browseRoot, projectsDir, skillsAutoUpdate, effectiveSkillsAutoUpdate, followups, effectiveFollowups, agentEnvPassthrough, effectiveAgentEnvPassthrough, resources: {maxParallel, maxMonitoringSessions, monitoringWakeIntervalMinutes, autoResumeOnUsageLimit, idleTimeoutMinutes, memoryLimitMb, memoryLimitDefaultMb, worktreeRetentionDefault}, composerDefaults, agentDefaults, cli}`; `agentDefaults` (additive) is `{runner?, models?: {claude?, codex?, opencode?, pi?}}` — the machine-wide agent and model defaults a repo that set none of its own falls back to, with BOTH keys optional on the wire because absent has to stay distinguishable from a value someone chose, and `null` on a PUT key clearing it back to "no opinion"; the project registry stays on `/api/v1/projects` and `schemaVersion` (a migration cursor, not a setting) is deliberately never carried. PUT is partial — absent keys stay untouched, `skillsAutoUpdate: null` clears the stored override, and the accepted bounds mirror the workspace schema exactly so an accepted value can never be degraded away by the next load. Four keys are additive: `resources.idleTimeoutMinutes` (1–1440, or `null` = never close an idle session; default 15, the value `IDLE_TIMEOUT_MS` used to hard-code), the read-only `resources.memoryLimitDefaultMb` (this host's derived ceiling, reported so the pane can name it), and the tri-state `followups` / `agentEnvPassthrough` pair, whose `null` clears the key back to the `XEZ_FOLLOWUPS` / `XEZ_ENV_PASSTHROUGH` env default and whose `effective*` twins report what the two resolve to right now. `agentEnvPassthrough: []` is a real stored "forward nothing" and is deliberately NOT a clear. All four take effect without a restart through the same semaphore refresh a `resources` change already fires. **`cli` is additive and is the one key of this route that does NOT** (#467, 0.17.0): the response carries, for each of the four stored keys `instance`, `output`, `color` and `logLevel`, the stored value (`null` = no stored key), what it plus its variable plus the built-in default resolve to for the next plain start (`effectiveInstance`, `effectiveOutput`, `effectiveColor`, `effectiveLogLevel`) and which layer decided (`instanceSource`, `outputSource`, `logLevelSource`: `stored` / `env` / `default`; `colorSource` adds `no-color`, because a non-empty `NO_COLOR` outranks a stored colour at a real start) — plus two answers about THIS process: `inForce`, which is `narrowed` when `XEZ_SINGLE_PROJECT` or a folder that owns its xezar state has narrowed it, and `narrowing` (`env-flag` / `project-root`, `null` unless narrowed), which says which of the two. Every field is REQUIRED on the wire, like `composerDefaults` and `resources`. PUT accepts `cli: {instance?, output?, color?, logLevel?}`, each a value of its vocabulary or `null`, and nothing else at that level; `null` clears that stored key back to the env chain, an emptied `cli` object is removed rather than stored as `{}`, and a key the body does not NAME — or a body that does not name `cli` — is left untouched on disk: materializing it on an unrelated write would turn “never chosen” into “chosen”, which is the whole of the tri-state. Every key was settled at boot, so no refresh is fired and no restart-free change is implied. Breaking: making `cli` or any of its fields optional or nullable beyond the stored values, answering `inForce` from the stored value instead of what is in force, dropping `narrowing` or the `…Source` fields, storing a value for `null`, or touching a `cli` key on a write that did not name it. **Folder writability contract**: changed `browseRoot` and `projectsDir` values are validated before persistence, never at load — `~` is expanded, the browse root must already be a directory, while the checkout root uses `mkdir -p`; both then get a real create/delete write probe (`W_OK` alone can lie on read-only mounts). Any failure answers `400 {error}` with **nothing persisted**, and on success the value is stored as the user wrote it (`~` kept). A `resources` change takes effect without a restart (the shared workspace semaphore refreshes its cache and pumps every project's run queue).
- Skills updates: `GET /api/v1/workspace/skills-update`, `POST /api/v1/workspace/skills-update/check`, `POST /api/v1/workspace/skills-update/apply` — additive workspace-level state/check/mutation surface for tracked `qodeca/xezar-skills` installations. The browser supplies only a validated `projectId`; executable names, arguments, paths, skill names, sources, and scopes are never accepted. Unknown projects answer 404, gone roots answer 409, and an owned update lock answers 409 with the latest safe state.
  - **Deliberate semantic change (multi-project workspace)**: `maxParallel` is workspace-global from here on. The per-repo key in `.xezar/config.json` was imported **once** by migration 001 (section 9) and is thereafter ignored by enforcement (`packages/xezar/src/workspace/semaphore.ts` consults the workspace `resources` plus each registry entry's own `maxParallel`); `GET/PUT /api/v1/config` still parses and writes it so older xezars sharing the repo keep working, but the running cap is the workspace's. The migration is the required path — no user action, no deleted keys.
  - **Deliberate semantic change (B2), narrowing the one above**: the per-repo `memoryLimitMb` is **honoured again**. It had become the one outcome a setting must never have — it saved successfully and then did nothing. The workspace ceiling remains the default; a repo that sets its own now overrides it for runs in that repo, resolved by `WorkspaceSemaphore.projectMemoryLimitMb(repoRoot)`, which is the same more-specific-wins lookup `projectMaxParallel` already uses. This is additive: a repo that sets nothing is unchanged, and the route's accept-and-write behaviour promised above is preserved rather than withdrawn. `PUT /api/v1/config` now refreshes the semaphore snapshot so the write applies without a restart.
  - **Additive (E)**: `GET/PUT /api/v1/config` gained `plannerModel`, `namerModel` and `skillsRepos`. All three were already in the file schema and are always materialized in the answer (the schema defaults them to `sonnet`, `haiku` and the shared catalog); on PUT, `null` clears each back to its default, while `skillsRepos: []` is stored as a real "no team skills" because `gatedSkillsRepos` reads the key's PRESENCE. #677 C2 adds to the same route: the answer gained an always-present boolean `projectModelsLocked` (this project's own key, beside the effective `modelsLocked`), and PUT accepts `modelsLocked`, where `true` stores the key and `false` or `null` delete it rather than storing `false` (section 3).
- `GET/PUT /api/v1/workspace/ui-state` — the global GUI-state twin of `/api/v1/ui-state`, backed by `~/.xezar/ui-state.json` (section 9): same `.passthrough()` + top-level key cap + shallow merge-on-write semantics as the per-repo route (one shared parse path in the code), so unknown keys survive round-trips; a bad body is `400 {error}` and never a partial write. The optional `lastLocation` object (bounded `{projectId, pathname, search?, hash?}`) and the `sidebar.collapsed` map are **legacy but still accepted**: both describe the browser rather than the workspace, so the cockpit moved them into localStorage — one shared answer meant the last client to navigate decided where every other client's next launch landed, and whose sidebar groups were shut. The keys stay named, bounded and round-tripped so a cockpit from before that change keeps working; nothing in the current cockpit reads or writes them, and a file that still carries them is untouched.
- `GET /api/v1/workspace/runs-index` — the cross-project task finder behind ⌘K, workspace-level and never mirrored under `/api/v1/p/`. Answers `{runs, perProjectLimit, truncated, referenceStatuses}` where each run is the deliberately SLIM `{projectId, id, title, titleSummary?, titleOrigin?, status, activity?, createdAt, finishedAt?, seenAt?, archived, autoResumeAt?, workflow, runner, runnerInherited?, model?, stepBackends?, branch?, startedAt?, pullRequestUrl?, referencedPullRequestUrl?, prNumber?, issueNumber?, referencedIssueUrl?, markerRefs?, costUsd?, peakRssBytes?, peakProcCount?, usage?}` — not `RunRecord`, whose `steps[]` multiplied by the registry is what this shape exists to avoid; adding a field is additive, swapping in the fat record is not. Archived runs are included — the project-scoped `GET /runs` has always carried them, and dropping them here would make a task findable only while you stand in its project — and each project contributes at most `perProjectLimit` of its newest, with `truncated` naming the projects that hit the cap so a consumer never has to present a capped list as a complete one. Reading it is **side-effect free by contract**: a project this process does not already own is read straight off `runs.json`, never through a built context, because building one prunes worktrees and resumes interrupted runs — a search box must not restart agents. Live-looking rows from a crashed process therefore read as interrupted here exactly as they would once the project were opened (both readers share `reconcileLoadedRun`). An unreadable workspace or a corrupt per-project index degrades to fewer rows, never a 500. `referenceStatuses` is additive and free: a `{projectId: {prs, issues}}` map of what the server ALREADY had cached for the references its rows carry, read from cache only so the route never touches `gh` and never slows down. A project with nothing warm is absent rather than present-and-empty — absent means "nothing is known", the same rule as `/github/ref-status`, and `GET /github/ref-status` remains the route that actually goes and looks. `runner` is RESOLVED server-side — the record's own `runner` (which the engine writes at run start, so it is what actually ran), else the last step that recorded a backend, else that project's current `defaultRunner` — because rows span projects and the browser would otherwise need one config request per project. `runnerInherited: true` is present only in that last case, which means the run has not started and the value is what it WOULD run as rather than history; `model` is the recorded string VERBATIM and absent means none was recorded; `stepBackends` is the COUNT of distinct backends the run's steps used, present only when greater than 1 — a derived number precisely so `steps[]` can stay off this row. In `project` mode (#467) it answers for THIS project only — a deliberate NARROWING of a cross-project answer, named here as one: a row this process refuses to open would be a search result that cannot be followed, and the cockpit reaches the other projects through their own cockpits instead. The default `workspace` mode is unchanged. Breaking: mirroring it under `/api/v1/p/`, removing a run field, resolving `runner` client-side, letting the read build project contexts, or letting it fetch from the forge.
- Skills: `GET /api/v1/skills`, `GET /api/v1/skills/importable`, `POST /api/v1/skills/refresh`
  - **Deliberate shape change (#771, 0.17.0)**: `POST /api/v1/skills/refresh` answers `{skills, sources}` instead of the bare `Skill[]`. `skills` is byte-identical to what the array always was; `sources` is one outcome per configured team-skills source, in configuration order, and empty when the project configures none. It is a DISCRIMINATED union and the discriminant is part of the contract: `{repo, ok: true}` carries no `reason`, and `{repo, ok: false, reason}` always carries one — a failure with no reason and a success with a reason are both refused by the schema, so no reader has to invent fallback text. The array could not say whether a refresh had actually happened — an unreachable origin and an up-to-date one were the same 200 — so the cockpit reported success for a fetch that never ran while the catalog block below it still read `Check is stale`. A caller that wants the old value reads `.skills`. The shipped cockpit and the MCP `project_config:refresh_skills` action moved with it in the same commit; `refresh_skills` keeps its `skills` key and gains `sources`. Breaking: dropping `sources`, reporting a source it did not reach OR could not LIST as `ok`, widening either branch of the union, or letting `reason` carry more than one line.
- Workflows: `GET/POST /api/v1/workflows`, `DELETE /api/v1/workflows/:name`, `POST /api/v1/workflows/parse`, `POST /api/v1/plan`
- Automations: `GET/POST /api/v1/automations`, `GET/PUT/DELETE /api/v1/automations/:id`, `POST /api/v1/automations/:id/{enable,pause,check}`, `GET /api/v1/automation-checks/:checkId`, `GET /api/v1/automation-log`, `POST /api/v1/automation-log/:receiptId/retry` — present always, but **gated** on `XEZ_AUTOMATIONS=1` (pre-rename issue 801, off by default): every route above answers `409` naming the flag, reads included. Unlike the inbox's `200 []` degradation, an off automations read refuses rather than answering empty — `{automations: []}` would read as "you have configured none", and a client would then offer to create one against a `409`ing POST. The routes themselves must keep existing and must behave exactly as before once the env flag is on.
- Runs: `GET/POST /api/v1/runs`, `GET /api/v1/runs/:id`, `PATCH /api/v1/runs/:id`, `PATCH/DELETE /api/v1/runs/:id/queued-messages/:msgId`, `POST /api/v1/runs/:id/{cancel,messages,finish,continue,open-in-cli,open-in,pr,archive,pin,read,unread,remove-worktree,git/commit,git/push}`, `POST /api/v1/runs/{archive-finished,read-all}`, `DELETE /api/v1/runs/:id`, `DELETE /api/v1/runs/:id/auto-resume`, `GET /api/v1/runs/:id/{handoff,diff,changes,files,commits,events,version}`, `GET /api/v1/runs/:id/commit/:sha`, `GET /api/v1/runs/:id/images/:file`
  - **Stale-write guard (#250, additive).** Every route that mutates ONE run — `PATCH /runs/:id`, `PATCH/DELETE /runs/:id/queued-messages/:msgId`, `POST /runs/:id/{cancel,messages,finish,continue,pr,archive,pin,remove-worktree,git/commit,git/push}`, `DELETE /runs/:id` and `DELETE /runs/:id/auto-resume` — and `POST /groups/:groupId/pick`, whose token is the kept variant's (`runId`, #271), accepts an OPTIONAL `expectedVersion` in its JSON body: the opaque token `GET /api/v1/runs/:id/version` answers as `{version}`. When it is sent and the run has changed since that token was read, the route answers `409` with `{status: "conflict", applied: false, error: "stale_version", resource: {kind: "run", id}, currentVersion?, changedSince: true, guidance}` and applies nothing; a malformed token (empty, over-long) is the usual `400 {error}`. When it is ABSENT the route behaves exactly as it always did — no check, same answers — and the routes that took no body still take none, so every existing caller, the cockpit included, is unchanged. The MCP tools are the callers that send it, and they require it. `GET /api/v1/runs/:id/version` is a read with no side effect; the token's format (`rev1:…`) is not part of the contract and a client must never parse, order or construct one. Breaking: making `expectedVersion` required on any of these routes, changing the rejection's status or keys, or putting a token into an existing response shape.
  - **Attachments widened, not renamed (pre-rename issue 950).** The `images` key on `POST /runs`, `POST /runs/:id/messages`, `PATCH /runs/:id/queued-messages/:msgId` and `POST /runs/:id/continue` still carries `{mediaType, data}` entries, and every `image/*` type it ever accepted is still accepted — the element schema only ADDS `application/pdf`, `text/plain`, `text/markdown` and `text/x-markdown`. A client that sends what it always sent sees no change; one that sends a PDF to an older xezar gets the 400 it always would. Two refusal STRINGS widened with it (`too many queued images` → `too many queued attachments`, `… at least one image` → `… at least one attachment`); the statuses and the `{error}` shape are unchanged. `GET /api/v1/runs/:id/images/:file` keeps its path and answers an image byte-identically, headers included; a non-image attachment is the additive case and leaves with its own content type plus `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, because it is user-supplied bytes coming back from the cockpit's own origin.
  - `POST /api/v1/runs/:id/pin` (pre-rename issue 935, additive) pins one task to the top of its project's list, or unpins it. Body `{pinned?: boolean}` with the archive route's exact semantics: an absent or empty body pins, `{pinned: false}` unpins, a wrong-typed `pinned` is a 400 and an unknown run a 404. The answer is the updated `RunRecord`, so there is no new response shape and no new SSE event — the change rides the existing `run` event. Archiving a run unpins it implicitly (see section 3), because archiving is how a user resigns from a task.
  - **The materializing window is now `active` (#200), so four routes 409 slightly more often.** A Continue enrols its run in the engine's `starting` registry for the width of `rematerializeReclaimedWorktree` — one microtask when the worktree is still there, a whole `git worktree add` when retention had reclaimed it — and `isActive()` covers `starting`. Inside that window `POST /runs/:id/pr`, `POST /runs/:id/remove-worktree`, `DELETE /runs/:id` and `POST /groups/:groupId/pick` answer `409` where they previously proceeded. Every one moves in the safe direction — `remove-worktree` could previously delete a tree a continuation was re-materializing under itself — and the window is the same one that made such a run uncancellable, so it is a narrowing of a bug rather than of a contract. Statuses and bodies are unchanged. In the same window `POST /runs/:id/cancel` now answers `{cancelled: true}` where it answered `{cancelled: false}`: the cancellation IS delivered now (the run's body consumes it and stops before spawning), so `true` is the honest value and `false` was the wrong one. The response SHAPE is unchanged, so this is not a break under the rule below — but a script reading `cancelled: false` as "there was nothing to cancel" will now see `true` for a run it caught mid-Continue.
  - **A variant group, or a reclaim candidate, whose worktree is not this project's own is refused (#288).** `GET /groups/:groupId` and `POST /groups/:groupId/pick` answer the existing `404 {error: "not found"}` for a group with ANY member whose recorded `worktreePath` is not `<project root>/.local/xezar/worktrees/<that run's id>`, or is reached through a symlink — the shape a copied or hand-edited `.local/xezar` produces, and the path the read runs git in and the pick deletes. `POST /worktrees/reclaim` (and the boot, project-open and task-end sweeps that share its enforcer) leaves such a record out of the sweep: not reclaimed, not counted against the keep-limit, not stamped. xezar writes every worktree path itself at exactly that location, so no group or task it created changes answer; statuses and bodies are unchanged. A narrowing in the safe direction, like the one above.
  - **A run whose worktree is not this project's own is refused by the routes that act on it (#316).** `DELETE /runs/:id`, `POST /runs/:id/{remove-worktree,git/commit,git/push,pr}` and `GET /runs/:id/{diff,changes}` answer `409 {error}` for a run whose recorded `worktreePath` is not `<project root>/.local/xezar/worktrees/<run id>`, or whose directory there is reached through a symlink — the rule reclaim uses (#288), through the same function. The `error` is one fixed plain sentence (the worktree is outside this project, xezar will not touch it, archive the task to move it out of the list) that names no path, id or project; the cockpit shows it as is. An id the project does not hold still answers `404 {error: "not found"}`. Before, these routes deleted, committed in, pushed from or ran `git add -N .` in whatever directory the record named. A run with no `worktreePath`, or whose worktree directory is already gone, answers exactly as before. xezar writes every worktree path itself at exactly that location, so no task it created changes answer. Such a stray record can no longer be deleted through `DELETE /runs/:id`, because deleting it is what ran `rm -rf` on the other directory; `POST /runs/:id/archive` still works on it. A narrowing in the safe direction, like the one above.
  - **Reviewer verdicts on the run (#460, additive).** `GET /api/v1/runs` and `GET /api/v1/runs/:id` — and therefore every route answering a `RunRecord`, plus the MCP `task_read view=task` that dispatches into them — carry two optional keys: `verdicts` (at most one reviewer report per role, so at most three) and `verdictIssues` (reports the engine refused, bounded). Absent on every run that had no reviewer step and on every record written before this, and **absent is not an approval**. A verdict is `{id, taskId, stepId, role, verdict, reviewedHeadSha, summary, recordedAt, evidenceUrl?, labels, findings?, findingsOmitted?, source, ingestedAt, publication}`; `role` and `verdict` are a DISCRIMINATED pair (`code-review` → `APPROVE`/`REQUEST CHANGES`, `qa` → `PASS`/`FAIL`, `design-review` → `PASS`/`PASS WITH FOLLOW-UPS`/`FAIL`), and flattening them onto one shared enum is breaking, not a simplification. `source` is `task-reported` — the packet says what a reviewer SAID, and no route here reads or writes a forge. The full rules, including the absent-vs-empty label evidence and the two-step `publication`, are in section 3. `findings` and `findingsOmitted` are the machine-readable half of the review (#673, additive): an optional PAIR — both keys or neither — where `findings` is at most 20 entries of `{id, severity, file?, line?, title, body?, fingerprint?}` and `findingsOmitted` counts what did not fit, `0` when the list is complete. Absent `findings` means the reviewer reported none IN THIS FORM; it is neither "there were no findings" nor an approval, exactly as an absent `verdicts` array is neither. `severity` is declared per role like `verdict` is (`blocker`/`major`/`minor`/`nit` for all three today) and `TASK_VERDICT_SEVERITY_ORDER` is the one derived reading of it. A finding REFUSES a key it does not know rather than stripping it — deliberately louder than the packet's own arms, because a silently stripped key is exactly how a producer-invented `findings` reached nothing before this; a newer producer meeting an older engine is therefore refused by name instead of losing the field. The MCP `task_create` action `start` reads those findings back through an optional `fromFindings` argument (#673, additive): `{runId, ids, role?}` names a reviewing task and the finding ids to build the task text from, and the text it renders names, per report, the engine the reviewing STEP ran on — the step the verdict itself names, not the task's own backend, which is a different pair on any chain that mixes backends per step. Every finding's `title` AND its `file` are rendered as one line, and its `body` as an indented quote block under its own numbered item, so nothing a reviewer wrote — a path included — can render as a sibling item, a heading or a free-standing paragraph; and when the selected report's `findingsOmitted` is above zero the text carries one line saying how many findings the reviewer left out. It is an ARGUMENT of the existing action, not a new action, so the audit inventory, the creation path and every other refusal are unchanged, and an omitted `fromFindings` behaves exactly as before. Because the tool's arguments are a strict object, an OLDER xezar meeting a caller that sends `fromFindings` refuses the call BY NAME with a schema error rather than ignoring the key and starting a task from an empty brief — loud and correct, and the same direction a finding's own strict shape already fails in. Four refusals are part of this surface rather than an implementation detail: a reviewing task that is unreadable, absent or archived; a task that carries no report of the requested kind; an id the task does not record (the whole call is refused, listing the missing ids, never a shorter brief); and a requested backend-and-model pair equal to a reviewing step's own, which is refused with both pairs named. That last refusal covers the task's own pair AND every agent step of an inline chain at its effective pair, and it resolves both sides through the engine's one canonical model identity (`model-identity.ts`, #405), so `opus`, `anthropic/opus` and `Opus ` compare equal. The reviewing side is the pair the reviewing STEP was named with; the record's task-level `modelIdentity` is deliberately NOT consulted, because the engine re-writes it on every agent spawn and it therefore describes whichever step ran last rather than the step the verdict names. It remains a NAME check: a tier alias and the pinned id it currently resolves to (`opus` and `claude-opus-5`), or a context-window variant (`opus[1m]`), are different names and are NOT collapsed — nothing in the engine maps them (`claude-model-catalog.ts` deliberately does not surface a CLI-resolved id), so a private mapping here would be a second source of vendor truth that goes stale. Name a different backend when independence has to be certain rather than merely stated. No finding title or body appears in the tool's answer or in any journal summary; the rendered findings reach the created task's own text and nothing else. Breaking: removing either key, widening `verdict` across roles, letting `labels.state: "unavailable"` carry an `observed` list, deriving an approval from anything but a recorded verdict, removing `findings` or `findingsOmitted`, making either required, letting `findings` be present without `findingsOmitted`, reading absent `findings` as "no findings" or as an approval, sharing one severity enum across roles, making `fromFindings` required, turning its missing-id refusal into a filter, dropping the same-pair refusal, narrowing it back to the run-level pair or to the task's own requested pair, rendering a finding's `body` unquoted or its `title` or `file` unfolded so it can leave its list item, preferring the record's task-level `modelIdentity` over the reviewing step's own pair, dropping the omitted-findings line, or putting a finding's own words into the tool's answer or a journal row.
  - **Advisory step progress on the run (#460, additive).** `GET /api/v1/runs` and `GET /api/v1/runs/:id` — and therefore every route answering a `RunRecord`, plus the MCP `task_read view=task` — carry an optional `progress` on each entry of `steps[]`: `{lastActivityAt, effectiveTimeoutMs, deadlineAt, stall?}`. The first three are REQUIRED-BUT-NULLABLE rather than optional, because `null` is a value this shape has to be able to say: it means *unknown or unlimited*, never zero and never now. `stall` is optional and present only while a condition holds — `{reason: "silence" | "timeout-near", since, observedAt}`. **Absent `progress` is unobserved, not healthy**, and it is what every record written before this carries, what a check step carries, and what a run carries when nothing was watching it. The whole field is an OBSERVATION: no route, status, timeout or cancellation behaviour changes because of anything in it, and the shape is the contract's own (`packages/contract/src/run-progress.ts`), imported by the store rather than restated. Breaking: removing the key, making any of the three nullable fields non-nullable, rendering an unlimited or unknown timeout as a finite number, or letting a consumer derive an action from a `stall`.
  - `DELETE /api/v1/runs/:id/auto-resume` (additive) retires a pending usage-limit resume for ONE task, leaving the workspace-wide `resources.autoResumeOnUsageLimit` untouched. Idempotent — a run with nothing scheduled answers `200 {cancelled: true}` too; only an unknown run 404s. Archiving a run does the same thing implicitly, because archiving is how a user resigns from a task.
- Worktrees: `GET /api/v1/worktrees`, `POST /api/v1/worktrees/reclaim`
- Project setup (#464 P2, additive): `GET /api/v1/onboarding`, `POST /api/v1/onboarding/offered`. The GET is READ-ONLY in the strong sense — it creates no record, refreshes nothing and starts no task — and answers `{state, provenance, available, unavailableReason, localHandoff, offerPending, dismissed, observed, lastOffered, lastChecked, checkingRunId, launch, issueFiling}`, where `state` is `never | set-up | changed | unknown | checking` and every nullable key is `null` rather than absent. `provenance` is `recorded` only for a record that parsed: a MISSING record reads `never` and a corrupt one reads `unknown`, and that distinction is protected, because collapsing them is how a surface claims a check that never happened. The POST records that the offer was made for the identity in its body and answers `200 {status, onboarding}` with `status` `recorded | conflict | unwritable` — `conflict` when the running identity moved since the caller read it and `unwritable` when the record could not be persisted, both meaning nothing was written. Neither route ever 5xxs on a missing, corrupt or read-only `.local/xezar/onboarding-state.json`; that file is disposable scratch and deleting it is supported. `issueFiling` (#468 step 3, additive) is `{status, reason, skill}` with `status` `available | unavailable | unknown`, discovered on every read and never stored: `reason` is `null` exactly when `available`, `unknown` means only that the shared skills collection has not finished loading, and a missing `gh`, remote or skill is always a reason, never a non-200. Breaking: dropping the key, reporting `available` while a part is missing, or reading an unloaded collection as `unavailable`.
  - **A start of the bundled setup definition is idempotent while one is running (#464 P2, `AC-13`).** `POST /api/v1/runs` with `workflow: "project-setup"` answers the run already in flight — `201` and the same record shape as always — instead of creating a second one, and the `variants` branch answers `{runs: [that run]}`. The key is (this project, that workflow) and liveness is the store's own `isActive`, the same test `GET /onboarding`'s `checkingRunId` reports, so the two doors cannot disagree. Every other workflow is untouched: two ordinary tasks at once is the product's whole point. It is a narrowing in the safe direction — a caller that used to get two agent runs for two presses now gets one, and the answer it reads (`id`, status, everything) is a real run of exactly what it asked for. Breaking: making this a `409`, widening it past the bundled setup definition, or letting a second check start while the first is live.
- MCP API reference (#284, additive): `GET /api/v1/mcp/reference` — the read-only tool reference behind Settings → MCP API. Answers `{available: true, xezarVersion, protocolVersions, capabilities, tools, refusedActions, refusedArguments, guards, notExposed}` where `tools` is exactly what the MCP bridge's `tools/list` answers (`[HEALTH_TOOL, ...tools.map(toolListing)]`) and `guards` (#301, additive) says, per tool and per `expectedVersion`/`operationId`, which actions the tool's own input schema refuses without it (`{tool, argument, everyCall, requiredBy}`, derived by validation, never from prose), or `200 {available: false, reason}` when the MCP module cannot load — never a 500. It answers whether or not the MCP service started, in local and hosted mode alike: the listing is static code with no secret, path, project data or account identity. There is no route that runs a tool from the cockpit, and adding one is not an additive change — it would make the cockpit a second leader (spec `mcp-api-reference-spec.md` § 13). Breaking: removing the route, removing a field, or letting `tools` differ from `tools/list`.
- MCP leader push delivery (#309, additive): `GET/POST /api/v1/mcp/leader`. GET answers `{available: true, owner, leader, delivery, blocker}` — `owner` (additive, #374) is `{client}` or `null` when no MCP session owns the project, with `client` `'codex'` once the owning Codex session announced its thread, `'claude-code'` once the owning bridge announced that client name at `session/open`, and `null` while xezar has not identified the client (a client identified another way is a new enum member, additive); `leader` is `{client, state: 'attached'}` or `null` (`client` is `'opencode'`, since #330 `'pi'`, and since #374 `'codex'` or `'claude-code'`), `delivery` is the owner session's event-controller `{state, deliveredSeq, ackedSeq, reactedSeq, latestSeq}` or `null` when no MCP session owns the project, `blocker` is `{code, message, fix}` or `null` — or `200 {available: false, reason}` when the project's MCP service is not running, never a 500. POST takes `{action: 'attach', client: 'opencode', baseUrl, sessionId}` (an OpenCode `serve` session the person runs), `{action: 'attach', client: 'pi'}` (additive, #330 — it carries NO address on purpose: pi speaks RPC over its own stdin and stdout only, so the address comes from inside the person's pi, where xezar's leader extension opens a socket and announces it in the project's data directory. Adding a required field to this variant is breaking), `{action: 'attach', client: 'codex'}` (additive, #374 — it carries no socket path, port, home or thread identity: xezar uses a bounded announcement from the owning Codex bridge and validates the existing local shared app-server), `{action: 'attach', client: 'claude-code'}` (additive, #374 — it carries NO address either: the target is the owner MCP session itself, woken over Claude Code Channels by pushing a `notifications/claude/channel` message down its own bridge. Refused with the recoverable `claude-code-not-owner` reason when the owner session is not Claude Code, and `claude-code-bridge-too-old` when its bridge predates the `leader/push` frame; `reactedSeq` stays 0 for Claude Code because xezar observes no reaction) or `{action: 'stop'}` (detach) and answers the same status; it `409 {error}`s in hosted mode (`capabilities.localHandoff: false`), when the MCP service is not running, when the project's event journal cannot be written, and — for `client: 'pi'` when no leader extension has announced itself for the project — with pi's own recoverable `pi-not-addressable` reason, which names why and never detaches a leader that is already working. Since #651, a `client: 'opencode'` body is answered `409 {error}` too when the named session is not found, belongs to another project's directory, or the server does not answer within the attach-time bound: the session is checked before anything is recorded, and a refused attach never detaches a leader that is already working. **xezar starts no agent process** (owner decision on #311): there is no `start` or `resume` action, and any other body is a `400`. A pi with no xezar leader extension loaded, a Codex session off the shared app-server and a Claude Code session started without `--dangerously-load-development-channels server:xezar` have no address to attach to, so they get no push and read their events with the `leader_events` tool. It runs no tool. Delivery itself needs no call: every MCP session that owns a project gets an event controller when it opens. Breaking: removing either route, removing a field, or adding an action that starts a process. MCP door (#450, additive): the `leader_events` actions `attach`, `stop` and `status` call the same controller for the calling MCP session only; the client is derived from that session and never taken from arguments; hosted mode refuses attach and stop. The status blocker code may also read `claude-code-channel-not-advertised` (additive). The route bodies, answers and 409 texts are unchanged. Breaking: letting an MCP call attach a client other than its own session's, or replace a leader of another client.
- MCP bridge↔service IPC frames (`packages/xezar/src/mcp/ipc.ts`, `bridge.ts`, `service.ts`), the private newline-JSON protocol over the project's Unix socket, `IPC_PROTOCOL_VERSION` 2, additive within it (#374): the service→bridge `leader/push` request (`{content, meta}`, replied `{pushed: true}` or a `push-failed` error) is how a channel event reaches a Claude Code client, and `session/open` gained two additive fields the bridge announces — `leaderPush: true` (it understands `leader/push`) and `clientName` (its `initialize` `clientInfo.name`). Both are optional: an older bridge omits them and the service refuses a Claude Code attach with `claude-code-bridge-too-old` rather than pushing into a bridge that cannot deliver; an older service ignores them. `leader/push` is distinguished from a normal response by carrying a `method`, so it never disturbs a request in flight. Breaking: changing the meaning of an existing frame or field, or requiring one of these new fields. `session/open` (#450, additive within version 2): the answer gains `canPush` (boolean) and, when false, `pushUnavailable` `{code, message}` (`code` a plain string on the wire, so a code added later never makes an older bridge refuse its session); the params gain `channelAdvertised` (boolean), sent on every open after the first handshake. An older bridge ignores the new answer fields; a newer bridge reads their absence (an older service) as `canPush` false and does not advertise `claude/channel` to Claude Code. A service that cannot be reached at `initialize` still gets the channel advertised, as before. Breaking: requiring any of these fields, or withholding the channel from a Claude Code client when the service is unreachable.
- MCP event catalog — a new kind, and one completion summary that says more (#460, additive). `verdict.posted` joins the E-03 category (`MCP_EVENT_KIND_CATEGORY` in `packages/contract/src/mcp-event-catalog.ts`), kept a distinct kind from `gate.passed` and `result.ready` for the reason F-11 already separates those two: a reviewer's judgement and a command that exited zero are different claims, and a consumer must be able to route on the kind without reading prose. It is journalled **only after** the verdict is durably on the run, so a row always has a record behind it; the summary stays summary-only (role, the exact verdict word, the reviewed sha, the report id and the label-evidence state) and the full packet is read from the task record. The categories E-01–E-06 are unchanged and closed, and `kind` remains open for additive growth, so a consumer meeting an unknown kind still routes on the category. The `task.done` summary now also says whether any verdict is recorded (`task finished: done, 1 reviewer verdict recorded` / `…, no reviewer verdict recorded`); its kind, category, subject and origin are untouched. Breaking: adding a category, moving a kind between categories, journalling `verdict.posted` before the record is written, or putting a packet's prose into the summary.
- MCP event catalog — the advisory liveness pair (#460 § 2, additive). `task.stalled` and `task.resumed` join the **E-01** category (`MCP_EVENT_KIND_CATEGORY`), kept distinct kinds from `task.blocked` because they are a different claim: blocked is a fact the engine knows (the run parked and cannot move without input), stalled is a SUSPICION a reader must go and check. Both are `origin: system` when the engine observes them. The conditions are fixed defaults, part of the contract and not settings: **no agent transcript activity for 5 minutes** (`STALL_QUIET_MS`) and **80 % of a finite effective step timeout spent** (`STALL_DEADLINE_RATIO`), re-evaluated every 30 s (`STALL_TICK_MS`) and only while a step is executing. One row per reason per execution episode: silence re-arms only after real activity (and publishes `task.resumed` when it does), while the deadline warning fires once and is not cleared by a resume, because the deadline did not move. A `monitoring` run, and every queued, waiting, review and terminal run, is not observed at all. **The pair changes nothing**: no cancellation, no timeout change, no status transition, no lease — and the summary of every `task.stalled` row says so in words, because a consumer routing on the kind alone must not read it as a failure. The summary stays summary-only (the step, the condition, the advisory clause); the timestamps are on the task record. Breaking: adding a category, moving either kind out of E-01, making the pair act on a task, removing the advisory wording from the summary, or putting an observation's timestamps into it. There is deliberately **no environment variable** for any of the three numbers; adding one is a design change, not a refinement (§ Zero config).
- MCP leader event replay — the guarantee a leader is told and acts on (#460 § 4, wording additive, behaviour unchanged). Delivery is **at-least-once within retained durable state**, never exactly-once, and it promises nothing about runtime state a person deleted or corrupted. The floors that make it true: the project event journal retains **at least the newest 10 000 rows** (`MCP_JOURNAL_RETAINED_ROWS`) and evicts **no row younger than 14 days** (`MCP_JOURNAL_MIN_RETENTION_DAYS`), whichever is larger, and a replay page carries at most **100 rows or 40 000 bytes** (`MCP_JOURNAL_PAGE_ROWS` / `MCP_JOURNAL_PAGE_BYTES`). Rows outside retention are an **explicit** `status: 'gap'` with `resumeCursor` and the current state, never silence. A `read` and a transport receipt advance `deliveredSeq` only; **only `leader_events` action `ack` advances the acknowledgement**, and it stays cumulative, monotonic and idempotent, so an older or duplicate cursor is a successful `no-op`. As of 0.15.0 **no timer re-pushes a row already delivered in a session** — existing transport retry and heartbeat are unchanged, and the recovery for a compacted leader is a `read`. The `leader_events` description and all three `initialize` instruction variants now carry that compaction-recovery text (additive prose; the schema, actions, answers and status words are untouched). Breaking: lowering either retention floor, shrinking a page bound, advancing the acknowledgement from anything but `ack`, answering a lost row as an empty result instead of a gap, or starting automatic re-push of delivered rows without recording the changed guarantee here.
- Open-in: `GET /api/v1/open-targets`, `POST /api/v1/open-in` — the latter opens the SCOPED PROJECT'S root in an `open-targets` id (Settings → "Project folder"). It takes `{target}` and no path at all: the folder is the registry's own root, so there is nothing for a client to point elsewhere. `cli:<runner>` targets are refused with a 400 (an agent CLI belongs in a task worktree), as is an app this machine does not have; localHandoff-gated like the rest of the family.
- Variants: `GET /api/v1/groups/:groupId`, `POST /api/v1/groups/:groupId/pick`
- Inbox: `GET /api/v1/todos`, `DELETE /api/v1/todos/:id`, `POST /api/v1/todos/:id/start` — present always, but **gated** on the follow-up Inbox switch (pre-rename issue 471, off by default) — the stored workspace `followups` key when set, otherwise `XEZ_FOLLOWUPS=1`: the GET degrades to `200 []` and the two mutators answer `409`. The routes themselves must keep existing and must behave exactly as before once the switch is on.
- Run history: `GET /api/v1/runs/:id/{history,history-context}` (reverse-paged visible events + compact current-state context; boot/default/project aliases remain identical)
- SSE: `GET /api/v1/events` (boot project), `GET /api/v1/runs/:id/events` (no-query full replay + live; optional opaque `cursor`/`afterSeq` resume, additive data-frame `id`, payload dedup by `seq`), `GET /api/v1/workspace/events` (all projects; workspace-level, never mirrored — see below)
  - Legacy `GET /api/v1/events` is **explicitly boot-project-only** and keeps its exact pre-workspace, un-stamped payload shapes (`run` = the bare `RunRecord`, `run-deleted` = `{id}`, `todos` = the bare item array, `usage` filtered to this project's runs, `ping`). Widening it to carry other projects' events, or stamping its payloads with a project id, would be a silent behavioral break for every script reading it — the all-project stream is `/api/v1/workspace/events`, and each project's own stream is `/api/v1/p/:projectId/events` in the same un-stamped shape.
  - `GET /api/v1/workspace/events` reuses the same event names but stamps every payload with the owning `project` id — additively where the legacy payload is an object (`run` grows a `project` key; `run-deleted` becomes `{id, project}`), wrapped where it is not (`todos` → `{project, items}`; `usage` → `{project, usage}`). `usage` is **filtered per project** — one event per project that has live rows, never a stamped whole and never an empty-record clear. Three workspace-only event names exist for the registry/GUI-clone flows: `project-added`, `project-removed`, `checkout-progress` (payloads relayed verbatim from the emitter). The host-wide `provider-status` event is also workspace-only and deliberately **unstamped**: its additive coarse provider row is `{provider, status, hint?, authFailureId?, enabled?}`. It is emitted on a runtime-authentication latch transition, a successful provider enablement change, and a successful incident-safe retry; runtime rows carry the fixed hint and opaque incident id, while enablement/retry rows carry the current `enabled` value. Evolution is additive: a new workspace event name is inert to older consumers, and subscribing never force-instantiates a project (a lazily-built project's events join streams already open).
- WebSocket: `GET /api/v1/ws` — the topic subscription bus, upgrade-only and workspace-level (single-mount, never mirrored under `/api/v1/p/`). **The path is protected, the frame protocol is not.** The path is what the `packages/xezar/web/dist` bundle and the Vite dev proxy connect to and what the upgrade guard answers `403` on, so moving or removing it is breaking. The frames (`{type:'subscribe'|'unsubscribe',topic}` up; `{type:'event'|'error'|'ping',…}` down) and the topic names are deliberately **internal**: the cockpit bundle ships in lockstep with the server that serves it, there is no cross-version consumer, and unlike `/api/v1/events` nothing outside this repo can have scripted them. Topic names may therefore be added, renamed or dropped freely — but a topic's payload, when it mirrors an HTTP route's shape (`health` does), inherits that route's contract.
  - Topics today: `health` (subscribed once at the cockpit root; its payload is `GET /api/v1/health`'s, and it is the one topic marked readable by a page the loopback fallback admits) and `mcp-leader` (additive, #374: subscribed by Settings → MCP connection's leader control while it is on screen; trusted connections only). An `mcp-leader` frame's `data` is `{projects: {<registry project id>: <GET /api/v1/mcp/leader answer>}}` (`mcpLeaderTopicSchema` in `packages/contract`) — every project whose MCP service is running, plus one whose service stopped while the topic was held, as `{available: false, reason}`. It mirrors that route's shape, so it inherits that route's contract, and it is published only when the payload changed. It carries exactly what the route answers: no filesystem path or home, but an OpenCode blocker may repeat the address and session id the person typed and a pi blocker pi's own error text — which is why the topic is trusted-only. A third topic is `project-instances` (additive, #796: held by the app shell while the `--instance project` "Other projects" band is on screen; trusted connections only). Its frame's `data` is `{projects: {<registry project id>: <the `instance` object of that project's `GET /api/v1/projects` row>}}` (`projectInstancesTopicSchema` in `packages/contract`) — every project this server answers for, so the map replaces the previous one wholesale, and it is published only when the map changed. It mirrors that field's shape, so it inherits that route's contract. A `url` names another local port and the map says which projects this machine has open, which is why the topic is trusted-only; a hosted server publishes `{}` and probes nothing. All three topics open only when `capabilities.localHandoff` is true: a remote cockpit opens no WebSocket and reads the same routes over HTTP.
  - **Local mode only since 0.16.0 (#547).** A hosted server (`XEZ_REMOTE=1` or a non-loopback bind) refuses every upgrade on this path before the handshake, whatever the Origin and including a native client that sends none: it answers `HTTP/1.1 403 Forbidden` and closes the socket. See § "Hosted servers refuse every WebSocket upgrade" below.
  - **Not covered by the §2 drift guard.** `packages/xezar/src/server/bc-route-inventory.test.ts` derives its inventory from a built app's route table, and an upgrade-only endpoint is not in it (the socket is attached to the raw HTTP server, not to Hono) — so this entry is maintained by hand. Any future upgrade route needs the same treatment.
- Repo/GitHub: `GET /api/v1/github`, `GET /api/v1/github/checks`, `GET /api/v1/github/search`, `GET /api/v1/github/ref-status`, `GET /api/v1/github/comments/:kind/:number`, `GET /api/v1/github/prs/:number/changes`, `GET /api/v1/github/prs/:number/merge-state`, `POST /api/v1/github/prs/:number/merge`, `POST /api/v1/github/prs/:number/ready`, `GET /api/v1/repo`, `GET /api/v1/repo/{diff,changes}`, `GET /api/v1/repo/commit/:sha`, `POST /api/v1/repo/branch`, `GET/PUT /api/v1/config`, `GET/PUT /api/v1/ui-state`
  - `GET /api/v1/github/comments/:kind/:number` (pre-rename issue 499) returns `{available, reason?, comments[], truncated?, events?}`. `events?` is additive (pre-rename issue 525) and may be absent entirely when the timeline fetch degrades; `comments[]` keeps its exact shape, contents and cap regardless of event volume.
  - `GET /api/v1/github/checks?prs=<csv>` (pre-rename issue 664) is additive: the list call (`GET /api/v1/github`) stopped eagerly fetching `statusCheckRollup` (the dominant cost on repos with many open PRs), so a PR row's `checks` comes back `null` from the list and is hydrated lazily through this endpoint for on-screen rows. `prs` is a comma-separated list of positive PR numbers, capped at 100 (400 on a malformed list); the response is `{available, checks}` (a `number → 'passing'|'failing'|'pending'|null` map) or `{available: false, reason}`, and degrades exactly like the list — never a 5xx. `GET /api/v1/github`'s response shape is unchanged: `checks` was already optional/nullable, so a `null` from the list is not a new shape.
  - `GET /api/v1/github/search?kind=issue|pr&q=<text>&limit=<n>` (pre-rename issue 730) is additive: the list call (`GET /api/v1/github`) returns the **open** set only — `gh issue list` / `gh pr list` default to `--state open` — so the tab's in-memory filter structurally cannot match a closed or merged item, and this endpoint is the cross-state lookup it falls back to. `kind` and a 1–256-char `q` are required, `limit` is optional and capped at `GH_SEARCH_MAX` (50); anything malformed is a `400 {error}`. The response is `{available, items, truncated?, labelColors?}` — `items` are the same `githubItemSchema` rows the list ships, with `checks` always `null` (hydrated lazily through `/api/v1/github/checks` like list rows) — or `{available: false, reason}`, degrading exactly like the list and never a 5xx. `GET /api/v1/github`'s response shape is untouched.
  - `GET /api/v1/github/ref-status?prs=<csv>&issues=<csv>` is additive and is the batched read behind a task's PR/issue chip (one request per project for a whole table, not one per chip). Both query keys are optional and at least one must name something (400 otherwise); each is a comma-separated list of positive numbers capped at 100 (400 on a malformed list). The response is `{available: true, prs, issues, conflicts?, recheckAfterMs}` — two `number → status` maps plus the cadence — or `{available: false, reason, recheckAfterMs}`, degrading in the payload exactly like `/github/checks`, never a 5xx. `recheckAfterMs` is how long the answer holds (milliseconds), or `null` for "nothing in this answer can change; do not schedule anything": the SERVER owns that judgement, because whether a status can still move is forge semantics and lives next to the cache that decides whether asking would even reach GitHub. A client is expected to obey it rather than keep its own table. A number the forge does not know is **absent** from its map rather than present with a fallback: absent means "nothing is known", which the cockpit paints as the neutral chip it painted before statuses existed, and collapsing that into a status would let "we could not ask" render as "nothing is wrong". The status vocabulary is `draft | review-required | changes-requested | checks-pending | checks-failing | ready | merged | closed` for PRs and `open | completed | not-planned` for issues; adding a value is additive (an unknown one renders neutral), renaming or removing one is breaking. `conflicts` is an **optional additive** list of the PR numbers the forge reports as `CONFLICTING` — a second axis, never folded into the status, because a pull request can be `ready` (open, green, nobody waited on) and unmergeable at the same time and one word cannot say both. It rides the same GraphQL node the statuses come from, so it costs no extra request, and it names OPEN pull requests only. Its **absence means "nothing is known about mergeability"** — an older server omits the key entirely, and GitHub's own still-computing `UNKNOWN` is never listed — so a client must not read a missing number as "merges cleanly"; the cockpit paints the conflict chip on `true` alone. Removing the key, or letting it mean "no conflicts", is breaking. GitHub computes mergeability on demand and answers `UNKNOWN` while it does, so a batch holding such a reference comes back with a **much shorter `recheckAfterMs` (seconds, not the usual minute)** for as long as that is plausibly still being computed — the one existing knob, used as designed: a client obeys the cadence rather than keeping its own, and the server never caches a non-answer for as long as an answer.
- **Content negotiation on the two mixed-format routes — additive, and the query flags stay the wire.** `GET /api/v1/repo/commit/:sha` serves the legacy `text/plain` blob or the structured `{sha, subject, author, when, files, stat}` payload; `GET /api/v1/runs/:id/files` serves the JSON listing/metadata or an image file's raw BYTES. Both now also read the request's `Accept` header, under a fixed precedence: **(1) the query flag whenever the request carries it** (`?structured=`, `?raw=` — present-but-not-`1` is an explicit opt-out, so a header can never override a caller that said what it wanted in the URL), **(2) otherwise the best `Accept` match**, **(3) otherwise the route's established default** — the text blob for `/repo/commit/:sha`, the JSON listing for `/runs/:id/files`. `*/*` matches nothing, deliberately: it is what `fetch`, `curl` and XHR send when they have no preference, so **every existing caller's answer is byte-identical**. Both routes answer `Vary: Accept`, and each response carries the `Content-Type` of what it actually sent. The one behavioural addition is that a client whose `Accept` really does ask for the other representation now gets it — e.g. an `<img>` or a browser navigation to a worktree image receives the bytes, with the same allowlist, size cap, `nosniff` and sandbox CSP the `raw=1` path has always applied. A negotiated (as opposed to flag-driven) image preference that the resource cannot satisfy falls back to the JSON representation rather than 409ing; `?raw=1` keeps its 409 and its exact wording. Breaking: changing that precedence, making `*/*` select a non-default representation, or letting `Accept` override a present query flag.
- Agent config (spec pre-rename issue 404, additive): `GET /api/v1/agent-config`, `GET/PUT /api/v1/agent-config/:id` — writes 409 in hosted mode (`XEZ_REMOTE`) by design
- SSE event names: `run-event` (v1), `ui-event` (v2 dotted types), `provider-status` (workspace-only host provider row)

**Project-scoped mirror — `/api/v1/p/:projectId/*`** (multi-project workspace, Phase 2): every per-project route above is registered **once** and mounted **twice**, unscoped `/api/v1/<path>` and scoped `/api/v1/p/:projectId/<path>`, sharing one handler so the spellings cannot drift. The contract:

- The unscoped routes stay bound to the **boot project** (the repo `xezar serve` started in) and answer **byte-identically** to `/api/v1/p/<bootId>/<path>` and `/api/v1/p/default/<path>`. That three-way parity IS the protected surface — enforced by `packages/xezar/src/server/route-parity.test.ts`, which iterates a manifest derived from the app's actual route registrations (so a newly added scoped route is parity-tested automatically, and the suite can never drift from the code).
- `projectId` is validated at the route boundary before any registry or filesystem touch: the slug shape (`^[a-z0-9][a-z0-9-]{0,63}$`) or the reserved literal `default`, which always aliases the boot project. Unknown or malformed id → `404 {error}`; a registered project whose folder is gone → `409 {error}`. Both status/shape pairs are part of the contract.
- Non-boot projects build lazily on first scoped touch (own store, own launch key, same crash recovery the boot project gets); nothing about the boot project's observable behavior changed with the mirror.
- Workspace-level routes (`/api/v1/health`, `/api/v1/projects`, `/api/v1/providers/*`, `/api/v1/workspace/*`) are single-mount and **never** mirrored under `/api/v1/p/` — they answer for the whole workspace, so a scoped spelling would be a second surface to protect with no consumer.

**One surface, versioned — `/api/v1/*`**:

- **Why it exists.** Hono infers an API's types only from routes registered through a *chained* builder. Every family is chained and mounted into one versioned table, which is what makes `AppType` (`packages/xezar/src/server/app-type.ts`) — and the client `@qodeca/xezar-api-client` builds from it — cover the whole API rather than a hand-written mirror of it.
- **No unversioned twin.** `versioned-surface.test.ts` fails if any route appears outside `/api/v1`. A route added as a loose `app.get('/api/x')` would answer while being invisible to the typed client, which is the two-surface problem this removed.
- **Version, then project.** The version is the outer dimension (`/api/v1/p/:projectId/…`): a consumer picks its API version once and addresses projects inside it.
- **Transcript compatibility.** Run transcripts persist absolute image URLs and keep them forever, so NDJSON written by older versions still names the unversioned `/api/runs/<id>/images/…`. The cockpit upgrades those onto `/api/v1` at render time (`resolveApiUrl`); the stored bytes are never rewritten.

**Cockpit page URLs — `/p/:projectId/*`** (multi-project workspace, Phase 3): every cockpit *page* now lives under a project prefix too (`packages/web/src/routes.tsx`), mounted by one `ProjectScopeRoute` layout gate. Unlike the API mirror above there is no unprefixed page spelling left to answer — the flat URLs redirect instead, and that redirect is a protected surface in its own right because it is what saved bookmarks and bookmarklets land on:

- **Legacy flat → `/p/<boot>/…` is permanent.** Every pre-multi-project path (`/`, `/new`, `/tasks/:id`, `/settings/*`, …) redirects to the boot project's scoped twin preserving **path, query and hash byte-for-byte**. It is a client-side `replace` navigation, not an HTTP 3xx — the server already serves `index.html` for every non-`/api`, non-asset GET (`packages/xezar/src/server/static-ui.ts`), so a **cold load** at a flat URL lands exactly as `open()` from github.com performs it. Until `/api/v1/health` names the boot project the router shows a quiet resolving state, never a flashed wrong screen.
- **`/p/default/…` is the page-level twin of the API's `default` alias** — the reserved literal, never an allocated slug, normalized to the real boot slug with a `replace` navigation so the address bar always names the project; the remaining path, query and hash survive byte-for-byte. An id the registry doesn't know renders the "not registered here" screen — the cockpit twin of the API's `404`.
- **The redirect IS the bookmarklet contract.** A generated launcher is now `<origin>/p/<projectId>/new?skill=&auto=&key=&ref=` (`packages/web/src/lib/bookmarklet.ts`): **only the path gained a prefix**, the query grammar after `?` is byte-identical, and `key` is that project's own `.local/xezar/launch-key` (each repo keeps its own — the scoped API client fetches the right one). Generating without a project id still emits the exact legacy flat `/new?…`. Every bookmarklet already saved in somebody's bar predates the prefix, so **the legacy redirect is the only thing keeping it working** — deleting it breaks browsers this repo cannot reach, which is why it is listed as permanent and not as a deprecation window.
- **Settings split, old URLs kept** (`packages/web/src/routes/settings/registry.tsx`): project sections live at `/p/<id>/settings/<section>` (`agents`, `agent-config`, `worktrees`, `bookmarklets`, `prompt-templates`, `mcp-connection`, `mcp-api`), global ones at `/settings/global/<section>` (`appearance`, `notifications`, `resources`, `skills`, `accounts`, `projects`, `keyboard`) — the one cockpit area deliberately **outside** every project scope, because appearance and notifications are the user's, resources are the machine's, and the Projects pane *is* the registry. A section that moved keeps **both** old spellings landing: `/p/<id>/settings/<global-id>` redirects to the global twin, and the legacy flat `/settings/<global-id>` reaches it through the flat redirect first. The **store** moved with them — appearance and notifications now write `~/.xezar/ui-state.json` via `/api/v1/workspace/ui-state`, resources writes `/api/v1/workspace/config`, and the project sections stay on the per-repo `/api/v1/config` + `/api/v1/ui-state` (section 3). Migration 001 copied the pre-existing per-repo `appearance`/`notifications` values up (section 9), so the split is invisible on upgrade and a downgraded xezar still reads its local copies.
  - **Single-project mode changes the store, not the route (#600, part 4).** With `capabilities.singleProjectRoot` true every `/settings/global/<section>` URL above still lands on the same section — no section moves between scopes and no redirect changes — but the store behind it is the project's own files: the workspace config becomes `<project>/.xezar/workspace.json`, workspace GUI state `<project>/.xezar/workspace-ui.json` and agent accounts `<project>/.xezar/agent-accounts.json` (`packages/xezar/src/state-layout.ts`), still reached through the same `/api/v1/workspace/*` and agent-account routes. Each section names that file on its pane and the global area's chip and index read "Workspace settings". `/settings/global/projects` is not routed in the mode, exactly as under `XEZ_SINGLE_PROJECT=1` (a not-found page, unchanged). Part 5 adds three copy changes, all in the mode only: the Resources pane has no "Configure per-project limits" link (its target is that unrouted page, and there is no second project to limit), the Agent accounts defaults card reads "Defaults for this project" instead of "Defaults for new projects", and the empty Tasks page adds one sentence ("This xezar keeps its settings and its working files in this folder, so everything a task needs travels with the repository."). In global mode nothing on this page changes. Breaking: moving a section between scopes, dropping a `/settings/global/<section>` URL other than `projects` in the mode, or rendering the file note or the new wording in global mode.

Breaking: removing/renaming a route; making a previously optional body field required; removing a response field; changing an SSE event name (`run`, `run-event`, `run-deleted`, `todos`, `usage`, `ping` — or, on the workspace stream, `project-added`, `project-removed`, `checkout-progress`, `provider-status`) or the `seq` dedup contract; breaking the three-way alias parity (an unscoped `/api/v1/*` answer diverging in status, content type or body from its `/api/v1/p/<boot>`/`/api/v1/p/default` spellings); changing the scoped 404/409 project-resolution contract or the meaning of the `default` alias; stamping or widening the boot-project `/api/v1/events` stream; narrowing `/api/v1/health` CORS or its fields; changing `/new` query parameters (breaks saved bookmarklets); **dropping the legacy-flat → `/p/<boot>` page redirect** — or letting it lose the query/hash, which is the same break one step quieter; changing the meaning of the `default` page alias; moving a settings section without leaving its old URL redirecting to the new one. Required path: additive first; if removal is unavoidable, keep the old route/field answering for one minor release and note it in the CHANGELOG. `/new` deserves extra caution — it lives in users' browsers (saved bookmarklets), not in this repo.

### Agent-config symlink refusal — deliberate, 2026-09-13 (#363)

`GET/PUT /api/v1/agent-config/:id` (including project aliases) now returns 409
with the existing `{ error: string }` body for a catalogued file symlink, including
a dangling link, or a directory link below the configured agent home/repository
that escapes that root. Previously reads served the target and writes followed it.
Listings retain their shape: refused entries have `writable: false`, a
`readOnlyReason`, `version: null`, `exists: false` and `size: 0`; those last two
values describe no accessible config, not whether a link exists on disk. Personal
layer seeding skips refused sources and destinations, preserving best-effort boot.

This change must ship in the next minor release, with the README migration note.
It intentionally narrows access to prevent a catalogued name exposing an
uncatalogued credential file. Replace individual file links with regular config
files to edit them. A symlink relocating the entire configured home remains
supported: that canonical directory is the boundary. Internal directory links
that stay within the boundary remain supported. Ordinary absent files, byte-exact
round trips, stale-write refusal and hosted-mode restrictions are unchanged.
Secrets explicitly stored inside ordinary config files (including MCP env/headers
or pi's `httpProxy` URL) remain raw content; this is not a content-redaction API.

## 3. Project state files (`.local/xezar/`) (`packages/xezar/src/runs/store.ts` and friends)

Written by one version, read by the next, and hand-editable by design:

Recovery additions for #185: one process owns the canonical project data directory before mutable startup, lazy project construction or scheduled execution. Live/uncertain peer claims refuse; dead claims recover automatically. `writer-claims/` is disposable runtime state, not authored configuration. Older versions do not honor ownership claims, so an upgrade must stop an older writer before starting the replacement.

- **`writer-claims/<pid>-<uuid>.json` → `machine`** (#199) — optional, additive, and written only when the platform names the host (`src/machine-identity.ts`); an unidentifiable host writes the pre-#199 `{pid, host}` bytes exactly. It is a stable machine id, so a laptop that changes network (and therefore hostname) still reaps its OWN dead claim instead of locking the cockpit out of `.local/xezar`. Deliberately one-way, and the one-way claim is about the PEER SCAN specifically: there, a matching identity makes the recorded `host` display-only, while a mismatched or ABSENT identity — every claim already on disk, and every claim an older version writes — falls back to the hostname comparison unchanged, so no claim this guard used to refuse becomes reapable by PID. The SELF-check ("is the claim I published still the one on disk?") has no hostname fallback at all and never had a meaningful one: it used to compare the claim's raw bytes against a body rebuilt with a live `hostname()`, which is why a machine that renamed itself mid-process refused its own claim (#199, reachable long after boot — `automations/coordinator.ts` calls `ownProjectData` lazily). It now identifies a claim by PID + machine and by nothing else, so on a host that cannot name itself (a distroless container with no `/etc/machine-id`) the self-check reduces to the PID and is strictly MORE permissive than the byte comparison it replaced. That is deliberate and not exploitable — the file sits at a path carrying this process's own PID and a UUID only it generated — but it is a real difference between the two halves, so do not read one as the other. An older xezar ignores the key and behaves as it always did.

An optional `runs/<id>.ndjson.corrections.json` is reviewed incident evidence installed only while writers are drained, followed by restart. It binds an LF-ended raw prefix by SHA-256 and excludes exact record byte ranges/hashes from generated history views. Original NDJSON stays append-only; future appends and raw sequence allocation are unchanged. No sidecar preserves ordinary reads. Malformed or changed evidence refuses corrected history with structured HTTP409 rather than silently restoring quarantined events. Opaque page/live cursors bind the correction generation; old cursors and sequence-only SSE resumes require a fresh replay and browser reload after activation. A downgrade ignores the sidecar and shows the original raw history, so preserve provenance and do not present a downgraded view as reconciled.

- **`mcp/event-journal.ndjson` → `gate`** (#460, PR 4) — optional additive `{stepId, resultScope: 'routine' | 'stage'}` routing metadata on newly written `gate.passed` and `gate.failed` rows. Older rows without it remain valid and significant; absence means stage for delivery. The row is still retained and returned by `leader_events read` whichever scope it carries. A routine successful pass alone is omitted only from pushes, while every failure remains significant. Push dispatch pages may carry optional positive `omittedRoutineCount`; it counts routine passes covered by the pushed visible cursor and is never a journal row. Acknowledgement, cursor encoding, raw replay, retention and gap semantics are unchanged. Making either optional field required, defaulting absent metadata to routine, filtering raw reads or append, or counting a failure as omitted is breaking.

- **`audit.ndjson`** and the read-only legacy **`mcp-audit.ndjson`** (#306, 0.16.0) — the project audit trail, one record per line. **Deliberate break, 0.16.0, recorded here on purpose** (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 3.1 and § 8). The file was renamed and the record went from `v: 1` to `v: 2` (`packages/contract/src/audit.ts`): `outcome` is now `{status: 'applied'}` or `{status: 'refused', reason}` instead of the strings `ok`/`rejected`/`not-applied`/`unverified`, `errorCode` became `outcome.reason`, and every record carries `seq`, `kind`, a UTC-only `ts` and a server-derived `actor` whose `type` equals `origin`; objects are strict. What the old name and shape were load-bearing FOR: (1) the released reader, which reads only `mcp-audit.ndjson` and only `v: 1`; (2) tests and tools that treated that one path as the door's own write when comparing state before and after a call; (3) the `unverified` outcome, which recorded a call whose effect may have started. The measured result for (1), run by `packages/xezar/src/mcp/audit-upgrade.test.ts` against a frozen copy of the 0.15.0 reader: it never throws, keeps 0 of the 16 v2 lines it is given – 15 records (MCP, UI, automation and command-line records, applied and refused, with and without a proxy user, receipt id, command, resource and `fieldNames`) plus a rotation marker – and counts each as quarantined; in a file holding both versions it keeps every v1 entry. For (3) there is no v2 value: such a call is not recorded, and the trail's one warning per process says `the action continued without an audit record` — a deliberate loss, because `refused` would claim that nothing happened. Rules that are now the contract, and changing any of them is breaking: **new wins** — when `audit.ndjson` exists (even empty) only it is read and the legacy file is ignored; **legacy is read-only** — `mcp-audit.ndjson` is read with the v1 schema only while `audit.ndjson` does not exist, is never written, renamed, chmodded, rotated or deleted, and reading it prints exactly one line per process, `xezar: mcp-audit.ndjson is deprecated; reading it read-only (removal not before 0.18.0)`; **no merge** — the two histories are never combined, so an interrupted upgrade cannot show an entry twice; **sequence** — `seq` is the last valid persisted v2 record's plus one, read from the files at each write and never from a cache, so a failed write allocates nothing and a torn last line is skipped and never glued to the next record; **best effort** — a failed or unrecordable audit write never changes the operation's result.

  **Rotation, retained names, sequence and modes** (#306 part 3, 0.16.0; spec § 7). These are the contract from 0.16.0 and changing any of them is breaking. **Names**: the live file is `audit.ndjson` and its rotations are `audit.ndjson.1` (newest) to `audit.ndjson.4` (oldest) in the same folder — five retained files, and no sixth is ever created; `audit.ndjson.lock` is the writers' lock file, and `audit.ndjson.lock.takeover` the short-lived guard beside it under which a stale lock is removed; neither is a retained file and neither outlives its writer. The legacy `mcp-audit.ndjson` is not part of the set and is never locked, renamed, chmodded, appended or rotated. **Ordering**: rotation happens BEFORE the append that would pass **10,000,000 bytes**, so a live file is never knowingly over the limit — `.4` is deleted, `.3`→`.4`, `.2`→`.3`, `.1`→`.2`, live→`.1`, and the new live file's FIRST line is one `{"kind":"rotated", seq, previousLastSeq, ts, projectId, v:2}` marker, with the action as its second line and the next sequence. A reader that expects only `kind: 'action'` lines must skip the marker; readers here already do. **Sequence** is monotonic across the whole retained set, so a rotation never restarts it, and reading the history means reading `.4`, `.3`, `.2`, `.1` and then the live file, in that order. **Modes**: every retained file is created AND repaired to `0600` at each write; a file that cannot be made `0600` gets nothing. **One lock**: all four doors take `audit.ndjson.lock` (2 s bound, 20 ms polling, takeover of a dead owner or a lock older than 30 s, and every removal guarded and checked against the lock's own token, so two holders are not possible) for the sequence, the append and the rotation; after the bound, or on any filesystem failure, that one record is dropped with one warning per PROJECT per process (#306 part 4: every door of a project shares it) — an audit write is never attempted unlocked and never changes or rolls back the user's operation; may delay the answer by at most the 2 s lock bound. A crash between the rename and the marker is repaired by the next writer, which writes the marker from the maximum retained sequence and never invents the lost action. Downgrade limit: 0.15.0 starts, reads its untouched legacy file and ignores `audit.ndjson`, but cannot show any record 0.16.0 wrote. Removal floor: the alias is removed no earlier than 0.18.0, only through #563, with release notes that give the manual preservation path; a user's `mcp-audit.ndjson` is never deleted by xezar.
- **Audit record origins, actors and action ids** (#306 part 2, 0.16.0) — what each door writes into `audit.ndjson` (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 4–§ 9). **Origin is the server door, never a caller field**, in local and hosted mode alike: the HTTP routes write `ui` (`packages/xezar/src/server/audit-ui.ts`), the MCP door `mcp`, the automation runner `automation` (`packages/xezar/src/automations/audit.ts`) and the headless command line `cli` (`packages/xezar/src/cli-audit.ts`); a request body that names an origin or actor changes nothing. MCP tools call the HTTP routes in process, so the `ui` door records only a request that arrived over a real connection — one operation is one record. **Actor** is server-derived and door-specific: `{type:'mcp'}`; `{type:'ui'}` or `{type:'ui', proxyUser:{value, trust:'asserted-by-proxy'}}`; `{type:'automation', receiptId}`; `{type:'cli', command}` with `command` from the contract enum. **Action ids** come from one shared inventory (`packages/xezar/src/mcp/audit-inventory.ts`) and are the same for the same change through `ui` and `mcp` (`run.pin`, `workspace.config.set`); v1 records named the tool action (`taskCreate.start`), so a reader that matched those strings must match the inventory id. Renaming an id, or moving a route or MCP action to another id, is breaking. **Recorded set**: run-state changes and config writes, never reads; whether an MCP call is recorded is decided per action by the inventory, not by the tool's `readOnlyHint`, so a read action inside a mutating tool (`check_automation` with `mode: preview`) writes nothing. `audit-inventory.test.ts` fails when an MCP action or a non-GET route is unclassified. **Settlement**: 2xx is `applied`; 4xx is `refused` with `http_<status>` (a stale-version 409 is `stale_version`, an MCP boundary refusal its boundary, an invalid leader cursor `invalid_cursor`, a `performed: false` answer its HTTP status or outcome, and the onboarding `conflict` answer `conflict`); an MCP answer that says the target is not in this project, from a lookup that precedes every effect, is `refused` with `not_found` (#573 — `execution_control`, `organise_work`, `task_create` and `handoff_git`; before 0.16.0 shipped, the first three wrote nothing and `handoff_git` wrote `applied`); 5xx, a throw or an error that may have started its effect writes nothing. An MCP answer with `status: 'conflict'` — a state the action does not allow, an Inbox action while the Inbox is off, a moved pull-request head — is `refused` with `conflict` (`stale_head` for the moved head), and a `handoff_git` `status: 'failed'` answer is `refused` with `policy`, `quality_blocker`, `forge_blocker`, `forge_unavailable` or `http_<status>` when its own answer says it refused before its effect, and writes NO record otherwise (#577; before 0.16.0 shipped, both were recorded as `applied`). The cockpit's Inbox start route records its own 409 and 404 the same way. An automation launch is `applied` with the run as resource, a refusal known to come before any run (`invalid_steps`, `unknown_workflow`) is `refused` with the automation as resource, and a duplicate receipt, held lease, filter miss or preview writes nothing. **Commands**: every valid subcommand writes exactly one record (`--help`, `--version`, an unknown command and an unknown `projects` word write none); `projects add|remove|tag|port` write to the project they acted on, everything else to the invocation project; a folder that is neither registered nor already holding `.local/xezar` gets no record and no new state; `fieldNames` and the digest carry what changed, never a tag, port or path. **Proxy user**: read from `X-Xezar-User` only when the server is hosted (`capabilities().localHandoff` false) and only from a loopback peer; trimmed, control characters stripped, capped at 128 UTF-16 code units without splitting a surrogate pair, omitted when empty, and never trusted as authentication. The bundled nginx site sets `proxy_set_header X-Xezar-User $remote_user;`, which overwrites a client's value; a custom proxy must do the same or the value is whatever the client sent. The bundled macOS ngrok tunnel (`server-install --platform macosx-ngrok`, #572, 0.16.0) writes an ngrok Traffic Policy file (`remove-headers` on `on_http_request`) that strips a client-supplied `X-Xezar-User` before it reaches xezar, the ngrok-equivalent of nginx's overwrite; it does not set the header to the basic-auth identity, so a request through the tunnel with no forged header is recorded with no proxy user, same as any other unset case. Prior 0.16.0 pre-releases neither set nor stripped the header, so a signed-in client's own value was stored, still labelled `asserted-by-proxy`; the label never means authenticated. **Best effort** is unchanged: a failed audit write never changes a response, a command's exit code or a launch, and warns once per project per process. **Redaction** is one seam every door passes through (#306 part 4, `packages/xezar/src/mcp/audit-redaction.ts`): a record holds identifiers, enum members, sorted `fieldNames` and a SHA-256 digest, never a value. A configuration write — `PUT /config`, `PUT /ui-state`, `PATCH /projects/:projectId`, `PUT /agent-config/:id`, the workspace pair, `projects tag` and `projects port`, and their MCP counterparts — stores the body's top-level key names and a digest taken with EVERY value replaced, so the digest identifies which keys changed and never what they changed to; an MCP configuration write now carries those key names too, which it did not before. An identifier that matches one of the host's secret env values or a well-known token shape is dropped from the record rather than masked, and free text, paths, URLs, a request's own credentials and a candidate's author are removed or replaced before the digest is taken. The 0.15.0 reader result is unchanged by all of this: it still parses none of these records and quarantines each one without crashing (`audit-upgrade.test.ts`), so no new break is recorded here.
- **`runs.json`** — array of `RunRecord` (zod schema in `packages/xezar/src/runs/store.ts`), atomic tmp+rename writes. New fields MUST be optional or defaulted (`archived` uses `.default(false)`); a required new field silently drops every pre-existing run because the loader `safeParse`s the whole array. The `runner` and `backend` enums keep the legacy id `claude-cli` **parseable and self-normalizing** — `storedRunnerSchema` accepts it and folds it to `claude`, so an old or hand-edited record loads instead of dropping every run in the file, and no consumer, wire type or contract schema ever sees a fourth runner (pre-rename issue 547). Follow that precedent for any id this project renames: widen the READ, fold to the current spelling, and leave the authored surfaces (request bodies, settings, workflow step defs) narrow.
  - **Retention is count-based, not time-based** (#679): the index keeps the newest `MAX_RUNS_KEPT = 300` non-archived runs and the newest `MAX_ARCHIVED_KEPT = 500` archived runs — the two counts are independent, so up to 800 records survive — and everything older is evicted. The ordering is oldest-first: `listRuns()` sorts by `createdAt` descending and `pruneOldRuns()` slices past the cap, so the records that go are the ones furthest from newest. The WHOLE run goes with them: its record (removed from the in-memory index and therefore from the next `runs.json` write), its `runs/<id>.ndjson` event log, its `runs/<id>.handoff.md` journal and its `runs/<id>-images/` directory. It is **silent** — no log line, no warning, no user-visible signal — so two measurements over the same store can disagree about the same window and that difference is eviction, not a bug. The prune runs when a run is CREATED: `createRun()` is its only call site, immediately before the save that persists the trimmed index, and it does NOT run on `RunStore.open()`, so opening a store already over a cap trims nothing until the next run is added. Changing either count, making retention time-based, archiving instead of deleting, or warning on eviction is a separate decision, and any change to which runs a reader finds is breaking.
  - Additive for pre-rename issue 737: optional `inputTokens`/`outputTokens` run and step counters plus optional per-step invocation/turn checkpoint fields. Historical records remain valid without them; directional aggregates appear only when every started agent step has complete checkpoints, so an unmetered or interrupted turn cannot leave a misleading partial subtotal. Remaining valid includes remaining VISIBLE: a record that carries only the legacy `tokensUsed` still shows that total wherever the split would otherwise render (thread header, Tasks table, variant subtitle), and never a fabricated direction — `packages/web/src/components/directional-usage.tsx` owns that fallback for every surface. A directional `0` is a metered zero and still renders as a direction; an absent total renders as nothing at all, so "spent nothing" and "recorded nothing" stay distinguishable.
  - Additive for pre-rename issue 935: optional `pinned`/`pinnedAt` — the per-project "Pinned" group. Optional with **no default**, unlike `archived`: absent already means "not pinned", so every record written before this parses and reads exactly as it did, and a consumer that ignores both keys sees the old shape. Unpinning DELETES the keys rather than writing `pinned: false`, so an unpinned record is byte-identical to one that never knew about pins. Archiving clears them (`setArchived` and the bulk `archiveFinished` sweep alike) — the same rule, and for the same reason, as the pending auto-resume it also retires.
  - Additive for pre-rename issue 751: optional `diffStat.repointed` — written **only as `true`**, and only for a run whose worktree HEAD had been checked out onto a branch other than the task's own, where the numbers are therefore narrowed to what that run did to the branch it found. The `{adds, dels, files}` numeric shape is unchanged and the key is absent on every other record, so a consumer that ignores it reads exactly the shape from before pre-rename issue 751. What *did* change for those runs is the **values**: a review or QA task that used to report the reviewed branch's whole diff now reports only its own. The values move once more in the follow-up fix: the anchor is the freshest base ref rather than a stale local one, and a repointed worktree is measured against the branch as the run found it rather than against `HEAD` alone — so runs that reported `+0 −0` for committed work now report it. Historical records keep their old numbers until the run's next turn-end — there is deliberately no backfill, because recomputing a finished run's stat would require a worktree that may already be reclaimed.
- **`runs.json` → `verdicts` / `verdictIssues`** (#460) — optional arrays on `RunRecord` holding a reviewer's own report about the task, and the reports that were refused. The shape is the CONTRACT's (`packages/contract/src/task-verdict.ts`), imported by the store rather than restated, so the file and the wire can never disagree. Both keys are optional with no default and both carry `.catch(undefined)`: absent means "no reviewer report", which is what every record written before this carries and exactly what it means, and a hand-edited or future-shaped entry drops its own field instead of taking the whole index down with it. Three rules are load-bearing and a change to any of them is breaking rather than a refinement. **The verdict vocabulary is per role and is never translated** — `APPROVE`/`REQUEST CHANGES`, `PASS`/`FAIL`, and the design reviewer's third outcome `PASS WITH FOLLOW-UPS`, which is neither of the other two; a shared pass/fail enum would erase a design review's outstanding work and make a QA `PASS` read as business acceptance. **Label evidence distinguishes absent from empty**: `state: "unavailable"` carries NO `observed` key, and `state: "verified"` with `observed: []` is a real "there are no labels" — collapsing the two is the fail-open bug the field exists to prevent, so the schema refuses `unavailable` WITH an observed list. **`publication` is a two-step marker, not a status**: the packet is written `pending` before anything announces it and flipped to `announced` after the journal row, so a crash between the two is recoverable by the report's own stable `id` — one logical report, never zero and never two. At most one packet per role, so at most three. **A findings list is counted, never silently short** (#673): `findings` and `findingsOmitted` ride the same contract shape rather than restating it, they are an optional pair, and a list present without its counter is refused — a missing counter beside a truncated list would read as complete, which is the one failure the counter exists to prevent. An older xezar ignores all of these keys and behaves exactly as it did; a downgrade that re-serializes `runs.json` drops them, and a dropped verdict must be read as "no reviewer report", never as approval — a dropped findings list the same way, as "no findings reported in this form", never as "clean".
- **`runs.json` → `steps[].progress`** (#460) — an optional advisory liveness snapshot per step, the CONTRACT's shape (`packages/contract/src/run-progress.ts`) imported by the store rather than restated, and carrying `.catch(undefined)` like `verdicts`: a hand-edited or future-shaped value drops its own field instead of taking the whole index down. Absent means **unobserved**, which is what every record written before this carries — never "healthy", and never a reason to conclude a step was fine. Three rules are load-bearing. **`null` is a value, and it means unknown or unlimited** — `lastActivityAt: null` is "nothing has been seen", `effectiveTimeoutMs: null` is "no wall clock, or none this backend reported", and neither is zero or now; making any of them optional-and-absent instead would let `JSON.stringify` drop the distinction. **It is written on transitions only** — the step's start, and a stall appearing or clearing — never per transcript delta and never on a timer tick that changed nothing, because every write bumps the run's version and fans the record out over SSE. **A finished step carries no `stall`**: the observation is about something live, and the journal keeps the history. An older xezar ignores the key and behaves exactly as it did; a downgrade that re-serializes `runs.json` drops it, and a dropped observation must be read as "unobserved". Breaking: making it required, persisting per-tick snapshots, rendering an unlimited timeout as a finite number, or letting anything act on a `stall`.
- **`runs/<id>.handoff.md.verdict.json`** (#460) — the packet's drop point: a reviewing task writes it, the engine reads it once at that step's settlement and REMOVES it. It is therefore transient rather than state — nothing reads it afterwards, and the durable copy is the `verdicts` entry above, which is why a reclaimed worktree cannot take a recorded verdict with it. The path is derived from the handoff journal's and is handed to the agent as `XEZ_HANDOFF_FILE` + `.verdict.json`; changing either half is breaking, because the producer side lives in versioned reviewer instructions the engine does not ship. The same applies to `XEZ_STEP_ID`, the per-step agent environment variable a reviewer reads to fill `stepId`: it is set on every agent spawn (empty, never omitted, when the caller names no step), it is the ONLY source an agent has for that value, and removing or renaming it silently costs every verdict a copied reviewer instruction would otherwise have recorded. Bounds are part of the contract: at most 40 KB, a regular file (a symlink is refused, checked on the path AND on the opened descriptor), and a `taskId`/`stepId` that name this task and this settling step. The findings half adds its own, and the 40 KB file bound is UNCHANGED and remains the backstop behind them (#673): at most 20 findings, at most 16 KB of serialized `findings` measured in UTF-8 BYTES rather than characters, per-field character bounds (id and fingerprint 64, file 260, title 160, body 300), a `line` only ever beside a `file`, ids unique within one packet, and the `findings`/`findingsOmitted` pairing. Every one of them refuses the WHOLE packet: a packet recorded with part of its findings is the "some of it arrived" state these bounds exist to prevent, and the producer can rewrite and retry. A packet failing any of them is refused into `verdictIssues` and yields no verdict of any kind — an ingestion failure must never be indistinguishable from a task that reported nothing.
- **`runs.json` → `queuedMessages`** (pre-rename issue 472) — optional array of `{ id, text, images?, createdAt }` on `RunRecord`: prompt messages stacked onto a run while it waits for a free agent slot. Absent reads as an empty stack, so files from before pre-rename issue 472 parse unchanged. Folded into `{{task}}` at dequeue by `hydrateQueuedInput`, which is deliberately READ-ONLY: it never writes the folded prompt back to `task`, or every restart would re-append the stack and compound without bound. Like `task`, `text` is deliberately **not** scrubbed by `redactPatch` — it is replayed into the prompt verbatim, so redacting it would corrupt the run.
- **`runs/<id>.ndjson`** — append-only event log, one JSON object per line with `seq`, `ts`, `type`, free extra keys. Readers skip bad lines. Never rewrite, reorder or re-number an existing file; event `type` strings are part of the format (GUI replay + `xezar run` console rendering).
- **`runs/<id>.handoff.md`**, **`runs/<id>-images/`** — Markdown journal and attachments; deleted with the run.
  - **One list, both kinds (pre-rename issue 950).** `taskImages` and `queuedMessages[].images` hold URLs of the run's attachments, and since pre-rename issue 950 those can be files (`pasted-3.pdf`, `pasted-4.md`, `pasted-5.txt`) as well as screenshots. The SHAPE is unchanged — still one array of strings per message, still one `pasted-<n>`/`screenshot-<n>` numbering space in `runs/<id>-images/` — so a record written by this version parses on an older xezar. What an older xezar DOES with a file entry is the honest cost of keeping one list: its cockpit renders a broken `<img>`, and its engine re-encodes the file as `image/png` when it re-reads the stack at dequeue. That was preferred to a second on-disk list, which every reader (the orphan sweep, the dequeue re-read, the per-stack cap, the bubble) would have had to learn about, and which an older xezar would have dropped entirely. Reading code must branch on the NAME's extension (`isImageAttachmentName`), never on which list the entry came from.
- **`ui-state.json`** — GUI prefs; schema is `.passthrough()` so unknown keys survive round-trips. Keep it that way — never strip keys you don't know.
- **`config.json`** — user-owned (`packages/xezar/src/config.ts`): missing/invalid degrades to defaults; the `PUT /api/v1/config` handler merges into the raw file so user keys survive and defaults are never materialized. Renaming any key (`skillsRepos`, `maxParallel`, `worktreeRetention`, `memoryLimitMb`, `defaultRunner`, `plannerModel`, `namerModel`, `liveTitleUpdates`, `reviewGate`, `baseBranch`, `systemPrompt`, `defaultModels`, `modelsLocked`) or changing a default is breaking; accept the old key as an alias during migration. `modelsLocked` is additive and optional: only `true` makes native per-runner model settings authoritative, while absence/`false` preserves the normal model selectors. Since 0.17.0 (#677 C2, owner 2026-09-20: "Both doors, like every key") `PUT /api/v1/config` — and so the MCP `project_config` `set_config` — accepts `modelsLocked`: `true` stores it, `false`/`null` DELETE the key and never write `false`, so `XEZ_AGENT_MODELS_LOCKED` and the workspace key still decide; the answer gains the additive `projectModelsLocked` (the file's own key) beside the effective `modelsLocked`. Storing `false`, or letting a project write lift the environment's or the workspace's lock, is breaking. (Since the multi-project workspace, the per-repo `maxParallel` key is still parsed and written but no longer drives enforcement — the workspace `resources` do, seeded from it once by migration 001; sections 2 and 9. The per-repo `memoryLimitMb` is enforced again as of B2: it overrides the workspace ceiling for runs in that repo, the same way a registry entry's `maxParallel` overrides the workspace cap.) `plannerModel`, `namerModel` and `skillsRepos` became settable through `PUT /api/v1/config` and Settings → Agents (E); they were file-only before, and renaming or re-defaulting them stays breaking.
- **`todos.json`**, **`launch-key`** — inbox entries (spec 007) and the bookmarklet secret. The inbox is opt-in since pre-rename issue 471, but the file's format is unchanged and its entries are **never** deleted by the gate: turning the Inbox back on (the stored `followups` key, or `XEZ_FOLLOWUPS=1` when none is stored) must surface exactly what was there before.
- **`tmp/<runId>/`** (pre-rename issue 785) — the temp directory handed to that run's agent as `TMPDIR`/`TEMP`/`TMP`. Purely additive scratch: nothing else reads it, it is re-created on demand by the next spawn, and it is removed when the run leaves the active registry (plus a startup sweep for whatever a crash left behind). The sweep is confined to this subtree and enumerates nothing beside it — reaping anything under `runs/`, `worktrees/` or `runs.json` from here would be breaking.
- **`.local/.gitignore`** — maintained by `ensureDataGitignore` in `packages/xezar/src/index.ts`. Everything the engine writes lives under `.local/`, so one blanket `*` rule covers every present and future run-data file; a new state file outside `.local/` would need its own rule and should not exist.

Breaking: any change that makes an existing file unparseable, silently discarded, or rewritten into a new shape without reading the old one. Required path: read old + new shapes for at least one minor release (a lazy upgrade-on-read is fine since writes go through the schema), or ship an explicit migration; never require the user to delete `.local/xezar/`.

The maintained kit lives in `.xezar/` and runtime state in `.local/xezar/`, with no discovery step and no per-file overlay: each is exactly one directory.

**Deliberate break, recorded here on purpose.** Xezar no longer reads the pre-`.xezar` layout (`.ai/xezar/`) at all — not as a kit, not as a run store — and the `migrate-layout` command that used to move it is gone. A repository that still has only that directory is treated as a project xezar has never seen: it starts with default settings and an empty run history. Nothing is deleted, moved or rewritten, so the old files stay on disk and can be moved by hand — maintained files (`config.json`, `workflows/`, `skills/`, `checks/`, `docs/`, guidance) into `.xezar/`, run state (`runs.json`, `runs/`, `worktrees/`, `todos.json`, `ui-state.json`, `launch-key`, `automations*`) into `.local/xezar/`. Registered task worktrees must move through `git worktree move` so their metadata stays valid. See [project layout](docs/project-layout.md).

## 4. Workflow YAML format (`packages/xezar/src/workflows/types.ts`)

Users commit these files (`.xezar/workflows/*.yaml`) and share them across repos — the compact `skills:` form exists specifically to be portable. Protected shape: `name`, `description?`, and `steps` XOR `skills`; per step `id`, `name?`, agent fields (`prompt`, `skill`, `model`, `runner`, `allowedTools`, `bashAllowlist`, `timeout`) XOR check fields (`command`, optional `resultScope: routine | stage`, `onFail: {retry, max}`); the `{{task}}` token; `onFail.retry` referencing an earlier step; the built-in `quick-task` name.

`resultScope` (#460, PR 4) is additive and check-only. An absent value means `stage`, preserving every custom and historical workflow's successful-check push. `routine` suppresses only a successful check from attached-leader pushes; it never removes the journal row, changes a read, or suppresses a failure. Making the field required, changing absence to routine, or accepting it on an agent step is breaking.

`timeout` (#22, 0.13.0) is the newest of those and additive by construction: it is optional, no file that predates it names it, and an ABSENT `timeout` is pinned to the exact spawn it produced before the field existed — the workflow's last (interactive) step uncapped, every earlier agent step falling through to the runner's 30-minute `DEFAULT_RUN_TIMEOUT_MS`. That default is now a protected surface in its own right: changing what an absent `timeout` does is a break even though no key changed. Its grammar is protected too — `<digits><s|m|h>` and the literal `none` — so a workflow written for 0.13.0 keeps loading. `none` is the only spelling for "no cap"; a zero-length duration and anything past Node's timer ceiling (`596h`) are refused at load time, and widening either later would be additive, not breaking.

Breaking: renaming a key, tightening a refinement so previously valid files fail to load, changing `{{task}}` substitution, changing `onFail` semantics (retry target, `max` default of 2), removing a `runner` value, or changing the cap an absent `timeout` resolves to. Note the loader already degrades per file (bad files are reported in `issues` and skipped, `xezar run` prints `! skipped …`) — but "your existing workflow is now skipped" is still a break. Required path: accept the old spelling alongside the new, and have `POST /api/v1/workflows` keep writing the most portable form.

## 5. Skills Markdown format (`packages/xezar/src/skills.ts`)

A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); the body becomes the agent's extra system prompt. Protected: frontmatter keys; the `SKILL.md`-in-a-directory convention; the discovery locations and their precedence (`.xezar/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → `~/.agents/skills`, `~/.claude/skills` → team repos); name-collision resolution ("the user's repo is the source of truth"); the `config.json` `skillsRepos` source shape (`{repo, ref}` — GitHub shorthand, git URL, or local path).

Breaking: requiring frontmatter, dropping a discovery directory, or inverting precedence so a team skill shadows a local one. Required path: additive discovery only; a precedence change needs a README callout and a minor bump.

The Manage-skills opt-out (`importedSkills` in the global `~/.xezar/ui-state.json`) preserves this contract: the key is a tri-state and its **absence keeps the historical full default-repo catalog**, so an existing install that never curated sees exactly what it saw before. Only a *present* array (the user actively curated in the Skills page) narrows the default repo, and only that repo — a `config.json` `skillsRepos` the user configured is never gated. The selection lives at workspace scope (not the per-repo `.local/xezar/ui-state.json`) so it follows the user across projects and never depends on the launch directory. Emptying the default catalog for a not-yet-curated install would be the breaking case, and is deliberately not what happens.

## 6. npm package surface (`package.json`)

- Name `@qodeca/xezar` — one published package, no alias distribution; `bin` entries `xezar` + `xez`; published `files` (package-relative): `dist`, `web/dist`, `scripts`, `README.md` — the cockpit's `xezar.svg` reaches the tarball inside `web/dist`, copied there from `packages/web/public/` by the web build, and `README.md` is copied in from the repo root by `prebuild`; `engines.node >= 20`; `"type": "module"`.
- The `exports` map publishes `.`, `./app-type` and `./package.json`, and nothing else. Once a package declares `exports`, Node hard-blocks every unlisted subpath, so adding one is a new compatibility surface and removing one breaks every consumer that imports it. `packages/xezar/test/e2e/package-exports.test.ts` resolves every advertised specifier from OUTSIDE the package, which is the only place that class of break is visible (pre-rename issue 851).
- `dist/index.js` must remain the bin entry, and `web/` must stay resolvable relative to `dist/server` (`resolveWebDir` walks `../../web`; the built cockpit lives at `packages/xezar/web/dist`).
- The tarball MUST contain the built UI (`packages/xezar/web/dist/index.html` + hashed `packages/xezar/web/dist/assets/*`) — `npm run check:pack` (`packages/xezar/scripts/check-pack.mjs`, run as the last leg of `npm run build`, which the manually dispatched `Release` workflow runs before it publishes — `.github/workflows/release.yml`) enforces this; do not remove it from the build chain.

Breaking: dropping a bin, raising `engines.node`, removing `packages/xezar/web/dist/` or `scripts/` from `files`, renaming the package, removing an `exports` subpath. Required path: raise `engines` only in a version bump flagged as breaking; keep old bins through a deprecation release.

## 7. Agent event protocol (`packages/xezar/src/core/agent-runner.ts`, `packages/xezar/src/core/ui-events.ts`)

The normalized streams every runner emits — persisted to `runs/<id>.ndjson` and replayed by both the cockpit and `xezar run`'s console. Two layers ship together and both are contracts; `AGENT_PROTOCOL.md` is the full spec.

- **v1 `AgentEvent`** (`agent-runner.ts`) — the flat stream. Its `type` strings (`text`, `tool-call`, `tool-result`, `image`, `token-usage`, `cost`, `session`, `turn-end`, `note`, `done`, `error`) are part of the on-disk NDJSON format and of the console renderer. Old recordings must keep replaying forever, so a v1 type is never removed or renamed.
  - A `note` may carry an **optional additive `tone: 'danger'`** (pre-rename issue 936) when it reports something the user actually lost — a discarded `XEZ:ASK` question, or one recovered from a truncated payload that may have taken an option with it — so the line is not rendered as the dimmest in the thread. Absent is the default and stays dim, which is what every note written before the field existed replays as; an unrecognized value degrades to dim rather than to an error. Making `tone` required, or letting its absence mean anything but dim, is breaking.
- **v2 `UiEvent`** (`ui-events.ts`) — the normalized item-lifecycle protocol, emitted **alongside** v1 (never replacing it; a mixed v1+v2 NDJSON file is valid by design). Its dotted `type` discriminators (`session.started`, `session.ended`, `session.error`, `turn.started`, `turn.completed`, `item.started`, `item.delta`, `item.updated`, `item.completed`, `plan.updated`, `usage.updated`, `image`, `ask.requested`, plus the reserved `permission.requested` / `permission.resolved`), the `UiItem` kinds (`message`/`reasoning`/`tool`), and the enum vocabularies (`ToolStatus`, `ToolKind`, `StopReason`, `PlanStatus`) are the wire shape the cockpit renders and the golden fixtures pin. `ask.requested` (pre-rename issue 473, AskUser) is emitted by the RunManager off the portable `XEZ:ASK` turn-end marker; Codex also emits the same additive event through its native `requestUserInput` bridge (pre-rename issue 565). It is not a mapper parity capability. What that marker ACCEPTS may widen (a payload missing only its closing brackets is repaired and now yields a card where it used to yield nothing, pre-rename issue 936) — widening is additive, since no consumer can have depended on a question being thrown away — but the emitted `questions[]` shape and the schema behind it are the contract, and loosening the schema itself is not.
- **`AgentRunner.defaultTimeoutMs`** (#460, additive and OPTIONAL) — a read-only report of the wall clock a runner applies when a spec names none, so a caller can say when a step will be killed without re-deriving a number per backend. It is reported, never set: `AgentRunSpec.timeoutMs` still decides, and nothing about the kill itself changed. Optional on purpose — absent means UNKNOWN (a caller simply gets no deadline to speak of, never a guessed one), and it keeps every existing implementation, including a test double, satisfying the interface exactly as it did. Breaking: making it required, or letting it disagree with the value the runner's own session uses.
- **Golden fixtures + parity** — `packages/xezar/src/core/__fixtures__/<backend>/*.expected.json` are the hand-verified contract per mapper, and `packages/xezar/src/core/ui-parity.test.ts` makes "every capability is emitted by **every** backend" executable. `BACKENDS` there lists every backend that owns a wire mapper, including pi's RPC mapper. The cockpit degrades per-capability, never per-backend; a change that lets one backend stop emitting a matrix capability is a regression, not a per-backend nicety.
- **Cross-refs** — the SSE event names carrying these (`run-event` v1, `ui-event` v2) are in section 2; the `runs/<id>.ndjson` append-only format is in section 3. The api-client's mirror (`packages/api-client/src/protocol/ui-events.ts`) is held type-exact by `packages/xezar/src/server/api-types.test.ts`.

Breaking: removing or renaming a v1 `AgentEvent` type or a v2 `UiEvent` `type`/`UiItem` kind; removing a field consumers read; narrowing an enum so a previously emitted value disappears; or dropping a parity capability from a backend. Additive is fine (new optional field, new event type — protocol v2 event types are additive by design; a new `ToolKind`/`StopReason` member is additive). Required path: read old + new shapes for at least one minor release (old NDJSON must still replay), and follow the parity requirement when adding a backend — a new runner is not compatible until it emits every matrix capability (`AGENT_PROTOCOL.md` §9). See also `AGENT_PROTOCOL.md` for the full schema, per-backend mapping, and new-runner checklist.

## 8. In-band agent marker vocabulary (`packages/xezar/src/handoff.ts`, `packages/xezar/src/runs/task-markers.ts`)

The plain-text markers the handoff contract asks every agent to emit and the engine parses from
turn text: `XEZ:DONE` (pre-rename issue 347), `XEZ:MONITORING` (pre-rename issue 490), and the task-reference markers
`XEZ:PR=<n>` / `XEZ:ISSUE=<n>` / `XEZ:TITLE=<phrase>` (spec 2026-07-18-task-ref-markers). These
are an agent-facing contract: skills, prompts, and running agents rely on an emitted marker
meaning what it meant when their session started.

Final interactive turns and Continue also accept a standalone `XEZ:DONE` line anywhere in
that turn (#524), including spaces/tabs and CRLF. A checkpoint after that line is accepted;
the previous end-of-turn form remains accepted. Detection uses accumulated turn text before
autonomous nudging, and DONE still wins over ASK/MONITORING. This broadens final-turn completion
only: markerless turns, explicit monitoring and the non-final-step guard below retain their rules.
Fenced examples never count as final-turn DONE markers, including unclosed fences.

Continue on an interrupted workflow (#520) keeps the completed prefix. After the continued agent
turn emits DONE, an interrupted agent step is completed, a failed check is rerun, and every later
step executes in definition order. A failed retry stays failed; success/review is published only
after the workflow tail finishes. This also repairs older `done` records with unfinished steps,
and survives restart or quota failure during the repair. Fully completed workflows retain their
agent-only follow-up behavior. Existing stored definitions and step states suffice: no migration
or new required field. Missing definitions with unfinished recorded steps fail closed. Automatic
check-repair limits remain bounded across Continue. Worktree isolation, leases, cancellation and
final autosave remain in force throughout the resumed tail.

`XEZ:DONE` in a NON-FINAL agent step (#317): that step is done only when its last turn ends with
the marker. Before #317 an absent marker there was inert and the step was marked done whenever its
session closed cleanly, so a step that ended on a question carried the workflow on without the
answer. An emitted `XEZ:DONE` still does what it did; what changed is that its absence now fails
the step with a message naming the marker, and the run stops (Continue reopens that session). The
last agent step keeps its interactive rules. A custom workflow whose earlier agent steps finish
without the marker is affected; there is deliberately no flag to restore the old default.

Autonomous re-prompting is bounded twice (#613). An autonomous Continue whose remaining workflow
needs `XEZ:DONE` from the continued turn (the #520 case above) gets at most 3 automatic re-prompts
(`MAX_GATED_CONTINUE_NUDGES`) instead of 40, and when a bound stops it the turn fails at once
instead of parking until the idle close. Its error keeps the prefix `remaining workflow requires
XEZ:DONE from the continued turn` and appends `— automatic re-prompting stopped after N turns — `
plus the reason, so a consumer matching the old text still matches. In every autonomous run, a turn
started by an automatic re-prompt that emitted no `tool-call` event is idle and stops the
re-prompting with a `note`; the first re-prompt is never judged. A last step (or a completed
workflow's Continue) keeps its 40-re-prompt budget for turns that do work, and still parks when a
bound stops it. Non-autonomous runs, `XEZ:DONE`, `XEZ:MONITORING` and the monitoring wake-up are
unchanged. No flag restores the old loop; the marker vocabulary itself is unchanged.

Breaking: removing or renaming a marker, or changing what an emitted marker does (e.g. making
`XEZ:PR` gate an action instead of steering display). Additive is fine — a new `XEZ:*` marker is
inert prose to older xezars, which is the property that keeps the vocabulary forward-compatible.
Required path for a change: keep parsing the old spelling for at least one minor release while
the instructions emit the new one.

## 9. `~/.xezar/` per-user workspace files (`packages/xezar/src/workspace/`, `packages/xezar/src/paths.ts`)

The multi-project workspace adds per-user state next to the per-repo files in section 3. Same contract, one extra twist: these files are shared by **every** xezar the user runs across all their repos, so an old CLI and a new one routinely read and write the *same file* — the `.passthrough()` rule cuts both ways (an **older writer must not lose keys a newer version wrote**, not just vice versa). All paths hang off `xezarHomeDir()`, so the `XEZ_HOME` override applies (tests and containers must pin it and never touch a real home).

**Since 0.16.0 the three files below can live somewhere else** — in single-project mode they are `<project>/.xezar/workspace.json`, `<project>/.xezar/agent-accounts.json` and `<project>/.xezar/workspace-ui.json`, resolved through one resolver (`packages/xezar/src/state-layout.ts`). Every rule in this section — the key contracts, the `.passthrough()` discipline, the merge-write lock, the degradation behaviour — applies unchanged whichever layout is in force. What changes is only WHERE, and the twist above is what changes with it: in the project layout these files are NOT shared by every xezar the user runs, they are shared by everyone who clones the repository. See [Single-project ROOT mode](#single-project-root-mode--the-folder-owns-the-state-0160-600).

- **`config.json`** (`packages/xezar/src/workspace/config.ts`) — workspace config + project registry: `schemaVersion` (the migration cursor), `browseRoot` (local-folder picker boundary), `projectsDir` (clone destination), optional `skillsAutoUpdate` (absence inherits `XEZ_SKILLS_AUTO_UPDATE`, then the default `true`), optional `modelsLocked` (only `true` makes native per-runner model settings authoritative in every project), optional `agentDefaults` (`runner`, `models` — the machine-wide agent and model a project with none of its own falls back to; absent means no opinion, which is what keeps them defaults rather than settings every repo inherits), optional `followups` and `agentEnvPassthrough` (the stored counterparts of `XEZ_FOLLOWUPS` / `XEZ_ENV_PASSTHROUGH`; absent inherits the env, and `agentEnvPassthrough: []` is a real "forward nothing"), optional `composerDefaults` (the New Task policy) and `disabledProviders` (host-wide provider preferences; absent = every provider enabled), `resources` (`maxParallel`, `maxMonitoringSessions`, `monitoringWakeIntervalMinutes`, `autoResumeOnUsageLimit`, `idleTimeoutMinutes`, `memoryLimitMb`, `worktreeRetentionDefault`), optional `cli` (`{output?, color?, logLevel?, instance?}` — the workspace-wide terminal presentation defaults of #467, plus `instance?`, which is not presentation but WHICH projects a process serves; absent inherits `XEZ_INSTANCE`, then `workspace`, and since 0.17.0 every key of this object is one a person or a leader can EDIT (the owner's decision D-5 of 2026-09-20 added the three presentation keys to `instance`) — `PUT /api/v1/workspace/config` `cli.*` and the MCP `project_config` action `set_workspace_config`, both validating with the same contract schema, both writing through `mergeWriteWorkspaceConfig`, and neither able to touch a key the body did not name, so a write that clears one leaves the others exactly as they are; the other three absent inherit `XEZ_OUTPUT` / `XEZ_COLOR` / `XEZ_LOG_LEVEL`, then the built-in default, and a value the vocabulary does not know degrades to absent with one warning rather than failing the load), `projects[]` (`{id, root, name, addedAt, lastOpenedAt, source, maxParallel?, tags?, cli?, lastListen?}` — `tags?` are the grouping labels the global Tasks page reads; absent means untagged, and the writers delete the key rather than storing `[]`. `cli?.port` (#467) is the port a person CHOSE for this project, written only by `xezar projects port` and never by a start, by `--port` or by `XEZ_PORT`. `lastListen?` (`{port, host, observedAt}`, #467) is where this project's cockpit last really listened — a HINT, written once after `listen` succeeds, never for a `--port 0` start, carrying no pid, lease or socket path, and never to be rendered as "running" without a liveness check of its own). Every field is optional/defaulted — a bad value degrades per-key, a corrupt registry entry is dropped per-entry, never the whole array; `.passthrough()` at every object level so unknown keys survive round-trips through any version. The effective skills preference is computed at read time and unrelated writes must not materialize the optional key. Writes are read-modify-write merges with atomic tmp+rename, mode `0600` (dir `0700`), and since #467 the whole read→mutate→write runs under a bounded cross-process lock (`config.json.lock`, `packages/xezar/src/workspace/config-lock.ts`) that **every** writer inherits by going through `mergeWriteWorkspaceConfig` — `serve`, `xezar projects`, the settings routes, migrations and the MCP. The lock is fail-open by contract: a lock held past its bound, or a home it cannot be written into, degrades to exactly the pre-#467 behaviour with one warning and never blocks a start. Adding a second writer that does its own atomic write, or making the lock able to fail a start, is breaking. A corrupt file degrades to in-memory defaults with one warning and is **left on disk untouched** until the next successful merge-write replaces it. The registry is additive state that is *written, never required* — it rebuilds as projects are opened, so losing it is an inconvenience, not data loss, and no code path may ever demand its existence. **`resources.memoryLimitMb`'s ABSENT default changed (B1)**: it used to read as `null` (no guard) and now derives a host-sized ceiling — `floor(totalMiB * 0.6 / 2)` clamped to [1024, 8192] MiB (`deriveDefaultMemoryLimitMb`). This is deliberate and is the one direction § Zero config allows: the previous zero-config default was the UNSAFE one (the OS OOM-killer instead of the engine pausing one run). An explicit `"memoryLimitMb": null` on disk still means "no limit" and is never replaced, because zod's `.default()` fills `undefined` only. `resources.idleTimeoutMinutes` is additive with the same absent-vs-null discipline: absent reads as 15 (the value `IDLE_TIMEOUT_MS` hard-coded), explicit `null` means "never close an idle session". `resources` is the **enforced** copy since Phase 2: the workspace semaphore (`packages/xezar/src/workspace/semaphore.ts`) caches this slice in memory (refreshed at boot and by `PUT /api/v1/workspace/config`, never re-read per tick; a failed re-read keeps the last good snapshot, never degrading to unlimited) and applies `maxParallel` across every project's manager with the pre-rename issue 347 waiting-run exemption intact — the per-repo `maxParallel` stopped being consulted post-migration, while the per-repo `memoryLimitMb` is consulted again as of B2 and overrides the workspace ceiling for that repo's runs (sections 3 and 5).
- **The workspace config file is watched (#677 D1)** (`packages/xezar/src/workspace/config-watcher.ts`) — while `serve` runs, a hand edit of that file or a merge-write by another xezar process reaches `semaphore.refresh()` as one coalesced re-read on the watcher's next delivery of the change, so every key the semaphore caches is live without a restart or a request; the sibling lock, takeover-guard, tmp and `.bak` files never fire it. **What the 250 ms debounce guarantees is coalescing, not latency**: a burst of events collapses into one re-read, but the OS's own delivery time is outside this module's control — usually within the debounce window, but the OS may coalesce or drop a delivery, so a hand edit can take seconds and, rarely, still need a restart. An unwatchable directory logs one warning and leaves the pre-D1 behaviour (live on the settings routes, restart for anything else); making the watch able to fail a boot, or dropping it so a hand edit needs a restart again, is breaking.
- **`agent-accounts.json`** (`packages/xezar/src/workspace/agent-accounts.ts`) — extra config dirs for a second login of the same agent CLI, plus which one each project uses: `version`, `accounts[]` (`{id, provider, configDir, label, addedAt}`), `selections` (repo root → `{claude?, codex?, opencode?, pi?}`), `defaults` (the machine-wide per-provider fallback a repo with no selection of its own uses). Same house rules as `config.json`: per-key `.catch` degradation, per-entry salvage for `accounts`, `.passthrough()` at every level, merge-write with atomic tmp+rename `0600`, and a corrupt file left on disk after one warning. **Its own file on purpose, and that IS the compatibility argument**: the twist named above — an older writer must not lose a newer version's keys — is a promise this repo cannot make on behalf of a build the user might switch to, and it fails outright whenever any version cannot parse `config.json` (that degrades to in-memory defaults, and the next merge-write persists them). A version that has never heard of accounts does not open this file, so it cannot drop them. Selections live here rather than on `projects[]` for the same reason, and so that deleting an account and scrubbing every reference to it is one atomic write. Accounts written into `config.json` by the branch that first shipped them are imported once and non-destructively — `config.json` keeps its keys, so an older xezar sharing the home reads exactly what it always read. Written, never required: delete the file and every project falls back to its discovered account.
- **`ui-state.json`** — the global twin of the per-repo GUI state in section 3, holding cross-project prefs (`appearance`, `notifications`, `importedSkills`, plus the legacy `sidebar.collapsed` and `lastLocation` keys the cockpit now keeps per-browser in localStorage and no longer reads here); per-project state (pinned runs, templates) stays in each repo's `.local/xezar/ui-state.json`. Same rules as its twin: unknown keys survive round-trips, writes go through the merge path (`mergeWriteWorkspaceUiState`) with atomic tmp+rename `0600`, and a missing or corrupt file merges from `{}`.
- **`appearance.density` gains `roomy`** (#424 step 4, in this file and its per-repo twin in section 3) — an added enum value, additive and not a break; no migration. The one definition is `appearanceSchema` in `packages/contract`, which both ui-state routes validate with. An older cockpit coerces an unknown value back to comfortable (`normalizeDensity`); an older server rejects the save, and the cockpit shows the message, puts the previous choice back and refetches. One caveat: an older cockpit that then changes accent or width PUTs the whole `appearance` object with `comfortable` and so overwrites a stored Roomy.
- **Migrations** (`packages/xezar/src/workspace/migrations.ts`) — the only sanctioned way to reshape these files, and the framework contract is itself protected: migrations run **ordered** (ascending `to`), are **idempotent** (safe to re-run after a crash mid-way), **additive** (they never delete or rewrite the user's per-repo files — migration 001 imports `maxParallel`/`memoryLimitMb` and the `appearance`/`notifications` ui-state keys by *copying*, leaving every per-repo file in place so a downgraded xezar keeps working off its local copies exactly as before), and **non-blocking** (a failure logs one warning and boot proceeds degraded on in-memory defaults; it is never a boot failure). `schemaVersion` is persisted after **each** migration, so a crash resumes exactly where it left off; an absent version means 0 = "run everything", which idempotence makes safe. Run state (`runs.json`, NDJSON) never migrates — it keeps section 3's additive-zod convention.

Breaking: renaming/removing a key or changing a default in either file; making any field required; stripping unknown keys on a write; a migration that deletes or rewrites per-repo files, or whose failure blocks boot; any code path that requires the registry to exist. Required path: same spirit as section 3 — additive first, read the old key as an alias for at least one minor release; anything more structural ships as a numbered migration that obeys the contract above.

The default-on team skills updater is an owner-approved exception to the normal opt-in rule for network and external-file mutation. Its compatibility boundary is deliberately narrow: work begins only after listen; checks are six-hour cached and bounded; updates name only sorted, lock-proven `qodeca/xezar-skills` entries, run serially under two stale-recoverable cross-process locks — the PROJECT half at `<cacheDir>/skills-update.lock` (`~/.cache/xez` globally, `<project>/.local/xezar/cache` in single-project mode) and the machine-wide `~/.agents` mirror at `<home>/.agents/.xez-skills-update.lock`, taken in every layout because that mirror never moves with the project — and failures never reject startup. `XEZ_SKILLS_AUTO_UPDATE=0` (or the stored global override) restores detection-only behavior. Broad scope-only updates, invoking `gh`, updating untracked/manual skills, or making this work boot-blocking are breaking changes.

### Default team skills source moved to `qodeca/xezar-skills` – deliberate, 2026-09-13

The team skills collection moved to its own repository under the product's owner, with the skill
prefix renamed from `om-*` to `xez-*`. This is a deliberate break of section 1's "changing a
default is breaking" rule and of section 9's `skillsRepos` default, taken on the repo owner's
explicit instruction rather than silently. It ships as a minor bump called out as breaking.

- **Broken**: the default `skillsRepos` entry (`qodeca/xezar-skills@main`; the previous default
  repository is no longer loaded unless configured); the lock source the updater recognises
  (only `qodeca/xezar-skills` entries in `skills-lock.json` / `~/.agents/.skill-lock.json` are
  checked and updated – entries from the previous source are reported as `current` with the
  reason "Installed skills come from another source; xezar does not update them" and are never
  touched); the default catalog's skill names (`xez-*`). A curated `importedSkills` list in
  `~/.xezar/ui-state.json` that names `om-*` skills is read as naming the matching `xez-*`
  skills – mapped on read only, never written back – so a selection made before the move keeps
  showing the same skills after it.
- **Not broken**: an explicit `skillsRepos` in `.xezar/config.json` still loads exactly what it
  names, from any repository, and is ungated (a repo that names its own `skillsRepos` gates
  nothing); `skillsAutoUpdate` and `XEZ_SKILLS_AUTO_UPDATE` keep their semantics; the three
  `/api/v1/workspace/skills-update*` routes and their shapes are unchanged; `.ai/skills/` and
  `.xezar/skills/` discovery is unchanged.
- **Restore path**: `"skillsRepos": [{ "repo": "open-mercato/skills" }]` in `.xezar/config.json`
  restores loading of the previous collection (ungated, not auto-updated); the manual
  `npx skills remove …` / `npx skills add qodeca/xezar-skills --skill '*'` migration in the
  README moves an `npx skills` install. xezar migrates neither automatically.

## Follow-up inbox default flip (pre-rename issue 471) — deliberate, 2026-07-17

The global follow-up inbox shipped enabled (spec 007; pre-rename issue 444 added the per-run `generateFollowups`
opt-out). Pre-rename issue 471 turns it **off by default**, re-enabled with `XEZ_FOLLOWUPS=1`: agents kept
hanging on stale, pre-saved follow-ups, which made skill behavior unpredictable — the feature is a
carry-over from the `GitHub janitor` era and is not wanted as a default.

This is a deliberate break of section 2's endpoint list and of the "changing a default is breaking"
rule in section 1, taken on the repo owner's explicit instruction rather than silently:

- **Broken**: the *default* answers of `GET /api/v1/todos` (now `200 []`), `DELETE /api/v1/todos/:id` and
  `POST /api/v1/todos/:id/start` (now `409`); the default value of `POST /api/v1/runs`
  `generateFollowups` (now `false`, and the capability is a hard ceiling on it).
- **Not broken**: every route still exists and behaves exactly as before under `XEZ_FOLLOWUPS=1`;
  `todos.json`'s format is unchanged and its entries are never deleted by the gate; the per-task
  handoff journal (`runs/<id>.handoff.md`, the "Notes" card) and the `XEZ:DONE` marker are
  untouched — pre-rename issue 471 keeps those explicitly.
- **No deprecation alias**: the flag *is* the migration path — one env var restores the old
  behavior wholesale, which the "keep the old spelling for a minor release" rule exists to provide.

## Per-project port memory and CLI output settings — deliberate, 0.16.0 (#467)

A **changed default**, accepted by the owner on 2026-09-16 (decision Q3 on #467) through the path
section 1 requires for one: a note here and in the CHANGELOG, a documented way back, and a minor
version bump called out as breaking.

**What changed.** Without `-p/--port`, `xezar` no longer starts from 4321 every time. It starts from
the first of these that is set:

| # | Source | Set by |
|---|---|---|
| 1 | `-p/--port <n>` | you, for this launch |
| 2 | `projects[].cli.port` | `xezar projects port <id> <port>` |
| 3 | `XEZ_PORT` | your environment |
| 4 | `projects[].lastListen.port` | xezar, after its last successful bind in this project |
| 5 | `4321` | the built-in default |

Then, as before, it takes the next free port from there. Rows 2 and 3 are in that order on purpose:
a `XEZ_PORT` exported once in a shell profile must not outrank a port someone deliberately pinned
for one project. When the start port came from row 4 or row 5, xezar also steps over ports that
**other** registered projects hold or remember, so two projects that are rarely both running stop
swapping ports on every restart and taking saved bookmarks with them. A port from rows 1–3 is tried
exactly as asked.

**The way back.** `xezar --port 4321` restores the old start point for one launch, and
`xezar projects port <id> 4321` makes that permanent for a project. Both then keep the unchanged
50-port fall-forward.

**What did NOT change.** The 50-bind budget (ports skipped for another project do not spend from
it), the 65535 ceiling, `EADDRINUSE`-only retry, the printed port always being the port the server
really holds (#238), `--port 0` (an OS-chosen port, which also ignores memory and is never
remembered), exit codes, `--version`, `--help`, `init` idempotence, the `run` exit contract, and
`server-install`'s own port semantics — a hosted instance's port comes from its own installer state
and is never reinterpreted with `serve` memory.

**New settings, all with working defaults.** `--output <auto|lines|rich>` / `XEZ_OUTPUT` /
`cli.output`; `--color <auto|always|never>` / `XEZ_COLOR` + `NO_COLOR` / `cli.color`;
`--log-level <debug|info|warn|error>` / `XEZ_LOG_LEVEL` / `cli.logLevel`; `-q/--quiet` / `XEZ_QUIET`.
Stored beats environment for the three stored ones, following `followups` / `agentEnvPassthrough`;
a flag beats both.

**What `serve` now prints, and where — a changed default.** Until this release `xezar serve` printed
its banner and then went almost silent. It now reports what the projects in it are doing, and all of
that is **new output on stderr**. The rules a script may rely on:

- **The boot banner on stdout is unchanged, byte for byte.** The banner, the agent and tool checks and the
  `cockpit → <url>` line are exactly what they were, in the same order, on the same stream, so
  `xezar serve | tee`, a wrapper that greps the URL, and a log file that captures only stdout all
  keep working. `run`'s transcript, `init`, `projects`, `--help` and `--version` are untouched, and
  `xezar mcp` still writes JSON-RPC to stdout and nothing else under every one of the new flags.
  One pre-0.16 informational line is deliberately removed from stdout: `recovered N run(s) from
  the previous session`. Recovery is now one stderr activity entry, `task.recovered`, with
  `count` and `settled`; human output says `task`, never `run(s)`, and distinguishes tasks
  deliberately settled at start-up from tasks merely resumed. A script that consumed the old
  line must read stderr's plain output and select `event=task.recovered`. This is part of the
  owner-approved 0.16.0 minor break for #467; no state, exit code or recovery behavior changed.
- **Off a terminal there is not one escape byte.** A file, a pipe, a non-empty `CI` or `TERM=dumb`
  gets append-only plain lines — `<ISO time> level=<level> …` — or uncoloured human lines when
  `--output lines` is explicit, and no cursor movement, even with `--color always`, *even when
  `--output rich` was asked for*. The refusal prints one `output.fallback` line and nothing else.
- **On a terminal** at least 60 columns wide, the last few lines are a live region that is redrawn
  in place: a table of active tasks, at most 10 rows plus an overflow count, at most four redraws a
  second and only while something changes. It is erased on the way out and the cursor is restored,
  on a normal exit and on Ctrl-C. Narrower than that, `auto` prints lines and no table.
- **`--quiet` cannot hide a failure.** It keeps warnings, errors, the real bound URL and each task's
  final status; information lines, recovery notices and the live region go.
- **`event=` names are the MCP catalog's where the catalog has one** (#467, PR 4;
  `packages/xezar/src/terminal/event-names.ts`): the same fact is found under the same name in a
  plain log and in a leader's journal. A park with no structured question is `task.blocked`, a
  routine successful check is a `debug` line, and check lines carry `result_scope`. The
  terminal-only names are a closed list. Renaming or removing a name, or reusing a catalog kind with
  a different meaning, is breaking; adding a name or a field is not. The journal-sourced lines
  (`task.stalled`, `task.resumed`, `verdict.posted`, `executor.*`, E-04/E-05 kinds) need the
  project's MCP service and are absent without it.
- Nothing here cancels a task or stops the service. A closed output (`EPIPE`) stops the *drawing*,
  and the runs and the HTTP server carry on.

**The way back:** `--output lines` for human activity lines (a one-line live summary on a capable terminal),
`--quiet` for warnings and errors only, `NO_COLOR=1` for no colour. Redirecting stderr
(`2>/dev/null`) restores the old near-silence exactly, because every new line is on that stream.

**How a bad value behaves.** An explicit one (a flag, or an `XEZ_*` someone typed) refuses the start
with the accepted values and exit 1, before the registry is read, before the project writer claim
and before any bind. A stored one degrades to absent with one warning and the file is left as it is.

**What is not in this entry.** The cockpit's own navigation between projects, the one-cockpit-per-
project default and `--instance workspace` (owner decision Q2) are a separate change and are not
shipped by this one: `xezar` still serves every registered project in one cockpit.

**Amended 2026-09-20 (#467).** That separate change is shipping, and it shipped with the OPPOSITE
default to the one the Q2 decision above anticipated. The paragraph stays as written because it
records what was true for 0.16.0; what changed is recorded in its own entry below, [Instance
mode](#instance-mode--which-projects-one-process-serves-0170-467), which discharges it. The short
version: `--instance` exists, `project` is opt-in, and `workspace` — every registered project in one
cockpit — remains the default, so nothing in the paragraph above describes behaviour a 0.16.0 user
loses. Since PR 5 the stored key is editable from Settings → Terminal and from the MCP.

## Single-project workspace mode — opt-in narrowing, 2026-07-21

`XEZ_SINGLE_PROJECT=1` deliberately narrows the multi-project workspace to the repository passed
to `xezar serve`. Activation is strict: only the exact string `1` enables the mode; `true`, `yes`,
an empty value, and an unset variable all preserve the default multi-project behavior.

- **Intentionally narrowed under the flag**: `GET /api/v1/health` and `GET /api/v1/projects` expose only
  the launch project; `POST /api/v1/projects`, `POST /api/v1/projects/checkout`,
  `PATCH /api/v1/projects/:projectId`, `DELETE /api/v1/projects/:projectId`, and
  `GET /api/v1/fs/browse` answer `409` before side effects.
  The equivalent `xezar projects add` and `xezar projects remove` commands refuse with exit code 1.
  The cockpit consequently omits cross-project navigation, add-project controls, the global
  Projects settings section, and the New Task project picker.
- **Unchanged by default**: without the exact opt-in, every section 2 route, response, CLI command,
  registry behavior, and cockpit affordance retains its multi-project contract. This is a
  capability mode, not a new default or a persisted workspace setting.
- **Non-destructive rollback**: the mode never deletes, rewrites, or migrates project rows in
  `~/.xezar/config.json`. Unset `XEZ_SINGLE_PROJECT` and restart the server to reveal the full
  registry again; no manual repair or state migration is required.
- **No deprecation alias**: no previously accepted input or default behavior changed. The explicit
  flag is the boundary authorizing the narrower protected surface, and removing it restores the
  protected default wholesale, so an old-spelling compatibility window would serve no purpose.
- **Not superseded by single-project ROOT mode (#600, 0.16.0).** That mode is a separate SUPERSET
  with its own flag, its own file layout and its own capability key, and this entry is unchanged by
  it: `XEZ_SINGLE_PROJECT=1` still means one project, no project management and **global** state, it
  is not deprecated, and nothing about it is scheduled for removal. The two are independent —
  either, both or neither — and `capabilities.singleProject` keeps answering only this question.
  See [Single-project ROOT mode](#single-project-root-mode--the-folder-owns-the-state-0160-600).
  Since 0.16.0 the guards listed above fire for EITHER narrowing, and that widened their condition
  only: with `XEZ_SINGLE_PROJECT=1` set, every refusal above keeps its exact status code, sentence,
  exit code and audit reason, and `single-project-doors.test.ts` pins them byte for byte. The ROOT
  mode refuses with its own sentence, at the same statuses and in the same shapes.
- **`--instance` can never re-widen it (#467, 0.17.0).** `--instance project` and this flag are
  different questions, and where they meet this flag wins: with `XEZ_SINGLE_PROJECT=1` set, the
  instance mode in force is `narrowed`, `/api/v1/health` sends no `instanceMode`, and every
  refusal above keeps its exact text. An explicit `--instance workspace` does NOT defeat the
  variable someone set on purpose — it is ignored, with one line on stderr saying so. Nothing
  refuses the start: two compatible-in-spirit settings meeting is not a typo, and AGENTS.md
  § Zero config forbids failing a boot over one. A bad VALUE still refuses, as it always did.

## Instance mode — which projects one process serves, 0.17.0 (#467)

`--instance <project|workspace>` (`XEZ_INSTANCE`, stored `cli.instance`) answers a question
neither narrowing above answers: whose DATA one process serves. **`workspace` is the default and
is what every xezar has always done** — one cockpit, every registered project — so this is an
opt-in mode and NOT a changed default, and no minor-version deprecation path is owed.

- **A third state, not a spelling of the two above.** `project` mode serves the project it started
  in and keeps everything else: every registered project stays VISIBLE on `GET /api/v1/projects`
  and in `/api/v1/health`, and `POST /api/v1/projects`, the checkout route, `PATCH`, `DELETE` and
  `GET /api/v1/fs/browse` all keep working. A change that starts hiding projects or refusing
  project management has turned this into `XEZ_SINGLE_PROJECT`, which already exists.
- **What it narrows, exactly two things.** A scoped request for another registered project
  (`/api/v1/p/<other>/…`) answers `409` with a sentence naming that project, its folder and the
  project this cockpit serves — refused BEFORE the project writer claim, so no claim file is
  written for a project this process does not serve. And `GET /api/v1/workspace/runs-index`
  answers for this project only.
- **`capabilities.instanceMode`** is optional and sent ONLY when it is `project`. A `workspace`
  payload is byte-identical to a 0.16.0 one, absent reads as `workspace`, and `narrowed` never
  reaches the wire — a narrowed cockpit already says so through `singleProject` /
  `singleProjectRoot`, and a third spelling of one fact is what two readers drifting apart is
  made of.
- **Precedence, and it is the shipped one.** Flag > stored `cli.instance` > `XEZ_INSTANCE` >
  `workspace`. Stored beats the environment for the reason `cli.output` and `cli.logLevel`
  already do: a variable exported once in a shell profile must not outrank a preference someone
  deliberately saved. A bad explicit value refuses the start with exit 1 before the registry is
  read, the writer is claimed or a port is bound; a bad stored value degrades to absent with one
  warning and the file is left on disk.
- **`GET /api/v1/projects` gains the derived `instance?`** (`{state, url?}`, additive, 0.17.0).
  Five states — `this`, `running`, `running-unknown-address`, `stopped`, `checking` — and each is
  the result of a CHECK made for that request: a bounded (300 ms) `GET /api/v1/health` probe of
  the address in `projects[].lastListen`, accepted only when the answer names THAT project as its
  `bootProject`, plus a read of the project's own writer claim, cached for ten seconds. A
  remembered address alone never reaches `running` — that is the promise section 9 makes about
  `lastListen` — and a live process with no remembered address (a `--port 0` start) is
  `running-unknown-address`, never `stopped`. The field is **omitted, never null**, when this
  server did not look, which is exactly hosted mode (`capabilities.localHandoff: false`), where
  no outbound probe is made at all. The stored `cli.port` and `lastListen` themselves stay off
  the wire.
- **Where that probe may reach, and how far.** It asks the bind address that project RECORDED —
  loopback for an ordinary cockpit, and a `--bind-host 192.168.x.y` sibling at that host, which is
  why it is deliberately NOT restricted to loopback; `~/.xezar/config.json` is hand-editable, so a
  host written there by hand is asked as written too. Two properties bound it and both are
  promises: the request carries nothing but `accept: application/json` — no credential, no cookie,
  no project id — and it **refuses redirects** (`redirect: 'error'`, so a 3xx reads as no answer).
  Following one would let whatever holds a remembered port aim this server's single outbound
  request at an arbitrary URL, and let an answer from one server satisfy the identity check for an
  address the row then links to.
- **It is a BOOT decision and cannot be re-taken live.** The MCP socket, the bind and every built
  project context were settled under it. Changing the stored key applies at the next start.
- **The stored keys are editable, and the edit says so** (0.17.0, PR 5). `cli.instance` and — by
  the owner's decision D-5 of 2026-09-20 — its three presentation siblings `cli.output`,
  `cli.color` and `cli.logLevel` are written through `PUT /api/v1/workspace/config` (Settings →
  Terminal, global scope) and through the MCP `project_config` action `set_workspace_config`, both
  validating with the same contract schema, so the two doors produce the identical
  `~/.xezar/config.json`. `null` on a key clears it back to its variable and then its default, and
  a key the body does not name — or a body that does not name `cli` at all — is left untouched on
  disk. The answer reports each key as stored value, what the next plain start resolves and which
  layer decided (`…Source`: `stored`, `env`, `default`, and `no-color` for a `NO_COLOR` that
  outranks a stored colour). Because none of the four can be re-taken live, the control states that
  a change applies at the next start. `cli.inForce` and `cli.narrowing` describe THIS process: a
  cockpit narrowed by `XEZ_SINGLE_PROJECT` is told the narrowing wins here, and a folder that owns
  its state (`narrowing: 'project-root'`) shows its answer as text with no instance control,
  because a stored mode can never take effect there. Answering `inForce` from the stored value, or
  losing the difference between the two narrowings, is breaking.
- **It is not an MCP locator and not a port.** `xezar mcp --instance project` is accepted and
  ignored, its stdout stays JSON-RPC and nothing else, and it still finds its project by
  repository root. Port resolution, the port-memory precedence and `--port 0`'s
  never-remembered property are untouched.

Breaking: changing the default away from `workspace`; sending `instanceMode` in `workspace` or
`narrowed` mode; hiding a project or refusing project management in `project` mode; letting
`--instance workspace` re-widen either narrowing; taking a writer claim for a project this
process refuses to serve; rendering `running` from `lastListen` without a liveness check, sending
`instance` as `null` instead of omitting it, probing another port in hosted mode, following a
redirect out of the health probe, or carrying anything beyond `accept` on it.

## Single-project ROOT mode — the folder owns the state, 0.16.0 (#600)

A folder can own its whole xezar setup. `xez --single-project` in a project folder creates
`<project>/.xezar/{config.json, workspace.json, agent-accounts.json, workspace-ui.json}`, and from
then on **the folder decides**: every `xez` started there is in the mode, flag or no flag, and the
per-user `~/.xezar` is not opened for reading or writing. Working files stay in
`<project>/.local/xezar`. The point is that a clone of the repository runs with the settings,
accounts and limits the repository carries, with no host setup step. `--global-layout` (#657,
unreleased — ships in 0.17.0) is the per-launch answer for the other side: it resolves the global
layout even in a folder that carries the marker, outranks it, and writes nothing, so it is safe in
a checkout another process is serving.

The feature ships **stable**, not experimental, so the names and the detection rule below are the
contract from this release on.

- **The default path is unchanged.** Without the flag and without `<project>/.xezar/workspace.json`,
  every path, file, route and default is byte-identical to 0.15.0. The mode exists only in a folder
  that was explicitly started with the flag; nothing on any existing machine moves, and there is no
  migration and no conversion of projects already in the global registry.
- **Locked file names.** `config.json` keeps its current meaning (the project config of section 3's
  sibling `.xezar` kit). The workspace config is `workspace.json` — a different NAME because
  `config.json` is taken, and `<project>/.xezar/workspace.json` is also the marker whose PRESENCE
  decides the mode. GUI preferences are `workspace-ui.json` and deliberately **not**
  `ui-state.json`: that name belongs to the per-repo runtime file in section 3, which
  `packages/xezar/src/tracked-files.test.ts` requires to stay gitignored, and a committed file of
  the same name could not coexist with that guard. `workspace.json.bak` — the registry snapshot
  every successful merge-write has always refreshed beside `config.json` — follows its file into
  the project directory; it is derived state, and `.gitignore` decides whether it travels.
- **The committed file holds no per-machine fact after the first opt-in boot (#600,
  release-candidate repair).** `<project>/.xezar/workspace.json` is the file a team commits, so an
  ordinary launch writes nothing about THIS machine into it: registration does not append a row and
  does not stamp one, and the row this folder is answered with is DERIVED from the folder (or taken
  from the stored row that travelled with the clone) rather than written back. `addedAt` (when this
  machine first registered the folder), `lastOpenedAt` and `lastListen` — when this clone was last
  opened here, and the port its cockpit last held here — live in
  `<project>/.local/xezar/machine-state.json`, beside the other working files, which the blanket
  `.local/.gitignore` keeps out of Git. Its `addedAt` and `lastOpenedAt` stamps are now validated to
  at most 64 characters, so a longer hand-edited stamp reads as absent (xezar's own stamps are ~24
  characters). Port memory therefore still works across restarts in the
  mode, `addedAt` is stable across restarts, and `git status` stays clean after a launch. **One
  exception is named rather than hidden:** the FIRST boot that opts a folder in still writes
  `workspace.json` once, through migration 001, with `schemaVersion` and the materialized defaults —
  including the host-derived `resources.memoryLimitMb` (`deriveDefaultMemoryLimitMb`), which then
  becomes an explicit committed value every teammate inherits until someone edits it. That write
  predates this repair and happens once per opt-in folder; no later launch rewrites it. The same
  write — and every later merge-write in the mode — OMITS the machine's multi-project keys
  `browseRoot`, `projectsDir` and `projects` (#650): adding, cloning and browsing are refused in the
  mode, the two roots default to this host's `~/` paths, and the registry there is the folder
  itself, derived rather than stored. A file written by 0.16.0 that carries them still loads: the
  dead roots have no consumer in the mode, and only a registry row whose `root` is this folder is
  read at all (foreign rows are already ignored); the next write drops all three. The default
  GLOBAL layout is byte-for-byte unchanged: it still writes every one of those keys into
  `~/.xezar/config.json`.
  Breaking: a launch after the first opt-in boot writing a per-machine key into the committed file,
  or a launch that leaves `git status` dirty in the mode.
- **Locked detection rule.** A linked git worktree is never a single-project root, the flag
  included, and neither is anything under `.local/xezar/worktrees/` or the user's home directory
  itself. That is not tidiness: every xezar task worktree is a linked worktree, so a mode that
  entered one would hand each running task its own copy of the state it is running against.
  Detection reads `.git` (a directory answers "main checkout" with no subprocess) and asks git only
  for the ambiguous `.git`-as-a-file case; a `.git` file git cannot answer for is treated as a
  worktree, because refusing the mode merely keeps today's behaviour while entering it wrongly
  splits a task's state.
- **`XEZ_HOME` does not create this mode and cannot leave it.** `XEZ_HOME` still relocates the
  GLOBAL state root and is unchanged. In the project layout it is not consulted for the three
  workspace files: the folder outranks the environment, which is the whole design (an environment
  variable can be lost by a plain `xez`, an IDE, a script or the MCP bridge; a file in the folder
  cannot). `XEZ_SINGLE_PROJECT` is not consulted either — see the entry above.
- **The team-skills cache moves with the folder; nothing else on the host does.** In the mode the
  bare clones of team skills repos are written to `<project>/.local/xezar/cache/skills/` instead of
  the shared `~/.cache/xez/skills/`, so a clone of the project fetches its own team skills rather
  than inheriting whatever this machine happened to fetch last. The MCP bridge's socket directory
  follows the same rule (`<project>/.local/xezar/ipc`, not `~/.xezar/ipc`), because `~/.xezar` is
  not opened at all. The skills updater's PROJECT lock follows that cache too (each folder serializes
  its own project half); the machine-wide `~/.agents` mirror is guarded by a machine-wide lock beside
  it (`<home>/.agents/.xez-skills-update.lock`), taken only while a global check is stale or a global
  apply is due, never created when the mirror is absent, and never able to stop the project half. So
  two folders — or a folder and an ordinary xezar — still cannot check or apply a global update at
  the same moment, while a mirror whose folder cannot hold the lock marks only the global scope
  unavailable. **In the global layout the team-skills cache and the MCP socket directory are
  byte-identical to 0.15.0**, `~/.cache/xez` included — the one addition is the transient lock beside
  the mirror, written only while a global check or apply runs — and `XEZ_HOME` still does not move
  that cache, exactly as before this mode existed. A single-project 0.16.0 folder and a 0.15.0 xezar
  on the same machine do not exclude each other on the global mirror, because 0.15.0 never takes the
  new lock.
- **Agent logins, global skill libraries, `gh` and `git` do NOT move.** `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `OPENCODE_CONFIG_DIR` and `PI_CODING_AGENT_DIR` resolve identically inside and
  outside the mode, as do `~/.agents/skills`, `~/.claude/skills` and `~/Applications`. These are the
  machine's, not the project's: relocating them would log a user out of a folder rather than isolate
  it. The mode moves xezar's own state and xezar's own cache, and nothing else.
- **A committed resource limit is applied exactly as written, inside the schema's own ranges.**
  `resources.memoryLimitMb` (a whole number of MiB, **0 to 1 048 576**, or `null` for no limit) and
  `resources.maxParallel` (a whole number, **1 to 16**) in `<project>/.xezar/workspace.json` are
  honoured as they stand, including above what this host would have derived for itself: no clamp,
  no refusal, and no warning-and-substitute. The host derivation (`floor(totalMiB * 0.6 / 2)`,
  clamped to [1024, 8192] MiB) still fills an **absent** key and is a default, never a ceiling.
  Identical behaviour on every machine that clones the project is the point of committing the file;
  a host that cannot take the value fails visibly rather than quietly running a different
  configuration than the one under review. The two ranges are the limit of that promise and are
  unchanged from 0.15.0: a value outside them has always been replaced silently by the workspace
  schema (`maxParallel` by the shipped 2, `memoryLimitMb` by the host derivation), which in a
  committed file would be a number nothing runs, so `.xezar/checks/catalog-check.mjs` now refuses
  one and names the range. The ranges are validation, identical on every machine — not host
  reconciliation.
- **The host-install records stay in `~/.xezar`.** `server.json`, `server-instances/`, the install
  lock, the systemd unit and the nginx site describe the MACHINE, not the project, and are the one
  part of the per-user home this mode still uses. `xezarHomeDir()` keeps answering the per-user home
  for exactly that reason; a caller that wants "where does my state live" asks the resolver.
- **Failing loudly, in one place only.** A `<project>/.xezar/workspace.json` that is not valid JSON,
  or a state directory that cannot be written, **refuses the boot** with a named error and exit 1.
  This is the deliberate exception to the zero-config "degrade, never fail the boot" rule, and it is
  narrow on purpose: that file is what makes the folder a single-project root, so degrading would
  mean silently running the project off the user's global setup. An EMPTY file is the user's own
  state, not corruption. The other three files keep their existing degrade-with-one-warning
  contracts unchanged.
- **Downgrade to 0.15.0 is a real, silent behaviour split, and it is named rather than prevented.**
  A 0.15.0 binary started in a single-project folder does not know the mode: it reads `~/.xezar` and
  writes there, so **0.15.0 in a single-project folder ignores the project state and uses your
  global setup.** It cannot be prevented — an old binary cannot be taught a new rule — and nothing
  in the project directory is damaged by it; the committed files are simply not read. Upgrading back
  to 0.16.0 resumes the mode with no repair step.
- **Upgrade from 0.15.0 state: nothing happens.** A 0.15.0 `~/.xezar` is untouched. Opting a folder
  in never writes to the per-user home, and no project row in `~/.xezar/config.json` is created,
  edited or deleted by anything in the mode. The one-time import below READS the home on an explicit
  yes; it never writes there either.
- **The one-time import is the one deliberate exception to "never opened" (BR-2, #600 part 5).** The
  first `--single-project` run in a folder with no `<project>/.xezar/workspace.json` asks once, in
  the terminal, whether to copy the global setup (`~/.xezar`, or `XEZ_HOME`) in, `[y/N]`. Only then,
  and only after an explicit yes, is the global home read — before the project files exist, and
  READ-only: nothing is ever written to it. `config.json` becomes `workspace.json` without its
  `projects` array or the machine-scoped `browseRoot`/`projectsDir` (#650),
  `agent-accounts.json` keeps only this folder's own entry in `selections` (other
  folders' choices are dropped), and `ui-state.json` becomes `workspace-ui.json`. An existing project
  file is never overwritten, an unreadable global file is skipped and named, and `workspace.json` is
  written last, so an interrupted import still counts as a first run. Nothing is written through a
  symbolic link: a `<project>/.xezar` that is a link, or resolves outside the project, refuses the
  boot (and the import refuses every file), and a state file that is itself a link is refused and
  named in the boot line, never written through or replaced (#612). A decline — including Ctrl-C or
  Ctrl-D at the prompt — imports nothing; with no terminal (stdin or stdout not a TTY) nothing is
  imported and one line says so; `xezar mcp` never asks, because its stdio is the protocol. A folder that already holds `workspace.json` — a
  second run, or a clone — is never asked, and nothing is synchronised in either direction
  afterwards. The exception is held to one call site: `packages/xezar/src/state-path-scan.test.ts`
  fails any direct call of `globalStateLayout()` or `globalStateRoot()` outside
  `packages/xezar/src/state-layout.ts`, and allowlists this import (`workspace/import-global.ts`) by
  name, with its reason. Breaking: reading the home without a yes or after the first run, writing to
  it, copying the registry or another folder's selection, overwriting a project file, writing outside
  the project (including through a symbolic link), or asking where nobody can answer.
- **A committed agent account that this machine does not have is refused, never substituted (#600
  part 5).** In the mode an account in `<project>/.xezar/agent-accounts.json` whose `configDir` does
  not exist on this machine reads, in Settings → Agent accounts, "Unavailable — this account's folder
  does not exist on this machine: `<configDir>`. Connect signs in and creates it, or pick another
  account for the task." A task that asks for it fails at that step before the agent starts, with
  `Agent account “<label>” is unavailable — ` followed by the same sentence. Both strings are built
  once, by `unavailableAgentAccountReason` / `unavailableAgentAccountRefusal` in
  `packages/contract/src/agent-profiles.ts`, so a person who reads the refusal recognises the row it
  came from. The boot never fails because of it. Global mode is unchanged: a just-added account whose
  folder does not exist yet still reads "folder not created yet; Connect will make it" and is not
  refused. Breaking: the two strings diverging, a silent fallback to the default account, or
  applying the refusal in global mode.
- **A registry of exactly one project, refused in all three doors (part 3).** In the mode the
  registry IS the folder: `GET /api/v1/projects`, `xezar projects list`, the cockpit and
  `/api/v1/health` answer one row, taken from `<project>/.xezar/workspace.json` when it holds one
  for this folder and DERIVED from the folder when it does not, so the answer is never "no
  projects". The derived row's id is allocated against the STORED ids — the same taken-set the
  boot identity uses — so a committed row for another machine's folder of the same name cannot
  make the row and the boot project disagree and drop it, and health builds its list from that
  same derived row rather than from the raw stored rows. A `workspace.json` a clone
  carried holding rows for other machines' paths is read past, never rewritten — this mode migrates
  and converts nothing, in either direction. Adding, cloning, editing and removing a project, and
  browsing host folders, are refused in every door xezar has: `409 {error}` from the five HTTP routes
  of section 2, exit code 1 from `xezar projects add/remove/tag/port`, and the existing boundary
  refusal from the MCP `project_config` tool. Each refusal is settled in the project's audit trail —
  `http_409` at the cockpit door, `single_project_root` at the CLI door (the flag keeps its
  `single_project_mode`), and the unchanged `project_registry` / `host_filesystem` boundary reason at
  the MCP door. **The MCP narrows nothing**: a project leader has never been able to manage the
  registry or browse the host, in any mode; what the mode adds is a sentence telling it why there is
  nothing to manage. A refusal in one door and a silent no-op in another is a defect, and the three
  doors read ONE predicate (`singleProjectRegistry`) so they cannot drift apart.

Breaking: changing any of the four file names or the marker; making the mode reachable from an
environment variable; letting a linked worktree enter it; moving the host-install records into the
project; moving an agent home, a global skill library or the global `~/.cache/xez` skills cache;
clamping a committed resource limit to the host, or narrowing the ranges it is accepted in;
widening the boot refusal beyond `workspace.json`; making `capabilities.singleProjectRoot`
required on the wire; changing the status code, exit code or sentence of an `XEZ_SINGLE_PROJECT=1`
refusal; answering more than one project row in the mode; letting any door apply a registry effect
the others refuse; or letting a refusal go unrecorded by the audit door. Required path: the
deprecation path at the top of this document.

## GitHub automations — opt-in gating (pre-rename issue 801), 2026-08-07

GitHub automations shipped gated only by forge
availability, so every project with a GitHub remote saw the feature and there was no way to switch
it off. `XEZ_AUTOMATIONS=1` makes the whole surface opt-in and **off by default**. Activation is
strict: only the exact string `1` enables it; `true`, `yes`, an empty value, and an unset variable
all keep it off. The flag is read live: a flip after boot starts or stops the workspace scheduler
at the next consult of the capability, with no restart, since #678. (The 2026-08-07 record below
says what it did before that.)

This deliberately flips the *default* answers of section 2's automations routes, the same kind of
break the "Follow-up inbox default flip (pre-rename issue 471)" entry above documents, taken on an explicit
instruction rather than silently.

- **Broken**: the *default* answers of `GET/POST /api/v1/automations`,
  `GET/PUT/DELETE /api/v1/automations/:id`, `POST /api/v1/automations/:id/{enable,pause,check}`,
  `GET /api/v1/automation-checks/:checkId`, `GET /api/v1/automation-log` and
  `POST /api/v1/automation-log/:receiptId/retry` — all now `409` with a reason naming the flag,
  under every one of the three scope spellings. The default behavior of the workspace automation
  scheduler also changes: it no longer starts, so a default xezar makes no GitHub requests on the
  operator's behalf and launches no runs from them.
- **Additive on health**: `capabilities.automations` is a new required boolean on the CORS-open
  `GET /api/v1/health`. Every pre-existing field stays byte-identical, so a consumer that ignores
  the key sees no change; it is what the cockpit's nav gate reads.
- **Not broken**: every route still exists and behaves exactly as before under
  `XEZ_AUTOMATIONS=1`; the storage formats of `automations.json`, the runtime-state files, the
  receipts and the execution log are unchanged; `RunRecord.automation` provenance on already
  launched runs is untouched, and the cockpit keeps showing it (as plain text rather than a link
  into the disabled view). The per-automation `enabled` toggle, the no-backfill baseline, the
  bounded filters and the polling caps are all unchanged — the flag wraps the feature, it does not
  reshape it.
- **Non-destructive rollback**: the gate never deletes, rewrites, or migrates automation
  definitions, receipts, or frozen high-watermarks. Set `XEZ_AUTOMATIONS=1` to get the feature back
  exactly as it was; no manual repair or state migration is required. As recorded here in 2026-08-07
  that needed a restart, because the scheduler was started once from the boot-time `listening`
  event; since #678 the flag is read live in both halves — turning it on starts the poller as well
  as opening the routes, turning it off stops it again, each observed at the next resolve of the
  capability. That is strictly more behaviour than the restart-only answer promised, so nothing a
  caller could depend on is broken by it.
- **No deprecation alias**: the flag *is* the migration path — one env var restores the previous
  behavior wholesale, which is what the "keep the old spelling for a minor release" rule exists to
  provide.

## The Xezar rename — a deliberate clean break, 0.10.1

Cezar became **Xezar** in 0.10.1. This is the one place in this document that records a break
taken on purpose across every product identifier at once, so it is written out in full.

### Why it is a break and not a migration

Xezar is an independent application, not a new version of Cezar. It therefore uses its own
state paths and its own identifiers, and it **does not read, write, move or delete anything
Cezar owns**. An existing Cezar install keeps its `~/.cezar/`, its `.ai/cezar/` directories, its
`~/.cache/cez/`, its `cezar`/`cez`/`cezar-cli` commands and its pre-rename scoped package.
Xezar starts empty beside it. Nothing is migrated, and nothing is silently adopted.

Auto-migration was rejected rather than skipped. Reading another product's state would mean
Xezar could corrupt or lock files a still-installed Cezar is actively using, and a half-adopted
registry is worse than an empty one. Users who want their history in Xezar can copy it by hand:
`cp -R ~/.cezar/ ~/.xezar/` and `cp -R .ai/cezar/ .ai/xezar/` — both are plain files, which is
the whole point of the format promise above.

### What changed

| Surface | Cezar (≤ 0.10.1) | Xezar (0.10.1) |
|---|---|---|
| npm package | the pre-rename scoped package, alias `cezar-cli` | `@qodeca/xezar` (single package) |
| Commands | `cezar`, `cez`, `cezar-cli` | `xezar`, `xez` |
| Repository | the pre-rename repository | `github.com/qodeca/xezar` |
| Per-user home | `~/.cezar/` | `~/.xezar/` |
| Per-repo state | `.ai/cezar/` | `.ai/xezar/` |
| Skills cache | `~/.cache/cez/` | `~/.cache/xez/` |
| Environment variables | `CEZ_*` (46 of them) | `XEZ_*`, same names otherwise |
| Cockpit env var | `VITE_CEZ_API_BASE` | `VITE_XEZ_API_BASE` |
| Agent marker vocabulary (§8) | `CEZ:DONE`, `CEZ:ASK`, `CEZ:PR`, `CEZ:ISSUE`, `CEZ:TITLE`, `CEZ:MONITORING` | `XEZ:DONE`, `XEZ:ASK`, `XEZ:PR`, `XEZ:ISSUE`, `XEZ:TITLE`, `XEZ:MONITORING` |
| API type identifiers | `cez.api.v1.*` | `xez.api.v1.*` |
| Browser storage keys | `cez-theme`, `cez-density`, `cez-accent`, `cez-sidebar-width`, `cez-sidebar-collapsed`, `cez-new-task-draft`, `cez-followup-prompt:*`, `cez-followup-selection`, `cez.reference-statuses.v1`, `cez.reference-conflicts.v1` | the same names with an `xez` prefix |
| Worktree branch prefix | `cez/<id8>` | `xez/<id8>` |
| Temp-file prefixes | `.cez-tmp-`, `.cez-write-probe-` | `.xez-tmp-`, `.xez-write-probe-` |
| Log prefix | `[cez]` | `[xez]` |
| Brand/favicon route | the pre-rename brand SVG route | `GET /xezar.svg` |
| systemd / launchd unit, nginx site | `cezar-<slug>` | `xezar-<slug>` |
| `/etc` config dir | `/etc/cezar/` | `/etc/xezar/` |

### Consequences a user will actually notice

- **Browser preferences reset once.** Theme, accent, density, sidebar width and any unsent
  task draft live under the old storage keys and are not read. The cockpit falls back to its
  documented defaults, which is exactly what a first run does.
- **Env vars must be renamed.** A shell profile or `.env` that sets `CEZ_DRY_RUN=1` has no
  effect on Xezar; it is `XEZ_DRY_RUN=1`. `.env.example` is the full list.
- **Agent prompts and skills that emit the old markers stop being understood.** A skill that
  writes `CEZ:DONE` must write `XEZ:DONE`. Xezar does not accept the old vocabulary — accepting
  it would mean a Cezar run and a Xezar run could both claim the same marker stream.
- **A server install is a fresh install.** The unit and nginx site names changed, so
  `server-install` provisions a new instance instead of adopting the Cezar one. Uninstall the
  Cezar instance first if both would bind the same port.

### What did NOT change

The HTTP API paths, request/response shapes, run-record fields, workflow YAML format, skills
Markdown format and agent-backend behaviour are all untouched. Only names moved. Sections 1–9
above continue to describe the live contract.

### Provenance kept on purpose

`@pat-lewczuk/cezar`, the pre-rename scoped package and `cezar-cli` stay published, undeprecated and
unmodified. Git history and every commit message keep the old name. `CHANGELOG.md` entries
written before 0.10.1 keep the names that were true when they were written.

---

## Codex runs load only the project's MCP servers (#324) — deliberate, 2026-09-13

A Codex run xezar starts used to load every MCP server, plugin and app the account's own
`$CODEX_HOME/config.toml` names, and `approvalPolicy: never` does not gate an MCP tool call — so a
task agent could drive the person's browser or Messages app with no prompt. That is the F-1 class
of hole #311 closed for shell access, and #324 closes it for Codex tools. Changing what a default
run can reach is breaking under section 1's rule, so it is recorded here rather than silently:

- **Broken**: the default tool set of a Codex task run. Before `thread/start` / `thread/resume` the
  runner calls `config/read` for the run's cwd and passes a per-thread `config` override
  (`packages/xezar/src/core/codex-run-isolation.ts`) that switches off every MCP server not
  declared solely by the project's `.codex/` layer, xezar's own bridge even when the project
  declares it (a task run is not the project's leader, #323), and the `plugins` and `apps`
  features. A Codex CLI that cannot answer `config/read` now fails the run closed with a message
  naming the reason, where it used to start.
- **Not broken**: a server that only the project's trusted `.codex/config.toml` declares still
  loads (a key the home config adds to it makes it the person's, and it is switched off); no
  config file is read or written by xezar (the override lives only on the thread); Claude Code,
  OpenCode and pi runs are unchanged; the v1/v2 event streams gain no type — the run transcript
  gets one ordinary `note` naming the switched-off servers, and only when there were some.
- **The bridge rule** (`isXezarBridge`): a server is xezar's bridge when it is named `xezar` (a
  reserved name: an unrelated project server called that is switched off too, and renaming it is
  the remedy), or when a word of its launch line — command and arguments split on whitespace,
  quotes, shell punctuation and `=` — is the package `@qodeca/xezar[@version]`, a path inside an
  installed copy, the CLI entry point `…/xezar/dist/index.js` or `…/xezar/src/index.ts`, or a
  `xezar` / `xez` executable on a line that also names `mcp`. A wrapper script whose launch line
  never mentions xezar is not seen; registering the bridge as `xezar` covers it.
- **What provenance rests on**: a server counts as the project's when every origin Codex reports
  for it is a `project` layer. xezar cannot require an origin for every key, because codex-cli
  0.154.0 fills defaults (`enabled`, `environment_id`, `tool_timeout_sec`, an empty `args`) with no
  origin; it relies on Codex reporting an origin for every key a config file set, as 0.154.0 does.
- **Migration**: README § "Codex runs and MCP servers" — declare the server in the project's own
  `.codex/config.toml`, keep the home config from adding keys to it, do not name it `xezar`, and
  update a Codex CLI that cannot answer `config/read`. Released as part of a **minor** version.
- **No opt-out knob**: the project's `.codex/config.toml` is the opt-in path, reviewed with the
  code, so no stored key or `XEZ_*` variable was added (§ Zero config: prefer no knob).
  `codex-app-server-runner.test.ts` (under `MOCK_CODEX_AMBIENT` / `MOCK_CODEX_CONFIG_READ_ERROR`)
  pins the default; it fails against a runner that starts the thread without asking.

## Claude Code, pi and OpenCode runs no longer load xezar's own MCP bridge (#342) — deliberate, 0.16.0

#324 gave Codex runs this rule. The other three backends passed nothing, so a task client loaded
whatever the person's and the project's config declared — including a `xezar` bridge entry. That is
not only a tool-surface question: xezar's bridge takes the project's one OWNER slot the moment it
connects, and a `keep-alive` entry connects at start-up with no prompt and no tool call. A task run
started in the project root (`worktree: false`) therefore held the slot for its whole lifetime and
the person's own leader session was refused `-32080 project occupied` until the task ended
(observed with pi, #342). Changing what a default run can reach is breaking under section 1's rule,
so it is recorded here rather than silently.

- **Broken, Claude Code**: a task run now receives `--strict-mcp-config` together with a
  `--mcp-config` overlay built from the project's own `.mcp.json` minus xezar's bridge. It
  therefore no longer loads the MCP servers a person added for themselves in `~/.claude.json`, nor
  anything a settings file would have enabled — the same narrowing Codex runs have had since
  0.15.0. It is the only lever the CLI offers: without `--strict-mcp-config`, claude merges the
  project file and the user file on top of the overlay and the bridge comes back.
- **Broken, pi — only where the MCP extension is installed**: a task run is started with
  `--mcp-config` pointing at a private per-run file. That file carries the pi agent directory's own
  `mcp.json` forward unchanged — the person's global pi servers still load — and adds
  `"disabled": true` for xezar's bridge. The flag substitutes for exactly one slot of the adapter's
  six-file chain, and the chain merges a server entry field by field, so the flag survives the
  project files layered above it. `--mcp-config` is registered by the optional `pi-mcp-adapter`
  extension, not by pi itself, and an extension resolves from the agent directory AND from the
  project folder the child runs in — pi also loads a project's own `.pi/extensions/*` and the
  packages its `.pi/settings.json` names, once that project is trusted. One binary and one agent
  home therefore answer differently per folder, so xezar asks this pi with the agent directory AND
  the working folder the child will really use, once per session and without caching the answer
  (#548). Where the extension is absent the flag is left out, nothing is written, and the run says
  so once: that pi reads no MCP configuration at all, so there is no bridge to switch off. A probe
  that cannot answer leaves the flag out too, and says only that it could not confirm — never that
  the extension is absent (§ Zero config: a missing peer degrades, never fails). Should a pi refuse
  the option anyway — the extension removed between the question and the spawn — the session is
  started once more without it rather than failing.
- **Broken, OpenCode**: a task run is started with `OPENCODE_CONFIG_CONTENT` carrying
  `{"mcp": {"xezar": {"enabled": false}}}`. That is the one layer OpenCode merges ABOVE the
  project's own `opencode.json`; `OPENCODE_CONFIG` is merged below it and the project entry would
  win. If a person already sets `OPENCODE_CONFIG_CONTENT` in their shell, xezar's value replaces it
  for task runs.
- **The reserved-name floor**: for pi and OpenCode the name `xezar` is switched off whether or not
  a project file declares it, because discovery reads project files only and a bridge declared in
  the person's own global config would otherwise contend in every project. An unrelated server
  named `xezar` is switched off too; renaming it is the remedy — the same rule and the same remedy
  as #324. A task client may therefore list one inert `xezar` entry marked disabled.
- **Not broken**: every other MCP server a project declares still loads, for every backend; no
  config file is read or written by xezar outside its own private temp overlay (never in the
  project, mode 0600, removed when the session ends); `codex-run-isolation.ts` is untouched; the
  v1/v2 event streams gain no type — the run transcript gets one ordinary `note`, and only when a
  bridge was really declared or a config file could not be read. The reserved-name floor is
  deliberately NOT reported as "switched off a bridge", or every run would say so.
- **Worktree ON gets the same treatment.** A linked worktree is a checkout of the same commit and
  carries the same committed config files. The observed worktree run bound no project only because
  the bridge binds by repository root and task worktrees are never registered — a property of the
  registry, not of the runner, so the seam does not lean on it.
- **Fail-open, unlike Codex**: Codex fails a run closed when it cannot read its config, because
  there xezar asks the live process and an unanswerable question means starting with servers nobody
  saw. Here xezar reads files it can name, so an unreadable or malformed file degrades instead —
  the run starts and says so once (§ Zero config). For Claude Code that means starting with no
  project MCP servers until the file is fixed.
- **Migration**: [docs/guide/13-mcp-leader.md](docs/guide/13-mcp-leader.md) § "To keep your leader
  while tasks run in the same folder". Declare a server your tasks need in the project's own file,
  and do not name an unrelated server `xezar`. Released as part of a **minor** version.
- **No opt-out knob**: no stored key and no `XEZ_*` variable was added (§ Zero config: never trade
  a working default for a knob). `core/worktree-off-mcp-isolation.test.ts` pins the default path;
  it fails against runners that pass no isolation (named break `worktree-off-inherits-xezar`), and
  against a pi runner that passes `--mcp-config` without asking whether this pi knows it (named
  break `pi-mcp-config-unconditional`).

## Pi isolated runs stay in their task worktree (#537) — deliberate, 0.16.0

A pi run in a linked task worktree already started with that worktree as its process directory,
but its file tools and unrestricted shell could still target the primary checkout explicitly.
Changing what a default agent run can reach is breaking under section 1, even though the old
reach was an isolation defect, so the restriction is recorded here rather than silently:

- **Broken**: a pi run in a linked worktree can no longer use `write` or `edit` to target the
  primary checkout. The guard resolves the path the way pi does before writing – `..`, symlinks,
  `~`, a leading `@`, `file://` URLs, Unicode spaces and letter case – and refuses a spelling it
  cannot resolve with confidence. That file-tool check is the enforced control. The shell check is
  **best-effort defence in depth, not containment**: it refuses a `bash` command that names a path
  in the primary checkout (absolute, `~`, `$HOME` or another set variable, `..`, a symlink, or a
  relative path read from a folder above it after `cd`, such as `cd ~/Projects && echo x >> repo/f`)
  or changes into it through `cd`, `pushd`, `-C`, `--chdir`, `--git-dir`, `--work-tree`, `GIT_DIR`
  or `GIT_WORK_TREE`, and it prefers a false block to a missed one. A directory-change target must
  be one literal path: a variable, a substitution, a glob or brace pattern, `~user`, a `CDPATH` or
  `OLDPWD` change, `~` after a `HOME` change, or a `..` that follows a symlink is refused rather
  than guessed, so a command such as `cd "$SOME_DIR"` that used to run is now refused. After a
  directory change the guard cannot follow (`pushd +1`, `popd` of an empty stack) every later path
  in the command is refused, and after `cd` to a folder that holds the primary checkout a relative
  glob is refused too, because it could expand into the checkout. A shell
  command cannot be parsed completely, so scripts and programs that build a path themselves,
  aliases and functions, `eval` of computed text and variables set inside the command and then
  used as a plain argument can still reach the primary checkout. If the guard cannot
  resolve the worktree or primary-checkout root, it rejects every `write`, `edit` and `bash` call
  instead of guessing.
- **Not broken**: relative paths inside the task worktree, temporary paths and home-directory
  paths outside the primary checkout remain available, and so do the run's own handoff and temp
  folders even when they sit under the primary checkout. xezar passes the primary checkout to the
  guard instead of letting it read the worktree's `.git` file, so bare-repository and submodule
  layouts keep working. Runs explicitly created with `worktree: false`, runs in non-Git
  directories, and Claude Code, Codex and OpenCode tool access keep their existing behavior.
  Event and workflow schemas do not change.
- **Prompt change for every backend**: an isolated `quick-task` run on any backend (Claude Code,
  Codex, OpenCode or pi) now carries one extra system-prompt paragraph asking the agent to keep
  project writes and Git commands inside its working copy. Runs with `worktree: false`, non-Git
  runs and every other workflow get the exact prompt they had before.
- **Migration**: a task that intentionally needs the repository's primary working copy must be
  created with `worktree: false`; xezar then applies its existing repository-root lease.
- **No opt-out knob**: linked-worktree containment is the safe zero-config default. The runner
  supplies the task root to its bundled pi extension, while the `quick-task` prompt carries the
  same instruction as the maintained workflow kit.

## A run xezar itself terminates for the memory limit ends `failed`, not `done` (#603) — deliberate, 0.16.0

`enforceMemoryLimit` closes a breaching run's session with `session.end()`, and a CLI that does not
exit on its own is then signalled by xezar and settles on the same "our own signal coming back"
teardown path a legitimate `XEZ:DONE` close does (pre-rename issue 703) — so `session.result` resolved cleanly
either way, and the step-completion handler could not tell "the agent finished" from "xezar cut it
off". The run, and its last step, settled `done` with no deliverable and no error.

- **Broken**: a run that reaches the memory ceiling and is terminated by xezar (fresh run or a
  Continue/restart-recovery continuation) now ends `status: 'failed'` with an `error` naming the
  memory limit, where it previously — incorrectly — ended `status: 'done'`. Any API, MCP or cockpit
  consumer that read a memory-limit termination as a successful `done` run must instead expect
  `failed`. `failed` is one of the statuses `continueRun`/`POST /runs/:id/continue` already accepts,
  so the leader's `Continue` still resumes the run — this was already true for `failed` and is not
  new for that path.
- **Not broken**: the memory limit itself, when the guard fires, and the graceful-close-then-forced-
  signal teardown of pre-rename issue 703 are unchanged. Every other terminal path (`XEZ:DONE`, cancel, an ordinary
  agent error, a real crash) settles exactly as before. No event or workflow schema changes; no new
  `RunStatus` value is added.

## The first automatic return after a red check resumes the author's session (#676) — deliberate, 0.17.0

A check step with `onFail` has always re-entered its retry target as a brand-new backend session
carrying the whole `{{task}}` brief plus the capped failing output, twice, before the run failed.
The first of those two returns now resumes the retry target's OWN recorded session instead, and
sends it only the failing output. Nothing about the allowance moved: the return is counted exactly
as before.

- **Broken**: a custom workflow whose `onFail` retry target is an agent step sees its FIRST return
  spawn with `resume: true` on that step's recorded `sessionId`, and receives a `userPrompt` that
  is the failing output alone — prefixed by one fixed sentence saying it is a repair turn — with no
  `{{task}}` text, no chain-boundary note and no attachment paths, because the session it is
  resuming already holds them. A retry target that depends on re-reading its brief in the return's
  first message must now read it from its own conversation. Two new `note` kinds are emitted on
  this path — the repair turn itself ("repair turn — resuming…") and an unavailable resume
  ("repair turn unavailable (…)"). In the "resumed, then unavailable" case BOTH appear, in that
  order and on the same step: the resume was announced before it was attempted, and the fall-back
  is announced when the attempt comes to nothing. That is deliberate — a reader must be able to
  see that the resume was tried, not only that a fresh session was started.
- **Not broken, and §4 does not change**: no YAML key is added, renamed or tightened; `{{task}}`
  substitution is untouched; `onFail`'s retry target and `max` default of 2 are untouched; a run
  that exhausts them still fails with the byte-identical `check "<id>" failed after 3 attempts`.
  The SECOND return is byte-for-byte the fresh session it has always been, whole brief included.
  **§8 does not change** either: a repair turn is a non-final agent step, so #317 judges it the
  same way — it is `done` only when its turn ends with `XEZ:DONE`, and the last (interactive)
  step's rules and the marker vocabulary are untouched. The repair turn takes its own step's
  `timeout` through `stepTimeoutMs`, so an absent `timeout` still resolves to the runner's
  30-minute default (§4's protected surface) rather than the Continue path's uncapped `0`.
- **Not covered**: a return whose resume is unavailable falls back to today's fresh spawn INSIDE
  the same return, with the whole brief, announced by a `note` and without consuming a second
  attempt. An unreachable session is an environment fact, not a repair round. Five cases, all of
  them this same exit: no recorded session id; a recorded backend that differs from the one now
  resolved; a different agent account (`profileId`); a backend whose runner cannot resume at all
  (OpenCode always opens a new conversation, so a recorded id there is never treated as
  resumable); and a resumed turn that ended at RUNTIME before the model produced anything — a
  `startSession` throw, or a session error or clean close before any text or tool call, such as a
  conversation the backend has forgotten, a usage limit, or a turn that simply said nothing. The
  note names what was observed and quotes the reason rather than calling every one of those a
  refusal (#732). A resumed turn that DID work and then failed is a failed step exactly as before,
  and is never silently re-run. The fall-back execution is bounded by what is LEFT of the step's
  wall clock, so one return can never spend `timeout` twice, and `progress.deadlineAt` is the
  instant that one budget runs out for either execution; when nothing is left the return ends on
  the failure it has and says so, instead of starting a second execution already past its
  deadline. §4's protected default is untouched: an absent step `timeout` still resolves to the
  runner's 30-minute default for the step, and the last (interactive) step stays uncapped. No contract schema, route, config key or env var changes, and
  `xezar run` headless takes the same path.
- **Not broken, token accounting**: a step's recorded `tokensUsed` still totals the whole step. On
  a backend that reports the session's cumulative figure rather than this execution's own (Codex),
  a resumed repair turn records that figure as the total instead of adding it to what the step had
  already spent — the same number a fresh return would have produced, not twice the first
  execution.

## An OpenCode step that stays silent after a refused permission ends `failed` (#692) — deliberate, 0.17.0

The OpenCode runner answers a `permission.asked` ask it cannot approve with `reject`, and that
boundary (#578, #686) is unchanged. What the session did AFTER the refusal had no bound of its own:
in four observed runs it emitted nothing further — no output, no new turn, no error — so a non-final
agent step ran out its 30-minute wall clock and reported the bare `opencode timed out after 30m`,
while the last, interactive step (uncapped by design) parked with nothing for the user to answer and
kept its slot until a person killed it. `REJECT_SILENCE_MS` (five minutes) now bounds exactly that
state.

- **Broken**: an OpenCode step in which xezar refused a permission ask and the session then started
  no further part OF ITS OWN for five minutes now ends `status: 'failed'` with an `error` naming the
  permission and the refused pattern. "Of its own" is load-bearing: only a part the model produces in
  a new round trip counts (`text`, `reasoning`, `tool`, `subtask`, `step-start`), never the
  `step-finish`/`patch` bookkeeping the server writes for the round trip that just ended — which it
  does after every refusal, 40–110ms before `session.idle`, so counting it would leave this bound
  unreachable. Before, the same step ended on the wall-clock timeout (`failed`, with the
  generic message) or — on the last step — did not end at all until the idle close, a cancel or a
  kill. A consumer that recognised the stall by the timeout text must read the new message; a
  consumer that treated the uncapped last step's silence as "still working" now sees a terminal run.
- **Not broken**: the reject policy, the allowed roots and the denial-loop bounds
  (`MAX_PERMISSION_DENIALS`, `MAX_REPEATED_PERMISSION_DENIAL`). No event `type` is added — the cause
  rides the existing v1 `error` and v2 `session.ended`, exactly like the permission failures that
  already used `failOnPermission`. No `RunStatus` value is added, no config key and no env var. A run
  in which xezar refused nothing arms nothing and is unchanged, as are the other three backends.
- **Not covered, and deliberately so**: the interactive park itself (section 8). A turn that ends
  after a refusal having SAID something — a question, an explanation, `XEZ:MONITORING` — still parks
  at `waiting` for as long as the user needs, because there the person has something to answer.

## The sidebar is navigation-only; Active/Archived, the recent list and search moved to the Tasks pages — deliberate, 0.16.0 (#546)

PR #559 removed the sidebar's `taskQuickList` slot on desktop and in the phone drawer. No route,
CLI command, persisted-file schema or event type changed — the surfaces sections 1–9 protect are
untouched — but the sidebar's own content changed for every user, so it is recorded here rather
than only in the CHANGELOG.

- **Removed**: `components/task-quick-list.tsx` and its test; the panel-only helpers only it used
  — `groupRuns`, `capBuckets` and the bucket types in `lib/task-groups.ts`, `commandShortcutHint`
  (`lib/use-command-shortcut.ts`), and the `openCommandPalette` event seam. `components/app-shell.tsx`
  and `app-shell-container.tsx` dropped the `taskQuickList` slot and the palette hint (the comment
  at `app-shell.tsx:616-618` names #546 directly); `components/project-groups.tsx` now renders only
  a group's header, expand/collapse and navigation — no task rows, buckets, pin control or "More…"
  row. Gone from both surfaces: the Active/Archived tabs, the RECENT task list (its "Needs you /
  Working / Recent / Pinned" buckets and the "More…" row), and the "Search… ⌘K" box.
- **Where each removed capability lives now**: the Active/Archived toggle and the task search box
  are on the Tasks pages — the per-project route (`routes/tasks-overview.tsx:207` desktop,
  `:222` phone) and the all-projects route (`routes/global-tasks.tsx:374`) — which is also where
  pin/unpin, unread state, PR/issue references and diff statistics already lived; the recent list's
  "Needs you / Working / Recent / Pinned" buckets have no direct replacement, and the Tasks page's
  own sort and filters are what covers the same ground now. The "Search… ⌘K" launcher's only job was
  opening the command palette, and that still works exactly the same way without it: `CommandPalette`
  is mounted globally in `app-shell-container.tsx:182` and opens with ⌘K/Ctrl+K from any route, with
  no sidebar click target required.
- **Not broken**: `workspaceUiStateSchema`, every stored UI-state key and every migration are
  unchanged — a `ui-state.json` carrying the legacy `sidebar.collapsed` map (section 2,
  `GET/PUT /api/v1/workspace/ui-state`) is still accepted and round-tripped byte-for-byte, even
  though the current cockpit reads and writes sidebar width through `xez-sidebar-collapsed` in
  `localStorage` instead (`lib/sidebar-collapse.ts:14`) rather than that stored key. The navigation
  badge meanings (#399), the phone 44 px tap targets (#430), and the sidebar's resizability are
  unchanged.
- **Deferred**: `docs/screenshots/` and `tour.gif` still show the old sidebar task panel; both are
  regenerated once for 0.16.0 after every design batch lands (#447), not by this PR.

## Hosted servers refuse every WebSocket upgrade (#547) – deliberate, 0.16.0

Before 0.16.0 a hosted server applied the same upgrade guard to `GET /api/v1/ws` as a local one,
so a native client that sent no Origin could open the subscription bus through a reverse proxy.
The bus carries local-machine signals and cannot carry the proxy's credentials from a browser, so
hosted servers now close it. The endpoint is upgrade-only and outside the section 2 drift guard,
so the change is recorded here by hand.

- **Broken**: a hosted server – `XEZ_REMOTE=1`, or a bind address that is not loopback – refuses
  every WebSocket upgrade on `/api/v1/ws` before the handshake. It answers `HTTP/1.1 403 Forbidden`
  with `connection: close` and closes the socket; no subscription frame is ever exchanged. The
  refusal does not depend on the Origin: a browser page, the cockpit itself and a native client
  that sends no Origin are all refused.
- **Migration**: a third-party client of a hosted server that used a native WebSocket must move to
  the authenticated HTTP API plus the server-sent event stream, through the same reverse proxy.
  A topic that mirrors an HTTP route (`health` mirrors `GET /api/v1/health`) is available by
  reading that route.
- **Not broken**: local mode (loopback bind, `XEZ_REMOTE` unset) keeps its existing rules – the
  loopback Host check, the same-authority and no-Origin trusted connections, and the Vite
  development proxy. The remote cockpit already opened no WebSocket – it subscribes only when
  `capabilities.localHandoff` is true – so it needs no change. The path, the frames and the topic
  names are unchanged.
- **No opt-out knob**: refusing the bus when hosted is the safe default.

## Every registered project gets its own MCP door (#557) – additive, 0.16.0

Before 0.16.0 only the project the cockpit started in had an MCP door; `xez mcp` in a project added
later answered "xezar is not running" while the same cockpit served that project's tasks.

- **Added**: a running cockpit now opens an MCP door for every other registered project the first
  time it serves that project – for example when the project is opened after it is added, or after
  a restart – and closes it when the project is removed. A folder whose data another cockpit
  already owns gets no second door.
- **Unchanged**: the socket location pattern, the `mcp-connection.json` shape, the IPC frames and
  the MCP tools. The starting project's door opens and behaves exactly as before.
- **What a reader could notice**: one more listening socket and one more connection file per
  served project, and `mcp.ready` or `mcp.unavailable` activity lines that name those projects.
  MCP journal activity lines are still printed for the starting project only.

## When in doubt

If a change might break any surface above, say so in the PR description, label the PR `risk-high`, and route it through the review + QA gates in `SDLC.md`. A silent break found in review is a blocker per `CODE_REVIEW.md`.

## MCP decision-only run versions (#449, #530), 2026-09-16

Run-version semantics change for every execution_control action and other run-version guards: the opaque rev1 token now uses an automatically persisted decision revision, not transcript sequence. A→B→A decisions still conflict across restart; transcript-only progress does not. The digest namespace changes so pre-upgrade tokens conflict: clients must read current state and decide again once after upgrade. No token parsing was supported. Legacy runs initialize without configuration; decisionRevision is an optional additive record field. Downgrading loses the new revision and requires a fresh read; no history or task content is migrated or deleted.

Only accepted effects reserve their specific delayed transition. Accepted cancellation acknowledgements remain suppressed; rejected operations and successful running steering cannot suppress independent later outcomes. Existing journal rows remain untouched. The user-facing API paths, action schemas and refusal shapes remain unchanged.

Participant `user-message` input also advances the decision revision; it is steering, not agent telemetry.

Pending question replacement also advances the decision revision (#534), including changed content under the same question ID. The optional additive `decisionQuestion` record field stores only the ID and a content digest; legacy records remain readable, and the next question event initializes it. Clearing the question with participant input remains one decision revision. Clients must re-read after a replacement. Known structured `applied:false` refusals now settle and replay as `rejected` (#536); existing durable receipts are not rewritten, and ambiguous throws/lost responses remain `unverified`. The run response gains the same optional metadata; MCP action and receipt response schemas are unchanged.

## The MCP `project_config` tool writes the workspace settings and the shared preferences (#677 wave 2 B1, B2 and B3) — deliberate, 0.17.0

A documented product boundary is reversed here, by the owner's rule of 2026-09-20 on #677 ("every
key"). Until 0.17.0 the `project_config` action `set_workspace_config` existed only to REFUSE: it
answered `Refused (workspace-wide setting)`, dispatched nothing, and the classification recorded
every workspace limit as a safe effective read a leader could see and never change.

**Documentation reconciliation, 2026-09-20 (#677 wave 2 B6).** The reversal now has one current
classification across the field matrix and UI inventory: PR #734 covers the workspace setting
keys (after PR #729 put the request schema in the contract), PR #748 the two workspace paths,
PR #753 the shared UI preferences, PR #760 provider on/off and retry, and PR #764 account writes
plus the identity read. The previous D-03 and inventory sentences are retained under “Previously”
where they were superseded; they are history, not current refusal behavior. The owner separately
said “Allow it in hosted mode” for workspace configuration. Hosted permission is a property of
each route's handler; the presence or absence of `localHandoffRoute` registration metadata is a
no-op for that decision.

- **Changed**: `set_workspace_config` is a real write. It takes `workspaceConfig` plus the usual
  `operationId` and dispatches `PUT /api/v1/workspace/config` — the cockpit's own route, its own
  validator, its own 400s, its own `mergeWriteWorkspaceConfig` and its own `semaphore.refresh()`.
  A leader may now change the seven `resources.*` keys, `followups`, `agentEnvPassthrough`,
  `composerDefaults.*`, `skillsAutoUpdate` and `agentDefaults.{runner,models.*}` — settings that
  apply to **every project on the machine**, not only the bound one.
- **Unchanged**: nothing is removed. A leader that never calls the action behaves exactly as
  before; an older leader simply does not know the argument exists. The refusal vocabulary, the
  boundary ids, every other refused action and the `get_limits` answer shape are untouched, and
  the write answers in that same `get_limits` vocabulary rather than the raw route body.
- **`browseRoot` and `projectsDir` followed in slice B2, under the same owner rule.** They are keys
  of the action now: B1 had held the two workspace folder paths back as the security-relevant half
  of the reversal, and B2 is the review that decided them. What refuses a bad one is the ROUTE, not
  the tool — `PUT /api/v1/workspace/config` requires an absolute path, requires an existing
  directory for the browse root and runs `mkdir -p` for the checkout root, answering 400 with its
  own reason **before** `mergeWriteWorkspaceConfig`, so a `resources` key sent in the same body
  still does not half-apply. Two consequences a reader should know: a settings write can CREATE a
  directory anywhere the user can write (the checkout root's probe), and moving `browseRoot` widens
  what a PERSON at the cockpit may then browse — the leader itself gains no listing, because
  `browse_folders` and the clone stay refused. A third consequence was named by the independent
  review of #748 and is recorded rather than answered: **because the probe REFUSES with its
  reason, the write is also a stat oracle over any absolute host path** — "does not exist", "is
  not a directory" and "not writable: EACCES …" are answers about the host filesystem that persist
  nothing, so a leader can learn whether a path exists, whether it is a file or a folder, and
  whether this user may write it. `fs-browse.ts` keeps that oracle shut for the BROWSE route on
  purpose, so the `mkdir` half of this bullet is true and incomplete on its own. It stays inside
  the accepted threat model — a leader can already start a task, which is code execution as the
  user — which is why no second check was added at the MCP door. The paths are written and not
  read back: the answer is the narrowed `get_limits` vocabulary, which carries no folder path.
- **The shared PRESENTATION preferences followed in slice B3, under the same owner rule plus the
  exclusions the owner named at 07:41 on 2026-09-20.** `set_workspace_ui_state` and `import_skills`
  stopped being refusals and are real writes through `PUT /api/v1/workspace/ui-state`, the
  cockpit's own route — its schema bounds, its 128 KiB body cap and its shallow merge, so a key
  that is not sent is left alone. `get_workspace_ui_state` reads the same bag back, in the same
  narrowed vocabulary. The leader's argument names exactly five keys: `appearance.{accent,
  density,width}`, `notifications.enabled`, `taskTable.expandedColumns`, `importedSkills` and
  `dismissedProviderAuthFailures`, and the argument is strict at EVERY level it names — an unknown
  key inside one of the four nested objects is an argument refusal that dispatches nothing. The
  merge is shallow at the TOP level only, so the three object-valued keys (`appearance`,
  `taskTable`, `dismissedProviderAuthFailures`) are sent WHOLE and a partial one clears the rest
  of its own object: the supported recipe is read, spread, write, exactly as the cockpit's panes
  do it, and `get_workspace_ui_state` is what makes it possible from this door. **That recipe does
  not reach `dismissedProviderAuthFailures`, and the argument text now says so** (#753 re-check,
  Minor 1): the read reports the provider NAMES of the dismissed incidents and withholds the
  incident ids a write needs, so any write of that key replaces every dismissal there is — `{}`
  clears them all, and leaving the key out keeps them. Three exclusions are part of the decision and none of them is a
  new refusal: the colour THEME is not a stored setting at all (the browser keeps it in
  `localStorage`, with no server route to dispatch), the per-repo composer-memory keys are one
  browser's preselection memory, and the two LEGACY keys of the same file, `sidebar` and
  `lastLocation`, describe one person's window and are not keys of the argument. The answer is
  narrowed like every other: `sidebar` and `lastLocation` are not in it, and a dismissed provider
  incident is reported as the provider's NAME rather than the incident id `get_capabilities`
  withholds. Hosted mode is unchanged here too — this route is permitted there, and a test pins
  that it is ALLOWED. `localHandoffRoute` registration metadata is not the source of that permission.
- **What a reader could notice**: the audit trail can now hold `workspace.config.set` and (since
  B3) `workspace.uiState.set` rows with origin `mcp`. That row already existed in the inventory for the cockpit door; what is new is
  that the MCP door produces it. The MCP record carries the action id, the operation key and a
  payload DIGEST — never the field values, and (unlike the cockpit door's record) not the field
  names either. `discover_project` answers differently about the same capability: its
  `workspace_limits` row went from `status: 'read-only'`, with the reason "only a person can change
  them in the cockpit's global settings", to `status: 'available'` with no reason (#743).
- **The record of the old decision is kept, not deleted**: the superseded rulings stay in
  `docs/features/mcp-server/mcp-ui-action-inventory.md` verbatim, beside the new one, dated.
- **An unknown key is refused at EVERY level, through both doors** (added in the review round —
  review m1 and QA case H, #735). Two bodies used to be answered 200 / `applied` for a change that
  never happened: an unknown TOP-LEVEL key (`{ nonsenseKey: 123 }`) by the ROUTE, which the MCP
  door already refused, and a misspelt NESTED key (`{ resources: { maxParalel: 9 } }`,
  `{ agentDefaults: { models: { gemini: 'x' } } }`) by BOTH doors.
  `setWorkspaceConfigInputSchema` is strict at every level now, so **`PUT /api/v1/workspace/config`
  answers 400 for bodies it used to accept**, and the MCP door refuses them as arguments with the
  same reason. The narrowing is deliberate and lands on both doors at once, because both validate
  with that one contract schema — which is the point: the two answers are identical rather than
  similar. No cockpit call site sends such a key; a client that did was silently losing the
  setting it meant to change.
- **Hosted mode permits workspace-config writes, through BOTH doors — a decision, not an
  oversight.** The workspace-config route handler permits the write when the server is bound to a
  non-loopback host, and `set_workspace_config` dispatches through that same route: with
  `capabilities.localHandoff: false`, both doors answer normally instead of 409. Independent QA
  raised this as a blocker (QA case G on #734, filed as #735) and asked for either the 409 or an
  explicit decision. **Owner decision, 2026-09-20: the write stays allowed in hosted mode — a
  server admin may change limits remotely.** `localHandoffRoute` registration metadata does not
  grant or refuse that permission. This is the opposite of the rule for agent-config
  writes (`PUT /api/v1/agent-config/:id`) and every agent-profile route, which 409 in hosted mode
  because they can define hooks and commands or name an account identity; workspace limits are
  neither. One writable key is not a limit and has an exposure shape of its own —
  `agentEnvPassthrough` decides which of the server's own environment variables the agent processes
  receive — and the decision covers it too (#743): it stays writable in hosted mode, unargued here.
  The behaviour is pinned by a test that asserts it is ALLOWED — and asserts an
  agent-config write still 409s on the same hosted app — so adding a 409 here later is a visible,
  named break rather than a silent change of mind, and it would be a change for both doors at
  once with its own entry here.

## The MCP `project_config` tool turns agent backends off and on (#677 wave 2 B4) — deliberate, 0.17.0

The second documented product boundary of this wave is reversed here, by the same owner rule of
2026-09-20 on #677 ("every key"), scoped by the owner at 07:41 the same day to "on/off and retry
only". Until 0.17.0 the actions `set_provider_enabled` and `retry_provider` existed only to
REFUSE: both answered `Refused (workspace-wide setting)` and dispatched nothing.

- **Changed**: both are real writes. `set_provider_enabled` takes `provider` and `enabled` and
  dispatches `PUT /api/v1/providers/:provider/enabled`; `retry_provider` takes `provider` and
  dispatches `POST /api/v1/providers/:provider/retry`. Both are the cockpit's own routes, with
  their own param and body validators, the same `mergeWrite` of `disabledProviders` into
  `~/.xezar/config.json`, the same `provider-status` event and the same refusals. The switch is
  **machine-wide and takes effect with no restart**: the gate that decides whether a new task may
  start reads the same key, so a provider a leader turns off stops being offered for the next task
  at once — in EVERY project on that machine. Turning one on re-enables a backend the person
  deliberately disabled. That exposure is the decision, not an oversight.
- **Unchanged**: nothing is removed, and a leader that never calls either action behaves exactly
  as before. `connect_provider` is still refused and its boundary is unchanged — `host-process`,
  because it opens a login terminal on the person's machine (owner, 2026-09-20 07:41). The refusal
  vocabulary, the boundary ids and `get_capabilities` are untouched.
- **The incident id is withheld in BOTH directions.** `retry_provider` takes no `authFailureId`
  argument: F-03 keeps that id out of every answer a leader gets, so it could never name one. The
  tool reads the CURRENT id from `GET /api/v1/providers/status` inside the handler and hands it to
  the route. That does mean a leader can clear an incident it never saw (#760 review, Minor 2);
  what the route's guard still protects is a rejection arriving BETWEEN the read and the write,
  which is a different id and is answered with the route's own 409, unrewritten. No answer of
  either action, or of `get_capabilities`, carries an `authFailureId` or a `profileId`.
- **What a reader could notice**: the audit trail can now hold `provider.setEnabled` and
  `provider.retry` rows with origin `mcp`. Both rows already existed for the cockpit door. The MCP
  record carries the action id, the operation key and a payload DIGEST — never the field values,
  and not the field names either. The cockpit door's record for those two routes now carries the
  body's field NAMES as well (`fieldNames: true`, as every other settings write of that door
  already did): names only, never a value, so the trail says the switch was written without saying
  which way.
- **Two request schemas moved to `packages/contract`** with no change of shape:
  `setProviderEnabledInputSchema` and `retryProviderInputSchema` replace the copies that were
  declared in `server.ts`, so the route and the MCP door validate against one definition
  (AGENTS.md § The HTTP API). The wire contract, the bounds and the 400 messages are identical.
- **Hosted mode permits both writes, through BOTH doors**, for the reason recorded above for the
  workspace-settings write: each provider route is permitted there, and a test pins the ALLOWED
  behaviour so a later 409 would be a visible, named break. `localHandoffRoute` registration
  metadata is not the source of that permission.
- **The record of the old decision is kept, not deleted**: D-03-2 and the I-115 ruling stay in
  `docs/features/mcp-server/mcp-settings-classification.md` and
  `docs/features/mcp-server/mcp-ui-action-inventory.md` verbatim, beside the new one, dated.

## The MCP `project_config` tool administers agent accounts (#677 wave 2 B5) — deliberate, 0.17.0

The third documented product boundary of this wave, reversed by the owner's decision of 2026-09-20
07:41 on #677: agent accounts are "**Writes and identity read**". Until 0.17.0 the actions
`create_account`, `update_account`, `remove_account`, `select_account` and `check_account_status`
existed only to REFUSE (`Refused (global agent accounts)`), and dispatched nothing.

- **Changed**: all five are real now, through the cockpit's own `workspace/agent-profiles` family
  and nothing else — `POST`, `PATCH …/:id`, `DELETE …/:id`, `PUT …/selection` and
  `GET …/:id/status`. Each keeps the route's own validators, its duplicate-folder 409, its 404 for
  an unknown id, its atomic write of `~/.xezar/agent-accounts.json` and its reference scrub on
  delete. The accounts file is **machine-wide**: an account a leader adds is an account every
  project on that machine can be pointed at. That exposure is the decision, not an oversight.
- **`configDir` is accepted with the route's existing bounds and no new validation.** An account's
  folder becomes an agent CLI's whole home, and a home can hold settings and hooks that run when
  the next task starts that agent — so writing one is, in effect, choosing which file tree gets to
  run code. Nothing validates that a folder is a sane agent home (the route never did, and this
  door deliberately adds no second opinion). The mitigation that DOES exist is hosted mode, below.
- **Narrowed at the leader's door, on purpose**: `select_account` writes THIS project's selection
  only. The route takes a `projectId` whose `null` writes the machine-wide default; a leader has
  no project id argument anywhere (D-01 § 1.5), so the bound project's id is supplied and the
  machine-wide default stays person-only. The answer is narrowed to this project's own selection
  for the same reason — the route's `selections` map is keyed by every repo root on the machine.
  The account row a write echoes back is narrowed too: no expanded `path`, no `files`, no `status`,
  and `configDir` only when THAT call sent one — a `create_account`, or an `update_account` that
  repoints the folder. A rename answers no folder at all, because the stored one is an absolute
  host path the leader never supplied (#764 review, Minor 2).
- **A new account's id is never allocated from an identity-shaped label** (#764 QA F1, completed
  in B6). The label remains stored for the person's pane, but when it contains `@` the route uses
  an opaque `account-<random>` source for the new slug. This is allocation-time only: every id already
  stored in `agent-accounts.json` remains byte-for-byte unchanged and is never re-keyed, so saved
  selections and callers holding the old handle keep working. Successful rows and duplicate-folder
  refusals use the same `@` predicate; `boss@corp` and `@marcin` are withheld in both paths.
- **Unchanged**: nothing is removed, and a leader that never calls these actions behaves exactly as
  before. `open_account_file` is still refused, with boundary `host-process` — it hands a path to
  an application on the person's desktop — and so is `connect_provider`. `get_account` is
  unchanged, including its rule that a label which looks like an email is withheld.
- **Hosted mode refuses ALL of it, through both doors.** Every mutating verb of the agent-profiles
  family, and both of its per-account GETs, answer 409 when `capabilities().localHandoff` is
  false, and each HANDLER carries that check itself — the refusal is per route, not one guard over
  the family. (The `localHandoffRoute` those routes also carry is registration metadata for
  `localHandoffRouteManifest`, which is what lets the inventory list the local-only routes;
  removing it changes the manifest and refuses nothing — #764 review, Minor 4.) That is the
  opposite of the workspace-settings and provider writes above, and deliberately: this family
  names host paths and account identity. A test pins the 409 for each of the five writes and both
  reads, so taking the check out of any one handler is a visible, named break.
- **What a reader could notice**: the audit trail can now hold `account.create`, `account.update`,
  `account.remove` and `account.select` rows with origin `mcp`. All four rows already existed for
  the cockpit door. The MCP record carries the action id, the operation key and a payload DIGEST —
  never a value, and not the field names either. The cockpit door's records for `POST` and
  `PUT …/selection` now carry the body's field NAMES as well (`fieldNames: true`, as `PATCH`
  already did): names only, so `configDir` appears as a key and never as a path.
- **Four request schemas moved to `packages/contract`** with no change of shape:
  `createAgentProfileInputSchema`, `updateAgentProfileInputSchema` (refinement included),
  `selectAgentProfileInputSchema` and `openAgentAccountFileInputSchema` replace the strict twins
  that were declared in `server.ts`, so each route and the MCP door validate against one
  definition (AGENTS.md § The HTTP API). The wire contract, the bounds and the 400 messages are
  identical, and `contract-parity.requests.test.ts` pins all four in both directions.
- **The record of the old decision is kept, not deleted**: D-122 and the I-122/I-123 rulings stay
  in `docs/features/mcp-server/mcp-settings-classification.md` and
  `docs/features/mcp-server/mcp-ui-action-inventory.md` verbatim, beside the new one, dated.

## The MCP `project_config` tool serves account identity (#677 wave 2 B5) — deliberate, 0.17.0

**This entry is separate from the one above because it deletes a NEGATIVE requirement rather than
widening a positive one**, and because the decision to do so is the owner's alone.

Until 0.17.0, `get_account_details` existed only to refuse, with its own boundary
(`account-identity`) and its own sentence: *"account identity is never served to a project
leader."* Requirements F-03 and F-12 said the same, the inventory recorded I-124 as "None, and it
is a negative requirement", and a test asserted the read was never served. The spec for this
programme recommended keeping it refused (§ 4 Q3: "it deletes a negative requirement rather than
widening a positive one"). The owner decided otherwise, in these words, on 2026-09-20 07:41:
accounts are "**Writes and identity read**".

- **Changed**: `get_account_details` takes `provider` and `accountId` and dispatches
  `GET /api/v1/workspace/agent-profiles/:id/details`, returning exactly what that route returns —
  `available`, its `reason` when false, and the labelled `fields` the agent's own auth file carries
  (email, organisation, plan, depending on the agent). Nothing is added, joined, logged or
  persisted, and a leader must name one account to get one answer.
- **Unchanged, and still pinned**: identity reaches NO other answer of this tool, successful or
  failed. `get_account` still withholds a label that looks like an email, the row a write echoes
  back is narrowed, and `get_capabilities` and `check_account_status` carry neither an identity nor
  a `profileId` nor an `authFailureId`. The tests that asserted "never served" were rewritten to
  the new contract rather than deleted: they now assert that this action serves it and that every
  other action still does not.
- **The ERROR path is covered too, which it was not when this entry was first written** (#764
  review, Major 1). The accounts family's duplicate-folder 409 names the conflicting account by its
  LABEL, and a person may have labelled their own account with their email in the cockpit: a leader
  naming the same folder would have read it. Route error text forwarded by this tool is now
  redacted at the door the same way a label is — a double-QUOTED run carrying an email shape
  becomes `(a label that looks like an identity, withheld)`, and the status and the rest of the
  route's own words are unchanged. The quotes are the scope on purpose: what the service quotes
  back is what a person typed, while a bare email shape also matches an scp-style git remote that
  an unrelated error is entitled to name. **The cockpit's own 409 text is NOT changed**: the person
  who typed the label is who it is for.
- **Hosted mode refuses it**, like the rest of the family: the details handler carries its own
  `capabilities().localHandoff` check and answers 409 when it is false.
- **The boundary identifier `account-identity` is gone from the refusal vocabulary**, together
  with `agent-accounts`, because no refusal names either any more. Both are recorded in the
  generated `docs/features/mcp-server/mcp-api.md` as boundaries that left the list, with the date
  and the reason. A client that matched on either string now sees no refusal carrying it; the
  shape of a refusal is unchanged.
