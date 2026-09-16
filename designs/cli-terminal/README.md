# CLI terminal – live activity, settings and one cockpit per project

Status: **Draft** – round 1 findings (B-1 … B-3, NB-1 … NB-8) addressed, waiting for the second `design-review`. Issue #467, PR 1 of the CLI plan. Base `main` at `bb271fc`.

This folder designs a surface that is not a web page: what `xez` prints in a terminal. It also designs the one cockpit change that follows from running one xezar per project (the project switcher). No code changes here.

## 1. Summary

Today `xez` prints a boot banner and then goes almost silent. A person running xezar for three projects in three terminals cannot see, without a browser, which task needs them, which check failed, or which terminal belongs to which project – and all three want port 4321.

This design gives each project its own xezar with a port it keeps, and turns its terminal into a calm live view:

- a short banner that names the project, the branch and the cockpit URL;
- one line per thing that happened – a task started, a check failed, a question was asked, a request was refused – with a word for its level and colour only as reinforcement;
- in an interactive terminal, a small live table of active tasks at the bottom, redrawn at most four times a second;
- plain one-line-per-event output for files, pipes and CI;
- flags, `XEZ_*` variables and stored keys to change all of it, with one precedence rule.

Owner decisions of 2026-09-16 that this design follows: (1) `picocolors` plus our own small bounded renderer; (2) one cockpit per project is the new default; (3) remembered ports and live activity on stderr are defaults, shipped in a minor release.

## 2. Problem evidence

From the accepted analysis (`.local/erfana-lens-reports/cli-terminal-ports-spec.md`, § 4, source at `bb271fc`) and a read of the code for this design:

- **Boot is the only structured output.** `packages/xezar/src/index.ts` prints the version, repo, branch, one `✓`/`✗` line per backend check, a busy-port notice and `cockpit → <url>`, all with `console.log` to stdout. After that, only selected failures reach the terminal through scattered `console` calls; there is no shared terminal logger and no HTTP error log (`server/server.ts`).
- **Headless `run` already streams detail** (`index.ts:540–580`); `serve` does not.
- **Ports are per invocation.** `-p/--port` defaults to 4321 and falls forward over 50 ports. There is no `XEZ_PORT` and nothing is remembered, so a project’s address changes with start order.
- **Two processes cannot own one project** (`runs/project-writer.ts`: “project data is already in use … Use the existing cockpit.”), yet the cockpit offers every registered project in place, and opening one another process owns hits that refusal.
- **MCP is per project already.** `xez mcp` finds `<XEZ_HOME>/ipc/<projectId>.sock` by project root, not by port (`mcp/index.ts`, `mcp/ipc.ts`), but a cockpit opens only its boot project’s socket (`index.ts:334`).

Measured on this repository’s own `.local/xezar/` on 2026-09-15 (read-only): 470 task records; titles are stored cut at 80 characters (p50 = p95 = max = 80); the longest step id is 11 characters; about 14 tasks overlapped at the busiest moment (approximate, from record times); the three largest event logs peak at 12, 18 and 21 events a second, almost all `item.*` and `tool-*` events that produce no terminal line.

## 3. Users and jobs

**Reader.** A developer who runs xezar on their own machine, often for more than one repository at once, with a terminal per project next to an editor. Also the same person reading a log file after the fact, and a CI job that boots xezar for tests.

**Job on arrival.** They just started `xez`, or they glance back at its terminal while doing something else. They want to know: is it up and where; is anything waiting for me; did something fail. Next they open the cockpit URL, answer a question, or go back to work.

**First read, before anything scrolls.** Which project this terminal is (project name first on the banner, and in the stop line), the cockpit URL, and – at the bottom of the screen at all times – how many tasks are active and whether one needs them.

**Scanning many.** Activity is time-ordered, one entry per event, with a fixed-width subject column (task id or source: `http`, `mcp`, `skills`, `provider`, `update`, `registry`, `xezar`) so the eye runs down one column. The live table orders tasks by who is waiting: needs permission, needs you, needs review, running (monitoring included), scheduled, queued; oldest first within each. There is no search or filter in the terminal: the table holds at most 10 rows and the cockpit is one click away.

**The distinction that must never be missed.** *Something is waiting for you or failed* against *everything is fine*. It is carried by words first – the level word (`warn`, `error`) on every line, the state word in the table (`needs you`, `failed`), and the count in the summary line (“1 needs you”) – and by colour second. A second distinction is kept just as strictly: `needs review` is not `done`, and `done` is never a verdict on the work.

## 4. Goals and non-goals

**Goals**

1. See task, check, agent, MCP, skills and HTTP-error activity in the terminal as it happens, within one second.
2. Run several projects on one machine without port or ownership confusion, with each project keeping its port.
3. Make every part of the output adjustable: presentation, colour, level, quiet, port, instance mode.
4. Keep scripts working: stdout contracts of `run`, `init`, `projects`, `--help`, `--version` and `mcp` unchanged; exit codes unchanged.

**Deliberately not built**

