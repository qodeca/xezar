# MCP settings classification (D-03) — field by field

Status: **classification record; the feature is implemented** (`packages/xezar/src/mcp/tools/project-config.ts` applies this classification). Date: 2026-09-10; status updated 2026-09-11.
Audience: product owner and engineering team.
Baseline: Xezar revision `9fdcf0e878999783db6c2a69dec93a7d00ccea44` (v0.13.1) and the current repository
instructions. Delivers [issue #77](https://github.com/qodeca/xezar/issues/77), phase 1 of
[epic #67](https://github.com/qodeca/xezar/issues/67).

Contract: [MCP server for a single-project leader](mcp-project-leader-requirements.md) — section 3
(scope), section 8 (technical boundaries), section 10 (D-03) and Definition-of-Done clause 5. The
product boundary is **settled** and this document does not reopen it: *project writes, and only safe
effective capability/limit reads from shared settings*. What this document decides is which field
falls where.

This is a decision table, not a tool catalog. It assigns no tool names, defines no transport, and
claims no implementation. The companion inventory of UI actions is
`mcp-ui-action-inventory.md` (a sibling document written in parallel; this document cites it by name
and never edits it).

---

## 1. How to read a row

The unit of a row is one **field or one action**, not one file and not one endpoint. Where a file's
read and its write have different answers, they are two rows. Every row carries exactly one status:

| Status | Meaning |
| --- | --- |
| **project-write** | In scope for the leader, bound to THIS project. Reads and writes alike: the effect stays inside the bound project's own state, and nothing about another project, another account, or the machine changes. |
| **safe-effective-read** | The value lives in shared (workspace, machine or home) state. The leader may READ an effective capability or limit derived from it, and may never write it. Every such row states what is deliberately withheld. |
| **excluded** | The leader must not touch it at all — no read, no write. Global administration, another project's data, an account identity, a secret, a host process, or pure presentation with no business effect. |

Two rules bind every row:

- **No row resolves an ambiguity by widening a schema.** Where a field is unclear, the resolution
  narrows what MCP may do; it never grows a contract schema, a route body, or a scope.
- **`excluded` for presentation is not a demotion.** Section 3 already settles it: *pure
  presentation actions, such as scrolling, need no separate tool when equivalent information or
  operations are available*. Those rows say `(presentation)` in the reason.

---

## 2. Enforcement primitives

Rows cite these by name instead of repeating them. Each is a real symbol in this repository, verified
at the baseline revision.

| Id | The enforcement | Where it lives | Status today |
| --- | --- | --- | --- |
| **E-BIND** | The project is resolved from a trusted binding and never from a caller-supplied parameter. The HTTP seam is the scope-resolver middleware `resolveProjectScope`, which sets `c.get('project')` for every project-scoped route. | `packages/xezar/src/server/server.ts:1334`; `packages/xezar/src/server/project-context.ts` `ProjectContexts.context` | Exists for project-scoped ROUTES. For MCP it must become the only source of the project id (F-01, F-16, section 8). |
| **E-409-LOCAL** | Writing agent config is a local-machine capability: `PUT /api/v1/p/:projectId/agent-config/:id` answers **409** whenever `capabilities().localHandoff` is false. **This 409 closes a hooks-based remote-code-execution path — config files may define hooks and MCP commands. No classification in this document routes around it, and every agent-config row names it.** | `packages/xezar/src/server/server.ts:5384`; `packages/xezar/src/server/capabilities.ts` `resolveCapabilities` | Exists. Must not be weakened, bypassed, or re-implemented anywhere else. |
| **E-409-PROFILE** | Every agent-account route answers 409 (`hostedProfileRefusal`) when `capabilities().localHandoff` is false, and `GET /workspace/agent-profiles` withholds the whole listing rather than serving it read-only. | `packages/xezar/src/server/server.ts:1989`, `:2045`, `:2111`, `:2147`, `:2167`, `:2218`, `:2271`; listing at `:1955` | Exists. |
| **E-SCOPE-USER** | A catalog file whose `ConfigFileDef.scope` is `'user'` is refused for MCP, keyed off the catalog **field** and never off path matching. | `packages/xezar/src/agent-config/catalog.ts` `ConfigFileDef.scope`; resolved per request by `findConfigFile(id)` at `packages/xezar/src/server/server.ts:5365` | **Does not exist yet.** `listAgentConfig` sets `writable: editable` for every file regardless of scope (`packages/xezar/src/agent-config/service.ts:109`), so today the only gate is E-409-LOCAL. This is MCP-layer work, listed in §7. |
| **E-SINGLE** | `PATCH`/`DELETE /api/v1/projects/:projectId` answer 409 in single-project mode. | `packages/xezar/src/server/server.ts:2441` (PATCH), `:2360` (DELETE) | Exists. Defence in depth only — it is not the project binding. |
| **E-CONTRACT** | The bounds a write may take are the zod schemas in `packages/contract`, unchanged: `setConfigInputSchema` and `setWorkspaceConfigInputSchema` (`packages/contract/src/workspace.ts:379`, `:94`), `updateProjectInputSchema` (`packages/contract/src/projects.ts:133`), `uiStateSchema` / `workspaceUiStateSchema` / `setWorkspaceUiStateInputSchema` (`packages/contract/src/workspace.ts:167`, `:229`, `:277`), `setAgentConfigInputSchema` (`packages/contract/src/agent-config.ts:84`). | `packages/contract/src/*`; validated as route middleware through `packages/xezar/src/server/validators.ts` | Exists. MCP reuses these; it never declares a parallel shape and never widens one. |
| **E-NARROW** | A workspace-level response that lists every project is narrowed to the bound project's own entry before it reaches the leader; the full listing is never proxied. | `GET /api/v1/projects` (`server.ts:2333`), `GET /workspace/agent-profiles` (`:1955`) | **Does not exist yet** — both routes are workspace-level and single-mount by design. MCP-layer work, §7. |

**The four routes that carry a `projectId` the caller chose** are the ones E-BIND has to cover
first, because their route scope is not a binding: `PATCH /api/v1/projects/:projectId`,
`DELETE /api/v1/projects/:projectId`, `PUT /api/v1/workspace/agent-profiles/selection` (a
`projectId` in the BODY, `server.ts:2219`) and the three `workspace/skills-update` routes (a
`projectId` in the body or query, `server.ts:2735`–`:2751`).

---

## 3. The four product decisions

The project leader has decided the four mismatches issue #77 names. Each is recorded with its
reason and the alternative that was rejected.

### D-03-1 — Agent config `scope: 'user'` entries → `excluded`

**Decision.** The six catalog entries whose `scope` is `'user'` are excluded from MCP entirely — no
read of their content, no write.

**Reason.** M-16 excludes home and global file administration **even behind a project route**, and
`~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.codex/config.toml`, `~/.codex/AGENTS.md`,
`~/.config/opencode/opencode.json` and `~/.config/opencode/AGENTS.md` are each shared by every
project on the machine. A leader bound to project A editing one of them changes project B, which
Definition-of-Done clause 5 requires engineering to prove impossible.

**Enforcement.** E-SCOPE-USER — keyed off the catalog `scope` field, never off path matching. A path
test would drift the moment `$CODEX_HOME` or `$XDG_CONFIG_HOME` relocates a home
(`AgentHomePaths`, `catalog.ts:28`), and the catalog is the only place that vendor knowledge lives.
E-409-LOCAL still applies underneath.

**Rejected alternative.** Allowing them because the route is project-scoped. Route scope is not
proof of authorization (section 8, first bullet), and `agent-config` is the worked example the
requirements name.

**What the leader keeps.** The effective consequence, already served project-scoped and naming no
path or content: `modelsLocked` on `GET /api/v1/p/:projectId/config`
(`packages/contract/src/workspace.ts:344`).

### D-03-2 — Provider enable/disable → `safe-effective-read` only

**Decision.** The leader reads which providers are usable and the understandable reason one is not
(F-03). It may not toggle `enabled`.

**Reason.** `disabledProviders` is a workspace-wide key: the handler merge-writes it into
`~/.xezar/config.json` (`server.ts:1727`–`:1732`), so a write from project A's leader changes
project B.

**Enforcement.** E-BIND plus the absence of any MCP write path to
`PUT /api/v1/providers/:provider/enabled`. The read is derived from
`providerStatusSchema` (`packages/contract/src/workspace.ts:480`), whose own comment records the
boundary: *credentials, account identity, and raw CLI output never cross this boundary*.

**Rejected alternative.** A project write. Implementing one would require a per-project override of a
workspace key, and section 8 forbids exactly that: *any project override must be actually local in
effect; do not expand global authority to implement it*.

### D-03-3 — Agent-account selection → `safe-effective-read` only, handle and label

**Decision.** Both the project Agents section's account half and the global Accounts section's
"Defaults for new projects" are excluded as writes. The leader reads only the **effective profile
handle and display label** for its own project — never the account identity.

**Reason.** `PUT /api/v1/workspace/agent-profiles/selection` writes
`~/.xezar/agent-accounts.json`, a global personal file
(`packages/xezar/src/workspace/agent-accounts.ts`), and the value names an account identity, which
F-12 and N-01 restrict.

**Enforcement.** E-409-PROFILE, E-BIND (the `projectId` is in the request body, `server.ts:2219`)
and E-NARROW. The read resolves through `selectionFor(store, repoRoot, provider)`
(`agent-accounts.ts:280`) for the BOUND root only, and reports two fields:
`AgentAccount.id` (the local handle, bounded by `AGENT_ACCOUNT_ID_RE`) and `AgentAccount.label`.

**Withheld, always.** Any email, login or credential; `configDir` and `path` (absolute host paths
carrying the username); every other project's selection; the machine-wide `defaults` map; and the
whole of `readAccountIdentity` (`packages/xezar/src/agent-config/account-identity.ts`), which is the
one deliberate, localHandoff-gated identity read in the product and stays outside the MCP boundary.

**Rejected alternative.** Allowing the per-project selection write. F-12 states global accounts
cannot be administered, and the selection is stored in the accounts file precisely because it
belongs to the accounts, not to the registry (`server.ts:2211`–`:2213`).

### D-03-4 — Per-project `maxParallel` and `tags` → `project-write`; Remove → `excluded`

**Decision.** `MaxParallelSelect` and `ProjectTagsEditor`, both writing
`PATCH /api/v1/projects/:projectId`, are project writes **for the bound project only**, and never a
write of the workspace-level `resources.maxParallel`. `useProjectRemoval` /
`DELETE /api/v1/projects/:projectId` is excluded.

**Reason (the two writes).** Both are actually local in effect, which is the test section 8 sets.
The registry entry's `maxParallel` is the more-specific-wins narrowing of this project's own cap —
`loadResourceLimits` builds the root→limit map from `projects[].maxParallel`
(`packages/xezar/src/workspace/semaphore.ts:163`–`:166`) and `projectMaxParallel(repoRoot)` applies
it to that root alone (`:395`). `tags` are a lens and nothing else: the editor's own comment records
that no other part of xezar reads them as a permission, a queue or a routing rule
(`projects-section.tsx:392`–`:398`). Section 3 forbids excluding a business action merely because
its endpoint is global, and this is that case.

**Reason (Remove).** It deregisters the project from the workspace registry and destroys the
leader's own binding. It is irreversible shared state from the leader's point of view, and a
capability whose success makes every subsequent call meaningless is not a project action.

**Enforcement.** E-BIND is the whole of it, and it is not optional here: `projectsRoutes` is a
WORKSPACE-level, single-mount family (`server.ts:2332`, mounted at `:5654`), so the `:projectId`
path parameter is caller-supplied and carries no binding of its own. The MCP layer must substitute
the bound project's id and refuse — never forward — a `projectId` a client names, including the
reserved `default` alias, which the handler resolves through `resolveBootProject()`
(`server.ts:2451`) to whatever project this server booted in. E-CONTRACT keeps the bounds
(`updateProjectInputSchema`: `maxParallel` integer 1–16 or `null`, `tags` at most 20 entries of at
most 32 characters). E-SINGLE remains as defence in depth.

**Rejected alternative.** Exposing Remove because it sits in the same reused component
(`remove-project.tsx` is shared verbatim by the global registry table and the project's own General
page). Component reuse is not a scope argument.

### D-03-5 — Project workflow check steps → never added and never removed through MCP (F-22)

Added on 2026-09-11 by [#262](https://github.com/qodeca/xezar/issues/262), after the #117 acceptance
suite found this document silent on it (finding F-22 / A-22). Leader decision; not one of the four
mismatches above.

**Decision.** A project workflow is a `project-write` for its agent steps only. A check step (a step
with `command`) is a quality gate, and MCP neither adds one nor removes or weakens one. Saving a
check step was already refused. Now `project_config save_workflow` and `delete_workflow` are also
refused when they would take away a check step that a workflow file **on disk** has:

- an overwrite (`overwrite: true`) of the file the save writes (`.xezar/workflows/<slug>.yaml`)
  while that file has a check step. Deleting the step, emptying its command and turning it into an
  agent step are all this case, because an MCP save can carry no check step at all;
- a save under the `name` of another workflow file that has a check step, which would shadow it;
- a delete of a workflow whose file has a check step;
- an overwrite target that cannot be parsed, because it cannot be shown to hold no check step.

The refusal is a reported blocker in the tool's own words (`boundary: 'quality-gate'`,
`blocker: true`), names each check step it would remove by step id and file, dispatches nothing and
writes nothing. No argument makes it succeed, and the input schema stays strict, so an invented
`force` or `qualityException` key is an argument error.

**Reason.** Refusing to add a gate while allowing its removal protects nothing. A leader that can
delete `npm test` from a workflow silently turns off that gate for every task the workflow runs
afterwards. The project rule is that quality validation failures stay visible and cannot be
dismissed as accepted exceptions. The safe default wins.

**Enforcement.** The MCP layer (`packages/xezar/src/mcp/tools/project-config.ts`,
`checkStepsAtRisk`) reads the workflow files from disk before it dispatches. It never trusts the
caller's description of what is there. The cockpit's own Save and Delete are unchanged: a person
changes a gate in the cockpit.

**Rejected alternative.** Making the rule symmetric by letting MCP save check steps as well. F-08
keeps arbitrary operating-system commands out of this surface.

---

## 4. The field matrix

Routes are written project-scoped where they are project-scoped (`/api/v1/p/:projectId/…`) and
workspace-level otherwise. All are under `/api/v1`.

### 4.1 Project → Agents — `packages/web/src/routes/settings/agents-section.tsx`

Every row except the last four writes `PUT /p/:projectId/config`, bounded by `setConfigInputSchema`
and merged into that repo's own `.xezar/config.json` (`server.ts:5204`).

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `defaultRunner` | project-write | Names the agent this repo runs by default; effect is confined to this checkout's config file. | E-BIND, E-CONTRACT (`setConfigInputSchema.defaultRunner`, `workspace.ts:381`) | — |
| `defaultModels.{claude,codex,opencode,pi}` | project-write | Per-runner model preset for this repo only; merged per runner so one write never clobbers another. | E-BIND, E-CONTRACT (`workspace.ts:383`); refused 409 when `agentModelsLocked(repoRoot)` (`server.ts:5208`) | — |
| `modelsLocked` (read) | safe-effective-read | The one effective consequence of the excluded user-scope files: whether native agent settings are authoritative. A boolean, and a boolean is the whole answer. | Derived by `agentModelsLocked` / `readAgentModelDefaults` (`packages/xezar/src/agent-config/models.ts`), served by `configAnswer` (`server.ts:5166`) | Which file locked it, its path, its contents, and any account identity inside it. |
| `systemPrompt` | project-write | Extra instructions for this repo's runs; capped at 20 000 characters by the schema. | E-BIND, E-CONTRACT (`workspace.ts:382`) | — |
| `liveTitleUpdates` | project-write | Tri-state per repo; `null` clears back to the `XEZ_TITLE_UPDATES` default. | E-BIND, E-CONTRACT (`workspace.ts:397`) | — |
| `reviewGate` | project-write | Tri-state per repo; `null` clears back to the `XEZ_REVIEW_GATE` default (OFF). Not a quality control — F-22 gates are unaffected by it. | E-BIND, E-CONTRACT (`workspace.ts:399`) | — |
| `plannerModel`, `namerModel` | project-write | Two background jobs scoped to this repo's runs. | E-BIND, E-CONTRACT (`workspace.ts:401`, `:403`) | — |
| `skillsRepos` | project-write | This repo's team-skill sources; `[]` is a real "no team skills". The fetch populates the shared cache under `~/.cache/xez/`, which is a cache keyed by source and never a setting another project reads. | E-BIND, E-CONTRACT (`workspace.ts:405`, max 32) | — |
| `baseBranch` | project-write | This repo's branch base; `null` restores "follow checked-out branch". | E-BIND, E-CONTRACT (`workspace.ts:380`) | — |
| Default agent picker — ACCOUNT half (`useSelectAgentProfile` → `PUT /workspace/agent-profiles/selection`) | safe-effective-read | **D-03-3.** Writes a global personal file and names an account identity. | E-409-PROFILE, E-BIND, E-NARROW; read through `selectionFor` (`agent-accounts.ts:280`) | Email/login/credential, `configDir`/`path`, other projects' selections, the machine-wide `defaults` map. |
| Providers card — `status` and `hint` per provider (`GET /providers/status`) | safe-effective-read | F-03: the leader must know which dependencies are usable and why one is not. Coarse states only: `connected` / `disconnected` / `not-installed` / `unknown`. | `providerConnectionStateSchema` (`workspace.ts:465`); `ProviderAuth.status()` | Credentials, account identity, raw CLI output (the schema's own stated boundary), `profileId`, and the login `command` string. |
| Providers card — `enabled` toggle (`PUT /providers/:provider/enabled`) | safe-effective-read | **D-03-2.** `disabledProviders` is workspace-wide. The leader reads `enabled`; it never writes it. | Workspace merge-write at `server.ts:1727`; no MCP write path | The other projects that the same key governs — expressed as: the leader is told a provider is off, not offered the switch. |
| Providers card — Connect (`POST /providers/connect`) | excluded | Opens a **terminal on the host machine** (`openTerminal`, `server.ts:1825`) and, with a `profileId`, names an account's absolute path. Section 3 excludes arbitrary operating-system processes; M-22 excludes global login sessions. | E-409-PROFILE for the named-account spelling (`server.ts:1774`); no MCP path for either | Everything: the command, the path, and the terminal. |
| Providers card — Try again (`POST /providers/:provider/retry`) | excluded | `clearRuntimeAuthFailure` clears a workspace-wide provider incident (`server.ts:1753`), so project A's leader would clear project B's warning. The leader reports the blocker instead (F-09, F-22). | No MCP write path | — |
| Providers card — Check again (refresh) | safe-effective-read | A refresh of the same coarse status; it spawns a probe, so MCP serves the cached answer and refreshes only on explicit demand, as `GET /workspace/agent-profiles` already does for its own listing (`server.ts:1881`). | `GET /providers/status?refresh=1` (`server.ts:1711`) | Same as the `status` row. |
| `dismissedProviderAuthFailures` (workspace ui-state) | excluded | Workspace-wide record of which incident a BROWSER dismissed (presentation). Nothing about execution depends on it. | `workspaceUiStateSchema.dismissedProviderAuthFailures` (`workspace.ts:241`) | — |

### 4.2 Project → Agent config — `agent-config-section.tsx`

Rows are by catalog entry (`packages/xezar/src/agent-config/catalog.ts` `CONFIG_FILES`, 14 entries).
**Every row here is gated by E-409-LOCAL**, named individually as required.

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `claude.user.settings`, `claude.user.memory`, `codex.user.config`, `codex.user.memory`, `opencode.user.config`, `opencode.user.memory` — read AND write | excluded | **D-03-1.** The six `scope: 'user'` entries; home files shared by every project on the machine. | E-SCOPE-USER (`ConfigFileDef.scope`, `catalog.ts:52`; `findConfigFile` at `server.ts:5365`) **plus E-409-LOCAL** (`server.ts:5384`) | Their content, their absolute paths, and their existence beyond the `modelsLocked` boolean. |
| `claude.project.settings`, `claude.local.settings`, `claude.project.memory`, `claude.local.memory`, `project.agents` (`<repo>/AGENTS.md`) — write | project-write | In-repo files belonging to this checkout. `.local` entries are gitignored personal layers seeded into the run's worktree (`seeded: true`), still inside this project. | E-BIND, **E-409-LOCAL** (`server.ts:5384`), E-CONTRACT (`setAgentConfigInputSchema`, content ≤ 2 000 000 bytes, `version` as the stale-write token) | — |
| The same five — read | project-write | This project's own files. Byte-exact; xezar never re-serialises a file it opened. | E-BIND; `readConfigFile` (`server.ts:5375`); hosted-mode 409 for `tracked === 'outside-repo'` (`server.ts:5367`) — which none of these five are | — |
| `claude.project.mcp` (`.mcp.json`), `codex.project.config`, `opencode.project.config` — write | project-write | In-repo project files. Full content, exactly as the cockpit writes them. | E-BIND, **E-409-LOCAL** (`server.ts:5384`), E-CONTRACT | — |
| The same three — read | safe-effective-read | **Asymmetric by ruling.** These are the project files with `holdsMcp: true` (`catalog.ts:154`, `:228`, `:273`). An MCP server definition's argument values are the classic place a token is pasted, so the read returns STRUCTURE only: server names, transport kind, argument shape. | E-BIND; the response is built from the parsed file, never from its bytes | Every argument VALUE — command strings, `args`, `env`, headers, URLs, tokens — and the file content itself (F-15). Target: elide the MCP section only, in a file that also holds ordinary settings. Safe fallback while that is unbuilt: structure-only for the whole file, which narrows and never widens. |
| `userMcp` block (`~/.claude.json` server names) | excluded | Claude's own home state file, shared by every project. The cockpit itself withholds it whenever `editable` is false. | `readUserMcpServers` (`packages/xezar/src/agent-config/service.ts:64`); withheld at `:117` | The path, the server names, and the file. |
| `writable` / `readOnlyReason` flags | safe-effective-read | Whether agent config may be edited at all here — the honest capability behind E-409-LOCAL. | `listAgentConfig` (`service.ts:109`–`:110`) | Nothing beyond the boolean and its one-line reason. |

### 4.3 Project → Worktrees — `worktrees-section.tsx`, `worktrees-panel.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `worktreeRetention` (keep last N) | project-write | Sizes THIS repo's own worktree pool. The workspace `resources.worktreeRetentionDefault` only seeds projects that set none. | E-BIND, E-CONTRACT (`workspace.ts:395`, 0–1000) | — |
| Worktree list (`GET /p/:projectId/worktrees`) | project-write | Reads this project's worktrees only (M-17). | E-BIND | — |
| Reclaim now | project-write | Runs the count-based enforcer for this project; directories only, branches kept. | E-BIND; same active-work protections as the UI | — |
| Delete one worktree | project-write | Destructive and in scope (F-04, M-17): removes the directory AND the branch for one of this project's runs. Confirmation clicks are not reproduced (section 3). | E-BIND; run ownership validated per F-02 | — |

### 4.4 Project → Bookmarklets — `bookmarklets-section.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| One-click launch (auto-submit) checkbox | excluded | Local component state, never persisted, no server effect *(presentation)*. | `useState` in `BookmarkletPanel` (`bookmarklets-section.tsx:64`) | — |
| Bookmarklet generation, and `GET /p/:projectId/launch-key` | excluded | The generated `javascript:` URL embeds the project's launch key, which is a **secret**. F-15: credentials must not enter tool responses, history or event logs. A browser bookmark is also meaningless to a leader that is not a browser. | `launchKeyResponseSchema` (`packages/contract/src/projects.ts:191`) and its own rule — *the value never renders as text, never logs*; route at `server.ts:3046` | The launch key, and every URL containing it. |
| Skill list shown in the panel (`GET /p/:projectId/skills`) | project-write | This project's skill catalog, which F-05 requires the leader to inspect anyway. | E-BIND | — |

### 4.5 Project → Prompt templates — `prompt-templates-section.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `promptTemplates` | project-write | Per-repo follow-up snippets in `.local/xezar/ui-state.json`. Exposed as a **whole-list read and replace**: `PUT /p/:projectId/ui-state` merges shallowly at the top level (`server.ts:3104`), so a per-item write would silently clobber the rest of the list. | E-BIND, E-CONTRACT (`uiStateSchema.promptTemplates`, `workspace.ts:197`; key cap `capUiStateKeys`) | — |

### 4.6 Project settings index → General — `project-general.tsx`, `project-location.tsx`

`ProjectGeneral` is not a registry section; it renders on the project settings index route
(`settings-shell.tsx:228`).

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| Project folder (`root`) | project-write | The bound project's own absolute root — the string every worktree and git command already resolves against, and F-03 requires the leader to discover the bound project. | E-BIND, E-NARROW (read from the bound registry entry, never from the listing) | In hosted mode the server already trims the root to a basename in `/health` (`server.ts:1475`); MCP follows the same rule rather than inventing a second one. |
| Copy path | excluded | Browser clipboard *(presentation)*. | — | — |
| Open with… (`POST /p/:projectId/open-in`) | excluded | Launches a desktop application on the machine hosting xezar. M-19 requires an unavailable desktop capability to be **reported**, not promised on the client's machine; the route already 409s in hosted mode (`server.ts:4422`). | `openProjectInSchema` (`projects.ts:577`); hosted refusal at `server.ts:4422` | — |
| Desktop-handoff availability (`GET /open-targets`) | safe-effective-read | The honest capability behind the row above: whether local handoff exists at all. The route already answers `[]` in hosted mode. | `server.ts:4414` (`capabilities().localHandoff ? detectOpenTargets() : []`) | The ids and labels of the applications installed on the host. The leader learns "unavailable", not the machine's software inventory. |
| Project facts — `name`, `status`, `branch`, `addedAt`, `lastOpenedAt`, `source` | project-write | Facts about the bound project, re-probed on every registry read. | E-BIND, E-NARROW | Every other registry row. |
| Max parallel tasks (`MaxParallelSelect` → `PATCH /projects/:projectId`) | project-write | **D-03-4.** Bound project only. | E-BIND (the family is workspace-level and single-mount, `server.ts:2332`), E-CONTRACT (`updateProjectInputSchema.maxParallel`), E-SINGLE | The workspace-level `resources.maxParallel`, which is never writable from here. |
| Remove from workspace (`useProjectRemoval` → `DELETE /projects/:projectId`) | excluded | **D-03-4.** Deregisters the project and destroys the leader's own binding. | No MCP path; E-SINGLE and the server's own 409s (running tasks, boot project) remain | — |

### 4.7 Global → Appearance — `appearance.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| Theme | excluded | `localStorage` (`xez-theme`), per browser, never on the server *(presentation)*. | `packages/web/src/lib/theme.ts` | — |
| Accent, density, reading width | excluded | Workspace-wide personal presentation in `~/.xezar/ui-state.json` — M-21 excludes global settings, and these describe the person at the keyboard *(presentation)*. | `workspaceUiStateSchema.appearance` (`workspace.ts:251`); written by `appearance-provider.tsx` through `PUT /workspace/ui-state` | — |

### 4.8 Global → Notifications — `notifications-section.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `notifications.enabled` | excluded | Workspace-wide, and it governs delivery to a BROWSER. The leader receives its own events through the MCP event channel (F-09, F-20), so nothing is lost *(presentation)*. | `workspaceUiStateSchema.notifications` (`workspace.ts:254`) | — |

### 4.9 Global → Resources — `resources-section.tsx`, all writing `PUT /workspace/config`

Every key here is enforced workspace-wide by `WorkspaceSemaphore`
(`packages/xezar/src/workspace/semaphore.ts` `loadResourceLimits`, `:160`), so every row is a read.

| Field | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `resources.maxParallel` | safe-effective-read | The workspace ceiling every project shares; a write changes every project's throughput. The leader needs the number to plan (F-03). | `semaphore.ts:181`, `:395`; write bounded by `setWorkspaceConfigInputSchema.resources` (`workspace.ts:126`) — never from MCP | The per-project overrides of OTHER projects (`projectLimits`, `semaphore.ts:163`). The leader reads the workspace cap and its own project's cap, nothing else. |
| `resources.maxMonitoringSessions` | safe-effective-read | Workspace-wide monitoring capacity. | `semaphore.ts:182` | How many of those sessions other projects are currently holding — the leader reads the ceiling, never the workspace-wide occupancy that would name another project's activity. |
| `resources.monitoringWakeIntervalMinutes` | safe-effective-read | Workspace-wide cadence; `null` means stay parked. | `semaphore.ts:183` | Other projects' monitoring sessions and their wake schedules. |
| `resources.autoResumeOnUsageLimit` | safe-effective-read | Workspace-wide; explains to the leader why a stopped run resumes on its own (F-09). | `semaphore.ts:184` | The provider usage-limit state itself, which belongs to an account (F-12): the leader learns that auto-resume is on, not whose subscription hit a limit. |
| `resources.idleTimeoutMinutes` | safe-effective-read | Workspace-wide. Absent reads as 15; an explicit `null` means never close an idle session, and the two must stay distinguishable in the read. | `semaphore.ts:185` | The idle state of any session outside this project. |
| `resources.memoryLimitMb` and `memoryLimitDefaultMb` | safe-effective-read | The workspace ceiling and the host-derived default an absent key falls back to (`deriveDefaultMemoryLimitMb`). | `semaphore.ts:186`, `:284` | The host's total memory, beyond the derived ceiling the response already reports. |
| `resources.worktreeRetentionDefault` | safe-effective-read | Seeds projects that set none; this project's own value is the project-write in §4.3. | `setWorkspaceConfigInputSchema` (`workspace.ts:133`) | Which other projects have taken the default and which have overridden it — that map is other-project data (N-01). |
| `followups` / `effectiveFollowups` | safe-effective-read | Workspace-wide switch for the follow-up Inbox; stored wins, absent inherits `XEZ_FOLLOWUPS`. The leader needs the effective answer to know whether Inbox actions exist (M-06). | Resolved once in `WorkspaceSemaphore.followupsEnabled` (`semaphore.ts:301`) and threaded into `resolveCapabilities` | The stored-versus-inherited distinction is reportable; the write is not. |
| `agentEnvPassthrough` / `effectiveAgentEnvPassthrough` | safe-effective-read | Workspace-wide list of extra environment-variable NAMES forwarded to agents. `[]` is a real "forward nothing". | `semaphore.ts:308`; `setWorkspaceConfigInputSchema.agentEnvPassthrough` (`workspace.ts:102`) | **The VALUES.** Only names are ever stored, and only names are ever reported — a value is a credential by default (F-15). |
| `composerDefaults.autonomous` / `.worktree` (+ `inheritedAutonomous`, `inheritedWorktree`) | safe-effective-read | Workspace-wide seed for new tasks. F-06 makes the leader state every option explicitly on create, so it reads these to predict the human's composer, never to change it. | `workspaceConfigResponseSchema.composerDefaults` (`workspace.ts:45`) | The environment variables behind the `inherited*` answers (`XEZ_AUTONOMOUS_DEFAULT` and friends) — the leader reads the resolved value and the fact that it is inherited, never the host's environment. |
| Link to per-project limits (`resources-project-limits-link`) | excluded | Navigation *(presentation)*. | — | — |

### 4.10 Global → Skills — `skills-section.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| `skillsAutoUpdate` / `effectiveSkillsAutoUpdate` | safe-effective-read | A workspace key in `~/.xezar/config.json`; stored `null` inherits `XEZ_SKILLS_AUTO_UPDATE`. | `skillsUpdateResponse` re-stamps it on the way out (`server.ts:2728`–`:2731`) | The host environment behind the inherited answer, and the global install locations the updater writes to. |
| Check for skill updates (`POST /workspace/skills-update/check`) | safe-effective-read | A POST that is a read in effect: it probes and reports, changing nothing on disk. M-14 flags this family as global despite carrying a `projectId`. | `server.ts:2744`; `resolveSkillsUpdateRoot` — and **E-BIND**, because the `projectId` is caller-supplied | Other projects' scope states. The response carries a `scopes` array covering `project` AND `global` (`skillsUpdateScopeStateSchema`, `workspace.ts:431`); the leader's read is narrowed to its own project's scope plus the global availability flag and reason. |
| Apply skill updates (`POST /workspace/skills-update/apply`) | excluded | Rewrites installed skill files at GLOBAL scope, which every project on the machine then reads. M-14 and M-21. | `server.ts:2751`; no MCP path | — |
| Installation status line | safe-effective-read | The human-readable reason a check is unavailable (F-03). | `skillsUpdateStateSchema.status` / `scopes[].reason` (`workspace.ts:445`) | Absolute install paths. |

### 4.11 Global → Agent accounts — `accounts-section.tsx`, `add-account-dialog.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| Effective account for the bound project (read) | safe-effective-read | **D-03-3.** Reported as a local profile **handle** and a **display label**. | E-409-PROFILE, E-BIND, E-NARROW; `selectionFor` (`agent-accounts.ts:280`) | Email, login, credential; `configDir` and `path`; other projects' selections; the machine-wide `defaults` map; every other account row. |
| Account listing (`GET /workspace/agent-profiles`) | excluded | Lists every account and every project's selection, and echoes absolute paths carrying the username — the same disclosure `/health` trims in hosted mode. | `server.ts:1955`; E-409-PROFILE | The listing entirely. Only the narrowed read above survives. |
| Per-project selection write, and the machine-wide default write (`projectId: null`) | excluded | **D-03-3.** A global personal file, naming an account identity. | `server.ts:2214`–`:2264`; E-409-PROFILE | — |
| Add account (`POST /workspace/agent-profiles`) | excluded | Creates a second login on the machine and points an agent at a host directory. F-12, M-22. | `server.ts:1988`; E-409-PROFILE | — |
| Rename account (`PATCH /workspace/agent-profiles/:id`) | excluded | Global account administration. | `server.ts:2040`; E-409-PROFILE | — |
| Remove account (`DELETE /workspace/agent-profiles/:id`) | excluded | Global account administration, irreversible for every project. | `server.ts:2267`; E-409-PROFILE | — |
| Connect an account (`POST /providers/connect` with `profileId`) | excluded | A host terminal plus an account path. See §4.1. | `server.ts:1774` | — |
| Re-check an account (`GET /workspace/agent-profiles/:id/status`) | excluded | Probes one named account's login; naming the account is the disclosure. | `server.ts:2106`; E-409-PROFILE | — |
| **Show details (`GET /workspace/agent-profiles/:id/details`)** | excluded | **This is the account-identity read** — email, organization and similar claims from the agents' own auth files. F-12 and N-01 restrict it absolutely, and its module states it is answered to exactly one route, never joined, never logged. | `readAccountIdentity` (`packages/xezar/src/agent-config/account-identity.ts`); route at `server.ts:2144`; E-409-PROFILE | Everything it returns. |
| Open an account's folder or file (`POST /workspace/agent-profiles/:id/open`) | excluded | Opens home-directory content in a local application. | `server.ts:2162`; E-409-PROFILE | — |
| "Defaults for new projects" — `agentDefaults.runner`, `agentDefaults.models.*` | excluded | Machine-wide seed keys. Nothing is lost: the leader already reads the EFFECTIVE runner and models for its own project on `GET /p/:projectId/config` (`configAnswer`, `server.ts:5167`–`:5176`), so reporting the machine-wide key would add a fact about the machine and no capability. | `workspaceConfigResponseSchema.agentDefaults` (`workspace.ts:75`); no MCP path | — |
| Agent installed / version rows | safe-effective-read | Which agents this host can run — an availability fact F-03 requires, with an understandable reason when one is missing. | `GET /health` checks | Install paths, home directories, account identity. |

### 4.12 Global → Projects — `projects-section.tsx`

| Field / action | Status | Reason | Enforcing code path | Withheld |
| --- | --- | --- | --- | --- |
| Registry listing (`GET /projects`) | excluded | Every other project's name, absolute root, branch, tags and status. N-01: an inaccessible resource must not reveal another project's name, content or existence. | `server.ts:2333`; E-NARROW reduces it to the bound entry (§4.6) | The whole list except the bound project's own row. |
| Add project (`POST /projects`) | excluded | Registers a new project in the workspace registry — the definition of managing multiple projects (section 3). | `server.ts:2353` | — |
| Clone from GitHub (`POST /projects/checkout`) | excluded | Creates a checkout on the host outside the bound project and registers it. | `server.ts:2508` | — |
| Folder browser (`GET /fs/browse`) | excluded | Lists host directories outside the bound project. A-04 requires forbidden paths to be rejected. | `fsBrowseResponseSchema` (`projects.ts:173`) | — |
| `browseRoot`, `projectsDir` | excluded | They parameterise only the two excluded actions above, and they disclose host paths outside this project. | `setWorkspaceConfigInputSchema` (`workspace.ts:95`–`:96`) | — |
| Per-row Max parallel — **bound project** | project-write | **D-03-4.** See §4.6. | E-BIND, E-CONTRACT, E-SINGLE | — |
| Per-row Max parallel — any other project | excluded | Another project's limit. | E-BIND refuses the foreign `projectId` before the route is reached | — |
| Tags — **bound project** | project-write | **D-03-4.** Whole-list replace; there is no add-one/remove-one spelling, and the server normalises (trim, dedupe case-insensitively, sort). | E-BIND, E-CONTRACT (`updateProjectInputSchema.tags`); normalisation at `server.ts:2485` | — |
| Tags — any other project | excluded | Another project's data. | E-BIND | — |
| Tag autocomplete vocabulary (`allProjectTags(registry.projects)`) | excluded | It is built from EVERY project's tags, so serving it would leak the workspace's other projects through a field that looks like an autocomplete convenience. | `projects-section.tsx:258` | The vocabulary. The leader reads and writes its own project's tags only. |
| Per-row Remove | excluded | **D-03-4.** | See §4.6 | — |

### 4.13 Cross-cutting — the two GUI preference bags

Per-repo `.local/xezar/ui-state.json` (`GET/PUT /p/:projectId/ui-state`, `uiStateSchema`) and
workspace `~/.xezar/ui-state.json` (`GET/PUT /workspace/ui-state`, `workspaceUiStateSchema`). Both
are deliberately open bags (BACKWARD_COMPATIBILITY.md §3): unknown keys round-trip untouched, so
this list names the keys the schemas name, never the keys they permit.

| Key | Bag | Status | Reason | Enforcing code path |
| --- | --- | --- | --- | --- |
| `promptTemplates` | per-repo | project-write | §4.5. | E-BIND, `uiStateSchema` (`workspace.ts:197`) |
| `githubView` | per-repo | excluded | Which sub-tab the GitHub view last showed *(presentation)*. | `workspace.ts:191` |
| `runsView` | per-repo | excluded | List-versus-table rendering *(presentation)*. | `workspace.ts:189` |
| `lastTask`, `recentSources`, `lastWorktree`, `lastAutonomous`, `lastGenerateFollowups`, `skillUsage` | per-repo | excluded | Composer PRESELECTION memory for a browser. F-06 requires MCP to state every task option explicitly on the create call, so the leader loses nothing — and writing them would move the human's form under their hands while they type. | `workspace.ts:172`–`:188` |
| `appearance` (per-repo copy) | per-repo | excluded | Presentation, and superseded: the live control writes the WORKSPACE bag (see §6, correction C-3). | `workspace.ts:194` |
| `dismissedSkillsBanner` | per-repo | excluded | Legacy dismissal flag for a banner that no longer exists *(presentation)*. | `workspace.ts:209` |
| `sidebar`, `lastLocation` | workspace | excluded | Both LEGACY: the current cockpit keeps them in each browser's `localStorage`. Workspace-wide presentation. | `workspace.ts:235`, `:261` |
| `appearance`, `notifications`, `taskTable` | workspace | excluded | Workspace-wide personal presentation (§4.7, §4.8). | `workspace.ts:251`, `:254`, `:256` |
| `dismissedProviderAuthFailures` | workspace | excluded | §4.1. | `workspace.ts:241` |
| `importedSkills` | workspace | excluded | Workspace-wide curation of which default skills are shown. The leader reads the resulting effective catalogue project-scoped through `GET /p/:projectId/skills` (F-05, M-14), so no capability is lost. | `workspace.ts:265` |

### 4.14 Route fields with no cockpit control

These are real keys on the settings routes that no settings component renders. They are classified
because a schema field is reachable whether or not a control exists.

| Field | Status | Reason | Enforcing code path |
| --- | --- | --- | --- |
| `setConfigInputSchema.maxParallel` (the repo's own `.xezar/config.json`) | excluded | **Inert.** Since Phase 2 the scheduler ignores a per-repo `maxParallel`: `loadResourceLimits` builds its override map from the REGISTRY entry (`semaphore.ts:163`–`:166`), not from the repo file. Exposing this write would report a change that never happens; the live control is D-03-4's registry write. | `workspace.ts:391`; `semaphore.ts:395` |
| `setConfigInputSchema.memoryLimitMb` (the repo's own `.xezar/config.json`) | project-write | **Live, and local in effect.** `loadResourceLimits` reads each registered repo's own config (`semaphore.ts:171`–`:179`) and `projectMemoryLimitMb(repoRoot)` applies it to that root alone (`:284`). `PUT /config` refreshes the semaphore when the key is named (`server.ts:5294`), so the write takes effect without a restart. | E-BIND, E-CONTRACT (`workspace.ts:393`) |
| `setWorkspaceUiStateInputSchema` bounds (`WORKSPACE_UI_STATE_MAX_KEYS`, `TASK_TABLE_MAX_COLUMNS`) | excluded | Write-side bounds on a bag every row above excludes. | `workspace.ts:269`–`:320` |

### 4.15 The remaining controls — presentation

Every control the settings surface renders that is not a field above. All are `excluded`, all for
the same reason section 3 gives: pure presentation, no business effect, no persisted state the
leader could need. Listed rather than omitted, so "unclassified" cannot be confused with "missed".

| Control | Where |
| --- | --- |
| Section nav, section pills, index cards, the scope chip, the "Global settings" link | `settings-shell.tsx:67`, `:129`, `:230`, `:184`, `:267` |
| Agent tab selection and config-file selection; the Revert button and the unsaved/conflict banners | `agent-config-section.tsx:88`, `:170`, `:332`, `:315` |
| Bookmarklet skill filter, and Copy on a bookmarklet row | `bookmarklets-section.tsx:122`, `:189` |
| Prompt-template add/remove/edit/skill-assign gestures before Save | `prompt-templates-section.tsx:90`–`:119` — all fold into the one whole-list replace in §4.5 |
| Monitoring-wake and idle "mode" radios | `resources-section.tsx:302`, `:363` — two spellings of one key each (`null` versus a number), classified with the key in §4.9 |
| Loading, error and empty states; every toast; every confirm dialog | throughout — MCP reproduces no confirmation click (section 3) |

---

## 5. The twelve carried rulings

Recorded in full by the sibling inventory `mcp-ui-action-inventory.md`; restated here because each
touches a settings field, and issue #77 requires each to be resolved or named as still open. **None
is left open.**

| # | Ruling | Where this document classifies it |
| --- | --- | --- |
| 1 | Bookmarklet auto-start is presentation. | §4.4 — `excluded (presentation)`. |
| 2 | Bookmarklet generation is presentation. | §4.4 — `excluded`. |
| 3 | The launch key never crosses the boundary (F-15). | §4.4 — the key and every URL containing it are withheld. |
| 4 | `githubView` is presentation. | §4.13 — `excluded (presentation)`. |
| 5 | Skills check-and-apply is global. | §4.10 — apply is `excluded`. |
| 6 | The skills CHECK is a safe effective read. | §4.10 — `safe-effective-read`, narrowed to this project's scope plus the global availability flag and reason. |
| 7 | The automations create form is matched, not widened. | Covered project action; MCP mirrors the existing form's fields and validation exactly and adds none. Classified in the sibling inventory; no settings field is involved beyond the `automations` capability flag, which is a `safe-effective-read` (§4.9's `followups` row is the same pattern). |
| 8 | `DELETE /automations/:id` is a covered project action. | Project action, not a settings field — sibling inventory. Restated so it is not read as excluded: it is in scope, bound by E-BIND and the automations capability. |
| 9 | `POST /automation-log/:receiptId/retry` is a covered project action. | Same as 8. The receipt must be validated as belonging to this project before access (M-18: *checks/logs need a project owner even behind an unscoped endpoint*). |
| 10 | Prompt templates are a project write exposed as a whole-list read and replace. | §4.5 — `project-write`, whole-list. |
| 11 | Agent MCP-kind config files: full-content WRITE through the 409-guarded route. | §4.2 — `project-write`, gated by E-409-LOCAL. |
| 12 | Agent MCP-kind config files: READ returns structure only, every value elided, never file content. | §4.2 — `safe-effective-read`, values withheld. |

---

## 6. Corrections

Where a document and the source disagreed, the source won. Recorded so the next reader does not
re-derive them.

- **C-1 — `setConfigInputSchema` does not live in `packages/contract/src/projects.ts`.** It is in
  `packages/contract/src/workspace.ts:379`, in the per-repo agent-knobs section, together with
  `configResponseSchema`. `projects.ts` holds `updateProjectInputSchema` (`:133`) and the registry,
  folder-picker and launch-key shapes. AGENTS.md § The HTTP API is right that
  `setConfigInputSchema` sits in the contract with an unused `server.ts` duplicate validating the
  real route (`setConfigSchema`, `server.ts:5305` ff.) — only the file was mis-stated.
- **C-2 — the per-project concurrency cap and the per-project memory ceiling are read from
  DIFFERENT files.** `maxParallel` comes from the registry entry in `~/.xezar/config.json`
  (`semaphore.ts:165`); `memoryLimitMb` comes from each repo's own `.xezar/config.json`
  (`semaphore.ts:174`). AGENTS.md says "the same more-specific-wins lookup", which is true of the
  LOOKUP and not of the SOURCE. The difference decides two rows in §4.14 in opposite directions.
- **C-3 — Settings → Appearance persists to the WORKSPACE bag, not the repo's.** The pane's own hint
  reads "Saved with this repo's cockpit state" (`appearance.tsx:126`), but
  `appearance-provider.tsx` calls `putWorkspaceUiState({ appearance })`. Both schemas still declare
  an `appearance` key, so the per-repo copy is legacy. Classified `excluded` either way; recorded
  because a classifier trusting the hint would file it as a project write.
- **C-4 — there is no scope-aware write gate on agent config today.** `listAgentConfig` sets
  `writable: editable` for every catalog file (`service.ts:109`), and the only per-file refusal is
  the hosted-mode 409 for `tracked === 'outside-repo'` on the READ (`server.ts:5367`). D-03-1's
  enforcement (E-SCOPE-USER) is therefore new work, not an existing check being cited.
- **C-5 — `ProjectGeneral` is not a settings-registry section.** `SETTINGS_SECTIONS`
  (`registry.tsx:92`) has five project entries and seven global ones, of which `keyboard` is
  `hidden`; `project-general.tsx`, `project-location.tsx`, `remove-project.tsx`,
  `provider-settings.tsx` and `worktrees-panel.tsx` are components those sections and the settings
  index compose (`settings-shell.tsx:228`). Issue #77's phrase "four sections leak" is about the
  per-SECTION `SettingsScope` (`registry.tsx:62`), which is exactly why this classification is
  per-field.

---

## 7. What engineering must build for this classification to hold

The matrix cites the enforcement each row needs. Three of those enforcements do not exist yet, and
naming them is part of removing the ambiguity Definition-of-Done clause 5 asks about.

1. **E-SCOPE-USER** — a refusal keyed off `ConfigFileDef.scope === 'user'`, applied to MCP reads and
   writes of agent config. Never path matching.
2. **E-NARROW** — narrowing `GET /projects` and `GET /workspace/agent-profiles` to the bound
   project's own entry before anything reaches the leader, including in errors, and reporting an
   account as handle plus label only.
3. **E-BIND for caller-supplied project ids** — the four surfaces listed at the end of §2 take a
   `projectId` from the path, the body or the query. MCP must substitute the bound project's id and
   refuse a named one, `default` included.

Nothing here weakens E-409-LOCAL or E-409-PROFILE, and nothing widens a contract schema.

### Negative tests this matrix owes (DoD clause 5)

Clause 5 requires proof that A's operations cannot affect B **through accounts, skills or files —
not just on `projectId`**. One test per resource family, each asserting B's unchanged state and B's
absence from responses, errors and events (A-03, A-04, A-09, A-22):

| Family | The negative test |
| --- | --- |
| Accounts | A's leader attempts every write in §4.11 — selection, add, rename, remove, connect, details, open — and each is refused. B's `~/.xezar/agent-accounts.json` entry is byte-identical afterwards, and no response, error or event contains an email, a login or an account path. |
| Files (home) | A's leader attempts a read and a write of each of the six `scope: 'user'` catalog entries. Each is refused by scope, and the refusal is identical whether or not the file exists — an existence oracle is a leak. |
| Files (project) | A's leader writes each in-repo catalog file for A. B's copies of the same-named files are unchanged, and a read of a `holdsMcp` file returns no argument value. |
| Skills | A's leader runs the update CHECK and is refused the APPLY. The global skill installation is unchanged, and the check's response contains no scope state belonging to B. |
| Registry | A's leader sends `PATCH /projects/<B>` with a valid B id, with `default`, and with B's slug spelled through every alias; each is refused, and B's `maxParallel` and `tags` are unchanged. `DELETE /projects/<anything>` is refused. |
| Limits | A's leader writes A's `memoryLimitMb` and reads the workspace `resources`. B's runs keep their previous ceiling, and the workspace `resources` slice is unchanged. |
| Quality gates (D-03-5) | A's leader overwrites, shadows and deletes a workflow whose file on disk has a check step. Each is refused as a quality-gate blocker naming the step, nothing is dispatched, and the file is byte-identical afterwards (`project-config.test.ts`; A-22 in `acceptance-durability.test.ts`). |
| Secrets | Across every call above, plus a full session transcript and the event log, `.local/xezar/launch-key` never appears (F-15, A-12). |

---

## 8. Traceability

D-03 (resolved for the settings surface), F-03, F-12, F-15, F-16, N-01, M-14, M-15, M-16, M-20,
M-21, M-22, A-09, A-22, DoD-5.
