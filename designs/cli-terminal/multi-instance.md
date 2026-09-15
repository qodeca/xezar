# One cockpit per project – the multi-instance model

Part of the `cli-terminal` design (#467). Owner decision 2 of 2026-09-16: **one cockpit per project is the new default**. Each project gets its own xezar process and its own port. The owner accepts the navigation and compatibility changes. Decision 3: remembered ports and live activity on stderr are defaults, shipped as a minor release.

Everything here is proposed, not implemented. Source claims name the file they were read from at `bb271fc`.

## 1. The model in one table

| | Today (0.15) | New default |
|---|---|---|
| What one `xez` process serves | Its boot project, plus any registered project opened in the cockpit (lazy contexts, `server/project-context.ts`) | Its boot project only |
| Where a second project runs | In the same process when you switch to it, or in a second process on another port | In its own process, on its own port |
| Port | `--port` or 4321, then the next free one (`index.ts` `PORT_SPAN = 50`) | Remembered per project (§ 3) |
| MCP | One socket per project, but only the boot project’s is opened (`index.ts:334`) | Unchanged, and now every running project has its socket, because every running project is a boot project |
| The cockpit’s other projects | Opened in place | Shown as links to their own cockpit, or as “not running” (§ 6) |
| The old model | – | Still there behind `--instance workspace` (§ 7) |

Why the model fits the code: the project writer claim (`runs/project-writer.ts`) already refuses two processes for one project, and the MCP socket is already per project (`mcp/ipc.ts`: `<XEZ_HOME>/ipc/<projectId>.sock`). Today a cockpit that opens a project another process owns runs into that refusal (analysis § 6(a)). The new default stops trying.

## 2. What each instance owns, and what they share

| Owned by one instance | Shared by all instances of one user |
|---|---|
| The HTTP listener: cockpit, `/api/v1`, SSE and the WebSocket bus, all on one port | `~/.xezar/config.json` – the registry and workspace settings |
| The project writer claim in `<repo>/.local/xezar/writer-claims/` | `~/.xezar/agent-accounts.json`, `~/.xezar/ui-state.json` |
| The MCP socket `~/.xezar/ipc/<projectId>.sock` | The team-skills cache and its cross-process update lock (`skills-update.ts`) |
| The scheduler: `maxParallel`, the memory ceiling, idle timeouts – enforced per process (`index.ts:232`) | `~/.cache/xez/` |
| The terminal renderer and its stderr | The agent CLIs’ own logins and config |

The scheduler row is the one real cost of the model. `resources.maxParallel` is documented as workspace-wide, but it is enforced by one in-process semaphore. Three instances with `maxParallel: 4` can run twelve tasks. See `open-questions.md` Q-3.

## 3. What `~/.xezar/config.json` records per project

Two new optional keys on each `projects[]` entry, and one optional workspace object. All of them follow § 9 of `BACKWARD_COMPATIBILITY.md`: optional, `.catch` per key, `.passthrough()`, merge-written, never required.

```json
{
  "cli": {
    "output": "auto",
    "color": "auto",
    "logLevel": "info",
    "instance": "project"
  },
  "projects": [
    {
      "id": "beta",
      "root": "/Users/me/Projects/beta",
      "name": "beta",
      "addedAt": "2026-09-01T09:00:00.000Z",
      "lastOpenedAt": "2026-09-15T08:06:12.104Z",
      "source": "boot",
      "cli": { "port": 4400 },
      "lastListen": { "port": 4401, "host": "127.0.0.1", "observedAt": "2026-09-15T08:06:12.104Z" }
    }
  ]
}
```

| Key | Meaning | Written by | Never |
|---|---|---|---|
| `projects[].cli.port` | The port a person chose for this project. A preference. | `xez projects port <id> <port>` only. `xez projects port <id>` with no port removes it. | Written by a start, by `--port` or by `XEZ_PORT`. |
| `projects[].lastListen` | The last address this project’s cockpit really listened on. A hint. | The instance, once, right after `listen` succeeds. | A liveness claim. It is stale the moment the process ends. No PID, no lease, no socket path. |
| `cli.output`, `cli.color`, `cli.logLevel` | Workspace defaults for how the terminal looks. | `xez config set cli.<key> <value>` is **not** built (Q-9); a person edits the file, or uses the flag or env. | Required. |
| `cli.instance` | `project` (default) or `workspace`. | Same as above. | Required. |

`lastListen.host` is the bound address (`127.0.0.1` by default, the `--bind-host` value otherwise). It is recorded so that a later check probes the right address. It is never used to choose the bind address.

A `--port 0` start (any free port) does not write `lastListen`: an OS-chosen port is a request for “anything”, and remembering it would make the next plain start ask for a random high port. This departs from the analysis (§ 6(e)) and is `open-questions.md` Q-4.

## 4. How a start picks its port

Precedence, highest first. The first value found is the **start port**; binding then tries it and the ports after it.

| # | Source | Example | Skips ports other projects remember? |
|---|---|---|---|
| 1 | `--port <n>` | `xez --port 5000` | No – you asked for it |
| 2 | `projects[].cli.port` | set with `xez projects port beta 4400` | No |
| 3 | `XEZ_PORT` | `XEZ_PORT=4500 xez` | No |
| 4 | `projects[].lastListen.port` | remembered from the last start | Yes, when it has to move on |
| 5 | 4321 | first start of a project | **Yes** |

Stored beats environment on purpose (rows 2 and 3). It is the pattern `followups` and `agentEnvPassthrough` already follow (AGENTS.md § Workspace registry), and with one instance per project it matters more: a `XEZ_PORT` exported in a shell profile would otherwise pull every project to the same start port. The flag always wins. The remembered hint loses to everything a person set.

**Binding.** Unchanged in its guarantees (#238): the port printed is the port the server holds, never a probe’s answer. Only `EADDRINUSE` moves on. At most 50 binds are tried. The range stops at 65535.

**Skipping (rows 4 and 5).** When the start port came from memory or from the 4321 default, xezar skips every port that another registered project remembers (`cli.port` or `lastListen.port`), whether that project runs or not. A skipped port does not count toward the 50 binds. A port a person set (rows 1–3) is tried as asked, and so are the ports after it. Without this, alpha stopped and beta started would take 4321, alpha would find it busy on its next start, move to 4322, and the two would swap ports forever – and every saved bookmark and bookmarklet would break with them.

**After the bind.** `lastListen` is merge-written with the port really bound. A failed write warns once (`error-cases.txt` A11) and never stops the cockpit.

**Worked example.**

| Step | alpha | beta | gamma |
|---|---|---|---|
| alpha starts, nothing remembered | 4321 | – | – |
| alpha stops; beta starts, nothing remembered: 4321 skipped | 4321 (stopped) | 4322 | – |
| beta stops; a web server takes 4322; gamma starts, nothing remembered: 4321 and 4322 skipped | 4321 (stopped) | 4322 (stopped) | 4323 |
| beta starts: 4322 busy, 4323 skipped (gamma remembers it), 4324 free | 4321 (stopped) | 4324, remembered | 4323 |
| alpha starts: 4321 free | 4321 | 4324 | 4323 |

The row where beta moves is the one weakness: a port that another program took is lost for good. `xez projects port beta 4322` pins it, so the next start tries 4322 again first.

**Writes need a lock.** Two instances starting at once both merge-write `config.json`. The atomic rename in `workspace/config.ts` prevents a torn file, not a lost update. The implementation adds a bounded cross-process lock around every workspace-config merge-write (every writer, including `xez projects`), rereads under it, and degrades to a warning on timeout (analysis § 6(e), AC-04).

## 5. How `xez mcp` finds the instance

**Without a port (the normal case).** Unchanged. `xez mcp` normalizes the working directory to the repository root, finds the registry row whose `root` equals its realpath, derives `<XEZ_HOME>/ipc/<projectId>.sock` and connects (`mcp/index.ts` `resolveMcpTarget`). The HTTP port plays no part. Two instances for two projects cannot cross: each socket is named by project id, and each instance opens only its own.

**With `--repo <dir>`.** Finds that project’s socket the same way.

**With `--port` or `XEZ_PORT`.** Neither is a locator for MCP. The analysis (§ 6(b)) is kept: a port must never retarget MCP.

- `XEZ_PORT` in the environment is ignored silently. It is often inherited from a shell profile, and a warning on every MCP spawn would be noise.
- An explicit `--port` prints one line to stderr (`error-cases.txt` C5) and carries on. It does not fail, because an MCP client configured with a stray `--port` works today and must keep working.

**When the project is not running.** The tool result keeps the existing message (`mcp/bridge.ts`): *“xezar is not running for project beta. Start the cockpit in the project's directory with `xez` (or `npx @qodeca/xezar`), then call this tool again.”* It does not add the remembered URL: a project leader works through the MCP only (AGENTS.md, MCP server row), so a URL would send it where it must not go.

**In workspace mode.** Only the boot project has a socket, as today. The other projects in that cockpit have no MCP.

## 6. The cockpit’s other projects: link out

**Choice: link to each project’s own cockpit. Do not hide them. Do not open them in place.**

Why not open in place: the project’s data belongs to another process. Opening it here is exactly what fails today (the writer refusal), and making it work would mean two schedulers for one project.

Why not hide: the registry is how a person with several projects finds them. Hiding it would make every other project invisible from the browser, and the owner asked for this change *so that* several projects can run on one machine. A person moving between projects needs the way across. `XEZ_SINGLE_PROJECT=1` already exists for the person who wants nothing else shown (§ 8).

**What each other project looks like.** One row per registered project in the sidebar group “Other projects” and in the command palette’s Projects group. The mockup is `switcher.html`.

| Row state | How it is known | What the row shows | Action |
|---|---|---|---|
| Running | This instance checks `GET http://<lastListen.host>:<lastListen.port>/api/v1/health` (300 ms) and the answer names that project as `bootProject` | name · `running` · the port | The row is a link to `http://localhost:<port>/p/<id>/`. Same tab on click, new tab with the usual modifier. |
| Running at an unknown address | The project’s writer claim is live, but no address answers as that project | name · `running — address not known` | None. The hint says: “Find the terminal that runs it.” |
| Not running | No live claim, no answer | name · `not running` | “Start in terminal” (opens a terminal running `xez --repo <root>`, local mode only) and “Copy command” |
| Folder missing | The registry status is `missing` | name · `folder missing` | Existing remove action |
| Checking | The first check has not answered | name · `checking…` | None |

The checks run on the server, not in the browser. `/api/v1/health` is CORS-open, so the browser could probe it, but a page that scans localhost ports is the wrong habit to build, and a server-side check can also read the writer claim. The answer is an additive field on `GET /api/v1/projects`, defined in `packages/contract` first:

```ts
instance?: {
  state: 'this' | 'running' | 'running-unknown-address' | 'stopped' | 'checking'
  url?: string   // only when state is 'running' or 'this'
}
```

It is refreshed when the switcher or palette opens, and cached for 10 seconds. No new WebSocket topic: the value is only needed while a person looks at the list.

**Other cross-project surfaces.** The global Tasks page (`routes/global-tasks.tsx`, from `GET /api/v1/workspace/runs-index`) shows this project’s tasks, then one line: “Other projects run in their own cockpits.” with the same links. The multi-project sidebar groups with quick lists become one group (this project) plus the “Other projects” links. Adding or cloning a project still works; the new project appears as “not running”.

**Hosted mode.** A hosted cockpit (`capabilities.localHandoff: false`) shows no “Start in terminal” and never probes other ports. Other projects show “not running here” with no action.

**Browser storage.** Each port is its own browser origin, so `localStorage` (sidebar width, last location) is per instance. Theme, accent and density are stored in `~/.xezar/ui-state.json` and follow across instances; the pre-paint script reads a per-origin copy, so a first visit to a new port may paint the default theme for one frame. That is `open-questions.md` Q-8.

## 7. `--instance workspace`: the old model, kept as an opt-in

| Flag | Environment | Stored key | Default |
|---|---|---|---|
| `--instance <project\|workspace>` | `XEZ_INSTANCE` | `cli.instance` | `project` |

`workspace` restores the 0.15 behaviour: one cockpit opens every registered project in place. Two rules keep it honest next to per-project instances:

- A project whose writer claim is live in another process is shown as a link (§ 6), never opened in place (`error-cases.txt` B4).
- A workspace cockpit prints one line at start: `info  xezar  workspace mode — this cockpit opens every project that is not running elsewhere`.

How long it stays is `open-questions.md` Q-1.

## 8. What `XEZ_SINGLE_PROJECT` means now

The meaning does not change: only the exact value `1` narrows the cockpit to the launch project and refuses project add, edit, checkout, browse and remove (`BACKWARD_COMPATIBILITY.md` § Single-project workspace mode). What it removes is now smaller, because the default already serves one project:

| | Default (`project`) | `XEZ_SINGLE_PROJECT=1` |
|---|---|---|
| Data served | This project | This project |
| Other projects in the sidebar and palette | Links (§ 6) | Hidden |
| Add, clone, browse, remove a project | Allowed | Refused with 409 |
| `GET /api/v1/health` `projects` | Every registered project | The launch project only |
| `xez projects add`, `remove` | Allowed | Exit 1 |

With `--instance workspace` it keeps its exact current meaning.

## 9. Collisions and their messages

Every message is in `error-cases.txt`; this table is the index.

| Collision | What happens | Case |
|---|---|---|
| Remembered port taken by another program | Move on, remember the new port | A1 |
| Remembered port taken by another project’s cockpit | Move on, name that project | A2 |
| `--port` taken | Move on (unchanged) | A3 |
| `cli.port` taken | Move on for this start, keep `cli.port` | A4 |
| Two projects set the same `cli.port` | The second to start moves on | A5 |
| No free port in range | Exit 1 before any claim | A6, A7 |
| Bind error other than busy | Exit 1, no retry | A8 |
| Second `xez` for the same project | Exit 1 before any port or claim; name the running cockpit only when checked | B1, B2, B2b |
| Project data claimed from another machine | Exit 1 | B3 |
| Workspace cockpit meets a project running elsewhere | Link, never open | B4 |
| A live MCP socket for this project | Cockpit starts without MCP | C3 |
| Two instances write `config.json` at once | Lock, reread, merge; warn on timeout | – |
| Two instances update team skills at once | The existing lock; the second prints “updated by another xezar” | F |
| Several instances’ tasks together exceed `maxParallel` | Not prevented (Q-3) | – |

Order of checks at start, so that a refusal touches nothing: validate flags and env → read the registry → claim the project writer → bind the port → write `lastListen` → open the MCP socket → start the renderer. The writer claim comes before the bind today (the store is built before `startServer`); the implementation keeps that order.

## 10. Compatibility: the entries `BACKWARD_COMPATIBILITY.md` needs

One new section, dated with the release, in the style of “Follow-up inbox default flip”. Proposed text for the implementing PRs, not for this design PR:

> **Per-project cockpit instances, remembered ports and terminal activity — deliberate, 0.16.0**
>
> Three defaults change together in a minor release, by owner decision on 2026-09-16 (#467).
>
> 1. **One cockpit per project.** `xez` serves only the project it starts in. Other registered projects are shown as links to their own cockpit or as not running, instead of opening in place. Restore the old behaviour with `--instance workspace` or `XEZ_INSTANCE=workspace`. `XEZ_SINGLE_PROJECT=1` keeps its meaning.
> 2. **Remembered ports.** Without `--port`, a project starts on the port it last listened on, then on `projects[].cli.port`/`XEZ_PORT` when set, then from 4321, skipping ports other projects remember. `--port 4321` restores the old start point for one start. The 50-port fall-forward, `--port 0` and `server-install` ports are unchanged.
> 3. **Live activity on stderr.** `serve` writes task, check, agent, HTTP-error, MCP and skills activity to stderr. In a terminal it draws a live table of active tasks. The boot banner stays on stdout with a new layout. `--output lines --color never` gives plain human lines; `--output plain` gives one logfmt line per event; `--quiet` shows warnings and errors only. `run`, `init`, `projects`, `--help`, `--version` and `mcp` keep their stdout contracts, and `mcp` stdout stays JSON-RPC only. Old logs are not reproduced byte for byte.

Section edits alongside it:

| Section | Change |
|---|---|
| § 1 CLI | Add flags `--output`, `--color`, `--log-level`, `--quiet`/`-q`, `--instance`; add `xez projects port`; add env `XEZ_PORT`, `XEZ_OUTPUT`, `XEZ_COLOR`, `XEZ_LOG_LEVEL`, `XEZ_QUIET`, `XEZ_INSTANCE`; note `NO_COLOR` is honoured. Change the `-p/--port` line from “default 4321” to the § 4 precedence. |
| § 2 HTTP | `GET /api/v1/projects` gains the additive `instance?` field. `GET /api/v1/workspace/runs-index` answers this project only in `project` mode (a narrowing, named in the new section). Health unchanged. |
| § 9 `~/.xezar/` | `config.json` gains `projects[].cli.port`, `projects[].lastListen`, top-level `cli`. All optional, per-key `.catch`, never required. Merge-writes gain the cross-process lock. |
| Single-project mode | One paragraph: its effect under the new default (§ 8). |

Same commit as the code, per AGENTS.md: `.env.example` for all six new `XEZ_*` variables and the changed default of `XEZ_SINGLE_PROJECT`’s context; the README env table; `CHANGELOG.md` under `# Unreleased` with a “Breaking defaults” note.