| Not built | Why | What a person might expect |
|---|---|---|
| Keyboard input in the terminal (keys to answer, cancel, scroll the table) | Answers belong in the cockpit, where the whole question and its context are; a terminal UI would need focus, input and a second answer path | “Press a key to open the task” |
| A spinner | A waiting state is a word, not motion; a spinner redraws forever and breaks screen readers | An animated “starting…” |
| A terminal bell or OS notification on “needs you” | The cockpit already notifies (Settings → Notifications) | A beep |
| OSC 8 hyperlinks | Support is uneven and hard to detect; terminals already link plain URLs | Clickable task ids |
| JSON log output | logfmt covers people and grep; `--output json` can be added later without a break (`open-questions.md` Q-10) | `--output json` |
| Log files and rotation | Shell redirection does it (`2> activity.log`) | `--log-file` |
| Separate ports for API, WebSocket or MCP | One HTTP server carries cockpit, API, SSE and WS; MCP is stdio plus a local socket (analysis § 6(b)) | `--mcp-port` |
| MCP over the network | Needs its own authorization design | Remote leaders |
| Configurable time format or colours | 16 terminal colours follow the person’s own terminal theme; one time format keeps logs comparable | A 12-hour clock |
| A cockpit Settings page for terminal settings | They matter only in a terminal (`open-questions.md` Q-9) | Settings → Terminal |
| A host-wide task limit across instances | Needs a cross-process lease (`open-questions.md` Q-3) | `maxParallel` counting all projects |
| Windows MCP | Unchanged from today: reported as unavailable | – |

## 5. Files

| File | What it holds |
|---|---|
| `README.md` | This handoff |
| `tty.txt` | Interactive terminal, 80 columns: first start, second project, live activity with the table, more than 10 tasks, Ctrl-C summary |
| `tty-narrow.txt` | Interactive terminal, 40 columns, and a resize from 80 to 40 |
| `non-tty.txt` | Redirected, piped, CI and `TERM=dumb`: plain banner and logfmt lines |
| `quiet.txt` | `--quiet`, `run --quiet`, the four log levels and the level table |
| `error-cases.txt` | Every refusal and failure: ports, instances, MCP, tasks, HTTP, skills, exposure, untrusted text, bursts, closed output |
| `multi-instance.md` | One cockpit per project: ownership, stored keys, port choice, MCP lookup, the switcher, `XEZ_SINGLE_PROJECT`, collisions, BC entries |
| `open-questions.md` | Q-1 … Q-12 for the review, each with a recommendation |
| `index.html` | Entry page: the colour key rendered in both themes and a coloured sample of `tty.txt` |
| `switcher.html` | The cockpit’s “Other projects” list in every state, desktop and 375 px |
| `styles.css`, `theme.js` | Feature rules for the two pages; the light/dark switch |

## 6. Screens

The terminal has four surfaces. `.txt` files show each one exactly.

### 6.1 Boot banner – stdout

Blank line, then:

```
  xezar <version> · <project> · branch <branch>
  <repo path, home shortened to ~>

  cockpit   <url>
            <port note, only when the port is not the remembered or set one>
  agents    <product name> <version or “missing”> · …
  tools     git <version> · gh <version or “missing”>
```

Labels are a 10-column left column (`cockpit`, `agents`, `tools`), lower case like the cockpit’s status words. Agent names come from the product-name map (`lib/runner-label.ts` today, rule 8). A list that does not fit wraps at a ` · ` onto the next line, aligned under the values. A repo outside git prints `not a git repository — tasks run in place, one at a time` in place of the branch part, as today.

The banner is written once and never redrawn. Nothing else is written to stdout by `serve` after it.

### 6.2 Activity lines – stderr

```
  HH:MM:SS  <level>  <subject>  <message>
                               <continuation>
```

- time: local, 24-hour, 8 columns (plain output uses UTC ISO-8601, § 10.3);
- level: `debug`, `info`, `warn`, `error`, padded to 5;
- subject: a task’s first 8 id characters (matching branch `xez/<id8>`), or a source word, 8 columns;
- message: starts with a lower-case verb or state word, then ` — ` and the details joined with ` · `;
- continuation: the task URL after `needs you` and `failed`, a server message, or a wrapped remainder; indented to the message column; at most 2 continuation lines except a URL, which is never cut.

### 6.3 Live region – stderr, rich mode only

A rule line `─ active tasks ─…`, a header row, up to 10 task rows, an optional overflow line and a summary line. Columns at 80: Task 8 · State 12 · Step 10 · Agent 11 · Time 7 (right-aligned `m:ss`, `h:mm:ss`) · Title (the rest: 20 at 80 columns). Cut cells end in `…`. Empty: `No active tasks — start one at <url>/p/<project>/new`.

Summary: `<n> active — <n> needs permission · <n> needs you · <n> needs review · <n> running · <n> scheduled · <n> queued — <n> failed since start`, leaving out every zero part except `<n> active`.

Narrow (< 60 columns), the same grammar as one line, with `since start` left out: `<n> active — <parts> — <n> failed`. Parts that do not fit are left out from the right and replaced by `…`; `<n> active` and the needs-permission and needs-you counts are never left out.

**What “failed” counts.** Every failed count – the summary line, the session summary and `failed=` in plain output – counts **task outcomes only**: a task whose record ended `failed`. A failed check step is not counted; it is an `error` activity line, and the task it belongs to either goes on (a repair step) or ends with its own `failed` line. A task a usage limit stopped (`scheduled`, § 9.2) is not counted as failed either, because it resumes on its own.

### 6.4 Session summary – stderr, on stop

```
  <time>  info   xezar     stopping — <n> tasks are still running

  Session summary — <duration>
    <n> done · <n> needs review · <n> failed · <n> cancelled
    <n> tasks were still running. xezar picks them up on the next start.
  xezar stopped for <project>.
```

The still-running sentence is left out at zero.

### 6.5 Cockpit: other projects

`switcher.html`, specified in `multi-instance.md` § 6. Uses the sidebar `group-heading`, `nav` rows, `Pill` with `dot`, `Button variant="ghost"` and the `CenteredState` pattern for the list’s own states.

## 7. States

