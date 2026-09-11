# Unreleased

## 🐛 Fixes
- 🐛 **Secret redaction is no longer defeated by a change of case.** The credential shapes were
  matched in one case only, so a lower-cased AWS key id (which loses nothing by being lower-cased)
  or an upper-cased GitHub, Slack, GitLab or Google token passed straight into run transcripts,
  the MCP audit trail, the event journal, automation logs and MCP tool responses. The shapes now
  match in any case, except the two whose prefix in another case is ordinary text (`sk-`, which
  ends `TASK-` branch names, and `github_pat_`, which is also an env var name). The host's own
  secret values now match in any case and in their URL-encoded form. (#272)
- 🐛 **A laptop that changes networks no longer locks the cockpit out of its own data.** A
  writer claim records the hostname that wrote it, and a dead PID was reclaimable only when that
  hostname still matched — so renaming a machine (`.local` to `.lan` on a different network is
  enough) turned the machine's own leftover claim into a `foreign-host writer claim` that only a
  hand-deleted runtime file could clear. A claim now also carries an opaque, hashed **platform
  machine id**, and when that id matches, the recorded hostname is display-only. No file to create,
  migrate or repair: the id is read from the host (`IOPlatformUUID`, `/etc/machine-id`,
  `MachineGuid`), and a host that cannot identify itself falls back to exactly today's hostname
  rule. The change is one-way — identity can turn a refusal into a reclaim, never the reverse — so
  a genuinely foreign live claim is refused exactly as before, and that one-way promise is about
  the scan of OTHER processes' claims. The second place the hostname was load-bearing — a process
  re-checking its OWN claim — is fixed differently rather than by the same rule: it now identifies
  a claim by process id and machine and never by hostname at all, so a laptop that changes network
  while `xez serve` is running no longer refuses itself, and a host that cannot name itself falls
  back to the process id alone. Claims already on disk
  keep their old meaning, which means one stale claim may still block once after upgrading; the
  refusal now names the file, both hostnames and the PID so clearing it is one obvious step. (#199)
- 🐛 **A shut-down `RunManager` can no longer be writing into a data root its owner has
  finished with.** `enforceRetention` was fired as an untracked promise, so `dispose()` could
  resolve while a worktree-retention sweep was still spawning `git worktree remove` inside the
  repository — the guarantee `dispose()` documents, missing at one of its call sites. The sweep is
  now enrolled in the set `dispose()` awaits, re-checks the disposed flag before it spawns and
  again before every directory it removes, and `pump()` stops after dispose instead of re-arming
  from records the teardown just cleared. Removing a project from Settings gets the same
  guarantee end to end: tearing a project context down now waits for its manager before closing
  the store, and `DELETE /projects/:id` waits for that — previously the promise was dropped, so
  a sweep could still stamp records into a store nobody owned and a quick re-add could see stale
  state overwrite fresh. A new `quiesce()` (cancel everything live, wait for the bodies, then
  dispose) is the stop-then-dispose helper several tests were hand-rolling three different ways;
  while it drains, the scheduler starts nothing new, and a run that has been accepted but has not
  registered yet — the window a Continue spends re-materializing its worktree — can now be
  cancelled instead of running an agent turn nobody could stop. Two visible consequences of that
  window counting as active: `Cancel` reports `cancelled: true` for a task caught mid-Continue
  where it used to report `false` and do nothing, and Create PR, Remove worktree, Delete and Pick
  variant refuse for the few hundred milliseconds it lasts instead of acting on a task that is
  rebuilding its worktree. Removing a project also answers within a few seconds now even when the
  git it is waiting on is wedged, rather than leaving the request hanging. (#200)
- 🐛 **Cancel now stops a task that is in the middle of starting its agent, instead of leaving
  it running for good.** For the fraction of a second between a step beginning and its agent
  session actually being up, `Cancel` marked the task cancelled and then reached a session that
  did not exist yet — so nothing was delivered. The agent started anyway, and because a cancelled
  task is not allowed to hand the ball back to you, the task neither finished nor parked: it sat
  there running, with a live agent process, until the cockpit was restarted. The cancellation is
  now handed to the session the instant it comes up, so the task stops within milliseconds
  whichever side of that line the click lands on. Same hole, same fix, for a task resumed with
  Continue. It also unwedges teardown: closing a project (or a test's cleanup) waits for the tasks
  it just cancelled, and one undeliverable cancellation was enough to make that wait never end —
  reproduced as a 90-second timeout on CI. (#199)

- 🐛 **`xezar run` finishes when the task finishes, instead of sitting there for another
  minute.** The headless run printed `run done` and then stayed alive — up to 60 seconds — because
  the background team-skills cache warm it had kicked off was still waiting on `git clone`/`git
  fetch` over the network, and a running git child holds the process open. The command already
  had its answer and had already declined to use that clone's result, so the wait bought nothing
  and, on a slow network, looked exactly like a hang. A remote git started by the skills cache no
  longer keeps a process alive past its own work; a clone that is still running when a one-shot
  command is done is dropped and re-attempted next time, leaving no half-built cache behind. The
  cockpit (`xezar serve`) is unaffected — it stays up for the whole clone as before — and nothing
  about the command's exit code changes. (#249)
- 🐛 **Removing a project while it is still opening now actually removes it.** Opening a project
  crosses several steps — its store, a worktree sweep, crash recovery — and a removal that landed
  inside that window tore down nothing, because teardown only knew about projects that had
  finished opening. The half-open project then finished and installed itself anyway, so every
  screen and API route for the removed project kept working on top of an open store this process
  still owned. A project that is opening is now tracked as belonging to a specific registration:
  if it is removed first, the work in progress is closed instead of published, and if it is removed
  and added again, the new one gets its own fresh state rather than inheriting the old one's.
  Removing also waits for an opening project to finish before checking for running tasks, so a
  project that is at that moment resuming tasks after a restart is refused with the usual "finish
  them first" message instead of being removed out from under them. (#200)

- 🐛 **`auto-resume.test.ts` stopped deleting its own repository out from under two live
  runs.** `startedAt` is stamped before `getRepoInfo`, `createWorktree` and the agent spawn, so a
  poll that waits for it returns with runs still mid-spawn; the teardown then raced `git worktree
  add` and failed as `ENOTEMPTY` in its own cleanup. Teardown now cancels, drains, disposes,
  flushes and only then removes — and when a run is still live it leaks the temp directory and
  fails saying so, rather than letting the delete report a fault it did not cause. The queue-hold
  assertion also gained the settle guard its mirror already had. (#200)

## 📝 Specs & Documentation
- 📝 **The MCP server has a reviewable API reference.** `docs/features/mcp-server/mcp-api.md`
  lists every tool, its arguments (the schema's own descriptions), the results each tool really
  returns — including where the tools' status words disagree — the two meanings of `origin`, and
  the rules each call follows, with links to the decision records. `mcp-api.json` beside it is
  exactly what `tools/list` answers, for diffing and JSON Schema viewers. A new traceability table
  maps every `covered` inventory record to the tool action that serves it, checked both ways. The
  tables and the JSON are regenerated from the real tool registry, so a tool change that is not
  reflected in the reference fails `npm test`. (#261)

# 0.13.1 (2026-09-10)

## Highlights
Continuing a task restores its Active visibility and preserves accepted messages and attachments
when worktree recovery fails. Isolated tasks refuse to continue in the primary checkout if their
worktree cannot be recovered. This release also improves validation execution, expands regression
coverage, and restores a guard against drift in the cockpit's event protocol types.

## 🐛 Fixes
- 🐛 **Task continuation preserves visibility, isolation and accepted input.** Continuing an
  archived task restores Active visibility. Tasks with recorded isolation stop before backend
  startup if their worktree cannot be recovered, while accepted continuation text and attachments
  remain in history. Explicit monitoring uses its timer and steering paths in both fresh and
  continued sessions. The project gate runner also overlaps dependency-safe checks while retaining
  complete failure and cancellation evidence; synthetic infrastructure fixtures run in required CI.
  Role, recovery and release guidance now makes delivery and evidence boundaries explicit. (#189)

## 📝 Specs & Documentation
- 📝 **Transport QA and integration lessons are retained in the project log.** The condensed
  report preserves the previously published OpenCode timeout measurements, gate-completion and
  merged-tree checks, and the limits of that QA. A suspected process kill is explicitly unconfirmed;
  these are historical observations, not new runtime changes or model qualification. (#191)

## 🚀 CI/CD & Infrastructure
- 🚀 **Regression coverage expands across sixteen server and cockpit files.** Tests exercise
  UI controls, task views, workflow screens, server installation, GitHub operations and skill
  discovery. The coverage gap analysis was remeasured, and a documentation audit corrected stale
  installation, API, protocol and development guidance without changing application behavior. (#188)
- 🚀 **The API client's UI-event mirror is checked against the server contract.** Type checks
  cover all 34 protocol exports, including optional-property drift; an export-inventory test requires
  new types to be mirrored and added to the comparison. The two copies already agreed, so this
  restores a missing regression guard rather than changing event shapes. (#190, #192)

---

## 🐛 Fixes
- 🐛 **The opencode runner no longer picks its own port — and it finally tells you why a
  server did not start.** It drew one random port in 40000–60000 with no probe and no retry, so a
  port that was already taken killed the child and reported `opencode serve exited before it
  started listening` with no port, no code and no reason. `opencode serve` has handled this itself
  all along: `--port 0` prefers 4096 and falls back to a free ephemeral port, and the runner
  already reads the bound URL back from stdout. So the draw is gone rather than replaced. The
  child's stderr is now folded into both start-failure messages, the way the Codex and Claude
  runners already did, and the 30-second window rejects with what happened instead of resolving a
  URL nothing is listening on. (#184)
- 🐛 **Two cockpit browser specs stopped racing their own data.** `settings-agents.e2e.ts`
  navigated to `/settings/agents` from `/settings/agents`, where every predicate about the section
  is equally true of the page being left — so a cold load could assert against the outgoing
  document and count 0 checked radios. `gotoAgents()` now waits for a marker only the incoming
  document carries, and the base-branch case waits for the branch list that `GET /api/v1/repo`
  fills instead of reading an option that may not exist yet. No sleeps, no relaxed assertions.
  (#183)

# 0.13.0 (2026-09-10)

## Highlights
Two user-visible changes lead this one. Six engine limits that the code already enforced but
nobody could reach are now settings in the running cockpit, and the memory guard **ships on** —
with no configuration at all xezar derives a ceiling from your machine's RAM and pauses a run
that crosses it, where before it left the OS OOM-killer to do that job. Both task tables also
gained a **Tool Name** and a **Model** column, so a list finally answers "what ran this, and on
which model?" without opening a task. The rest is a long run of fixes at the agent seam and a
coverage epic that closed twenty gaps.

## ✨ Features
- ✨ **Six engine limits are adjustable from the running cockpit.** The idle timeout that closes a
  parked `waiting` session (`resources.idleTimeoutMinutes`, default 15, or *Never*), the default
  worktree retention new projects inherit, the follow-up Inbox switch and the agent env-passthrough
  list all became stored settings in `~/.xezar/config.json` with controls in Settings → Resources,
  and `plannerModel`, `namerModel` and `skillsRepos` gained controls in Settings → Agents. The two
  that used to be read from the environment only at boot (`XEZ_FOLLOWUPS`, `XEZ_ENV_PASSTHROUGH`)
  now follow the stored value when one is set — a plain restart no longer loses your Inbox. Every
  one takes effect on the next run with no restart, through the existing
  `WorkspaceSemaphore.refresh()` hook rather than a second reload path. (#146)
- ✨ **Both task tables show the tool and the model each task ran on.** Two new columns after
  Workflow, visible by default: the backend's product name (`Claude Code`, `Codex`, `OpenCode`,
  `pi`) and the model string the run actually used, printed **verbatim** — no catalog, no friendly
  name, so a model on your own hardware reads exactly as the run recorded it. A value nobody chose
  is shown muted, and a missing model reads `auto`. A workflow that used more than one backend
  reads `Claude Code +1`. On a phone the same two facts sit on the task card. (#146)
- ✨ **A workflow step can set its own wall clock.** `timeout:` on an agent step takes the literal
  `none` or a duration in `s`, `m` or `h`. Absent stays a protected default: the last interactive
  step is uncapped and every earlier agent step keeps the runner's 30-minute deadline. (#22, #40)

## 🔧 Changed
- 🔧 **The per-task memory guard now ships on.** An absent `resources.memoryLimitMb` used to mean
  "no guard at all". It now derives a host-sized ceiling — `floor(totalMiB * 0.6 / 2)` clamped to
  1024–8192 MiB — so an upgraded install starts pausing runs it previously let the OS kill. An
  explicit `"memoryLimitMb": null` still means *no limit* and is never replaced. Adjust it in
  Settings → Resources. (#146)

## 🐛 Fixes
- 🐛 **One process owns a project's task state.** A second server refuses before recovering another live server's tasks, including nested and symlink-equivalent paths. Dead owners recover automatically. Audited incident corrections can exclude exact erroneous history records from display while preserving the original append-only evidence. (#185)
- 🐛 **A failed page leaves the cockpit navigation available.** A route rendering error now
  displays a recovery message with a retry button. Opening another page also recovers without
  remounting the shell and its global subscriptions. (#50)
- 🐛 **Slow OpenCode fallback turns can finish past five minutes.** Blocking prompt requests use
  Node HTTP transport with cancellation controlled by the run. Real-model QA reproduced the old
  failure at 301 seconds and a complete seven-file result at 457 seconds with the fix. (#153, #178)
- 🐛 **A repo's own `memoryLimitMb` is honoured again.** It had become the one outcome a setting
  must never have: it saved successfully and then did nothing. A repo that sets its own value now
  overrides the workspace ceiling for its own runs, the same more-specific-wins lookup the parallel
  cap already used. (#146)
- 🐛 **pi's wall-clock timeout escalates to SIGKILL, like every other backend.** On expiry pi sent
  one SIGTERM and waited, so a step's `timeout:` was enforced for Claude, Codex and OpenCode and
  merely advisory for pi. (#146)
- 🐛 **pi's streamed text no longer splits a turn-end marker across events.** Text is coalesced per
  completed message, the way Codex and OpenCode already did, so a marker stays contiguous and
  parses. (#151, #163)
- 🐛 **pi's models are discovered from its own config**, rather than reported as unavailable. (#152, #157)
- 🐛 **The autonomous keep-going nudge fires on new, continued and recovered runs.** It previously
  fired nowhere: the initial turn-end handler lacked the call, while continuation state lacked
  the flag. Both paths now use the same helper. (#141, #159)
- 🐛 **Accept is never lost at the review gate.** The turn is torn down before `review` is
  published, closing a race that could drop the acceptance. (#155, #160)
- 🐛 **The queue watchdog settles its rescue in `dispose()`**, so a shutdown cannot leave a rescued
  run half-handled. (#125, #158)
- 🐛 **XEZ markers inside fenced code blocks are ignored.** An agent quoting a marker in a code
  fence no longer triggers it. (#124, #149)
- 🐛 **`gh` unavailable with an empty token now says so, with a hint**, instead of reporting a
  confusing detection failure. (#127, #150)
- 🐛 **A CLI killed from outside xezar now names the signal.** A `128 + signal` exit the runner did
  not cause used to surface as a bare exit code. It now says which signal, and that xezar sent
  none — so another process or the OS did. The known cause is an unscoped `pkill -f` from a peer
  agent: xezar passes a skill's whole text as one `--append-system-prompt` argument, so a pattern
  that appears in any skill matches every agent running it. Five agents were killed mid-review that
  way. The project kit and all 16 of its skills now ban pattern kills outright. (#156, #167)
- 🐛 **pi records an output-cap stop, and says when a turn produced nothing**, instead of ending
  silently. (#164, #166)

## 📝 Specs & Documentation
- 📝 **The documentation was resynced with the code, twice.** The second sweep corrected statements
  that had become false: `AGENTS.md` and `BACKWARD_COMPATIBILITY.md` both still said a repo's
  `memoryLimitMb` was ignored, the README called the memory ceiling optional and said pi waits on a
  timeout, and `packages/api-client/README.md` advertised hand-written DTOs that no longer exist and
  an export that never did. `AGENT_PROTOCOL.md` gained the obligation whose absence let pi's
  timeout ship as advisory: a wall-clock deadline MUST escalate SIGTERM→SIGKILL, and the two
  constraints that had lived only in a code comment. (#146, 653d31f)
- 📝 **Business requirements recorded for the Tasks view and the Inbox default.** Both are
  requirements, not implemented features. (#64, #66)
- 📝 **The SDLC label taxonomy was trimmed to the labels the repository actually has.** (#39, #65)
- 📝 **The PR #40 integration task's observations were added to the dogfooding ledger.** (#41)

## 🚀 CI/CD & Infrastructure
- 🚀 **Remote installer refusal paths have additional offline tests.** Cancellation, rejected
  credentials, incompatible hosts, root execution and existing proxy ownership are covered;
  recursive server-install branch coverage exceeds 70%. macOS installer tests keep generated
  launch-agent files inside their temporary fixture home. (#56)
- 🚀 **Twenty coverage gaps closed.** A measured audit (`docs/testing/coverage-gaps.md`, plus a
  `test:coverage` script writing to `.local/coverage/`) ranked what the gates could not see, and
  the epic worked through it: `packages/contract` became a vitest project so a test written there
  actually runs, `xezar init` and `xezar serve` gained CLI-level tests, and coverage arrived for
  `server/git.ts`, the workflow loader, the skills catalog routes, `POST /plan`, `GET /launch-key`,
  backend detection, `createRunner` dispatch, the handoff journal, `skills-remote`'s degradation
  paths, update-check, the planner, the cockpit boot shell, the Commits tab, the enabled
  automations route, and the `server-install` and `server-deploy` argument surfaces. The OpenCode
  runner's teardown test now drives its golden mock server instead of a mocked `node:child_process`.
  Tracked as epic #42 and its twenty child issues (#43–#62), delivered by #63 and
  #120–#144 and #154.
- 🚀 **Vitest worker fan-out is capped** at `min(4, availableParallelism() - 1)`. Vitest's default
  is per *run*, so several concurrent gate runs on one machine meant roughly 180 worker processes
  and unrelated suites timing out at 909s — starvation that reads as flakiness. The cap is a
  deliberate no-op on CI's smaller runners, and `--maxWorkers=N` and `VITEST_MAX_WORKERS` still
  override it. (#146)
- 🚀 **The browser suite pins itself to one worker, and defends that pin.** `VITEST_MAX_WORKERS` is
  applied at the very end of vitest's config resolution, so it outranks both `fileParallelism: false`
  and `--no-file-parallelism`. For this suite that is a correctness break rather than a speed
  choice — the specs share one server and one set of on-disk fixtures, and several rewrite state
  global to all of it, which is the shape behind four rounds of failures in files the change under
  test never touched. The e2e config now deletes the variable, and a unit test fails if that stops
  working. Export it for `npm test` freely; it no longer reaches `npm run test:e2e`. (#162, #169)
- 🚀 **Browser e2e specs made host-independent**, and the commit spec now waits for the committed
  screen rather than the address bar. (#133, #136, #145, #148)

---

# 0.11.2 (2026-09-09)

## Highlights
A small release from the second day of developing Xezar with Xezar. The one user-visible fix is
OpenCode: a local or LAN model that is configured but carries no stored credentials is now
recognised as **Configured** instead of being reported as disconnected, so Connect stops opening
a login terminal you do not need. The rest is maintainer-facing — the project kit gains a
`release` workflow that runs a whole release as one Xezar task, and the UI-leader pilot prompt
gains its launch procedure, waiting pattern and a written scenario evaluation.

## ✨ Features
- ✨ **A whole release runs as one Xezar task.** The project kit gains a `release` workflow that
  takes a one-line brief (`bump: patch`, optionally `version:` and `dry-run: true`): it derives
  the `# <version> (<date>)` changelog section from the pull requests merged since the last `v*`
  tag, folds every stray `# Unreleased` section into it, runs the canonical gates, merges the
  changelog PR, dispatches the existing Release workflow once and merges the bot's bump PR. A new
  `changelog-check.sh` refuses a changelog with more than one `# Unreleased` heading or one placed
  below a dated release, which is the mistake the 0.11.1 release had to repair by hand. Kit and
  documentation only — no engine source, no package manifest and no change to
  `.github/workflows/`; nothing publishes outside the manually dispatched Release run. (#31, #33)

## 🐛 Fixes
- 🐛 **OpenCode recognizes configured local/LAN models without stored credentials.**
  When `opencode auth list` reports no credentials, xezar checks `opencode models`
  before marking the provider disconnected. A recognized model avoids an unnecessary
  `opencode auth login` terminal, and the Providers card says **Configured** instead
  of **Credentials found**. Failed discovery remains unverified; authentication
  rejections from actual tasks still override the configuration check. (#34)

## 📝 Specs & Documentation
- 📝 **The UI-leader pilot prompt records how to launch the cockpit and how to wait on it.**
  `docs/prompts/claude-code-ui-leader-prompt.md` gains a startup inventory, a sourced tool
  comparison with a model-tier routing matrix, a checkpoint format, and a "Reliable browser
  operation and waiting" section describing the cockpit launch procedure and the bounded
  background-watcher pattern used in the 2026-09-09 dogfooding session. Documentation only. (#35)
- 📝 **The UI-leader pilot prompt has a written scenario evaluation.**
  `docs/features/builtin-project-leader/claude-code-ui-leader-evaluation.md` records 26 review
  fixtures against the prompt's own clauses. Every row is marked *static-covered* and *not-run*:
  it states which instruction addresses each expected decision, not that any model has followed
  it, and the pilot guide keeps the procedure for a live run. Documentation only. (dfb690e)

---

# 0.11.1 (2026-09-09)

## Highlights
A bug-fix release from the first day of developing Xezar with Xezar. The user-visible fixes are
the new-task composer keeping a brief that was written straight into the textarea and honouring
the highlighted picker row on Enter, a task no longer binding itself to a GitHub issue on a
passing `#N` mention, and the canonical test gate passing inside a task worktree. The one
addition is `--version` / `-v` on the CLI.

## ✨ Features
- ✨ **`--version` / `-v` prints the installed package version.** Both the `xezar` and `xez`
  commands accept the flag; it prints the bare version to stdout and exits 0, and it runs before
  any repository or `~/.xezar` lookup, so it works outside a git repository too. `--help` lists
  it and the flag inventory in `BACKWARD_COMPATIBILITY.md` records it. (#21)

## 🐛 Fixes
- 🐛 **The new-task composer keeps a brief that was written straight into the textarea.** Text
  set on the element by a browser automation tool (Chrome DevTools' `fill` past its typing
  threshold), a form filler or an extension never reached the draft: the box showed it, Start
  stayed disabled, and the next re-render — picking a skill or workflow — wiped it. The composer
  now honours the native `input` event too, so the brief lands in the draft and survives any
  later pick. Typing key by key was never affected. (#14, #26)
- 🐛 **Enter in the skill/workflow picker commits the row shown as highlighted.** The picker now
  owns its highlight, clamps it to the rows currently listed after every filter change, and
  commits Enter from that same state instead of asking the DOM which row carries
  `aria-selected` at that instant; a second Enter landing during the close animation no longer
  toggles the pick back off. (#15, #26)
- 🐛 **A task is bound to a GitHub issue only on an explicit reference.** An issue URL anywhere
  in the brief, a worded reference such as `issue #N` in its opening line, or a GitHub closing
  keyword (`Closes #N`, `Fixes #N`, `Resolves #N`) still binds the task; a passing `#N` mention
  anywhere else in the text no longer does, so a brief that says "another task (issue #6) is
  editing it" stays unbound instead of attaching itself to issue 6. (#25)
- 🐛 **The om-* skill pack finds its pipeline config and tracker descriptor again.** 0.11.0 moved
  `.ai/agentic.config.json` into `.xezar/` and dropped `.ai/trackers/github.md`, but the pack's
  skills hard-code those `.ai/` paths, so every om-* skill failed to find them. Both files are
  back where the pack reads them, with the `tracker` key restored; everything Xezar-owned stays
  in `.xezar/`. (#24)
- 🐛 **The canonical test gate now passes inside a xezar task worktree.** The shared test
  bootstrap pinned scratch to `<repo>/.local/test-tmp`, so when the checkout under test was itself
  a task worktree (`…/.local/xezar/worktrees/<runId>/`) every temp repo the tests created sat
  under that ancestor and the workspace registry's guard refused to register it — 18 tests in
  `npm test` and one in `npm run test:package` failed with 400 or exit 1 on every dogfooding
  task, while CI in a plain checkout stayed green. Only in that case does scratch now move to a
  per-checkout `xezar-test-tmp-<hash>` directory under the OS temp dir, with the same Git ceiling
  and per-fixture cleanup; a normal checkout keeps its in-repo scratch and the registration guard
  is untouched. Test infrastructure only; the published package does not carry it. (#19, #23)
- 🐛 **The unit-test gate passes inside a task worktree on macOS.** The #19 change moved the
  unit-test scratch dir to the OS temp dir inside a worktree, which exposed two test bugs:
  `cli-version.test.ts` spawned the CLI with a bare `--import tsx` that cannot resolve from a
  directory with no `node_modules` above it, and the main-module guard in
  `scripts/migrate-local-state.mjs` compared a symlinked `argv[1]` (`/var/folders`) with the
  real-path `import.meta.url` (`/private/var/folders`) and silently skipped the CLI block. The
  loader is now resolved to an absolute URL and the guard compares real paths; a guard test
  invokes the script through an explicit symlink so Linux CI pins it too. Test infrastructure
  only. (#27, #29)

## 📝 Specs & Documentation
- 📝 **`AGENTS.md`, `CODE_REVIEW.md` and `README.md` describe the review gate, worktree
  isolation and the API surface as the code actually behaves.** The review gate is optional and
  off by default (the Settings → Agents toggle wins, otherwise only `XEZ_REVIEW_GATE=1` turns it
  on, and autonomous runs always skip it); a git task that asks for isolation fails closed rather
  than falling back to your checkout; and every route lives under `/api/v1`, validated through
  the middleware trio with schemas in `packages/contract`. No runtime, default or contract
  change. (#20)

## 🚀 CI/CD & Infrastructure
- 🚀 **`coverage/` is git-ignored.** The kit's worktree preflight requires test-coverage output
  to be ignored, because the cockpit autosave runs `git add -A` and would otherwise commit it into
  the task branch; the root `.gitignore` did not cover it, so every writing workflow in this
  repository failed at its preflight step before doing any work. (#16)

---

# Renamed to Xezar (2026-09-08)

**Cezar is now Xezar.** Same tool, new identity: published as
[`@qodeca/xezar`](https://www.npmjs.com/package/@qodeca/xezar) from
[`qodeca/xezar`](https://github.com/qodeca/xezar), providing the `xezar` and `xez` commands.

```bash
npm install -g @qodeca/xezar
```

Xezar is an **independent application**, not an upgrade of Cezar. It keeps its own state —
`~/.xezar/`, `.ai/xezar/`, `~/.cache/xez/` — and never reads, moves or deletes anything Cezar
owns. An existing Cezar install keeps working, untouched, side by side.

Everything a user has to change is listed in
[BACKWARD_COMPATIBILITY.md → "The Xezar rename"](BACKWARD_COMPATIBILITY.md#the-xezar-rename--a-deliberate-clean-break-0101).
The short version:

- `CEZ_*` environment variables are now `XEZ_*` (see `.env.example`).
- Agent markers `CEZ:DONE` / `CEZ:ASK` / … are now `XEZ:DONE` / `XEZ:ASK` / … — update any skill
  or prompt that emits them.
- Cockpit browser preferences (theme, accent, density, sidebar width, unsent drafts) reset once,
  because they live under new storage keys.
- Copy your history across by hand if you want it: `cp -R ~/.cezar/ ~/.xezar/` and
  `cp -R .ai/cezar/ .ai/xezar/`. Both are plain files.

Also in this release: the unscoped `cezar-cli` alias package is retired — there is now exactly
one published package — and automatic npm publishing (PR previews, `develop` snapshots and the
nightly channel) is gone. Releases are manual, owner-triggered and go straight to `latest`; see
[docs/publishing.md](docs/publishing.md).

> **About the entries below.** Everything under this line was written while the product was
> called Cezar, published first as `@pat-lewczuk/cezar` and then as `@open-mercato/cezar` with
> the unscoped `cezar-cli` alias. Those names are left exactly as they were written. A changelog
> records what actually shipped, and renaming it retroactively would make it describe releases
> that never existed. The old packages remain on npm, unchanged.

---

# 0.11.0 (2026-09-09)

## Highlights
**The project layout moved, and the old one is no longer read.** A project's maintained kit now
lives in `.xezar/` and its run state in `.local/xezar/`. Each is exactly one directory: no
discovery step, no per-file overlay, no fallback. A repository that still holds only the old
`.ai/xezar/` starts with default settings and an empty run history — nothing there is deleted,
moved or rewritten, so the files stay on disk and can be moved by hand.

**This is the one thing to read before upgrading.** If you have an existing project, move its
files across before you start 0.11.0; the table is in
[docs/project-layout.md](docs/project-layout.md), and the contract note is in
[BACKWARD_COMPATIBILITY.md § 3](BACKWARD_COMPATIBILITY.md).

## 💥 Breaking
- 💥 **`.ai/xezar/` is not read any more — not as a kit, not as a run store.** Configuration,
  workflows, skills, checks and guidance are read from `.xezar/`; runs, worktrees, scratch,
  todos, UI state, the launch key and automations from `.local/xezar/`. The `migrate-layout`
  command that used to move an old project is gone with its journal and its `--offline` flag, so
  moving is a manual step now. Move maintained files into `.xezar/` and run state into
  `.local/xezar/`; registered task worktrees must move through `git worktree move` so their Git
  metadata stays valid. Nothing in the old directory is touched, so a mistaken move is
  recoverable by copying again. (#11)

## 🔧 Changed
- 🔧 **One blanket ignore rule instead of a maintained list.** Everything the engine writes now
  lives under `.local/`, so startup keeps a single `*` rule in `.local/.gitignore` rather than
  appending each new state file to an ignore file inside the data directory. A new run-data file
  can no longer be forgotten there. (#11)
- 🔧 **A launch in your home directory can no longer overwrite your global settings.** When the
  project kit path would collide with the per-user `~/.xezar/` workspace directory, it resolves
  to that launch's own `.local/xezar/kit` instead. The per-user registry, preferences and agent
  accounts are unaffected by any of this and do not move. (#11)

---

# 0.10.2 (2026-09-08)

## Highlights
One shipped change: xezar now honours **`OPENCODE_CONFIG_DIR`** when it looks for OpenCode's
config, ahead of the XDG fallback. Everything else in this release is test infrastructure and
documentation, which the published package does not carry.

## 🔧 Changed
- 🔧 **`OPENCODE_CONFIG_DIR` is honoured for OpenCode's config dir.** `agentHomePaths()` checked
  only `$XDG_CONFIG_HOME/opencode`, falling back to `~/.config/opencode`. It now checks
  OpenCode's own variable first. Nothing changes for anyone who has not set it — the XDG lookup
  and the `~/.config/opencode` default are unchanged and still apply in that order — so this is
  additive. It matters because `XDG_CONFIG_HOME` is machine-wide: pointing it somewhere to move
  one agent's config relocates every XDG-aware tool in the process, which inside xezar's own e2e
  boot deauthenticated `gh` and hid the developer's global git config. The narrow variable moves
  OpenCode's config and nothing else. Note it moves **config only** — OpenCode keeps credentials
  in `~/.local/share/opencode` — which is exactly why it remains unusable for Agent accounts, a
  distinction `src/core/agent-profiles.ts` documents and this change does not disturb. (#7)

## 🚀 CI/CD & Infrastructure
- 🚀 **The e2e boot no longer reads the developer's own agent settings.** The cockpit seeds each
  runner's model from that agent's native settings file by design, and the test environment
  pinned only `XEZ_HOME` — what xezar *writes*. So a developer with OpenCode configured booted
  the suite with their own model pre-filled, and `settings-agents.e2e.ts` failed on their machine
  while passing in CI, where nobody is logged in. `test-env-up.sh` now also pins
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `OPENCODE_CONFIG_DIR` at an empty 0700 sandbox under
  `.ai/qa/agent-home/`, wiped on every cold boot, and unsets `ANTHROPIC_MODEL`, which outranks
  every settings file. The pins are part of the reuse fingerprint (`environment.agentHome`), so an
  instance booted with different pins is never reused — without that, switching branches served
  the stale un-isolated process for the rest of the TTL and the fix looked like it had not worked.
  Project- and local-scope config in the repo is deliberately still not isolated; `AGENTS.md`
  states the guarantee and its limits. (#7)
- 🚀 **The Release workflow can publish.** `0.10.2` is the first release it has ever cut: `0.10.1`
  went out by hand under the bootstrap exception, so the first dispatch was also the first time
  the pipeline ran end to end, and two faults surfaced that nothing earlier could have caught.
  The release tests inherited `ACTIONS_ID_TOKEN_REQUEST_URL`, which `scripts/release.mjs` reads as
  proof npm can mint a token; that variable exists only in a job holding `id-token: write`, so the
  fixtures believed they were authenticated and offered a dummy package to the real registry,
  failing the gate on its own harness. It is blanked now, alongside the credentials the helper
  already hid, with the one OIDC case opting back in explicitly. Separately, the package's trusted
  publisher had never been created despite `docs/publishing.md` recording that it had — that guide
  now says so plainly, and documents the `Allow npm publish` permission whose absence produces a
  404 that reads as if the package did not exist. (#9)

---

# 0.10.1 (2026-09-04)

## Highlights
The cockpit gets easier to live in on a phone and harder to be wrong about. **Pinned tasks** keep
the two or three you're actively working on at the top of the list, a follow-up can be sent to a
**different Claude login** than the one that started it, and the composer now takes **PDF, TXT and
MD** files the same way it's always taken a screenshot. The Claude model picker reads from **your
own CLI** instead of a hand-written list, and a run's reference chips get several correctness
passes: a conflicting PR now says so, a task can no longer borrow another repository's pull request
as its own, and a stale review request or an "Update branch" click can no longer paint over a real
rejection.

## ✨ Features
- ✨ **Pin the two or three tasks you are actually living in.** The task list is sorted by what
  happens next, which is the right default and a bad fit for a long-running task you keep coming
  back to: it sinks under every newer run, and a finished-but-unmerged one drops into `Recent` and
  then out of the sidebar's ten-row budget entirely. A task can now be pinned — from the sidebar
  row (the control appears on hover, and stays lit once pinned), the Tasks table row, the mobile
  card, or the thread header beside Archive — and pinned tasks gather in a **Pinned** group above
  `Needs you`, first in that project's table too. A pinned task appears there once and nowhere
  else, keeps its status and attention dots so one that wants you still says so, and is never
  evicted by the sidebar's ten-row cap: the ten rows still go to the other groups, so pinning
  three tasks cannot hide what needs you. Pins are per task and therefore per project — pinning in
  one repo changes nothing in another — and archiving a task unpins it, because archiving is how
  you resign from one. The group is absent entirely when nothing is pinned. `POST
  /api/v1/runs/:id/pin` is a new additive route with the archive route's exact semantics (no body
  pins, `{pinned:false}` unpins) answering the updated record, and `runs.json` gained optional
  `pinned`/`pinnedAt` keys that unpinning deletes rather than writes as `false` — so a record
  written before this, or unpinned after it, is byte-identical to what an older cezar wrote.
  Cross-project pins on the global All-tasks page and in the ⌘K palette are a follow-up. (fixes
  #935) (#938)
- ✨ **Continue a task on another agent account, not just another agent.** The thread's Continue
  carried a runner pill that could switch `claude → codex` but never offered the second Claude
  login the new-task composer has offered since accounts landed — so "finish this one on my other
  account" was sayable only when a task was created. It is the same flat control now, in both
  places: `claude · Default`, `claude · Klaudiusz`, `codex` — one row per thing that can actually
  run the work, each naming the folder it resolves to. The row selected until you pick another is
  the account this run is ON (the step that spawned recorded it), not the project's current
  setting, so switching a project's account never relabels work it did not do. Picking another
  login starts a fresh session rather than resuming: a session id only resolves inside the config
  dir that created it, and `claude --resume` under a different login would silently open an empty
  conversation. A host with one agent and one login sees exactly the composer it always saw.
  `POST /api/v1/runs/:id/continue` gained an optional `agentProfile`; an id that no longer exists
  is a 400, matching `POST /api/v1/runs`. (#924)
- ✨ **The composer takes a PDF, TXT or MD file the same way it already takes a screenshot.**
  Paperclip, ⌘V and drag-drop all used to either grey the file out or silently discard it, and the
  wire would have refused it regardless (`mediaType: /^image\//`). Every attachment-carrying route
  now widens the same `images` field to accept `application/pdf`, `text/plain` and
  `text/markdown`/`text/x-markdown` alongside images — the agent is handed the file's on-disk
  **path**, never its bytes — and a format cezar won't take is now refused out loud, naming the
  file, instead of vanishing without a word. An attachment with nothing to preview renders as a
  named chip, in the composer row and on the thread bubble alike. (fixes #950) (#951)

## 🐛 Fixes
- 🐛 **A question one closing brace short is now a card, not a wall of JSON.** An agent that ended
  its turn with a `CEZ:ASK` payload missing its final `}` — the single most common way a
  hand-written one-line JSON blob gets mangled, and what an output-token limit does to one — lost
  the whole question: no chips, ~760 characters of raw JSON left in the transcript, and a grey
  footnote where a three-option card should have been. The task still parked at Needs you, so it
  looked identical to a question that had never been asked. A bounded repair now sits under the
  schema: the payload is scanned for its unclosed `{` and `[`, the missing closers are appended,
  and the result goes through the **unchanged** validator. Only syntax is repaired, never
  semantics — a stream cut mid-string, after a comma or after a colon is still refused, so is a
  mismatched closer and an already-balanced payload that failed to parse for some other reason
  (a trailing comma), and a repair that yields fewer than two options still degrades to plain text
  exactly as before. A recovered card is never passed off as a clean one: the run records a note
  saying the question was recovered from an unbalanced payload and asking you to check that the
  options — and how many of them you may pick — match what was asked, and the raw marker is
  stripped along with the card it produced rather than left sitting under it. Because that note is
  the only trace a repair leaves, it renders in the danger tone rather than as the dimmest line in
  the thread. The two forgiveness layers now read as a pair — presentation drift (unknown keys, an
  over-long header) was already recovered above the parse; syntax drift is recovered below it.
  Relatedly, a question that IS lost outright no longer whispers either: its note gets the same
  treatment, and the marker contract agents receive now says in as many words that the JSON must
  be syntactically valid. (fixes #936) (#937)
- 🐛 **A pull request with merge conflicts no longer reads "ready to merge".** The chip's status
  answers *whose move is it* — `ready` means open, checks green, nobody waited on — and every word
  of that stays true of a branch GitHub is refusing to merge, so a conflicted PR sat there in
  ready-green with nothing on screen saying otherwise. Mergeability is now carried as its own axis
  (it rides the same batched GraphQL query, so it costs no extra request) and paints the chip that
  links to the PR in its own colour: orange, not the red that already means "checks failed" and
  "changes requested", with a warning glyph and a panel that leads with the conflict and still
  spells out the status underneath. Only a forge that actually answers `CONFLICTING` paints it —
  GitHub's still-computing `UNKNOWN`, an unreachable forge and a server too old to send the field
  all leave the chip exactly as it was, because none of them is an answer — and `UNKNOWN`, which
  is what GitHub says for the first seconds after every push while it computes the merge base, is
  now cached as the non-answer it is: such a reference is re-asked within seconds instead of being
  held for the usual minute, so a conflict shows up on its own rather than on a page reload. A
  push made through cezar drops what the forge told us about that task's pull requests for the
  same reason — it is the event that changes the answer. Every reference chip everywhere now opens
  the SAME panel — a popover driven by our own hover intent, so it can hold a control without
  costing the chip the tap and tab order a link is owed — and a conflicting one carries a
  **Resolve conflicts** button that sends the agent `Merge head branch and resolve
  conflicts in PR number N` on whichever seam the task's state allows — a live message, or a
  continue for a task parked at review, which is where a conflicting PR usually hangs. The number
  is in the words because a task can point at several pull requests, and each chip's button names
  its own. Offered on the task page, the Tasks table and cards, the sidebar, and the cross-project
  All tasks page alike — that last one fetches the task's record when the panel opens (its index
  row is deliberately too slim to say whether a finished task can be reopened) and sends through
  the run's OWN project rather than whichever one the page happens to be standing in. (#904)
- 🐛 **A task that opens its own PR keeps the chip for the PR it was working on.** A task started
  on someone else's PR that pushed a follow-up of its own showed only the new one: the agent
  re-declares `CEZ:PR` with the number it just opened, as the marker contract asks it to, and
  that declaration was applied to the *referenced* tier — which clears the chip when no candidate
  matches the declared number. A declaration naming the PR the run itself created is now read as
  what it is, a statement about the created PR (`pullRequestUrl` already carries it), so the PR
  the task is about survives it, as does the number the task came in with. Records already
  written this way heal when they are next read — no migration. The run header now paints every
  PR the task points at, too, instead of only the strongest one — including a PR known only by
  number, which it used to drop whenever it had no repository to build a link from. (#901)
- 🐛 **A task can no longer be credited with a PR it only read about.** cezar decides a task
  opened a PR by spotting `gh pr create` (or "opened a pull request") near a PR link — and it
  scanned tool *output* for that phrase, so a task that printed a log, a stored transcript, or a
  test fixture containing someone else's creation line adopted their PR as its own, in a
  different repository, permanently: the first PR adopted wins, so the real one that followed was
  never looked at. The phrase is now believed only from the agent's own words or from the command
  cezar saw run — the link itself may still come from the command's output, which is where `gh`
  prints it. And when a task declares a PR (`CEZ:PR`) that no scraped link corroborates, that
  declaration now leads the chips — so a PR picked up by mistake can no longer push the one the
  task actually named out of the single-chip surfaces. (#901)
- 🐛 **A reference chip on a task's own page links, in every project.** A PR or issue known only
  by number was a live link on All tasks and dead text on the task's page whenever the project
  was not the one cezar booted in: that page synthesized links from `/health`, which always
  reports the boot project's repository, so it refused to guess rather than point at the wrong
  repo (#526). It now reads the project registry's own per-project repository — the same source
  All tasks uses — and falls back to health only for the boot project. (#901)
- 🐛 **A pull request's own repository decides whether cezar trusts it, not just the URL.** A task
  could adopt a completely unrelated repository's pull request or issue as its own reference chip
  — a research task that cites one upstream PR in passing was enough to make that PR the task's
  identity. A referenced link is now vetoed unless it matches the project's own repository or is
  corroborated by the task's own prompt; the veto only ever removes a candidate, never adds one,
  and an already-poisoned record self-heals the next time it is read, no migration needed. (fixes
  #945) (#946)
- 🐛 **A stale review request, and GitHub's own "Update branch" merge, can no longer clear a real
  rejection.** A PR rejected by one reviewer while two others never looked showed "Waiting for
  review" instead of "Changes requested", because any pending review request was read as a
  re-request regardless of when it was made. A standing request now has to postdate the review it
  would answer, and a head commit that is itself a merge from `main` — what "Update branch"
  produces — no longer counts as the author pushing a fix. (#909)
- 🐛 **Opening another project's task from All tasks or the sidebar no longer 404s until you
  reload.** A soft navigation under React StrictMode could re-fire the thread's query before the
  project scope had settled, so the request landed on the wrong project's boot-time route, 404ed,
  and the cache held onto that miss under the correctly-scoped key. Both scope effects are now
  layout effects, settled before any request of the commit goes out. (#905)
- 🐛 **The Changes tab's file tree scrolls on its own.** With a lot of changed files, reaching the
  bottom of the tree meant dragging the whole diff down with it — the pane had no height cap and
  no scroller of its own. It now caps at the room left under the sticky chrome and scrolls
  independently, and a wheel that bottoms out in the tree no longer chains into the diff. (#918)
- 🐛 **The composer's skill picker can be cleared, and no longer haunts the next task.** Clicking
  the already-selected skill re-picked it instead of clearing it, the only real exit was an
  unlabeled `quick-task` row tucked under Workflows, and a skill picked once was silently
  preselected — and auto-run — for every task after it. "Nothing picked" is now a real state, with
  three ways back to it: an ✕ on the pill, clicking the selected row again, or the "No skill" row
  at the top of the list. A new task always starts with no skill picked. (#919)
- 🐛 **A resumed session keeps the tools its step was actually granted.** A Continue on a parked
  or closed run, restart recovery, and the usage-limit auto-resume all rebuilt the session with
  the default tool set, silently dropping any MCP servers or subagents the step declared — and,
  worse, un-restricting Bash whenever the step had scoped it down. The continuation now resolves
  its tools from the same persisted workflow definition the fresh run used. (#928)
- 🐛 **Typing a Polish letter in the composer no longer sends a canned reply.** On macOS, ⌥ is a
  character modifier, not a chord modifier: ⌥C types `ć` and also fired "Continue.", ⌥A typed `ą`
  and fired "Yes, approved.", swallowing the keystroke either way. The quick-reply shortcuts now
  stand down whenever an input, textarea or contenteditable has focus — the same rule ⌘K already
  follows. (#943)
- 🐛 **The Claude model picker lists what your own CLI actually offers.** It advertised a
  hand-written list of releases that goes stale the moment Anthropic ships anything newer — Opus 5
  was unreachable from the picker until now. Claude gets the same host-local discovery Codex
  already had; a missing, old, logged-out or slow CLI falls back to the previous presets rather
  than leaving an `auto`-only picker. (fixes #784) (#841)
- 🐛 **The GitHub tab's search finds an issue or PR whatever its state.** It only ever searched the
  open set, so a closed or merged item — the ones you're most often looking for — was invisible.
  (fixes #730) (#732)
- 🐛 **Mobile task history reclaims the screen space its chrome was taking.** Header, workflow row,
  dock and composer spacing are now compact on phones, without touching the desktop layout. (#764)
- 🐛 **The run header's metadata row collapses behind a disclosure on phones, not the whole page.**
  Workflow, branch, tracker references, diff stats, token usage and cost wrapped into three or
  four lines at 390px, pushing the transcript — the reason the screen exists — below the fold. The
  row now collapses by default below `md` and expands per run; the desktop header is untouched,
  and a self-resuming run's status pill stays visible outside the disclosure either way.
  Complements #764's scrolling header, which it is now rebased on top of. (fixes #765) (#873)
- 🐛 **A fresh task started with a `/skill` command actually runs it.** `/skill` expansion applied
  to a live reply and to a continuation's opening prompt, but not to a brand-new task's, so a
  skill visible in the Skills list answered "Unknown command" the first time it was ever used.
  (#947)

## 🚀 CI/CD & Infrastructure
- 🚀 **A CI re-run no longer fails the packaged-CLI e2e regardless of the diff.** The
  release-snapshot test asserts an exact version string, but let the workflow's own
  `GITHUB_RUN_ATTEMPT` leak into the child process it drives — so a second attempt stamped a `.2`
  suffix the hard-coded expectation never accounted for. The test environment now pins the attempt
  the same way it already pins the other CI-only variables. (#911)

## 👥 Contributors

- @pat-lewczuk
- @wojciechszyjka
- @piotrchabros
- @blabbler78
- @matgren
- @AGmakonts
- @patzick

# 0.10.0 (2026-08-14)

## Highlights
The cockpit stops being one-project-at-a-time: **All tasks** shows every registered repo's work
in a single filterable table, grouped by tags you give your repositories, and every PR or issue
chip in cezar now says where that PR or issue stands. Alongside that, **agent accounts** let one
project run on your work login and another on your personal one, `pi` joins claude, codex and
opencode as a runner, and a task killed by a provider usage limit resumes itself when the window
reopens.

## ⚠️ Breaking
- **GitHub Automations are now opt-in via `CEZ_AUTOMATIONS=1`.** They previously ran for any
  project with a GitHub remote, with no way to switch them off. Off — the default — every
  automations route answers `409` naming the flag and the scheduler never starts, so nothing
  polls GitHub and no run is launched on your behalf. `GET /api/v1/health` reports the new
  required `capabilities.automations`. (#801, #802)

## ✨ Features
- ✨ **All tasks: one table for every project, grouped by the repos that belong together.** Tag
  your repositories in **Settings → Projects** (`storefront`, `infra`, `client-acme`; the field
  autocompletes from tags already in use), then open **All tasks** — the new top sidebar item,
  `/tasks`, or `⌘K → All tasks` — to see every registered project's work in one table with its
  PR/issue chip and an archive button. Filter by tag, status and workflow (multi-select, ORed
  inside a facet and ANDed across, each option showing how many tasks it would leave), group by
  tag, and share the view: filters, grouping and the Active/Archived tab live in the URL. Tags
  are stored in `~/.cezar/config.json`, deduplicated case-insensitively, and read by nothing else
  in cezar — a tag is a lens, not a permission or a routing rule. `PATCH /api/v1/projects/:id`
  gained an optional `tags`; over ssh, `cezar projects tag <id> [<tag>…]` does the same thing.
  (#845)
- ✨ **A task's PR or issue chip now says where that PR or issue stands.** Every reference chip
  in the cockpit — sidebar rows, the per-project Tasks table, All tasks, the run header — carries
  the state of the thing it points at in three channels: colour (violet done, green fine, blue
  waiting on a reviewer, amber for a running build, red for anything wrong), a GitHub-vocabulary
  icon, and a tooltip that spells it out; the status reaches the chip's accessible name too. A PR
  reads as merged, closed, draft, changes requested, checks failing, checks running, waiting for
  review, or ready to merge — decided by *whose move it is*, which is what the colour encodes.
  "Changes requested" turns blue once the author has answered (cezar reads the pending
  re-request and the head commit's date) instead of blaming them for edits they already made.
  References resolve by number, so a `#774` filed as a PR still gets the right answer if it is an
  issue. Statuses are batched per project, cached server-side, remembered per reference for the
  tab's lifetime and across reloads, refreshed at a cadence the server sets (a merged PR is never
  re-asked; a hidden tab polls nothing), and dropped the moment cezar merges a PR itself. When
  there is nothing to show the chip stays neutral and says which kind of nothing on hover.
  Additive route: `GET /api/v1/github/ref-status?prs=&issues=`.
  (#871)
- ✨ **Agent accounts: run one project on your work login and another on your personal one.** The
  same CLI logged in twice (`CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`, or `CODEX_HOME` for
  Codex) is now something cezar can address. Add the config folder under **Settings → Agent
  accounts**, pick which account each project uses under **Settings → Agents**, and override it
  per task from the composer. Each account reports its own connection state and **Connect**, and
  "Open in → Claude CLI" hands the terminal the account that actually ran the work so `--resume`
  lands on the right conversation. **Show details** reveals the email, organization and plan, and
  opens that account's own `settings.json` / `CLAUDE.md` / `config.toml` / `AGENTS.md`. Identity
  is opt-in: nothing fetches an email until you expand a row. Zero-config is untouched — with one
  login there is no new control anywhere. Accounts live in `~/.cezar/agent-accounts.json`, so
  downgrading and upgrading cezar cannot lose them, and cezar never silently falls back to
  another account when the chosen one is unavailable. OpenCode is not supported yet: it keeps
  credentials outside its config folder.
- ✨ **Handing an issue or PR to the agent can pick which account runs it.** The GitHub tab's
  "Hand this to the agent" panel was the one start surface the agent-accounts work missed, so
  delegating an issue always ran on whatever the project's selection resolved to. It now offers
  the same runner/login rows as the composer, under the composer's rules: switching the agent
  drops the account and the model pin rather than carrying a foreign login along, switching only
  the account keeps the model, and an untouched pill still follows the project's selection
  instead of pinning it. One agent with one login sees no pill and sends exactly what it sent
  before. The Inbox card's ▶ Run is deliberately unchanged — its endpoint cannot carry an account
  yet, and offering a choice the server would drop is worse than not offering one. (#878)
- ✨ **`pi` is a fourth agent backend.** It drives a Claude-compatible headless stream-json
  session, so it reuses the proven session machinery (multi-turn stdin, EOF watchdog, wall-clock
  kill switch, normalized events) and differs only in the binary it spawns. Like opencode, it
  selects models with the canonical `provider/model` identity and has no default provider, so a
  bare model id fails loudly rather than silently defaulting. (#470)
- ✨ **A task killed by a provider usage limit resumes itself.** cezar reads the reset instant
  from the provider's own marker, parks the run with `autoResumeAt` = reset + 30s, and resumes it
  through the ordinary queued-continuation path — durable across restarts and self-healing if a
  timer is lost. With no instant to read, nothing is scheduled: guessing a window is a retry loop
  against a provider still refusing. (#778)
- ✨ **Long sessions load progressively.** History is paged from the server with bounded reads and
  hydrated as you scroll, instead of a long transcript blocking the thread on one giant payload.
  (#739)
- ✨ **Foldable task table columns.** Choose which columns the Tasks table shows; the choice is
  persisted per workspace. (#743)
- ✨ **A General page for the project you are inside** (`/p/<id>/settings`). Where the checkout
  is (with Copy and "Open with" for this machine's editors, file manager and terminal), what
  state its folder is in, how many of its tasks may run at once, and how to remove it — the last
  two previously reachable only from the global registry table in another settings area. (#772)
- ✨ **Readable task names in the sidebar quick-list.** The reference number is painted once, as a
  leading PR/issue chip that is itself the link, and the title has a width floor — metadata drops
  before the title truncates. (#789)
- ✨ **The agent badge shows the canonical model identity.** The normalized `provider/model` a run
  actually resolved to is now readable in the session header's agent disclosure, next to runner
  and account, and only when it says something the plain model name does not. (#546, #833)
- ✨ **Toasts animate in and out from the top right.** They no longer land on the thread's action
  row, and dismissal is two-phase so the exit transition actually runs. (#820)
- ✨ **Advanced users can opt out of repository-root run serialization.** Set the exact value
  `CEZ_DISABLE_REPO_LOCK=1` to let runs in the shared checkout overlap, including explicit
  `worktree=false` runs, non-Git degradation, and continuations whose worktree cannot be
  restored. The safe default is unchanged and isolated worktree runs are unaffected. This escape
  hatch is intentionally dangerous — concurrent agents can overwrite each other's files or Git
  state — so cezar shows a visible unsafe-mode note whenever it is active. (#762)

## 🐛 Fixes
- 🐛 **`npx cezar-cli` starts again.** The alias imported a subpath the scoped package's exports
  map does not expose, so Node rejected it with `ERR_PACKAGE_PATH_NOT_EXPORTED` and every launch
  died on startup. It imports the bare specifier now. (#851, #852)
- 🐛 **Killing a run really kills it.** `ChildProcess.killed` reports that a signal was
  *delivered*, not that the child died, and every agent CLI installs its own SIGTERM handler — so
  the SIGKILL escalation, gated on `!child.killed`, was skipped for exactly the child it exists
  for, and the process outlived teardown. Fixed in the agent-runner watchdogs and in OpenCode's.
  (#844, #857, #858, #867)
- 🐛 **The sidebar's Tools dot is green when cezar can actually start a task.** It went amber
  whenever any probed tool was missing, so a healthy host with only the optional codex/opencode
  runners absent looked permanently degraded and the tooltip asked for attention to tools nobody
  wanted. Amber now means no agent CLI at all, or the configured `defaultRunner` is the missing
  one; anything else is a choice not taken, which the per-row dot in the open menu already says.
  (#884)
- 🐛 **The settings gear and the theme toggle stay inside the sidebar on a nightly build.** A
  nightly's version string is long (`v0.9.2-nightly.20260813.1` against a release's `v0.9.2`) and
  the footer chip refused to give up a pixel, pushing the two buttons beside it out of the
  sidebar and over the page. The chip now yields: it shows as much of the version as fits and the
  whole of it on hover. (#879)
- 🐛 **A malformed history response degrades instead of throwing mid-render.** The two history
  fetchers returned an unvalidated body typed as if the server had been checked, so a 200 with an
  unexpected shape reached the hook, which iterated `page.events` and threw an uncaught
  `TypeError` — the documented full-replay fallback only fires on a rejected query, so it never
  ran. Both calls now validate at the client boundary. (#827, #863)
- 🐛 **A task's diff stat means something again.** The base was a branch *name* resolved once at
  worktree creation, which drifted, producing five-figure diffs for small changes
  (`+59514 −12160 / 927 files` for an 18-file change). It is now anchored at the freshest base
  and at the branch the task actually found. (#782)
- 🐛 **The global Tasks page reacts to work happening in other projects.** Events from other
  projects were dropped before reaching any cache, so `/tasks` — the one page that spans every
  project — ran on its 15-second poll alone, and that poll does not tick in a hidden tab. Those
  events now refresh the cross-project index (debounced), a reconnect reconciles it, and
  returning to the tab refetches. Scoped caches are untouched: another project's run still never
  lands in this project's list.
- 🐛 **A reference's status is shared across every surface again.** All tasks keyed each chip by
  its run's real project id while the sidebar, run header and per-project table used the
  `default` alias, so one pull request was remembered under two names. Every surface now names
  the project the same way.
- 🐛 **Opening the cockpit on your phone no longer rearranges it on your desktop.** Sidebar group
  collapse and the page a bare `/` restores were stored workspace-wide in `~/.cezar/ui-state.json`,
  so every open cockpit shared one answer. Both now live in each browser's own storage — zero
  requests per toggle, and the sidebar paints its real state on the first frame. The server keys
  stay accepted and round-tripped for older cockpits. (#786)
- 🐛 **Each task gets its own `TMPDIR`, preflighted.** Every agent inherited the host's temp
  directory, so all runs on a machine shared one — and when it stopped accepting writes the
  failure was silent (under `EDQUOT` the inode is allocated while the write fails, so a Bash
  command runs, lands its side effects, and the agent reads back nothing). (#785, #787)
- 🐛 **The composer reads git state from the project, not the folder cezar booted in.** Booting
  outside a git repo reported `repo: null` for every registered project: the Worktree chip
  vanished, variants were pinned to 1, every run posted `worktree: false`, and Push went dark.
  (#791, #792)
- 🐛 **The `/new` header follows the run mode the composer resolved**, instead of always claiming
  the run happens in an isolated worktree. (#793, #835)
- 🐛 **A `CEZ:MONITORING` run resumes on its own again**, and `/skill` expands on continuations.
  (#810, #811, #812)
- 🐛 **"Mark all read" no longer stamps a run that is waiting out a usage limit**, so the count it
  returns is the number the unread badge was showing. (#803, #834)
- 🐛 **A legacy `claude-cli` runner id in `runs.json` stays parseable.** The persisted enum had
  dropped it, and because the loader validates the whole array, one legacy record would have
  dropped every run in the file — the exact failure `BACKWARD_COMPATIBILITY.md` §3 warns about.
  (#547, #832)
- 🐛 **OpenCode models are discovered, not hard-coded.** cezar parses `opencode models` — strict
  `provider/model` matching so a banner never becomes a picker entry, an empty listing meaning
  "no provider configured" rather than a failure, and bounded output, size and deadline. (#799)
- 🐛 **Answers to an Ask reach the agent through idle teardown.** (#758)
- 🐛 **`server-install` refuses to uninstall a registered project again.** (#535, #790)
- 🐛 **`npm test` no longer opens a real Terminal window.** Every launcher now goes through its
  injectable seam. (#824, #825)

## 🔧 Changed
- Dropped the unused `KNOWN_PROVIDERS` export. (#548, #831)

## 🚀 CI/CD & Infrastructure
- 🚀 **`npx cezar-cli@nightly` is always the trunk.** A nightly workflow verifies main (typecheck,
  unit suites, build, packaged-CLI e2e) at 03:17 UTC and publishes it under the `nightly`
  dist-tag; a scheduled run skips itself when main has not moved in 24h. The channel is reachable
  only by asking for it by name, and only from main. (#876)
- 🚀 Allow releasing from `release/*` branches. (#780)
- 🚀 Synchronize the repository-root lease test instead of racing a timer. (#797, #800)
- 🚀 Stop the JetBrains launcher case racing a real process. (#823, #862)
- 🚀 Give the health-topic probe waits a realistic budget. (#701, #733)

## 📝 Specs & Documentation
- 📝 Design spec for publishable Cezar React components. (#710)
- 📝 Spec for linked-PR chips on the GitHub Issues list. (#816)
- 📝 Disambiguate cezar (OSS) from the hosted team SaaS. (#883)
- 📝 Add the missing root `LICENSE` file (MIT). (#796)

## 👥 Contributors

- @pat-lewczuk
- @patzick
- @pkarw
- @wojciechszyjka
- @andrzejewsky
- @sheeerth
- @sapersky
- @dominikpalatynski

# 0.9.2 (2026-08-04)

## ⚠️ Breaking
- **The HTTP API moved to `/api/v1`.** Every route answers under `/api/v1/…` (project-scoped:
  `/api/v1/p/<projectId>/…`) and the WebSocket bus is `/api/v1/ws`; the unversioned `/api/*`
  spelling is gone. The bundled cockpit ships in lockstep, so a normal upgrade needs nothing from
  you — this only matters if you script the API directly, where the fix is adding `/v1`.
  `GET /api/v1/health` is still the CORS-open discovery endpoint, historical run transcripts keep
  rendering (old image URLs are upgraded when read), and saved bookmarklets are unaffected.
  Versioning is what lets the typed client describe the whole surface and makes a future `v2` an
  additive mount rather than an edit to every route.

## ✨ Features
- ✨ **The two mixed-format routes do real HTTP content negotiation.** `GET /api/v1/repo/commit/:sha`
  (legacy text blob or structured commit payload) and `GET /api/v1/runs/:id/files` (JSON listing or
  an image's raw bytes) now honour the request's `Accept` header, answer `Vary: Accept`, and set a
  `Content-Type` confirming what they actually sent. Purely additive: the `?structured=`/`?raw=`
  flags still decide whenever the request carries one, `*/*` (what `fetch` and `curl` send) is read
  as "no preference" and keeps each route's existing default, so every current caller's answer is
  byte-identical. What is new is that a client that really does ask — an `<img>`, a browser
  navigation — gets the other representation without the flag, under the same allowlist, size cap
  and sandbox CSP as before.
- ✨ **Finished tasks now carry a read/unread marker (#767).** A done or failed run you have not
  opened since it finished reads as *unread* — its row is promoted (brighter, semibold) and wears a
  small trailing violet dot — while everything you have already seen dims back. The Tasks nav item
  shows how many are unread, opening a task's thread clears it, and a "Mark all read" sweep clears
  the lot. Unread is a deliberately separate channel from the status dot, which keeps saying
  done/failed, so "what happened" and "have I seen it" never collapse into one signal.

- ✨ **⌘K searches the whole workspace, not just the project you are standing in.** The palette
  now lists your **projects** — recency-ordered like the sidebar, the active one last — so
  switching is a keystroke, and it finds **tasks in any project**, each row labelled with the
  project it belongs to. That is backed by one new workspace-level route,
  `GET /api/v1/workspace/runs-index`, which answers a deliberately slim row per run instead of the
  full record: it never builds a project context, so reading it cannot prune worktrees or resume
  interrupted runs — typing in a search box must not restart agents. Projects this process has
  never opened are read straight off `runs.json`, sharing `RunStore`'s own reconciliation so a
  crashed process's `running` row reads as interrupted here exactly as it would once opened.
  The palette also opens on **New task** (one row now, not three scattered copies) followed by
  **Recently finished** — the tasks you have not opened since they finished, the same signal
  behind the Tasks badge. Ranking is substring-based rather than cmdk's fuzzy subsequence, because
  a run id is a uuid and typing a task number used to match stray digits inside unrelated ids
  ahead of the task actually named that; searching also folds the sections into one ranked list so
  a near-miss can never sit above an exact hit. The dialog is wider on wider screens, taller on
  taller ones, and anchored near the top so it no longer jumps as results come and go.

## 🔧 Changed
- Every mutating route is now visible to the typed client, `POST /api/v1/todos/:id/start` included.
  Its body used to be parsed inside the handler to keep "unknown id 404s before the body is
  validated"; a small existence guard registered *before* the body validator keeps that status
  order while the body becomes part of the route type. A bodyless POST still 201s and a malformed
  one still 400s.
- **Validation errors (`400 {error}`) are worded differently and now name the field.** Two causes:
  zod 4 rewrote its default messages (`Required` → `Invalid input: expected string, received
  undefined`), and each issue is now prefixed with its path — `task: must be at most 100000
  characters` where it used to be `task must be at most 100000 characters` for a handful of fields
  and an unattributed sentence for the rest. **The `{ error: string }` shape and the 400 status are
  unchanged**, and the message was never a pinned contract (BACKWARD_COMPATIBILITY.md §2 pins the
  shape, not the text) — but a script matching on the exact wording will need updating, and the
  cockpit shows the new text verbatim in its toasts.
- Every mutating route now validates its body as route middleware rather than inside the handler,
  and the query string / path params of 17 more routes are validated too. Behaviour is unchanged
  by design, including the tolerant cases (a body sent without a JSON content-type, a malformed
  body, and a repeated query key such as `?refresh=1&refresh=1`, which still takes the first
  value). The point is that the typed client can now check request bodies, params and queries at
  compile time.

## 🐛 Fixes
- 🐛 **Running the test suite no longer wipes your project registry.** A merge-write resolved
  `~/.cezar/config.json` twice — once to read, once to write, after the `await` — and
  `cezarHomeDir()` re-reads `CEZ_HOME` on every call, so a test that lost its sandbox pin
  mid-flight (a timeout was enough) read the temp home and wrote the real one, replacing every
  project with the fixture's. The path is now resolved once per merge-write, the whole server
  suite runs with `CEZ_HOME` pinned to a per-worker sandbox, and a write into the real `~/.cezar`
  from a vitest process is refused outright. The same one-path fix lands in the `ui-state.json` twin.
- 🐛 **The registry survives a lost config file.** Every merge-write that leaves projects behind
  also writes `~/.cezar/config.json.bak`, and cezar restores from that snapshot when the config
  file is missing, empty, or corrupt. Removing `~/.cezar` still resets cezar completely; removing
  only `config.json` no longer loses the project list. A config that parses and is simply empty is
  left alone — that is a user who removed their last project, not a lost registry.
- 🐛 **Structured questions render as a form, not raw JSON (#757).** When an agent asked a
  structured question, the Ask card could fall back to printing the raw JSON payload; it now renders
  the real question with its options, and long question text wraps instead of overflowing.
- 🐛 **Subagent sessions render like the main thread (#756).** A subagent's transcript now goes
  through the same session renderer as the top-level thread, so its messages, tools and reasoning
  look identical instead of a stripped-down variant.
- 🐛 **The task diff stat stops counting a repointed HEAD's branch (#751).** When a task's worktree
  HEAD was repointed onto another branch, the ± diff stat folded in that branch's whole history; it
  is now anchored at HEAD so it counts only the task's own changes, and the Changes tab says so when
  a repointed HEAD has narrowed what it shows.

## 👥 Contributors

- @pkarw
- @pat-lewczuk
- @patzick
- @andrzejewsky
- @sheeerth
- @wojciechszyjka

# 0.9.1 (2026-07-24)

## Highlights
A stabilization release that hardens single-project mode and sharpens the cockpit. Project edits and the registry are now correctly gated and isolated when `CEZ_SINGLE_PROJECT` is set (#625, #626), the diff and task commit list are virtualized for snappier scrolling on large runs (#599), and browser tabs finally carry project-aware titles (#543). Codex sessions read more clearly with labeled image-view tool calls and context compaction (#593, #596), while streamed deltas coalesce into whole text events (#633). A batch of run-fidelity fixes keeps task titles, issue-number provenance, and tool issue links accurate (#623, #539, #538).

## ✨ Features
- ✨ Project-aware browser page titles (fixes #543). (#592) *(@pkarw)*

## 🐛 Fixes
- ⚡ **Settings → Agent accounts opens instantly.** The account listing used to probe every agent's
  login while you waited — one CLI shell-out per agent plus one per account, 2.5s on a machine with
  four accounts. Which login an agent uses is operating knowledge that changes only when you run
  `claude auth login`, so cezar now warms every account — extra logins included — once at boot and
  keeps it in memory instead of re-probing every few seconds; the listing serves what it holds and never spawns anything (the rule
  `/api/v1/health` already follows). A *disconnected* answer is still re-checked within seconds,
  because that one blocks starting a run — so logging in from a terminal is not punished with a
  ten-minute wait. Same machine, same accounts: 2.5s → 12ms.
- **An added agent account can now be signed in from cezar.** The account row grows Connect and
  Check again; Connect opens a terminal aimed at that account's config dir rather than the default
  one. Previously the pane pointed at a Connect button that did not exist.
- **A task now says which agent, account and model produced it**, as text in the header
  (`claude · Klaudiusz · opus`) rather than hidden behind an icon; the account is the one the step actually spawned under, so a resumed
  task reports the login that owns its session rather than whatever the project is set to now.
- ✨ **Settings → Agent accounts now sets the default agent, account and models once, not per repo.**
  A project that has chosen nothing now follows the machine-wide default — and a project that HAS
  chosen is never moved by changing it, so a global tweak cannot quietly re-point work you already
  configured. Models merge per agent, so pinning one repo's Claude model keeps the machine's Codex
  preset.
- **Settings → Agents picks the default agent and its account in one click.** "Default runner" and
  the separate account picker were two fields answering one question; they are now a single flat
  list — `claude · Default`, `claude · Klaudiusz`, `codex` — matching the composer. The runner still
  goes to the repo's committable config and the account to your machine only, so a teammate keeps
  their own. With no extra logins it is the control it always was.
- **The composer's runner pill now lists agents and logins as one flat list** — `claude · Default`,
  `claude · Klaudiusz`, `codex` — instead of a separate account pill beside it. Every row is a
  concrete thing that can run the task, so which subscription it will bill is readable without
  opening anything. It starts on whatever the repo is set to and any row overrides it for that task
  alone. An agent with one login stays one row, so a machine with no extra accounts sees the list it
  always saw.
- **fix(server): `GET /api/v1/providers/status` no longer stalls for ~1–3s whenever its cache
  lapses.** It shares the same knowledge as the accounts listing and had the same problem from the
  other side: any provider you are not signed into pulled the whole response onto a five-second
  window, so one reader in every five seconds paid for three CLI spawns. Reads are now
  stale-while-revalidate (what `/api/v1/health` already does) and the run gate re-checks a provider
  before refusing to start a run, instead of the cache being kept young to protect it. Measured on
  the built server: reads that alternated between 3ms and 817ms are now 1–7ms across every cache
  window, while "Check again" (`?refresh=1`) still blocks for the real answer.
- 🐛 **`CLAUDE_CONFIG_DIR` is honoured.** A host that relocates Claude Code's config folder was
  invisible to the Agent config pane, which kept showing `~/.claude`. Related: the MCP listing read
  `~/.claude.json` from the wrong place under an override — that file is a *sibling* of the default
  folder but lives *inside* a relocated one.
- 🐛 **`CEZ_CLAUDE_BIN` counts as "installed".** The environment probe hardcoded a bare `claude`,
  unlike every other call site, so a host whose only install is at a custom path reported Claude as
  missing — dropping it from the composer and the installer's dependency step even though runs
  would have worked.
- ⚡ Virtualize the diff and the task commit list. (#599) *(@patzick)*
- 🐛 Repair concatenated task titles (fixes #623). (#627) *(@pkarw)*
- 🐛 Prevent single-project registry leak (fixes #626). (#629) *(@pkarw)*
- 🔐 Gate project edits in single-project mode (fixes #625). (#630) *(@pkarw)*
- 🐛 Label Codex image view tool calls (fixes #593). (#631) *(@pkarw)*
- 🐛 Keep the composer's runner and model aligned. (#632) *(@pkarw)*
- 🔄 Coalesce codex/opencode streamed deltas into whole v1 text events. (#633) *(@pkarw)*
- 🐛 Link per-project resource limits (fixes #634). (#635) *(@pkarw)*
- 🐛 Preserve task title message boundaries. (#636) *(@pkarw)*
- 🐛 Label Codex context compaction (fixes #596). (#639) *(@pkarw)*
- 🐛 Avoid boot slug collisions (fixes #558). (#641) *(@pkarw)*
- 🐛 Track issue number provenance (fixes #539). (#642) *(@pkarw)*
- 🐛 Keep tool issue links display-only (fixes #538). (#643) *(@pkarw)*
- 🐛 Auto-refresh the team-repo cache so codex reviews use current skills. (#644) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Document `CEZ_SINGLE_PROJECT` mode. (#597) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Pin `CEZ_HOME` in specs that boot their own server. (#619) *(@pat-lewczuk)*
- 🚀 Cover detached launcher lifecycle (fixes #574). (#640) *(@pkarw)*

## 👥 Contributors

- @pkarw
- @patzick
- @pat-lewczuk

# 0.9.0 (2026-07-21)

## Highlights
<!-- TODO: Highlights — auto-update-changelog leaves this blank for the human author to fill in. -->

## ✨ Features
- ✨ Edit the coding agents' own config files (global vs local, raw + highlighted). (#418) *(@pkarw)*
- ✨ Canonical provider/model identity shared across runners (fixes #405). (#466) *(@pat-lewczuk)*
- ✨ Runner + model selection for the Continue flow (fixes #401). (#468) *(@pat-lewczuk)*
- ✨ AskUser structured questions across claude, codex & opencode (fixes #473). (#502) *(@pkarw)*
- ✨ Multi-project workspace — per-user registry, project-scoped cockpit, config migrations (fixes #520). (#521) *(@pkarw)*
- ✨ Discover PR/issue refs from skill report lines and GitHub links. (#534) *(@pkarw)*
- ✨ Grouped sub-agent display — Agents dock + drill-down sheet (fixes #474). (#550) *(@pkarw)*
- ✨ Render full timeline (commits, labels, merges) with per-commit CI markers (fixes #525). (#552) *(@pkarw)*
- ✨ Stack, edit and remove prompt messages on a queued run (fixes #472). (#553) *(@pkarw)*
- ✨ Link clone root to project settings (fixes #561). (#571) *(@pkarw)*
- ✨ Separate browse and checkout roots. (#572) *(@pkarw)*

## 🔒 Security
- 🔒 Guard the localhost API against CSRF and DNS rebinding (fixes #426). (#467) *(@pat-lewczuk)*

## 🐛 Fixes
- 📦 Never push a release commit to protected main. (#514) *(@pat-lewczuk)*
- 🔄 Stop GitHub nav item flickering — stale-while-revalidate forge probe. (#516) *(@pat-lewczuk)*
- 🔄 Resolve a stale local base ref to `origin/<base>` to stop phantom diffs. (#518) *(@pat-lewczuk)*
- 🐛 Skill pickers order most-used → project → global (fixes #519). (#523) *(@pkarw)*
- 🐛 Label Skill and Agent tool rows in the Session tab (fixes #529). (#532) *(@pkarw)*
- 🐛 Name the autosave trigger in the commit subject + refuse conflicted trees (#471). (#533) *(@pkarw)*
- 🐛 Keep reasoning text alive across replay and drop empty "Thinking" rows (fixes #528). (#536) *(@pkarw)*
- 🐛 A custom hand-off prompt extends the item context instead of replacing it (fixes #524). (#541) *(@pkarw)*
- 🐛 Preserve thinking across resumed steps (fixes #556). (#564) *(@pkarw)*
- 🐛 Isolate cross-backend continuation sessions (fixes #562). (#566) *(@pkarw)*
- 🔐 Default to full permissions (fixes #563). (#568) *(@pkarw)*
- 🔄 Refresh checkout root after save (fixes #567). (#569) *(@pkarw)*
- 🐛 Make picker tiers deterministic (fixes #555). (#570) *(@pkarw)*
- 🐛 Render reasoning snapshot arrays. (#573) *(@pkarw)*
- 🐛 Show queued task references immediately (fixes #554). (#578) *(@pkarw)*
- 🐛 Bridge subagents and native questions (fixes #565). (#579) *(@pkarw)*
- 🐛 Scope subtasks by session id (fixes #551). (#587) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Multi-project workspace — per-user `~/.cezar` registry, project-scoped cockpit, config migrations. (#517) *(@pkarw)*
- 📝 Grouped sub-agent display within a single session. (#522) *(@pkarw)*
- 📝 GitHub tab timeline events (commits, labels, merges) + per-commit CI markers. (#527) *(@pkarw)*
- 📝 Worktree file editing from the Files tab (#530). (#531) *(@pkarw)*
- 📝 Stack, edit and remove prompt messages on a queued run. (#537) *(@pkarw)*
- 📝 Correct the linting constraint — oxlint, not typescript-eslint. (#560) *(@patzick)*
- 📝 Discover latest Codex models. (#585) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Migrate to TypeScript 7 (native compiler). (#559) *(@patzick)*

## 👥 Contributors

- @pkarw
- @pat-lewczuk
- @patzick
