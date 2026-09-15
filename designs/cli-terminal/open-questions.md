# Open questions for the design review

Each question has the options, the trade-off and a recommendation. The three owner decisions of 2026-09-16 (picocolors plus our own renderer; one cockpit per project by default; remembered ports and live activity on stderr as defaults) are settled and not reopened here.

The review settles each one as **accepted**, **changed to …** or **owner decides**. Only Q-1, Q-3 and Q-9 look like owner calls; the rest are design calls the review can make.

## Q-1 How long does `--instance workspace` stay?

The old model (one cockpit opens every project) stays as an opt-in so that a person who liked it has a way back.

| Option | Cost | Benefit |
|---|---|---|
| A. Keep it for at least one minor release, then decide from use | Two navigation paths in the cockpit for a while; tests for both | Satisfies the BC rule for a changed default: a way back, then a planned removal |
| B. Keep it for good | Two models to maintain forever; every cross-project feature asks “which mode?” | Nobody is ever forced |
| C. Do not ship it | Least code | No way back; breaks the BC path for a changed default |

**Recommendation: A.** Re-decide at the release after next with a real count of who uses it.

## Q-2 “Start in terminal” for a project that is not running

`multi-instance.md` § 6. The cockpit can show the command to copy, or also open a terminal that runs it.

| Option | Cost | Benefit |
|---|---|---|
| A. “Start in terminal” and “Copy command”, local mode only | A project-scoped sibling of the existing task handoff `POST /runs/:id/open-in-cli`; 409 in hosted mode like every local-machine action | One click, and the new cockpit’s activity is visible in its own terminal – which is what the owner asked for |
| B. “Copy command” only | Nothing new | A person must find a terminal and paste |
| C. Start the other instance in the background | A hidden process to manage; widens what a browser click can spawn | No terminal needed |

**Recommendation: A.** C goes against § Zero config (“no process to manage”).

## Q-3 Resource limits across instances

`resources.maxParallel` and the memory ceiling are enforced inside one process. Three instances can each run their full allowance.

| Option | Cost | Benefit |
|---|---|---|
| A. Ship per-instance limits, say so in the docs and print one start line when other instances are running (“2 other xezar cockpits are running — each applies its own limit of 4 tasks”) | A person can overload the machine | Small, honest, ships with the rest |
| B. A cross-process lease in `~/.xezar/` before this ships | New locking with crash recovery; the hardest part of the change | The documented “workspace-wide” limit stays true |
| C. Divide the limit by the number of running instances | Surprising; changes as instances come and go | Roughly bounded |

**Recommendation: A now, B as a follow-up issue** filed with the implementation PR. This is an owner call because it changes what a stored setting means.

## Q-4 Remember the port of a `--port 0` start?

The analysis (§ 6(e)) remembers it. This design does not.

**Recommendation: do not remember.** `--port 0` means “any port”. Remembering 53122 turns the next plain `xez` into a start at a random high port, and test harnesses that use `--port 0` would fill the registry with them.

## Q-5 Skip ports other projects remember?

`multi-instance.md` § 4. Without skipping, two projects that are not always both running swap ports, which breaks bookmarks and saved bookmarklets.

**Recommendation: skip** when the start port came from memory or the default, never when a person set it.

## Q-6 One status vocabulary for the terminal and the cockpit

Design-system rule 7: status words come from `packages/web/src/lib/attention.ts`. The server cannot import the web package.

| Option | Cost | Benefit |
|---|---|---|
| A. Move the run-status → word map to `packages/contract` (Node-free), and have both `attention.ts` and the terminal renderer read it | One move; `attention.ts` keeps tone and pulse | One source of the words, as rule 7 intends |
| B. Copy the words into the server with a parity test | Two copies | No change to the web package |

**Recommendation: A.** `design-system/README.md` rule 7 and `components.md` get a sentence naming the new home.

## Q-7 The global Tasks page in project mode

`GET /api/v1/workspace/runs-index` today reads every project’s store. In project mode an instance owns one store.

| Option | Cost | Benefit |
|---|---|---|
| A. This project’s tasks, then “Other projects run in their own cockpits.” with links | A narrowing of a route’s answer, named in the BC entry | Honest; no reach into another process’s data |
| B. Read other projects’ `runs.json` read-only from disk | Stale, and races the owner’s writes | A cross-project overview stays |
| C. Ask each running instance over HTTP and merge | New client code, timeouts, partial pages | A live overview |

**Recommendation: A**, with C as a possible follow-up if the overview is missed.

## Q-8 Theme flash on a new port

Each port is its own browser origin. The pre-paint script reads a per-origin copy of theme, accent and density, so the first visit to a new instance can paint the default theme for one frame before `ui-state.json` arrives.

| Option | Cost | Benefit |
|---|---|---|
| A. Accept one frame on the first visit per port | A flash once per new port | Nothing new |
| B. Carry theme, accent and density in the link query (`?appearance=`) from the switcher | Link grammar; the pre-paint script reads one more source | No flash when arriving from another cockpit |

**Recommendation: A**, recorded as a `known-gaps.md` entry when the implementation lands.

## Q-9 How a person sets the stored terminal defaults

`cli.output`, `cli.color`, `cli.logLevel`, `cli.instance` and `projects[].cli.port` are stored keys. The design adds `xez projects port`. Nothing else writes the `cli` keys: a person edits `~/.xezar/config.json` or uses the flag or env.

The owner rule of 2026-09-16 says a new cockpit capability must also be reachable through the MCP. These are terminal settings, not cockpit capabilities, but the reviewer should confirm that reading.

| Option | Cost | Benefit |
|---|---|---|
| A. Flags, env and the file; `xez projects port` only | Editing JSON for a lasting preference | Smallest surface; no new UI or MCP action |
| B. Also a Settings → Terminal section in the cockpit and a `project_config` MCP action | A settings page, contract fields and an MCP action for something that only matters in a terminal | Discoverable |

**Recommendation: A.** Owner confirms the MCP-parity reading.

## Q-10 Plain output format

| Option | Cost | Benefit |
|---|---|---|
| A. logfmt (`key=value`) | Not a formal standard | Readable by a person and by grep; common in log tools |
| B. JSON lines | Hard to read in a terminal | Strict, typed |
| C. Both: `plain` is logfmt, a later `json` value adds JSON lines | One more value later | Neither reader loses |

**Recommendation: A now**, C when someone asks. `--output` already takes a value, so adding `json` later is additive.

## Q-11 The boot banner: stdout or stderr?

The owner said live activity goes to stderr. The banner and the cockpit URL are on stdout today.

**Recommendation: keep the banner on stdout.** `xez | tee` users and scripts that read the URL keep working. Everything after the banner goes to stderr.

## Q-12 The design gate for the implementation PRs

SDLC.md § The design gate says a diff under `packages/xezar/**` alone is not UI in scope, so PR 3 (the renderer) would not get `needs-design` automatically. This design is only useful if the renderer is reviewed against it.

**Recommendation:** the implementation PRs carry `needs-design` by hand, citing this folder. A change to the SDLC definition goes through #447, not through this design.