| State | Terminal | Where |
|---|---|---|
| Default | Banner, activity lines, live table | `tty.txt` 2–3 |
| Empty (first use) | `No active tasks — start one at …/new` | `tty.txt` 1 |
| Empty (narrow) | `No active tasks` | `tty-narrow.txt` 4 |
| Loading | Banner lines 1 and 2 (version, project, branch, path) print first, before the agent and tool version checks and before the bind, so the terminal is never blank while those run. The `cockpit`, `agents` and `tools` lines follow once the port is bound and the checks answer; there is no “starting” word or spinner. MCP becomes ready later and announces itself with its own line; it is never shown as ready before it listens. **Measured on 2026-09-16 (PR 3), and it does not work that way yet:** on this repository, on a fresh single-project start with the agent CLIs mocked, the terminal is blank for a median **606 ms** (5 runs, 478–642 ms) and then the whole banner — version, branch, every check and the `cockpit` line — arrives in one piece, **0 ms** apart. The split above needs the banner itself rewritten to § 6.1, which PR 3 did not do (see § 14). So the wait this row exists to cover is about six tenths of a second of nothing, not a partial banner. | `tty.txt` 1 |
| Error – refused start | `error` + `fix` lines, exit 1, nothing claimed | `error-cases.txt` A6–A9, B1–B3 |
| Error – while running | `error` activity line with the task URL | `tty.txt` 3, `error-cases.txt` D, E |
| Refusal | HTTP 409 from a hosted-mode or local-machine guard is a `warn` line with the server’s own message; the cockpit’s refusal copy is unchanged | `error-cases.txt` E |
| Partial | MCP unavailable, an agent missing, the port not remembered, the registry unreadable: one `warn`, the cockpit keeps working | `error-cases.txt` A10, A11, C, F |
| Stale | A remembered port that another program took: move on and say so | `error-cases.txt` A1, A2 |
| Burst | Info lines above 20 a second folded into one count line; warnings and errors never folded | `error-cases.txt` G3 |
| Output closed | Drawing stops; the service keeps running | `error-cases.txt` G4 |
| Quiet | Short banner, warnings and errors only | `quiet.txt` |
| Plain | logfmt lines | `non-tty.txt` |
| Narrow (< 60 columns) | Two-part entries, one-line live summary | `tty-narrow.txt` |
| Stop | Session summary | `tty.txt` 5 |

Cockpit switcher states (loading, error, hosted refusal, phone) are in `switcher.html`.

## 8. Settings surface

W = `~/.xezar/config.json`; P = that file’s `projects[]` entry for this project. Every stored key is optional, validated per key and never required. Nothing reads `.env`.

| Purpose | Flag | Environment | Stored key | Default | Applies to |
|---|---|---|---|---|---|
| Preferred HTTP port | `-p, --port <0–65535>` | `XEZ_PORT` | `P.cli.port` (set with `xez projects port <id> [<port>]`) | `P.lastListen.port`, else 4321 skipping ports other projects remember | `serve` |
| Remembered address | – | – | `P.lastListen {port, host, observedAt}` (written by xezar) | – | `serve` |
| Instance mode | `--instance <project\|workspace>` | `XEZ_INSTANCE` | `W.cli.instance` | `project` | `serve` |
| Presentation | `--output <auto\|rich\|lines\|plain>` | `XEZ_OUTPUT` | `W.cli.output` | `auto` | `serve`, `run` |
| Colour | `--color <auto\|always\|never>` | `XEZ_COLOR`; `NO_COLOR` | `W.cli.color` | `auto` | `serve`, `run` |
| Level | `--log-level <debug\|info\|warn\|error>` | `XEZ_LOG_LEVEL` | `W.cli.logLevel` | `info` | `serve`, `run` |
| Quiet | `-q, --quiet` | `XEZ_QUIET=1` | – | off | `serve`, `run` |
| Bind address | `--bind-host <host>` | – | – | `127.0.0.1` | unchanged |
| Project root | `--repo <dir>` | – | – | cwd, normalized to repo root | unchanged |
| Browser | `--no-open` | – | – | open after health answers | unchanged |
| Single project | – | `XEZ_SINGLE_PROJECT=1` | – | off | meaning unchanged, see `multi-instance.md` § 8 |
| Skills banner | – | `XEZ_NO_BANNER=1` | – | off | unchanged: only the skills banner |
| Home | – | `XEZ_HOME` | – | `~/.xezar` | unchanged |
| MCP port | – | – | – | none: stdio plus local socket | `xez mcp` ignores `XEZ_PORT` and warns on `--port` |

**Precedence, highest first**

| Setting | Order |
|---|---|
| Port | `--port` > `P.cli.port` > `XEZ_PORT` > `P.lastListen.port` > 4321 (details and skipping: `multi-instance.md` § 4) |
| Instance, output, level | flag > `W.cli.*` > env > default |
| Colour | plain output (never colour) > `--color` > non-empty `NO_COLOR` > `W.cli.color` > `XEZ_COLOR` > detection |
| Quiet | `--quiet` > `XEZ_QUIET` > off; combined with the level, the narrower wins |

Stored over environment follows the `followups` / `agentEnvPassthrough` pattern. The flag always wins.

**`auto` output**, decided once at start and again on resize: `rich` when stderr is a TTY, `CI` is unset or empty, `TERM` is not `dumb` and the width is at least 60; `lines` on a TTY narrower than 60 (with the one-line live summary, `tty-narrow.txt`); `plain` otherwise. Explicit `rich` on a non-TTY falls back to `plain` with one `output.fallback` line. Explicit `lines` is honoured anywhere.

