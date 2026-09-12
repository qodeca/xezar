# D-04 — the connection file and the one-time client setup

Status: **decision record for a spike. It ships no production code.** Date: 2026-09-10.
Decides: **D-04** (section 10 of the [MCP requirements](mcp-project-leader-requirements.md)).
Covers: **F-14**, **F-15**, **U-M01**, and the connection-file half of **A-01** and **A-12**.
Technical appendix it verifies rather than assumes: the
[client compatibility report](mcp-client-compatibility.md).
Tracked by [#81](https://github.com/qodeca/xezar/issues/81), inside phase 2 ([#69](https://github.com/qodeca/xezar/issues/69)) of [epic #67](https://github.com/qodeca/xezar/issues/67).

Baseline read for this record: worktree of `qodeca/xezar` at branch `xez/455024aa`, parent commit
`9fdcf0e` (`chore(release): v0.13.1`).

**Implementation note, added 2026-09-11 by [#262](https://github.com/qodeca/xezar/issues/262).** The
writer is `packages/xezar/src/mcp/connection-file.ts`, called by `startMcpService` once the MCP socket
listens (not on every `ProjectContexts.build()`: the MCP service is where the socket, and therefore
`endpoint`, exists). Two points differ from the record below, both on purpose:

- **There is no `token` field.** D-04.5 added a token only because the transport was still open. D-01
  then chose a per-project Unix socket and made *which socket the peer connected to* the binding (D-01
  § 6), so a token would be a secret that nothing checks. With no secret in the file, F-15 holds by
  construction.
- **`endpoint` is `{ "socket": "<path>" }`**, D-01's socket path.

Everything else is as decided: the path, `schemaVersion: 1`, the `project` and `service` labels, the
atomic temp-file-plus-rename at mode `0600`, `ensureProjectDataIgnored` before the first write, and a
failed write that is one warning (N-07). `tracked-files.test.ts` guards both file names.

**pi, added 2026-09-11 by [#330](https://github.com/qodeca/xezar/issues/330) (WP0).** The requirements now
name pi as a fourth required initial client, through the third-party `pi-mcp-adapter` extension (F-17).
§ 3.4 adds pi's one-time setup, and § 3.5 compares the four clients. Its evidence is the
[pi evidence record](mcp-adapter-evidence-pi.md), run on 2026-09-11 against the real bridge, not § 8.
Everything else in this record, including "all three clients" in D-04.2 and D-04.6, describes the
2026-09-10 run of Claude Code, Codex and OpenCode, and is unchanged.
**Where pi's entry goes was settled later the same day by [#341](https://github.com/qodeca/xezar/issues/341)
(WP3):** the project's `.pi/mcp.json`, for the reasons and runs in § 3.4 "Which file the setup
recommends". The cockpit's pi card uses it.

The requirements document draws a three-way split and this record preserves it. **Agreed** outcomes
are fixed and are not reopened. **Technical proposal** rows are suggestions that still need a
decision. **Open** rows have no decision at all. Every statement below carries its own label.

## 0. How to read the evidence labels

Every factual claim in this record is one of four things, and never anything else:

| Label | Meaning |
| --- | --- |
| **Executed** | A command was run on this machine on 2026-09-10 and its output was read. The command and the observation are in § 8. |
| **Read from source** | A file in this repository was read at the cited path and line. |
| **Documented** | An official vendor page describes the behaviour. This is not evidence of a working xezar integration. |
| **Not attempted** | With the reason it was not attempted. |

"Should work" is not a label used here, and no claim below rests on one.

Absence claims are scoped to what was examined. Where this record says something was not found, it
means not found in the files or command outputs named, not that it does not exist.

## 1. What was already agreed, and what this record is allowed to decide

**Agreed (F-14, not reopened):** xezar automatically writes local connection configuration inside
the bound project's `.local/xezar/`, and the user configures the leader application **once** to use
it. Not all applications automatically discover that file.

**Agreed (F-15, a hard constraint on the answer, not a preference):** connection data must not
require pasting into chat. Any credentials remain local and outside Git, and must not enter history,
tool responses, or event logs.

**Agreed (U-M01):** the automatically generated project file **must not be described as
automatically discovered by every client**. The setup guidance must separate the one-time user
action from anything automatic, per client.

**Open, and decided here:** the file's **name**, its **format**, its **creation trigger**, the
**exact change that keeps it out of Git**, and the **per-client one-time setup step**.

**Open, and deliberately NOT decided here** — see § 7 for the full boundary: the transport and
bridge architecture ([#79](https://github.com/qodeca/xezar/issues/79), D-01), session binding,
liveness and occupancy ([#80](https://github.com/qodeca/xezar/issues/80), D-02), the async event and
tool contract ([#82](https://github.com/qodeca/xezar/issues/82), D-05), durable operation keys and
audit retention ([#83](https://github.com/qodeca/xezar/issues/83), D-06), and operational limits,
retention bounds, packaging and any `XEZ_*` environment variable
([#84](https://github.com/qodeca/xezar/issues/84), D-09).

## 2. The decision

### D-04.1 — Name and location

**Decision.** The connection file is:

```
<project root>/.local/xezar/mcp-connection.json
```

One flat file per project, in the project's own data directory. There is no second file and no
directory of connection state.

**Why `.local/xezar/`.** F-14 fixes it, and the source agrees: `projectDataDir(repoRoot)` returns
`join(repoRoot, '.local/xezar')` unconditionally, for every project, and its own comment says
"There is no other location and no discovery step"
(`packages/xezar/src/project-data-paths.ts:11`, read from source). `ProjectContext.dataDir` is that
same value (`packages/xezar/src/server/project-context.ts:37` and `:211`, read from source).

**Why a flat file rather than a subdirectory.** Every existing sibling in that directory is flat —
`runs.json`, `todos.json`, `ui-state.json`, `automations.json`, `launch-key`
(`packages/xezar/src/project-data-paths.ts:5-9`, read from source). A subdirectory would be the only
one, and it would buy nothing: § D-04.2 fits the whole descriptor in one object.

**Why `mcp-connection.json` and not `mcp.json`.** `mcp.json` is one character away from Claude
Code's `.mcp.json`, and the two files have **opposite** Git status — Claude's is a tracked project
file (executed, § 8.1), xezar's must never be committed (executed, § 8.5). Two files whose names
differ by a leading dot, whose contents look similar, and whose correct handling is opposite is a
mistake waiting to be made in a support conversation. The longer name cannot be confused.

**Why the `.json` extension, when `launch-key` has none.** `launch-key` holds one opaque string and
nothing else (`packages/xezar/src/server/launch-key.ts:12`, read from source). This file holds a
structured object. The extension is the accurate description.

### D-04.2 — Format

**Decision.** One UTF-8 JSON object, written atomically (temp file plus rename, the pattern
`packages/xezar/src/runs/store.ts` already uses for `runs.json`), with file mode **`0600`**.

Fixed keys:

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "<registry project id, the slug>",
    "root": "<absolute, realpath'd repository root>",
    "dataDir": "<absolute path to this project's .local/xezar>"
  },
  "service": {
    "pid": 12345,
    "startedAt": "<ISO 8601 timestamp of this service process>"
  },
  "endpoint": { "…": "shape owned by D-01 (#79)" },
  "token": "<opaque local capability token>"
}
```

**`schemaVersion` starts at `1`.** N-08 requires new persisted fields to follow the repository's
compatibility rules, and the repository's rule for run state is that new fields are optional so old
files still parse (`AGENTS.md`, task-routing row "Runs store / state persistence"). A version
integer makes a future *incompatible* change
detectable instead of silently misread. It is not a retention value and not a limit; it is an
identifier.

**`project.id` and `project.root` are informational, not authoritative.** They exist so a human, and
a "which project is this?" UI panel, can read the file and understand it. They are **not** what the
server trusts. See § D-04.5.

**`service.pid` and `service.startedAt` exist so a stale file is recognisable.** A descriptor left
behind by a service that is no longer running is a normal state, not a corruption, and the bridge
must be able to say so in a specific error instead of hanging. Which liveness rule acts on that is
D-02's ([#80](https://github.com/qodeca/xezar/issues/80)); D-04 only fixes that the facts needed to
make the judgement are *in the file*.

**`endpoint` is a nested object whose shape belongs to D-01.** This record fixes that the endpoint
lives **in this file** rather than in anything the user edits — that is what makes N-07's "do not
require ... a fixed port" achievable, because the port or socket path is written by the service that
knows it, at the moment it knows it. What goes inside `endpoint` is [#79](https://github.com/qodeca/xezar/issues/79)'s
decision and this record does not pre-empt it.

**`token` is an opaque local capability token, generated with `randomUUID()`.** Same generator the
launch key already uses (`packages/xezar/src/server/launch-key.ts:21`, read from source), so this
introduces no new randomness policy and invents no length. A v4 UUID carries 122 random bits.

**The token is regenerated on every write of the file** (that is, on every creation trigger, § D-04.3).
The reasoning, not an invented duration: nothing outside this file ever stores the token — no client
config holds it (§ 3, executed for all three clients), so rotation costs a re-read and nothing else.
A rotating token bounds the value of a leaked copy to one service lifetime. And F-19 already requires
a client that returns after expiry to establish a new session, so a bridge that finds its token stale
is already in a state the requirements describe. **This is not a timeout or a retention period** —
there is no clock here, only a service lifetime. Timeouts and retention stay with
[#83](https://github.com/qodeca/xezar/issues/83) and [#84](https://github.com/qodeca/xezar/issues/84).

### D-04.3 — Creation trigger

**Decision.** The file is written **when a project context is built** — the same seam that already
ensures the launch key, immediately beside it:

> `packages/xezar/src/server/project-context.ts:222` — `const launchKey = ensureLaunchKey(dataDir);`
> (read from source)

Concretely: on `ProjectContextMap.build()`, which runs lazily on first access to a project by the
running server, and again on every subsequent service start. The write is unconditional and
overwrites — the endpoint and the token both describe *this* service process, so a stale copy has no
value worth preserving.

**Rejected alternatives, and why:**

| Trigger | Rejected because |
| --- | --- |
| `xezar init` | `init` never overwrites existing files and is optional — a user who never runs it would have no connection file, which turns generated state into required setup. `AGENTS.md` § Zero config forbids exactly that. |
| First MCP connection | Chicken and egg. U-M01 requires the settings screen to show **configuration readiness and one-time setup guidance** before any client has connected. A file that only exists after the client connects cannot be shown to the user who is trying to configure the client. |
| A background timer or watcher | Adds a mechanism with no reader. `AGENTS.md` § Zero config: prefer a daemon-free mechanism, and never trade a working default for a knob. |

**Zero-config properties this trigger gives, and the guarantee behind each:**

- **Written, never required.** No user authors it, no user migrates it, and no boot fails without it.
- **Deleting it discards nothing and is repaired on the next context build** — the same property
  `ensureLaunchKey` has, which regenerates when the file is missing or empty
  (`packages/xezar/src/server/launch-key.ts:13-21`, read from source).
- **MCP must not block ordinary cockpit startup (N-07).** The write sits inside the existing
  `try` block of `build()`, whose failure path already tears the half-built context down
  (`packages/xezar/src/server/project-context.ts:246-250`, read from source). A read-only repository
  is the case that matters, and the repository's standing policy for it is degradation, not failure —
  `ensureLaunchKey` swallows its own write error and comments "non-fatal", and
  `ensureProjectDataIgnored` swallows its own with "Normal store writes decide how to handle a
  read-only repository" (`packages/xezar/src/project-data-paths.ts:24`, read from source). The
  connection-file write follows that policy: a failure degrades to "MCP not available for this
  project, here is why", never to a failed boot.

### D-04.4 — The exact change that keeps it out of Git

**Decision, and it is a correction to the assumption in the issue:** **no new ignore pattern is
required.** The blanket rule that already exists covers this file, and that was verified by
execution rather than by reading.

`ensureDataGitignore` writes `.local/.gitignore` containing a single `*`
(`packages/xezar/src/index.ts:681-690`, read from source), and its exported twin
`ensureProjectDataIgnored` writes the identical rule for secondary project contexts
(`packages/xezar/src/project-data-paths.ts:16-25`, read from source). Executed against a fresh
`git init` fixture with only that helper's own body run (§ 8.5):

```
.local/xezar/mcp-connection.json       -> .local/.gitignore:2:*   .local/xezar/mcp-connection.json
.local/xezar/mcp-connection.json.tmp   -> .local/.gitignore:2:*   .local/xezar/mcp-connection.json.tmp
.mcp.json                              -> NOT IGNORED (tracked by git)
.codex/config.toml                     -> NOT IGNORED (tracked by git)
opencode.json                          -> NOT IGNORED (tracked by git)
staged after `git add -A`: ".mcp.json"
```

So the file, and its atomic-write temp sibling, are excluded by `.local/.gitignore` line 2, and a
`git add -A` in a repository holding both files stages the client config and never the connection
file.

**The change `AGENTS.md` actually asks for is therefore not a pattern — it is two things:**

1. **Add the filename to the guard's fixture list.** `packages/xezar/src/tracked-files.test.ts:45-54`
   holds a `localRuntime` array that names every engine-written file by name and asserts each is
   ignored, both in this repository and in a fresh `git init` fixture (`:96` and `:112`). Add
   `'mcp-connection.json'` and `'mcp-connection.json.tmp'` to that array. This is what "keep
   `.local/.gitignore` maintenance in sync with any new state file" means in practice here: the rule
   is blanket, so the thing that goes out of sync is the *guard's inventory*, not the rule. The file
   header of that test records why the inventory is guarded by name — a rename once moved the ignore
   rules off directories that existed on disk, and `git add -A` swept four files of local machine
   state into a commit on a repository about to be made public.
2. **Call `ensureProjectDataIgnored(dataDir)` before the first write**, from the writer, the way
   `projectScratchDir` already does (`packages/xezar/src/project-data-paths.ts:32`, read from
   source). This is an ordering guarantee, not a new rule: it makes the ignore file exist before the
   connection file does, so there is no window in which the connection file is visible to
   `git add -A`.

**One correction to record about file modes.** The two ignore helpers differ: the exported
`ensureProjectDataIgnored` creates `.local` with `mode: 0o700`, while the private
`ensureDataGitignore` in `index.ts` passes no mode. Executed against a fresh fixture through the
`index.ts` helper, the resulting `.local` directory mode was **`755`** (§ 8.5). **Directory mode is
therefore not a protection this file may rely on.** The file's own `0600` mode is what carries it —
the same choice `ensureLaunchKey` makes (`writeFileSync(..., { mode: 0o600 })` followed by an
explicit `chmodSync`, because mode is ignored on a pre-existing file;
`packages/xezar/src/server/launch-key.ts:24-25`, read from source) and the same choice
`ownProjectData` makes for its writer claims (`openSync(claim, 'wx', 0o600)`,
`packages/xezar/src/runs/project-writer.ts:39`, read from source). Executed: the fixture file
written with `mode: 0o600` had mode `600` (§ 8.5).

### D-04.5 — What actually enforces the binding

Section 8 of the requirements is explicit: **file presence or location alone is not a security
boundary.** This record does not treat it as one, and the design is arranged so that it cannot
accidentally become one.

| Layer | What it does | What it is **not** |
| --- | --- | --- |
| The file's path (`<root>/.local/xezar/mcp-connection.json`) | **Discovery.** It tells the bridge process where to connect and which token to present. | Not authorisation. A process that can read the file has learned an address, not a permission. |
| The file's `0600` mode | Reduces exposure to other local users on a shared machine. | Not the boundary. It is defence in depth, and § D-04.4 shows the containing directory is `755`. |
| `project.id` / `project.root` **inside** the file | Human-readable labels for a settings screen. | **Never** the identity the server trusts. F-01 forbids an input parameter, project alias or prompt content from changing the binding — a value the client hands back is exactly such an input. |
| **The token, resolved server-side to an owner record** | **The enforcement.** The service holds the mapping from token to project, minted at the moment it wrote the file. The bridge presents the token; the server derives the project binding from its own record and applies it to every read and write (F-01, F-02, F-16). | Not a user credential, not a vendor account, not something a human ever types or reads. |
| The owner generation / lease | Enforces F-18's exactly-one-owner rule on top of that binding. | D-02's decision ([#80](https://github.com/qodeca/xezar/issues/80)), named here only so the seam is visible. |

**Why the token exists at all, rather than relying on the filesystem.** The transport is D-01's
decision ([#79](https://github.com/qodeca/xezar/issues/79)) and is genuinely open. If it picks a unix
domain socket, the socket's own mode is an OS-enforced check; if it picks loopback HTTP, there is no
such check at all, and `AGENTS.md` records that binding `127.0.0.1` is a scope decision and not by
itself an authorisation one. Putting the token in the descriptor makes D-04's answer hold under
**either** transport, which is precisely what lets #79 choose freely without reopening this record.

**Deliberate consequence for N-09.** Because the server never reads a project identity out of
anything the client sends, a task file, a diff, a PR body or a prompt that *claims* a different
project changes nothing. Data stays data.

### D-04.6 — How F-15 is satisfied, clause by clause

F-15 has three clauses. Each is met by a specific property of the design, and two of the three were
verified by execution.

| F-15 clause | How it is met | Evidence |
| --- | --- | --- |
| "must not require pasting into chat" | The one-time setup for all three clients is a shell command or a file edit that names a **command**, never a value. The user copies no token, no port, no path out of the cockpit and into a conversation. | **Executed** for all three clients (§ 3). Every configuration written contained only `command`/`args`. |
| "credentials remain local and outside Git" | The token exists in exactly one file, and that file is blanket-ignored by `.local/.gitignore`. No client config anywhere holds it. | **Executed** (§ 8.5 for the ignore rule; § 8.1–8.4 for the three client configs, none of which contains a secret). |
| "must not enter history, tool responses, or event logs" | A rule this record fixes for the implementation: the token is read by the bridge and presented on the wire, and is **never** a field of any tool result, event payload, run record, NDJSON line or error message. An error about a bad token names the file path, never the value. | **Not attempted** — there is no MCP server in this repository to test against (§ 6). It is stated here as a binding constraint on [#86](https://github.com/qodeca/xezar/issues/86) and as the thing A-12 must actually exercise. |

**A supporting observation, offered as a warning rather than as protection.** Codex masks
environment-variable values in its own listings — `codex mcp get` printed `env: PROBE_LOG=*****`
(executed, § 8.3). That is a display mask in one client, and it is not a guarantee this design leans
on. The design's actual answer is stronger and simpler: **no secret is ever placed in a client
config in the first place**, so there is nothing for any client to mask, log, or fail to mask.

## 3. The one-time setup, per client

This is the section U-M01 governs. Read the automatic column and the user column as different
things, because they are.

**A note on the command name.** No MCP server, bridge, or `mcp` subcommand was found in
`packages/xezar/src` (searched case-insensitively across `*.ts`; the twelve files that matched
`mcp` are the agent-config catalog, the tool-display mappers and their tests — none is a server).
The CLI's own subcommand list is `serve`, `run`, `init`, `projects`, `server-install`,
`server-deploy`, `server-uninstall` (`packages/xezar/src/index.ts:131-171`, read from source).
`npx -y @qodeca/xezar mcp` below is therefore the **placeholder actually used in the executed
fixtures**, not a decided command name. Naming the bridge command is
[#86](https://github.com/qodeca/xezar/issues/86)'s job, and D-04 does not pre-empt it — what D-04
fixes is that the setup step names a **command and nothing else**, which is the property F-15
depends on.

**How the bridge finds the file.** All three clients spawn a local stdio server with the working
directory set to the project root (executed for Claude Code and OpenCode, § 8.1 and § 8.4; **not
attempted** for Codex — its read-only `mcp list`/`mcp get` do not spawn the process at all, § 8.3,
and observing its spawn would require starting a real Codex session, which consumes a model turn and
the machine's real account). The bridge therefore resolves the connection file by walking up from
its working directory, the way any repository-aware tool does, with an explicit **`--project <path>`
flag** as the override for a client that spawns from somewhere unexpected. Codex additionally accepts
a per-server `cwd` key in its config, which its own `mcp get` echoed back (executed, § 8.3), so the
override has a native spelling there too.

**Deliberately no environment-variable override.** `AGENTS.md` § Zero config requires any new `XEZ_*`
variable to update `.env.example` in the same commit, and `.env.example` belongs to
[#84](https://github.com/qodeca/xezar/issues/84). A flag needs no such entry, so D-04 adds a flag and
no variable. If a later issue wants the variable spelling, it owns the `.env.example` change.

### 3.1 Claude Code

Local version observed: **2.1.268** (executed — note this differs from the `2.1.263` recorded in the
compatibility report on 2026-09-08 and from the `2.1.267` named in this task's brief; the CLI on this
machine reported 2.1.268 on 2026-09-10).

**Recommended one-time user action — one command, run once, from the project root:**

```sh
claude mcp add --scope local xezar -- npx -y @qodeca/xezar mcp
```

**Executed and observed.** The command reported `Added stdio MCP server xezar-local ... to local
config` and named the file it changed: `$CLAUDE_CONFIG_DIR/.claude.json`, keyed by the project path.
The entry it wrote was `{"type":"stdio","command":"npx","args":["-y","@qodeca/xezar","mcp"],"env":{}}`
— **no secret, no port, no token**. `git status` in the fixture repository showed **no new or
modified file**: local scope writes entirely outside the repository. A subsequent `claude mcp list`
connected to it immediately, with **no approval step** (§ 8.1).

| | |
| --- | --- |
| **Automatic (xezar does this, the user does not)** | Writing `.local/xezar/mcp-connection.json` on project-context build; regenerating it if deleted; keeping it out of Git. |
| **One-time user action** | The single `claude mcp add --scope local` command above. |
| **NOT automatic — state it plainly (U-M01)** | Claude Code does **not** discover `.local/xezar/mcp-connection.json`. Nothing in it is read by Claude Code at any point. The user's command is what tells Claude Code that a xezar MCP server exists. |

**The project-scope alternative, and its real cost.** `claude mcp add --scope project` writes
`.mcp.json` at the repository root, which is a **tracked** file — the fixture's `git status` showed
`?? .mcp.json`, and `git add -A` staged it (executed, § 8.1 and § 8.5). It contains no secret, so
committing it is safe under F-15 and is the right choice for a team that wants the server shared.
But it costs a **second** one-time user action that local scope does not: `claude mcp list` reported
the project-scope entry as `⏸ Pending approval (run \`claude\` to approve)` and did not connect to
it, while the local-scope entry connected in the same command (executed, § 8.1). Project-scoped MCP
servers require per-user approval before use, and xezar's own agent-config catalog already records
this: "Each requires approval before use"
(`packages/xezar/src/agent-config/catalog.ts:156`, read from source).

**Recommendation: local scope.** One action instead of two, and nothing enters the repository at
all. Offer project scope as the explicit "share this with my team" choice, and say in the same
sentence that it needs an approval step.

### 3.2 Codex

Local version observed: **codex-cli 0.154.0** (executed).

**One-time user action — two parts, and both are genuinely required:**

1. Create `<project root>/.codex/config.toml` containing:

   ```toml
   [mcp_servers.xezar]
   command = "npx"
   args = ["-y", "@qodeca/xezar", "mcp"]
   ```

2. **Trust the project once.** Either accept Codex's trust prompt the first time you run `codex` in
   that folder, or add a `[projects."<absolute path>"] trust_level = "trusted"` entry to your user
   config.

**Executed and observed, and part 2 is not optional.** With the project **untrusted**,
`codex mcp list` run from inside that project listed **no** `xezar` server — the project's
`.codex/config.toml` was simply not loaded. With a `trust_level = "trusted"` entry present for the
same path and nothing else changed, the same command listed
`xezar  npx  -y @qodeca/xezar mcp  enabled` (§ 8.3). A control probe confirmed the listing does read
config-file servers in general, so the untrusted result was a genuine non-load and not a reporting
gap: injecting `mcp_servers.probe` in memory made `probe` appear in the same listing.

| | |
| --- | --- |
| **Automatic** | Writing `.local/xezar/mcp-connection.json`; regenerating it; keeping it out of Git. |
| **One-time user action** | Create the project `.codex/config.toml` block **and** trust the project. Two steps. |
| **NOT automatic — state it plainly (U-M01)** | Codex does **not** discover `.local/xezar/mcp-connection.json`. It also does **not** read a project `.codex/config.toml` at all until that project is trusted — so a user who does step 1 and skips step 2 sees a silent nothing, with no error naming the cause. Setup copy must say this. |

**Do not tell users to run `codex mcp add`.** It has no scope flag (`codex mcp add --help`, executed)
and it reports `Added global MCP server 'xezar'` — it writes an `[mcp_servers.xezar]` block into the
**user-level** `$CODEX_HOME/config.toml` (executed against an isolated home, § 8.3). A per-project
leader binding written at machine scope is the wrong shape: one entry would apply in every project
the user opens. The project file is the correct target, and it is the one the compatibility report
already names.

**A machine-specific finding worth recording, because it invalidated a first attempt.** The first
run of `codex mcp add` with `CODEX_HOME` exported to a fixture directory wrote into the **real** user
state anyway, and `codex mcp list` under the same pin still listed this machine's real servers. The
cause is local, not a Codex behaviour: `which codex` resolves to `~/.codex-cli/bin/codex`, a personal
shell wrapper whose last line is
`exec /usr/bin/env -u CODEX_SQLITE_HOME CODEX_HOME=/Users/…/.codex-cli … codex "$@"` — it hard-sets
`CODEX_HOME` and discards the caller's. Re-running against the underlying npm binary directly gave
correct isolation (`No MCP servers configured yet`). **The stray entry was removed with
`codex mcp remove xezar` and the removal was verified** — the machine's `codex mcp list` is back to
its single pre-existing `chrome-devtools` server, and the user's `~/.codex-cli/config.toml` contains
no `xezar` MCP block. This is recorded because anything that pins `CODEX_HOME` on this machine — the
browser suite's boot included — is subject to the same wrapper.

### 3.3 OpenCode

Local version observed: **1.18.30** (executed).

**One-time user action — one file:** create or extend `<project root>/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "xezar": {
      "type": "local",
      "command": ["npx", "-y", "@qodeca/xezar", "mcp"],
      "enabled": true
    }
  }
}
```

**Executed and observed.** With that file in the project root, `opencode mcp list` run from the
project listed `xezar` as a configured server. There was **no trust prompt and no approval step** —
the project config was picked up from the working directory immediately (§ 8.4).

| | |
| --- | --- |
| **Automatic** | Writing `.local/xezar/mcp-connection.json`; regenerating it; keeping it out of Git. |
| **One-time user action** | Add the `mcp.xezar` block to the project `opencode.json`. One step. |
| **NOT automatic — state it plainly (U-M01)** | OpenCode does **not** discover `.local/xezar/mcp-connection.json`. `opencode.json` is a **tracked** project file (executed, § 8.5), so this block is normally committed — which is safe only because it holds no secret. |

**`opencode mcp add` exists but is interactive** (a TUI prompt; `opencode mcp --help`, executed), so
the written-file form above is the one to document.

### 3.4 pi

Added 2026-09-11 by [#330](https://github.com/qodeca/xezar/issues/330). Not part of the 2026-09-10
run: "executed" below means executed on 2026-09-11 in the [pi evidence record](mcp-adapter-evidence-pi.md),
against the real `xezar mcp` bridge of a real `xezar serve` at `5031bf8`, not in § 8.

Local versions observed: **pi 0.85.1** (`@earendil-works/pi-coding-agent`) and **pi-mcp-adapter
2.32.1** (executed). These are installed versions, not certified minimums. The adapter's 2.33.0 was
published on the run date and was **not tested**.

**pi itself has no MCP client, by design.** pi's own README says "**No MCP.** Build CLI tools with
READMEs (see Skills), or build an extension that adds MCP support." (`README.md:499` of pi 0.85.1), and
its `docs/usage.md:309` says pi "intentionally does not include built-in MCP" (documented; both lines
re-read in the installed package on 2026-09-11). The capability comes from **`pi-mcp-adapter`**, a
third-party pi extension (MIT, `github.com/nicobailon/pi-mcp-adapter`) that the user installs. The
requirements count pi through that extension (F-17), on the same footing as the adapter/Channels
prerequisites U-M02 already names. **A pi without the extension has no xezar tool at all:** with
`--no-extensions`, the same folder and prompt offered the model 0 xezar tools (executed, negative
control).

**One-time user action — two parts, and both are required:**

1. Install the extension once, pinned to the verified version:

   ```sh
   pi install npm:pi-mcp-adapter@2.32.1
   ```

   It added `"packages": ["npm:pi-mcp-adapter@2.32.1"]` to pi's `settings.json` and the package under
   pi's agent directory (executed). This step needs the network.

2. Add a `xezar` entry to `.pi/mcp.json` in the project root (why this file and not pi's user-level
   `mcp.json`: "Which file the setup recommends" below):

   ```json
   {
     "settings": { "directTools": true },
     "mcpServers": {
       "xezar": {
         "command": "npx",
         "args": ["-y", "@qodeca/xezar", "mcp"],
         "lifecycle": "keep-alive"
       }
     }
   }
   ```

**Executed and observed, with two substitutions.** The evidence runs used this entry — in pi's agent
directory for the A-01 run, in `<project root>/.pi/mcp.json` for the `scope` run and for every run in
"Which file the setup recommends" — with this revision's built bridge (`node packages/xezar/dist/index.js mcp`) in place of `npx -y @qodeca/xezar mcp`,
and a fixture `XEZ_HOME` — the same two as the #118 harness; a real user's entry needs
neither. pi connected, reported `MCP: 1 servers connected (11 tools)`, offered the model all 11 xezar
tools, and `health` named the project. Each key is there for a measured reason:

- **`"directTools": true`.** Without it the model sees one `mcp` proxy tool and has to search for the
  xezar tools first (executed in #330, run A).
- **`"lifecycle": "keep-alive"`.** With the adapter's defaults (`lazy`, a 10-minute `idleTimeout`), the
  adapter closed the idle bridge between 601 s and 661 s after the last call, so pi gave up the project
  and another client took it. With `keep-alive`, pi still held the project at 700 s (executed). A
  `keep-alive` server connects when pi starts, so pi takes the project at start, not at its first call
  (read from adapter source).
- **The pinned version.** The extension is third-party and moves fast; this evidence does not cover
  a version it did not run (pi evidence record, blocker PI-5).

| | |
| --- | --- |
| **Automatic** | Writing `.local/xezar/mcp-connection.json`; regenerating it; keeping it out of Git. |
| **One-time user action** | Install the extension **and** add the `.pi/mcp.json` entry. Two steps. |
| **NOT automatic — state it plainly (U-M01)** | pi does **not** discover `.local/xezar/mcp-connection.json`. pi alone is **not** an MCP client: the entry does nothing until the extension is installed, and a user who installs bare pi sees no xezar tool. The project entry is a file in the working tree, untracked until the user commits it; it holds no secret. |

**Where the entry can live.** The user-level file above binds each project by pi's working directory:
the same entry bound project B when pi started in B, and A when it started in A, and an unregistered
repository got `This directory is not a xezar project yet…` and no project's data (executed). The
extension spawns the bridge in pi's session working directory (read from adapter source,
`server-manager.ts:799`). `<project root>/.pi/mcp.json` also works for one project, with no trust flag
(executed). The project `.mcp.json` works for pi as well, but Claude Code reads the same file, so an
entry there reaches both clients (#330).

**Which file the setup recommends — settled 2026-09-11 by [#341](https://github.com/qodeca/xezar/issues/341)
(WP3).** WP0 left open whether a `keep-alive` entry makes pi take a project's leader slot when pi starts
in that project for other work, including a pi task that xezar itself runs there. Four runs answered it,
each against a real `xezar serve` and the real bridge built from this branch (no MCP source differs from
`2e5a537`), with pi 0.85.1, pi-mcp-adapter 2.32.1, the scripted endpoint and the `keep-alive` entry above;
the harness is WP1's, and the private evidence is in task `1ccce22d`'s evidence folder (`pi-location/`):

| Run | What was started | Observed (executed) |
| --- | --- | --- |
| `root` | pi in the project root, entry in `<root>/.pi/mcp.json`, **no prompt** | The adapter spawned the bridge at once; **0 model requests**; a second client got `-32080` project-occupied. After pi exited, the second client got the project. |
| `root-tools` | The same, with the `--tools` allowlist xezar's pi runner passes (`pi-runner.ts:374`) | Identical: pi held the project from start with no prompt. The allowlist hides the tools from the model but does not stop the extension connecting. |
| `worktree` | The entry committed, pi started in a git worktree of the project under `.local/xezar/worktrees/`, runner-shaped and then with tools visible | A bridge was spawned but bound no project: `health` answered `This directory is not a xezar project yet…`, and a client in the project root got the project throughout. |
| `anywhere` | The same entry in pi's user-level `mcp.json`, pi started in a plain folder that is no repository | A xezar bridge was spawned there too. |

So, with `keep-alive`, **a pi started in the project root is that project's leader client from the
moment it starts** — whether the user meant it as the leader or not, and including a pi task xezar runs
with Worktree OFF. This is `keep-alive` doing what it says ("Connect at startup", adapter README) plus
the bridge acquiring the project at `initialize` (`packages/xezar/src/mcp/bridge.ts:145`, read from
source). A pi task in a task worktree cannot take the slot, because the bridge binds by the working
directory's repository root and a task worktree is never registered.

**Decision: the setup recommends `<project root>/.pi/mcp.json`**, not pi's user-level file:

- it reaches this project only, like the other three clients' recommended targets. The adapter reads
  project files from pi's working directory and does not walk up (`getConfigSources`, `config.ts:188-194`
  and `420-423` of the adapter, read from source), so pi started in a subfolder does not load it either;
- a user-level `keep-alive` entry starts a xezar bridge wherever pi starts (run `anywhere`), and makes
  pi the leader client of every registered project it is started in;
- it needs no trust flag (executed in the `scope` run).

What stays true either way, and the card says it: `keep-alive` means pi connects when it starts in the
project, so any pi started there, including a pi task xezar runs with Worktree OFF, is the project's
leader client and every other client is refused until that pi exits (run `root`; the card's wording
since the design review on [#343](https://github.com/qodeca/xezar/pull/343)). The alternatives are named, not recommended: pi's user-level file for every project at once,
and the project `.mcp.json`, which Claude Code reads too, so an entry there reaches both clients (#330).
The adapter's `lazy-keep-alive` (connect at first call, never idle-close) would avoid taking the project
at start, but **no run covers it**, so the setup does not offer it.

**Tool approval** is off by default in the extension, and the setup does not turn it on. A user's own
`approveTools` — `settings.approveTools` in the adapter's `mcp.json`, or the per-server key that
overrides it — gates a matching tool at call time.

**Corrected 2026-09-12 by a run.** This paragraph used to say that a gated call "makes matching headless
calls fail with `approval_required` (documented, adapter README; not run)". The README does say that, and
it is wrong for xezar's case: the fail-closed branch is reached only when the extension has no UI
(`tool-approval.ts:170-172`, adapter 2.32.1), and pi hands its extensions a `ui` in every mode, so the
call takes the branch below it and opens a dialog (`state.ui.select`) that carries no `timeout`. Nothing
in xezar answers it. #330 WP5's QA measured a step naming `xezar_health` failing at 121 s with
`pi CLI timed out after 2m and was killed`, while an ordinary pi task — offered no `xezar_*` tool by the
runner's default allowlist — was unaffected at 2.8 s. The setup guidance is therefore to leave xezar's
tools ungated; answering the dialog is [#369](https://github.com/qodeca/xezar/issues/369).

### 3.5 The four side by side

| | Claude Code 2.1.268 | Codex 0.154.0 | OpenCode 1.18.30 | pi 0.85.1 + pi-mcp-adapter 2.32.1 |
| --- | --- | --- | --- | --- |
| Recommended target | `$CLAUDE_CONFIG_DIR/.claude.json` (local scope) | `<root>/.codex/config.toml` | `<root>/opencode.json` | `<root>/.pi/mcp.json` (§ 3.4 "Which file the setup recommends") |
| In Git? | No — outside the repo entirely | Yes, tracked | Yes, tracked | In the repo; untracked until committed |
| One-time user actions | **1** (one command) | **2** (write file **and** trust project) | **1** (write file) | **2** (install the extension **and** write the entry) |
| Extra approval gate | None at local scope; **yes** at project scope | Trust is the gate, and it is silent when missing | None observed | None observed |
| MCP client built in | Yes | Yes | Yes | **No** — the third-party extension is a prerequisite |
| Contains a secret | No | No | No | No |
| Reads `.local/xezar/mcp-connection.json` | **No** | **No** | **No** | **No** |
| Spawn working directory observed | Project root (executed) | **Not attempted** — read-only commands do not spawn | Project root (executed) | pi's session working directory (read from adapter source); the per-project binding it gives executed |

The first three columns are the 2026-09-10 run in § 8. The pi column is the 2026-09-11 run in the
[pi evidence record](mcp-adapter-evidence-pi.md).

The last row is the whole of U-M01 in one line: **no client discovers the generated file. Four
different one-time actions, three of which put a file inside the project, and two of which need a second step:
Codex's trust, which fails silently if skipped, and pi's extension, without which pi has no MCP client
at all.** Setup copy that says "xezar configures this for you" would be false for all four.

## 4. Corrections, where the source disagrees with the documents

Recorded because the source wins.

| Claim | Correction | Evidence |
| --- | --- | --- |
| Issue #81 and the requirements § 8 name `packages/xezar/src/paths.ts` as the path helper for the connection file. | `paths.ts` owns the **per-user** home (`xezarHomeDir()`) and nothing about a project's data directory. `projectDataDir()` lives in `packages/xezar/src/project-data-paths.ts:11`. The connection file does not use `paths.ts` at all — `XEZ_HOME` is irrelevant to it. | Read from source; `paths.ts` read in full. |
| Issue #81 cites `ProjectContext.dataDir` at `project-context.ts:31`. | Line 31 is the `export interface ProjectContext {` line. The `dataDir` field is at `:37`, and the value is assigned at `:211`. | Read from source. |
| The issue's acceptance asks for "the git-ignore change". | There is no ignore-pattern change to make. The existing blanket `*` already covers the file, verified by execution. The change is to the guard's fixture inventory in `tracked-files.test.ts` and to write ordering. See § D-04.4. | **Executed**, § 8.5. |
| `ensureDataGitignore` is the helper to call. | It is a **private** function in `index.ts` and is called only on the `openStore`/`init` paths (`:663`, `:676`). The project-context path has an exported twin, `ensureProjectDataIgnored` (`project-data-paths.ts:16`). A new writer should call the exported one. | Read from source. |
| The compatibility report's local versions (Claude 2.1.263, Codex 0.153.4, OpenCode 1.18.29, dated 2026-09-08). | On 2026-09-10 this machine reported **2.1.268**, **0.154.0**, **1.18.30**. The brief's "claude 2.1.267" is also stale. Version-pinned claims in that report should be re-read as "as of its date". | **Executed**, § 8. |
| The compatibility report's "Claude Code ... Project `.mcp.json` and local/project scopes exist" (documented, 2026-09-08). | Confirmed by execution, and one behaviour worth adding to it: **project scope is gated by an approval step that local scope does not have.** `claude mcp list` reported the project entry as `⏸ Pending approval` and connected to the local one in the same invocation. | **Executed**, § 8.1. |
| The compatibility report's "Codex ... trusted project `.codex/config.toml`" (documented, 2026-09-08). | Confirmed by execution, and sharpened: **untrusted is a silent non-load**, not an error. The word "trusted" in that sentence is load-bearing. | **Executed**, § 8.3. |

## 5. What this decision closes, and against which acceptance criteria

| Requirement / criterion | What D-04 now supplies | What is still missing before it can pass |
| --- | --- | --- |
| **F-14** | Name, format, creation trigger, and per-client setup are fixed. | Nothing at the decision level. The implementation is [#86](https://github.com/qodeca/xezar/issues/86). |
| **F-15** | No value is ever pasted; no secret enters any client config or Git. Two of three clauses verified by execution. | The "never in history, tool responses or event logs" clause is a constraint on code that does not exist yet. |
| **U-M01** | § 3 states, per client, exactly what is automatic and what the user does. No autodiscovery is claimed for any client. | The settings screen itself (UX-M01). |
| **A-01** | The provisioning half: xezar writes into A's `.local/xezar/`, the client is configured without authoring or pasting connection data. | The "client accesses A" half needs a running server. [#85](https://github.com/qodeca/xezar/issues/85). |
| **A-12** | The Git half is executed and proven: `git add -A` never stages the file. | The "no secret in history/responses/logs" half needs a running server and real event traffic. |
| **N-07** | Deleting the file discards nothing and it is rebuilt; a failed write degrades rather than failing the boot. | Verified as a design property against the existing degradation policy, **not** executed — there is no writer yet. |

## 6. Scope of what was and was not tested

**No production code was written and none is proposed for this commit.** The fixtures used to
produce § 8 were a throwaway `git init` repository under `/tmp`, a probe shell script, and a Node
script that executed the existing `ensureDataGitignore` body. **All of it was deleted**; the
worktree's `git status` was clean afterwards.

**No MCP server was run, because none exists.** Searching `packages/xezar/src/**/*.ts`
case-insensitively for `mcp` returned twelve files, all of them the agent-config catalog, the
tool-display mappers, `paths.ts`'s Claude state-file helper, and their tests. **Not found in the
files examined:** any MCP server, bridge, transport, or `mcp` CLI subcommand. Every "Failed to
connect / Connection closed" in § 8 is that absence showing up, and is the expected result.

**Real user state was touched once and restored.** `codex mcp add` escaped its intended isolation
through the local wrapper described in § 3.2. The entry was removed with `codex mcp remove xezar`
and the restoration was verified twice: `codex mcp list` shows only the pre-existing
`chrome-devtools` server, and `~/.codex-cli/config.toml` contains no `xezar` MCP block. The Claude
fixtures stayed inside their pinned `CLAUDE_CONFIG_DIR`; the real `~/.claude.json` was checked and
contains no `xezar` or `probe` server at any scope. The OpenCode commands were read-only and wrote
nothing.

**No model turn was started, in any client, for any of this.** Every command used was a
configuration or listing command.

## 7. What D-04 deliberately does not decide

Naming these keeps the phase-2 boundary clean and prevents this record from being read as settling
something it did not.

| Left open | Owner |
| --- | --- |
| The transport, the bridge architecture, and therefore the concrete shape of the `endpoint` object. | D-01 — [#79](https://github.com/qodeca/xezar/issues/79) |
| Session binding, liveness checks, lease and fencing, occupancy and handover — including what a bridge does when `service.pid` names a dead process. | D-02 — [#80](https://github.com/qodeca/xezar/issues/80) |
| The event and tool contract, event IDs, ordering, replay. | D-05 — [#82](https://github.com/qodeca/xezar/issues/82) |
| Operation keys, version checks, audit retention — every duration and every numeric bound. | D-06 — [#83](https://github.com/qodeca/xezar/issues/83) |
| Operational limits, packaging, and any `XEZ_*` environment variable plus its `.env.example` entry. | D-09 — [#84](https://github.com/qodeca/xezar/issues/84) |
| The bridge command's actual name and its handshake. | [#86](https://github.com/qodeca/xezar/issues/86) |
| Whether each client's model actually **reacts** to a delivered event. | [#85](https://github.com/qodeca/xezar/issues/85). Still the material gap the compatibility report names, and nothing here narrows it. |

No timeout, retention period, transport, tool name or numeric limit is decided in this record. The
two numbers it does contain — `schemaVersion: 1` and file mode `0600` — are a schema identifier and
an existing repository convention, each cited to its source above.

## 8. Evidence log

All commands run on 2026-09-10, macOS 26.6.2 (arm64), against a throwaway fixture repository under
`/tmp` that was deleted afterwards. Versions observed at the time of the run:
Claude Code **2.1.268**, Codex CLI **0.154.0**, OpenCode **1.18.30**, Node **v24.20.0**.

### 8.1 Claude Code — executed

```
$ claude mcp add --scope project xezar -- npx -y @qodeca/xezar mcp
Added stdio MCP server xezar with command: npx -y @qodeca/xezar mcp to project config
File modified: /private/tmp/<fixture>/proj/.mcp.json

$ git status --porcelain
?? .mcp.json

$ cat .mcp.json
{"mcpServers":{"xezar":{"type":"stdio","command":"npx","args":["-y","@qodeca/xezar","mcp"],"env":{}}}}

$ claude mcp add --scope local xezar-local -- npx -y @qodeca/xezar mcp
Added stdio MCP server xezar-local ... to local config
File modified: /tmp/<fixture>/home/claude/.claude.json [project: /private/tmp/<fixture>/proj]

$ git status --porcelain      # unchanged — local scope wrote nothing into the repo
?? .mcp.json

$ claude mcp list
xezar:       npx -y @qodeca/xezar mcp - ⏸ Pending approval (run `claude` to approve)
xezar-local: npx -y @qodeca/xezar mcp - ✘ Failed to connect — -32000: MCP error -32000: Connection closed
```

The local-scope entry as stored under `projects["<path>"].mcpServers`:
`{"type":"stdio","command":"npx","args":["-y","@qodeca/xezar","mcp"],"env":{}}`.

**Spawn working directory probe.** A stdio server pointed at a script that appends `pwd -P` to a
log, registered at local scope and triggered by `claude mcp list`:

```
cwd=/private/tmp/<fixture>/proj
argv=argA
```

Claude Code spawned the server with the working directory set to the project root.

### 8.2 Claude Code — read from official documentation only

Nothing in § 3.1 rests on documentation alone. The compatibility report's Channels findings are
**documented, not executed**, and are outside D-04's scope.

### 8.3 Codex — executed

```
$ codex mcp add --help
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
# no --scope / --project option in the option list

$ CODEX_HOME=<fixture home> codex mcp list      # isolated, before anything
No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.

# project .codex/config.toml present with [mcp_servers.xezar]; project NOT trusted
$ CODEX_HOME=<fixture home> codex mcp list
No MCP servers configured yet.

# same file; user config now has [projects."<abs path>"] trust_level = "trusted"
$ CODEX_HOME=<fixture home> codex mcp list
Name   Command  Args                  Env  Cwd  Status   Auth
xezar  npx      -y @qodeca/xezar mcp  -    -    enabled  Unsupported

# control probe: does `mcp list` report config-file servers at all?
$ codex -c 'mcp_servers.probe.command="echo"' mcp list
...
probe  echo  -  -  -  enabled  Unsupported          # yes — so the untrusted result was a real non-load

$ CODEX_HOME=<fixture home> codex mcp add probe -- echo hi
Added global MCP server 'probe'.
$ cat <fixture home>/config.toml
[projects."/private/tmp/<fixture>/proj"]
trust_level = "trusted"

[mcp_servers.probe]
command = "echo"
args = ["hi"]
# => `mcp add` writes USER scope, into $CODEX_HOME/config.toml. No project scope offered.

$ CODEX_HOME=<fixture home> codex mcp get probe
probe
  enabled: true
  transport: stdio
  command: <fixture>/probe/spawn-probe.sh
  args: argA
  cwd: /tmp/<fixture>/proj          # a per-server cwd key is accepted and echoed back
  env: PROBE_LOG=*****              # Codex masks env values in its own listing
```

**Spawn working directory: not attempted.** `codex mcp list` and `codex mcp get` did not spawn the
server — the probe log stayed empty after both. Observing Codex's spawn cwd would require starting a
real Codex session, which consumes a model turn on the machine's real account, so it was not done.

**Isolation failure and its repair.** The first `codex mcp add` ran through `~/.codex-cli/bin/codex`,
a personal wrapper containing
`exec /usr/bin/env -u CODEX_SQLITE_HOME CODEX_HOME=/Users/…/.codex-cli … codex "$@"`, which discards
the caller's `CODEX_HOME`. It therefore wrote to real user state. `codex mcp remove xezar` returned
`Removed global MCP server 'xezar'.`, and `codex mcp list` afterwards showed only the pre-existing
`chrome-devtools` server. All later Codex commands invoked the underlying npm binary directly, which
honoured the pin.

### 8.4 OpenCode — executed

Project `opencode.json` written with `mcp.xezar` as `{"type":"local","command":["npx","-y","@qodeca/xezar","mcp"],"enabled":true}`:

```
$ opencode mcp list
●  ✗ xezar   failed
│      MCP error -32000: Connection closed
│      npx -y @qodeca/xezar mcp
```

Listed as a configured server, from the project file, with no trust prompt and no approval step. The
connection failure is the absent server (§ 6), not a configuration failure.

**Spawn working directory probe**, same script as § 8.1, registered as a second `mcp` entry:

```
cwd=/private/tmp/<fixture>/proj
argv=argA
```

OpenCode spawned the local command with the working directory set to the project root, and honoured
an `environment` key for env vars.

**One isolation limit worth recording:** `OPENCODE_CONFIG_DIR` pointed at an empty fixture directory,
yet the listing still included a server from the machine's global OpenCode config. The pin did not
fully isolate reads. All OpenCode commands here were read-only and wrote nothing to user state.

### 8.5 Git exclusion and file modes — executed

A Node script created a fresh `git init` fixture and ran **the actual body of
`ensureDataGitignore`** extracted from `packages/xezar/src/index.ts` — the same technique
`packages/xezar/src/tracked-files.test.ts:98-116` uses, so no CLI process was booted:

```
.local/.gitignore = "\n*\n"

.local/xezar/mcp-connection.json       -> .local/.gitignore:2:*   .local/xezar/mcp-connection.json
.local/xezar/mcp-connection.json.tmp   -> .local/.gitignore:2:*   .local/xezar/mcp-connection.json.tmp
.local/xezar/runs.json                 -> .local/.gitignore:2:*   .local/xezar/runs.json
.mcp.json                              -> NOT IGNORED (tracked by git)
.codex/config.toml                     -> NOT IGNORED (tracked by git)
opencode.json                          -> NOT IGNORED (tracked by git)

staged after `git add -A`: ".mcp.json"
connection file mode: 600
.local dir mode     : 755
```

Both the connection file and its atomic-write temp sibling are excluded by `.local/.gitignore` line
2. With both files present, `git add -A` staged only the client config. The connection file written
with `mode: 0o600` kept mode `600`; the containing `.local` directory created by the `index.ts`
helper was `755`, which is why § D-04.4 says directory mode is not something this file may rely on.

## 9. Known limits of this record

- **Nothing here certifies a working xezar MCP integration.** There is no server to integrate with.
  Every client command that tried to connect failed for that reason, and that is the honest state.
- **Codex's spawn working directory is unobserved.** The `--project` flag in § 3 exists partly for
  that reason: the design does not depend on an unverified cwd for that client.
- **The "no secret in history, tool responses or event logs" clause of F-15 is unverified**, because
  there is nothing yet that could log one. It is written here as a binding constraint on #86 and as
  something A-12 must actually exercise, not as a satisfied requirement.
- **The client versions in § 8 drift.** Three of the four version numbers carried into this task
  from earlier documents were already stale by two days. Any future record should re-observe rather
  than inherit them.
- **This is a decision record, not an implementation.** No file under `packages/` changed.