**Colour detection** (`auto`): colour when the output is `rich` or `lines` and stderr is a TTY and `TERM` is not `dumb`. `always` colours `rich` and `lines` even through a pipe; `plain` never has colour. `NO_COLOR` set to any non-empty value turns colour off unless `--color always` is passed (no-color.org leaves explicit user choice above the variable). `FORCE_COLOR` is not read; picocolors reads it and `--color` from `process.argv` on its own, so the renderer builds its colours with `createColors(enabled)` from this resolution only.

**Validation.** A bad flag or env value stops the start before any registry read, lock, claim or bind, with the accepted values, exit 1 (`error-cases.txt` A9). A bad stored value is ignored with one warning and left on disk (A10). Ports reject fractions, `NaN`, negatives and values above 65535.

## 9. Copy deck

Rules from `docs/design-system/writing.md`, applied to the terminal: sentence case; `xezar` lower case; ` — ` (em dash, the cockpit’s UI form) between clauses; `·` between facts; `…` never `...`; curly quotes around text a person or agent wrote; no Oxford comma; no contractions; status words lower case and identical to the cockpit’s `lib/attention.ts` labels (`needs permission`, `needs you`, `needs review`, `running`, `monitoring`, `scheduled`, `queued`, `done`, `failed`, `cancelled`); ages follow `lib/format.ts` `shortAge` (one unit, floored: `writing.md` § 12); durations use a **new** terminal formatter, `formatDuration` in `packages/xezar/src/terminal/format.ts` (PR 3), with two units and no rounding up (`41s`, `2m 23s`, `1h 02m`) and table `m:ss` / `h:mm:ss` – no cockpit helper makes this form today; tokens `18.4k`; cost `$0.31`; missing values `—`. “Task” in human copy, `run` only as a plain-output key.

### 9.1 Strings

| Where | Copy |
|---|---|
| Banner line 1 | `xezar 0.16.0 · beta · branch feature/login` |
| Port note, skipped | `4321 is kept for alpha — beta uses 4322 from now on` |
| Port note, busy, unknown program | `4322 is used by another program — beta uses 4323 from now on` |
| Port note, `cli.port` also set for a running project | `4400 is also set for alpha, which is running — using 4401 this time` |
| Port note, busy, other cockpit | `4322 is used by the xezar cockpit for gamma — beta uses 4323 from now on` |
| Port note, `--port` busy | `5000 was busy — using 5001` |
| Port note, `cli.port` busy | `4400 is set for beta but was busy — using 4401 this time` |
| No agent | `none found — install Claude Code, Codex, OpenCode or pi` |
| MCP ready | `ready — run xez mcp in this project folder` |
| MCP unavailable | `unavailable — <reason>. The cockpit works without it.` |
| Task queued | `queued — “<title>”` |
| Task started | `started — <step> · <agent>` |
| Step started | `step <i>/<n> <step> started · <agent>` |
| Check passed | `check <step> passed — <duration>` |
| Check failed | `check <step> failed — exit <code> · <duration>` |
| Question | `needs you — “<question>”` |
| Question without supplied text | `needs you — waiting for an answer` (plain output omits `question=`) |
| Answered | `answered — running again` |
| Review | `needs review — <duration> · <tokens> tokens` |
| Done | `done — <duration> · <tokens> tokens · <cost>` |
| Failed, agent | `failed — <agent> stopped · exit code not reported` / `failed — <agent> exited with code <n>` / `failed — <agent> stopped by signal <SIG>, not sent by xezar` |
| Paused | `paused — <agent> usage limit · resumes at <HH:MM>` (table state `scheduled`) |
| Needs permission | `needs permission — <tool> · <agent>` + continuation task URL |
| Cancelled | `cancelled — <duration>` |
| HTTP | `<status> <METHOD> <route template>` + continuation `“<server message>”` |
| HTTP folded | `repeated <n> times in 10s` |
| Leader | `leader attached — <client product name>` / `leader detached` |
| Skills | `<source> updated — <n> skills changed` / `update failed — <reason> · next try <HH:MM>` |
| Provider | `<agent> needs sign-in — open Settings → Agents` / `<agent> signed in` |
| Update | `xezar <v> is available — restart with` + `npx @qodeca/xezar@latest` |
| Empty table | `No active tasks — start one at <url>/p/<project>/new` |
| Live summary, wide | `4 active — 1 needs review · 2 running · 1 queued — 1 failed since start` |
| Live summary, narrow | `2 active — 2 running — 1 failed` |
| Overflow | `+<n> more <state> — see <url>/p/<project>/tasks` (the hidden rows’ state, or `tasks` for mixed states) |
| Folded burst | `<n> more info lines in the last second were folded — see the cockpit` |
| Stopping | `stopping — <n> tasks are still running` |
| Stopped | `xezar stopped for <project>.` |
| Refused: already running | `xezar is already running for <project>.` / `Its cockpit: <url> (process <pid>)` / fix `Use that cockpit, or stop it first with Ctrl-C in its terminal.` |
| Refused: no port | `No free port in <from>–<to> on <host>.` / fix `Stop a program that uses one of these ports, or pass --port <port>.` |
| Bad value | `<flag or var> must be <rule> — got “<value>”.` |
| `xez mcp --port` | `xezar mcp finds the cockpit by project, not by port — --port is ignored` |
| Non-loopback bind | `Listening on <host>:<port> — xezar has no built-in login.` + two sentences |

### 9.2 Colour

Only the terminal’s 16 standard colours, so the person’s own light or dark terminal theme decides the exact shade. Never bright white or black, never a background colour, never 256-colour or true-colour codes. Each colour mirrors a cockpit token role (`docs/design-system/foundations.md`); `index.html` renders them in both themes.

| Element | ANSI | Cockpit role it mirrors | Word that carries the meaning without colour |
|---|---|---|---|
| `error` level, `failed` state, “failed” counts | red | `--danger` | `error`, `failed` |
| `warn` level, `needs permission`, `needs you` and `scheduled` states | yellow | `--pending-strong` | `warn`, `needs permission`, `needs you`, `scheduled` |
| `needs review` state | magenta | `--violet` | `needs review` |
| `running`, `monitoring` states, URLs | cyan | `--info` | `running`, `monitoring` |
| `done`, `passed`, `ready` | green | `--success` | `done`, `passed`, `ready` |
| `info` and `debug` levels, `queued` and `cancelled` states | default foreground (no colour, not dim) | `--foreground` | `info`, `debug`, `queued`, `cancelled` |
| Time, column headers, rule line, the `—` placeholder | dim | `--muted-foreground` | – (context only) |
| Project name on banner and stop line | bold | – | the name itself |

**The one contrast rule.** Dim is used for exactly four things: the time, the column headers, the rule line and the `—` placeholder. Nothing else is ever dim. Every level word and every state word – including `info`, `debug` and `queued` – prints at full contrast, in its colour or in the default foreground. A tester checks it by grepping the coloured capture for the dim code (`ESC[2m`) and finding it only before those four.

## 10. Developer notes

### 10.1 Event sources

As the analysis § 6(d) proposes: subscribe to the boot `RunStore` before recovery (`runs/store.ts` `run` and `event`); for status transitions compare with the previous status so token updates never print; seed restored records as “recovered”, not as starts. Workspace changes (providers, registry, skills, automations) come from `WorkspaceEventBus`. HTTP 4xx/5xx need a new diagnostic middleware at the Hono boundary, logging returned and thrown errors once each, never the body, query or headers. MCP ready/unavailable come from `startMcpSocket`’s result, not from the banner. In project mode (`multi-instance.md`) there is exactly one store per instance, which removes the lazy-context subscription problem the analysis describes; in workspace mode, attach per store through `ProjectContexts.onStoreCreated`.

### 10.2 Event → line mapping

| Event | Level | Human line (subject · message) | Plain `event=` | Table effect |
|---|---|---|---|---|
| Boot ready | info | banner (stdout) | `xezar.ready` | – |
| Worktrees cleaned / reclaimed | info | `xezar · cleaned <n> orphaned worktree: <ids>` | `worktree.cleaned` / `worktree.reclaimed` | – |
| Runs recovered | info | `xezar · recovered <n> tasks from the previous session` | `task.recovered` | rows appear |
| Task queued | info | `<id8> · queued — “<title>”` | `task.queued` (new) | row |
| Task started / step started | info | `started — …` / `step i/n …` | `task.started` (new) / `step.started` (new) | row updates |
| Check step settled | info / error | `check <step> passed — …` / `failed — exit <n> …` | `gate.passed` / `gate.failed` | – (never counted as failed, § 6.3) |
| Question asked | warn | `needs you — “<question>”` + URL | `question.asked` | state `needs you` |
| Question answered | info | `answered — running again` | `question.answered` | state `running` |
| Review | info | `needs review — …` | `result.ready` | state `needs review` |
| Done | info | `done — …` | `task.done` | row removed, counted |
| Failed | error | `failed — <cause>` + URL | `task.failed` | row removed, counted |
| Cancelled | info | `cancelled — <duration>` | `task.cancelled` | row removed, counted |
| Monitoring | info | `monitoring — <step>` | `task.monitoring` (new) | state `monitoring` |
| Usage-limit pause | warn | `paused — …` | `task.paused` (new) | state `scheduled` (as `attention.ts`); not counted as failed |
| Memory pause | warn | `paused — …` | `task.paused` (new) | row stays, state unchanged |
| Permission asked | warn | `needs permission — <tool> · <agent>` + URL | `permission.asked` (new) | state `needs permission` |
| Agent session error | error | part of `failed — …`; exit code or signal only when observed, else “exit code not reported” | `exit=<n>` / `signal=<SIG>` / `exit=unknown` | – |
| HTTP 5xx | error | `http · <status> <METHOD> <route>` + message | `http.error` (new) | – |
| HTTP 400 401 403 409 413 422 | warn | same | `http.refused` (new) | – |
| HTTP other 4xx | debug | same | `http.refused` | – |
| Origin guard refusal | warn | `http · 403 <METHOD> <route> — cross-origin request refused` | `http.refused reason=origin` | – |
| MCP ready / unavailable | info / warn | `mcp · ready — …` / `unavailable — …` | `mcp.ready` / `mcp.unavailable` (new) | – |
| Leader attached / detached | info | `mcp · leader attached — <client>` | `leader.attached` / `leader.detached` (new; reconcile with #450) | – |
| MCP session open / close | debug | `mcp · session opened` | `mcp.session` (new) | – |
| Skills updated / failed / nothing new | info / warn / debug | `skills · …` | `skills.updated` / `skills.failed` / `skills.checked` (new) | – |
| Provider signed out / in | warn / info | `provider · <agent> needs sign-in …` | `executor.unavailable` / `executor.available` | – |
| Update available | info | `update · xezar <v> is available …` | `update.available` (new) | – |
| Port remembered / not remembered | debug / warn | `registry · …` | `registry.port` (new) | – |
| Stop | info | `xezar · stopping — …` + summary | `xezar.stopping`, `session.summary`, `xezar.stopped` (new) | region erased |

Names marked “new” are not in `mcp/event-catalog.ts`. Where the catalog has a name, the meaning and name are reused. #460’s significance and verdict policy must be reconciled before PR 3 fixes these meanings.

### 10.3 Output modes

| Mode | When | Streams | Format | Live region | Colour |
|---|---|---|---|---|---|
| `rich` | auto on a capable TTY ≥ 60 columns | banner stdout, rest stderr | human lines | table | yes |
| `lines` | auto on a TTY < 60; or asked | same | human lines | one-line summary on a capable TTY outside CI, none elsewhere | only on a capable TTY outside CI |
| `plain` | auto off a TTY, in CI, `TERM=dumb`; or asked | same | logfmt, UTC ISO-8601 ms | none | never |
| `--quiet` | any mode | banner reduced to the cockpit line(s) | as the mode | none | as the mode |

logfmt: `<time> level=<l> project=<id> event=<name> key=value …`; a value with a space, `"`, `=` or no characters is double-quoted, `"` and `\` escaped with `\`.

HTTP diagnostic rows also include `request_id=<8 hex>` to correlate a request without exposing its headers or body.

Unchanged: `run` keeps its stdout transcript (with `--quiet`, only the final status line); `init`, `projects`, `--help`, `--version` keep stdout; `xez mcp` writes JSON-RPC only to stdout and never starts a renderer.

### 10.4 Renderer and redraw budget

- Durable lines are written once and never touched. Only the live region (at most 14 lines: rule, header, 10 rows, overflow, summary) is redrawn.
- A redraw moves the cursor up over the region, clears to end of screen, writes new durable lines, then the region – in one `write()` call.
- At most 4 redraws a second; changes inside a 250 ms window are merged. Nothing changed, nothing drawn. The Time column ticks once a second only while a visible row is under one hour; otherwise once every 15 seconds.
- Resize (`SIGWINCH`) is debounced 100 ms, then the region is erased and redrawn at the new width; crossing 60 columns switches between table and one-line summary.
- The cursor is hidden while the region is drawn and restored on normal stop, `SIGINT`, `SIGTERM` and uncaught error.
- Scrollback is never cleared. The alternate screen is never used.
- Info lines above 20 a second (200 in plain) are folded into one count line; warnings and errors never are.
- On `EPIPE` or a closed stderr the renderer detaches its listeners and timers; the service and its tasks carry on.
- Unicode: `─ · — … ↳ “ ”` when the locale is UTF-8 (`LC_ALL`, `LC_CTYPE`, `LANG`); otherwise `- | - ... -> " "`.
- Budget measured by a fixture: 1000 store updates a second for 10 seconds give no more than 40 redraws and keep every error line (AC-12).

### 10.5 Untrusted text

Task titles, questions, agent error text, server messages, GitHub titles and branch names, paths and project names can all hold terminal control codes. Every such value goes through one function before it is printed, in every mode and at every level:

1. Remove ESC sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`, including OSC 8 hyperlinks and OSC 52 clipboard writes), DCS, APC, PM and SOS.
2. Remove the remaining C0 and C1 control characters and DEL.
3. Replace CR, LF, TAB, U+2028 and U+2029 with a space; collapse runs of spaces.
4. Remove bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069) so text cannot reorder a line.
5. Redact known secret shapes with the same redaction the run evidence uses; never print the launch key.
6. Cut to a display width (wide characters count 2, combining marks 0) with `…`: 20 in the table, the message column in lines, 200 characters in plain.
7. In plain output, quote and escape after cleaning.

HTTP entries print the route template, never the request path, query or body. `error-cases.txt` G2 shows an example.

### 10.6 Files a developer will touch

| PR | Files |
|---|---|
| 2 – settings and ports | `packages/xezar/src/index.ts` (parse, validate, precedence, order of start checks), `workspace/config.ts` (schema for `cli`, `projects[].cli`, `projects[].lastListen`; cross-process merge lock), `workspace/projects-cli.ts` (`port` subcommand), `mcp/index.ts` (`--port` notice), `.env.example`, README env table, `BACKWARD_COMPATIBILITY.md`, `CHANGELOG.md` |
| 3 – renderer | new `packages/xezar/src/terminal/` (resolve mode, format, sanitize, render), subscription wiring in `index.ts`, HTTP diagnostic middleware in `server/server.ts`, `picocolors` in `packages/xezar/package.json`, status words moved to `packages/contract` (Q-6) |
| 3b – cockpit switcher | `packages/contract` (`instance?` on the projects entry), `server/server.ts` projects route and the health probe, `packages/web/src/components/app-shell.tsx`, `project-groups.tsx`, `command-palette.tsx`, `routes/global-tasks.tsx`; design-system docs for the new row states |
| 4 – MCP and guide | reconcile with #450 (attach events) and #460 (significance); guides for #448 |

### 10.7 Tests

Unit: sanitizer (every row of § 10.5), logfmt quoting, width cutting with wide characters, precedence tables, port skipping. Integration with a fake clock and a fake TTY: redraw budget, resize, cursor restore, EPIPE. Built-CLI (`npm run test:package`): two projects on one `XEZ_HOME`, second instance refused, `--port` busy, exhaustion, `mcp` stdout clean under every new flag. Prove each named break red first (AGENTS.md § Changing a mechanism).

## 11. Accessibility

- **Words carry meaning.** Every line has a level word; every table row has a state word; the summary counts in words. `NO_COLOR=1` and `--color never` lose nothing but colour.
- **No motion.** No spinner, no blinking, no progress bar. The only repeated redraw is the Time column, at most once a second.
- **Screen readers.** A redrawn region is read badly by terminal screen readers. `--output lines` (or `XEZ_OUTPUT=lines` stored as `cli.output`) gives append-only lines with no live region, and `TERM=dumb` turns it off automatically. A person must be able to find this without the README: PR 3 puts it in two places a person meets first. (1) `xez --help` lists `--output` with the line `lines   one line per event, no live table (use with a screen reader)`. (2) The PR 3 guide (#448) has one sentence next to the install steps: “Using a screen reader? Start xezar with `xez --output lines`, or set `XEZ_OUTPUT=lines`.” The README’s install section carries the same sentence.
- **Contrast.** 16 standard colours only, so a person’s high-contrast terminal theme applies. Dim is used only for context, never for a level or state word.
- **Keyboard.** Ctrl-C stops xezar; a second Ctrl-C exits at once. Nothing else needs a key.
- **Cockpit switcher.** Real links and buttons, a label on every control, the `:focus-visible` ring, `sr-only` text for a state that a dot shows, `role="status"` on the checking line, no sideways scroll at 375 px (`switcher.html`).

## 12. Responsive

### 12.1 Width behaviour

| Width | Banner | Activity | Live region |
|---|---|---|---|
| ≥ 100 | as at 80 | message column wider | Title column wider |
| 80 | `tty.txt` | one line, continuation lines | table, 10 rows |
| 60–79 | as at 80, lists wrap at ` · ` | message column narrower | Agent column dropped first, then Step; Title never below 12 |
| < 60 (40 shown) | stacked, one value per line | time, level and subject on one line, message under it, at most 3 lines | one summary line |
| < 30 | stacked | subject line, message cut to one line | none |

Width is read from `process.stderr.columns`; when unknown on a TTY, 80.

### 12.2 What gets cut, in order

1. The Agent column.
2. The Step column.
3. The Title column down to 12, then the whole table in favour of the one-line summary.
4. Token and cost parts of `done` and `needs review` lines (they stay in plain output).

Never cut: the time, the level word, the subject, the state word, the first line of an error, a URL, the “needs you” count.

### 12.3 Worst case, measured

| Case | Number | Source |
|---|---|---|
| Longest list | 14 active tasks at once; the table shows 10 and one overflow line | this repo’s `runs.json`, 2026-09-15 (approximate) |
| Longest title | 80 characters (stored cut); the table cuts to 20, lines to the message column | same, p95 = max = 80 |
| Longest step id | 11 characters; the Step column (10) cuts it with `…` | same |
| Longest task prompt | unbounded; never printed, only the title | – |
| Event rate | 21 events a second from one task at peak, 14 tasks ≈ 300 a second; lines come from transitions only, far fewer | largest three event logs |
| Slowest state | The health probe that names another cockpit: 300 ms per probe, only after `EADDRINUSE`, at most 3 probes per start | design limit |
| Long route template | 36 characters (`/api/v1/p/:projectId/runs/:id/finish`); with status and method it fills the 51-column message column, so the server message always goes on a continuation line | `server/server.ts` |
| Narrowest | 40 columns in `tty-narrow.txt`; 375 px phone for the cockpit switcher in `switcher.html` | – |

## 13. Acceptance criteria

The analysis’s AC-01 … AC-14 stand, with these changes and additions for decisions 2 and 3.

| ID | Criterion a tester can check |
|---|---|
| AC-01 (changed) | With one `XEZ_HOME`, `xez` in repo A and `xez` in repo B start two instances on two ports; each cockpit serves only its project and shows the other as a running link; `xez mcp` in each repo reaches its own project. |
| AC-03 (changed) | Precedence follows § 8 exactly, including skipping (`multi-instance.md` § 4) and not remembering `--port 0`. |
| AC-05 (changed) | A second `xez` in a running project exits 1 with the B1 or B2 message, opens no port and changes nothing on disk. |
| AC-08 (changed) | At 80 columns in a PTY the output matches `tty.txt` scene by scene (text and order; times and ids aside); at 40 it matches `tty-narrow.txt`. |
| AC-09 (changed) | Off a TTY the output matches `non-tty.txt`: no byte in 0x1B, one event per line, logfmt parses. `--quiet` matches `quiet.txt`. |
| D-AC-1 | With `NO_COLOR=1`, every state in `tty.txt` is still named by a word; no line differs from the coloured one except for escape codes. |
| D-AC-2 | Every string in § 9.1 appears as written (placeholders aside); sentence case, ` — `, `…`, curly quotes. |
| D-AC-3 | The G2 title in `error-cases.txt` prints as one line with no escape byte, and a title with U+202E prints without it. |
| D-AC-4 | The switcher in `switcher.html` states (running link, running address unknown, not running, folder missing, checking, check failed, hosted) each render with their own words, in light and dark, with no sideways scroll at 375 px. |
| D-AC-5 | `--instance workspace` restores in-place opening for every project not running elsewhere; `XEZ_SINGLE_PROJECT=1` hides other projects in both modes. |

## 14. Open decisions

Questions for the review are in `open-questions.md` (Q-1 … Q-12). Departures from the design system and from the analysis, each with its reason:

| Departure | Reason |
|---|---|
| A terminal surface has no tokens; colours map to token roles instead (§ 9.2) | ANSI colours are chosen by the person’s terminal theme; hex values would override it |
| `running` and `monitoring` are cyan (`--info` role), not `violet` as in `lib/attention.ts:120,123` | The cockpit tells `running` from `needs review` (both `violet`) by the pulse and the bucket. A terminal has no pulse and no motion (§ 11), so with magenta for both the only difference would be the word. Cyan keeps a second cue. Q-6 carries the terminal colour role in the shared status map |
| `needs permission` is yellow, not `violet` as in `lib/attention.ts` | Same reason: it waits for a person, like `needs you`, and must not look like `running` or `needs review` without a pulse |
| Level words (`info`, `warn`, `error`) are new status vocabulary | The cockpit has no log levels; they are lower case like its status words |
| The `fix` label in refusals | Mirrors the cockpit’s “Fix:” line in `mcp-leader-control.tsx` |
| Output mode `plain` added beside the analysis’s `auto/lines/rich` | Separates human lines (usable in a file) from machine lines |
| `--port 0` not remembered | Q-4 |
| Port skipping | Q-5 |
| The analysis kept the shared cockpit as default | Replaced by owner decision 2 |
| **§ 6.1's boot banner is not what PR 3 ships.** The terminal still prints the pre-#467 banner — `xezar v<version> — <path>`, `branch <branch>`, one `✓` line per agent and tool, then `cockpit → <url>` — instead of the three-block compact form above | PR 3's own scope pins the `serve` **stdout** contract, and the `cockpit → <url>` spelling is parsed by two test files inside `packages/xezar/src/mcp/`, a directory PR 3 was told not to edit while #460 PR 3 is in flight. Everything § 6.2 to § 6.4 covers — the activity lines, the live region and the session summary, all on stderr — IS shipped. The banner needs its own change, with the eight call sites that read `cockpit → ` updated in the same commit; it is listed as a follow-up on PR 3 rather than done badly here |

## 15. Delivery plan

1. **This PR** – design only, `needs-design`, `skip-qa` (mockups only).
2. **PR 2** – settings, ports, registry lock, `xez projects port`, BC and env docs. `needs-qa`.
3. **PR 3** – event sources, renderer, HTTP diagnostics. `needs-design` by hand (Q-12), `needs-qa` with terminal QA at 80 and 40 columns in light and dark terminals.
4. **PR 3b** – cockpit switcher and the projects `instance?` field. `needs-design`, `needs-qa`.
5. **PR 4** – MCP reconciliation (#450, #460) and guides (#448).

## 16. Risks

| Risk | Mitigation |
|---|---|
| Per-instance limits overload a machine (Q-3) | Start line naming other running instances; follow-up for a lease |
| Saved bookmarklets point at a port; ports that move break them | Port memory and skipping keep ports stable; `xez projects port` pins one |
| Two instances lose each other’s registry writes | Cross-process merge lock for every writer (AC-04) |
| A person upgrades and wonders where the other projects went | Links, not hiding; CHANGELOG “Breaking defaults”; `--instance workspace` |
| Terminal injection through agent or GitHub text | One sanitizer, § 10.5, tested per rule (AC-11) |
| Redraw flicker or debris on resize | Region-only redraw in one write, debounced resize, narrow mode never wraps its region |
| Output volume hides a failure | Folding applies to info only; errors are never folded |
| Screen readers read the redrawn table | `--output lines` and `TERM=dumb`; documented |
| Log meaning drifts from the MCP event catalog | Reuse catalog names; reconcile with #460 before PR 3 |

## 17. References

- Issue #467 and the accepted analysis `.local/erfana-lens-reports/cli-terminal-ports-spec.md` (revision 1, 2026-09-15).
- `AGENTS.md` § Zero config, § Workspace registry, CLI entry row; `BACKWARD_COMPATIBILITY.md` § 1, § 2, § 9, § Single-project workspace mode; `SDLC.md` § The design gate.
- `docs/design-system/README.md` rules 7, 8 and 10; `writing.md` §§ 1, 7, 9, 12; `foundations.md` colour roles; `patterns.md` § 2.
- Source at `bb271fc`: `packages/xezar/src/index.ts`, `mcp/index.ts`, `mcp/bridge.ts`, `mcp/ipc.ts`, `mcp/service.ts`, `mcp/event-catalog.ts`, `runs/project-writer.ts`, `workspace/projects-cli.ts`, `workspace/config.ts`, `packages/web/src/lib/attention.ts`, `components/app-shell-container.tsx`.
- NO_COLOR convention: https://no-color.org/ – not re-read for this design (unverified here); the analysis cites picocolors’ README and manifest, read 2026-09-15.
- Related issues: #447 (SDLC policy), #448 (guides), #450 (MCP attach and push), #460 (significance and verdicts).

## 18. Design review

Round 1 (`ec2b935`, FAIL): B-1 one dim rule (§ 9.2); B-2 terminal colour departure for `running`/`monitoring` (§ 14, Q-6); B-3 failed counts are task outcomes only (§ 6.3). Non-blocking NB-1 … NB-8 addressed in §§ 6.3, 7, 9, 9.1, 9.2, 10.2, 11, 14, `open-questions.md` Q-2 and `switcher.html`. Round 2 pending.

### PR 3 review response: bounded follow-ups

The PR #505 response preserves the accepted AC-01–AC-14 frame. These non-blocking
review findings remain proposed follow-ups under issue #467, not independent acceptance:

- NB-1: success green and project bold remain with the compact-banner/colour follow-up; state words remain readable and unchanged.
- NB-2: recovery-settled outcomes and `task.recovered` need a separate distinction between historical recovery and new outcomes; suppressing transient recovery failures remains mandatory (AC-06).
- NB-5: retaining the closing quote on a width-truncated activity message remains a copy/layout follow-up; sanitization and bounded widths remain mandatory.
- NB-6: accepting explicit `--output plain` belongs to the settings-contract follow-up; this response preserves the existing flag vocabulary and records the unshipped design option.
- NB-10: sharing terminal/cockpit status words through the contract remains scope owed by issue #467; current labels agree, but this response does not claim the shared vocabulary shipped.

The unchanged stdout banner also retains its port-note position and lacks the staged loading
banner; both stay with the previously declared § 6.1 follow-up. QA and design must re-review
the delivered head; these dispositions do not clear either gate.
