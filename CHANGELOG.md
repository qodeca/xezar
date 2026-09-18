# Unreleased

## 💥 Breaking

- 💥 **The audit trail moves to `audit.ndjson`, and its records change shape.** (#306, part 1 of 4)
  A project's audit trail is now written to `.local/xezar/audit.ndjson` as version 2 records; xezar
  0.13.0–0.15.0 wrote version 1 records to `mcp-audit.ndjson`. A record now says `applied` or
  `refused` (with a machine reason) instead of `ok`, `rejected` or `unverified`, and carries a
  sequence number, a UTC time and an `actor` that matches its origin. An MCP call that may have
  started its effect and then failed is no longer written as `unverified`: it is not recorded, and
  xezar prints one warning that the action continued without an audit record. The old file is
  **read-only**: xezar reads it only while `audit.ndjson` does not exist, prints one deprecation line
  when it does, and never writes, renames or deletes it. When both files exist, `audit.ndjson` wins.
  **Upgrade:** nothing to do; keep `mcp-audit.ndjson` if you want the old history. **Downgrade:**
  0.15.0 still reads its untouched `mcp-audit.ndjson`, and skips every `audit.ndjson` record as
  unreadable (measured, not assumed), so records written by 0.16.0 are not visible to it. The alias
  is removed no earlier than 0.18.0 (#563). An MCP record's `action` is now the shared action id the
  cockpit records too (`run.start`, `run.pin`), not the tool action (`taskCreate.start`), and a read
  action inside a mutating tool is no longer recorded. Details: `BACKWARD_COMPATIBILITY.md` § 3.
- 💥 **A task xezar starts can no longer take your project's MCP leader slot.** (#342) Claude Code, pi and OpenCode tasks are now started with your `xezar` MCP entry switched off for that one client, the way Codex tasks already were — so a task running in the project folder itself (Worktree off) no longer holds the leader slot and refuses your own leader session with "project occupied". Tasks in their own working copy get the same treatment. Your config files are never edited. Two narrowings come with it: a Claude Code task now sees only the MCP servers your project's own `.mcp.json` declares, not the ones in `~/.claude.json`; and for pi and OpenCode a server named `xezar` is switched off in tasks even when xezar never read the file declaring it, so rename an unrelated server of that name. A config file that cannot be read never stops a run — the task says so once and starts. For pi this applies only where the optional `pi-mcp-adapter` extension is available to the task: that extension is what lets pi read an MCP config file at all, and it can come from the pi agent directory or from the project folder the task runs in, so xezar asks the question for that task's own folder and account at every start. Where the extension is not available a pi task now starts normally, loads no MCP servers, and says once that there was nothing to switch off; where the question cannot be answered the task says that instead, and a pi that refuses the option anyway is started once more without it (#548 — before this, every such pi task failed the moment it started). Details: `BACKWARD_COMPATIBILITY.md` § "Claude Code, pi and OpenCode runs no longer load xezar's own MCP bridge".
- Hosted servers now refuse every WebSocket upgrade before the handshake; remote clients continue to use authenticated HTTP and event streams. Local native clients and the Vite development proxy keep their existing access. (#547, SM1)
- 💥 **Start-up recovery now says when it deliberately settled previous-session tasks.** (#467) One aggregate stderr activity entry reports `task.recovered count=<all candidates> settled=<waiting tasks settled>` before the cockpit-ready event, while seeded per-task outcomes and transient restart failures stay suppressed and session totals stay unchanged. Wide and 40-column terminals say “N tasks from the previous session were settled at start-up”; plain output carries only `event=task.recovered count=… settled=…`; `--quiet` omits it. The old stdout line `recovered N run(s) from the previous session` is removed, so scripts that consumed it must read stderr's plain output and select `event=task.recovered`. No state, exit code, API, MCP event or recovery behavior changed.

## ✨ Features

- ✨ **A folder can own its whole xezar setup, so a clone runs the same way.** (#600, part 1 of 5)
  Start `xez --single-project` once in a project folder and xezar keeps its settings, agent accounts
  and project registry in `<project>/.xezar` — `config.json` (unchanged meaning), `workspace.json`,
  `agent-accounts.json` and `workspace-ui.json` — with working files in `<project>/.local/xezar`,
  and never opens `~/.xezar`. After that the folder decides: every `xez` started there is in the
  mode, flag or no flag, so a teammate who clones the repository gets the same behaviour with no
  host setup step. One terminal line names the mode and the folder, and `GET /api/v1/health`
  reports `capabilities.singleProjectRoot`. A linked git worktree is never a project root, so xezar
  tasks keep running against the project's own state. Nothing changes for anyone who does not pass
  the flag: no migration, no conversion, and `~/.xezar` is untouched. `XEZ_SINGLE_PROJECT` keeps
  its exact meaning — one project, no project management, global state — and is not deprecated; the
  new mode is a separate superset with its own flag and its own capability key. A
  `<project>/.xezar/workspace.json` that is corrupt or unwritable refuses the start with a named
  error rather than quietly falling back to your global setup; the other three files degrade with
  one warning as they always have. **Downgrade:** 0.15.0 in a single-project folder ignores the
  project state and uses your global setup — an old binary cannot be taught a new rule, so it is
  named rather than prevented, and nothing in the folder is damaged. This part ships the state
  layout, the detection, the capability and the boot line; the cockpit badge, the refusals in all
  three doors and the import from a global setup follow. Details:
  `BACKWARD_COMPATIBILITY.md` § "Single-project ROOT mode".
- ✨ **A single-project folder now keeps its team skills and its committed limits to itself.**
  (#600, part 2 of 5) In single-project mode the cache of team skills xezar fetches is written to
  `<project>/.local/xezar/cache/skills/`, not the machine-wide `~/.cache/xez/skills/`, so a clone of
  the project fetches its own team skills instead of inheriting whatever this machine fetched last;
  the MCP bridge's socket directory moves with it for the same reason. A committed
  `resources.memoryLimitMb` (0 to 1 048 576 MiB, or `null` for no limit) or `resources.maxParallel`
  (1 to 16) in `<project>/.xezar/workspace.json` is now applied exactly as written, above what this
  host would have derived for itself included — no clamp, no refusal, no warning-and-substitute —
  because a project that runs with different numbers on the reviewer's machine than on the author's
  is what committing them was meant to end. Those two ranges are the workspace schema's own and are
  unchanged: a value outside them has always been replaced silently, so a committed one is now
  refused by name instead. One message changed in the DEFAULT global layout as well: when the socket
  path is too long for this system, xezar names the socket directory it tried instead of "the xezar
  home path"; the remedy it suggests is still `XEZ_HOME`, and in single-project mode it says to move
  the project instead, because `XEZ_HOME` cannot move that folder. What does
  **not** move: your agent logins (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`,
  `PI_CODING_AGENT_DIR`), your global skill libraries in `~/.agents/skills` and `~/.claude/skills`,
  `gh`, `git`, and the host-install records in `~/.xezar` (`server.json`, `server-instances/`, the
  systemd unit, the nginx site) — a cockpit is still installed on one machine. **Nothing changes in
  the default global layout**: `~/.cache/xez` stays exactly where and what it was, `XEZ_HOME` still
  does not move it, and a test now pins that from both sides. Details:
  `BACKWARD_COMPATIBILITY.md` § "Single-project ROOT mode".
- ✨ **A folder that owns its xezar setup has a registry of exactly one project, and says so at
  every door.** (#600, part 3 of 5) In single-project mode `GET /api/v1/projects`, `xezar projects`
  and the cockpit list one project — the folder — even when a `workspace.json` a clone carried names
  more; rows for other machines' paths are ignored, never rewritten. Adding, cloning, editing and
  removing a project, and browsing host folders, are refused in all three doors: the HTTP API
  answers `409` with a plain sentence, `xezar projects add/remove/tag/port` exits 1 with the same
  sentence, and the MCP `project_config` tool refuses at its boundary and now says why there is
  nothing to manage. Every refusal is recorded in the project's audit trail, with a reason that says
  which narrowing refused. Nothing changes for an ordinary multi-project workspace, and
  `XEZ_SINGLE_PROJECT=1` refuses with exactly the status codes, sentences, exit codes and audit
  reasons it always has — the guards widened what turns them on, never what they do. Details:
  `BACKWARD_COMPATIBILITY.md` § 2 and § "Single-project ROOT mode".
- ✨ **The cockpit says when it is in single-project mode, and Settings names the file each section
  writes.** (#600, part 4 of 5) A neutral "Single project" badge sits under the logo in the sidebar
  and in the phone top bar. Add project, the sidebar's project groups, the composer's project pill
  and the command palette's Projects group are absent in the mode — and under `XEZ_SINGLE_PROJECT=1`
  — whatever the registry happens to list. Each Settings section says where its saves land
  (`.xezar/config.json`, `.xezar/workspace.json`, `.xezar/agent-accounts.json`,
  `.xezar/workspace-ui.json`, or the uncommitted `.local/xezar/ui-state.json`), and the global
  area reads "Workspace settings". The `/settings/global/…` URLs keep landing; in the mode they
  write the project's files instead of the home directory. Global mode is unchanged. Details:
  `BACKWARD_COMPATIBILITY.md` § 2.
- ✨ **The first single-project run can bring your global setup along, and a clone never borrows a
  login it does not have.** (#600, part 5 of 5) The first `xez --single-project` in a folder with no
  `.xezar/workspace.json` asks once, in the terminal, whether to copy your global setup (`~/.xezar`,
  or `XEZ_HOME`) into the project, `[y/N]`: workspace settings become `workspace.json` without your
  project list, agent accounts keep only this folder's own account choice, and GUI preferences
  become `workspace-ui.json`. Nothing is written before you answer, a decline imports nothing,
  existing project files are never overwritten, an unreadable global file is skipped and named, and
  `~/.xezar` is only read, never written. Nothing is written through a symbolic link: a
  `.xezar` that links out of the project refuses the start, and a state file that is a link is left
  alone and named. Ctrl-C or Ctrl-D at the question is a decline, not a crash. With no terminal — a script, CI — nothing is imported and
  one line says so; `xezar mcp` never asks; a second run or a clone is never asked; and nothing is
  kept in sync afterwards. That one read is the mode's single deliberate exception to "`~/.xezar` is
  not opened", and a source scan now fails any other direct reach for the global layout. In the
  mode, an agent account the project names whose folder does not exist on this machine reads
  **Unavailable** in Settings → Agent accounts with a sentence saying why and what to do, and a task
  that asks for it is refused before the agent starts with the same sentence — as are the task
  namer, the chain planner and "Open in → agent CLI", which never start on it — never a silent
  fallback to the default login; the start itself never fails because of it. The cockpit copy
  follows the mode: the defaults card reads "Defaults for this project", Resources drops the
  "Configure per-project limits" link, and the empty Tasks page says the folder carries its own
  setup. A browser test now boots a fresh clone of a single-project repository to prove it runs with
  the committed setup. The user guide (projects, settings, configuration, CLI and remote access) and
  the README describe the mode. Global mode is unchanged throughout. Details:
  `BACKWARD_COMPATIBILITY.md` § "Single-project ROOT mode".
- ✨ **Single-project mode has a reviewed cockpit mockup and developer handoff.** `designs/single-project-mode/`
  covers the mode's sidebar next to the global one, the dev-badge plus mode-badge combination, the
  phone top bar, Settings' file-naming notes, the unavailable-account row, the composer and command
  palette without project controls, and the `/settings/global/projects` refusal — every state, in
  both themes. This PR itself changes no cockpit code; the parts above are what ships it. (#600, #604)
- ✨ **The sidebar is navigation-only.** (#546) The Active/Archived task switcher, task list, and `Search…` launcher have been removed from the sidebar. Manage and search tasks on the Tasks page, and open the command palette with `⌘K` on macOS or `Ctrl+K` elsewhere. Existing task badges, task data, APIs, and saved UI state are unchanged.
- **The audit trail is bounded, and safe to share between processes.** (#306, part 3 of 4) A
  project's `.local/xezar/audit.ndjson` now rotates before it passes 10 MB (10,000,000 bytes) and
  keeps five files — the live one plus `audit.ndjson.1` to `.4`, so a project's trail stays under
  50 MB whatever it does. A rotated file's history is not lost: sequence numbers run on across the
  set, the new live file starts with one `rotated` marker saying where the previous one ended, and
  xezar reads the oldest rotation first. Every writer — the cockpit, MCP, the automation runner and
  a command — now takes one lock per project for the sequence, the append and the rotation, so two
  xezar processes writing at the same moment cannot lose or repeat a record. All five files are kept
  owner-only (`0600`), and one that is not is repaired before anything is written to it. If any of
  that cannot be done — a folder xezar cannot write, a lock held by another process for more than
  two seconds, a failed rename — the record is dropped and xezar warns once; **your action still
  happens**, exactly as before. The old `mcp-audit.ndjson` is untouched by all of it.
- 🔒 **The audit trail redacts through one seam, and no longer says a change was applied when it was
  refused.** (#306, part 4 of 4, with #577 and #573) Everything a record could hold now passes one
  redaction step, whichever door wrote it: a value that matches one of this machine's secret
  environment values or a well-known token shape is dropped rather than stored, and prompts, messages,
  titles, paths, URLs, a request's own credentials and an automation candidate's author never reach
  the file — not even inside the fingerprint (digest) a record keeps to say "this same change again".
  A settings change stores the NAMES of the settings you changed and a fingerprint taken with every
  value removed, so the trail says which settings changed and never what you set them to; an MCP
  settings change now records those names too. Three answers that changed nothing were recorded as if
  they had been applied and are now recorded as refusals with a reason: an action the task's state does
  not allow, an Inbox action while the Inbox is off, and a `handoff_git` commit, push, pull request,
  ready or merge the cockpit's own rules, the merge verdict or the forge refused. A hand-off that
  failed in a way xezar cannot be sure about writes no record at all rather than a wrong one, and says
  so in one warning. That warning is now one line **per project** per process however many doors fail,
  and it never carries a folder path or an error object's own words. The file format is unchanged, so a
  0.15.0 xezar still reads its own `mcp-audit.ndjson` and still skips every `audit.ndjson` record
  without crashing.
- **An MCP "not found" is now recorded as a refusal.** (#573, with #306 part 3) Asking MCP to cancel,
  continue, pin or push a task this project does not have left no trace at all — and for `handoff_git`
  it was recorded as if it had been applied. Such an answer comes from a lookup before anything
  happens, so it is now one `refused` record with the reason `not_found`, the same way the cockpit
  records its 404. An answer that may have followed a real effect is still never recorded as refused.
- **The audit trail now records every door, not only MCP.** (#306, part 2 of 4) A change made in the
  cockpit (`ui`), by the automation runner (`automation`) or by a command (`cli`) is written to the
  project's `.local/xezar/audit.ndjson` beside the MCP records, with the same action id for the same
  change in the cockpit and over MCP. Every command-line subcommand — `serve`, `run`, `init`,
  `projects` (list, add, remove, tag, port), `mcp`, `server-install`, `server-deploy` and
  `server-uninstall` — writes one record, `applied` or `refused` with a reason; `--help`, `--version`
  and unknown commands write none, and a folder that is not a xezar project (the home directory or a
  task worktree) gets no new state, printing the same one-warning line a write failure uses instead of
  staying silent. Each run an automation launches gets its own record linked to its receipt id. Reads are never recorded,
  and a failed audit write never fails the action (one warning). On a hosted server, the cockpit
  record also keeps the user the reverse proxy authenticated, from the `X-Xezar-User` header, marked
  `asserted-by-proxy`; the header is read only in hosted mode and only from a loopback proxy, and the
  bundled nginx site now sets it to the authenticated user, overwriting any value a client sends.
  Details: `BACKWARD_COMPATIBILITY.md` § 3.

## 🐛 Fixes

- 🐛 **The Tasks page header no longer scrolls sideways in a narrow desktop window.** (#625, #447, #424)
  Below about 896 px at comfortable density (`known-gaps.md` G-48; density-dependent, from 958 px
  roomy to 835 px ultra), with “Mark all read” and “Archive finished” both shown, the one-row header
  needed more width than the pane beside the sidebar had: the pane scrolled sideways (602 px of
  header in 536 px at 800 px) and the search box was squeezed to 46 px and pushed past the window up
  to about 1060 px. The header now wraps like the shared page header does: the actions and the
  240 px search move to a second right-aligned row when they do not fit. A wide window and the
  phone layout are unchanged. The `designs/design-system-air` Tasks mockup carries the same fix.
- 🐛 **A project added to a running cockpit now gets its own MCP connection.** (#557)
  Before, only the project the cockpit was started in could be led over MCP: `xez mcp` in a project
  added with **Add project** answered "xezar is not running" while the same cockpit served that
  project's tasks. Now each project gets the same connection once the cockpit opens it, and loses it
  when the project is removed. The starting project's connection, the socket location and the
  connection file are unchanged. After a restart, a project other than the starting one is served
  again once it is opened in the cockpit.
- 🐛 **A run xezar itself terminates for the memory limit no longer ends `done` with no deliverable.** (#603)
  `enforceMemoryLimit` closes a breaching run's session with `session.end()`, and — deliberately,
  per #703 — a CLI that does not exit on its own is then signalled by xezar and settles on the same
  "our own signal coming back" path a legitimate `XEZ:DONE` close does, so `session.result` resolves
  without throwing either way. Before this fix the step-completion handler could not tell that
  distinction apart from a finished turn, and recorded the step, and the run, `done` even though
  xezar cut it off mid-turn and nothing was posted. Both construction sites (`runAgentStep` for a
  fresh run, `runContinuation` for Continue and restart recovery) now check the reason
  `enforceMemoryLimit` records on the live `ActiveRun` and end the run `failed`, naming the memory
  limit, instead — one of the statuses `continueRun` already accepts, so the leader's `Continue`
  resumes it. The memory limit and the pause mechanism itself are unchanged.
- 🐛 **A conversation image can be opened, read and left with the keyboard.** (#453)
  The full-screen image preview in a task thread used to be a clickable picture over a
  hand-rolled overlay: a keyboard reader could not open it at all, and once it was open there
  was no way in or out except the Escape key. It is a proper dialog now — Enter or Space on the
  thumbnail opens it, focus moves inside and stays there while you Tab, and Escape or the close
  button in the corner hands focus back to the thumbnail you started from. The thumbnail and
  the close button both reach the 44 px phone target, the close button stays on top of a
  picture larger than the screen, and an image the server no longer has says so in words
  instead of showing a broken picture. Two smaller repairs ship with it: on a phone a task
  title now wraps to a second line instead of cutting off after about fifteen characters, and
  a task's Files tab remembers which file you were reading when you come back to it.
- 🐛 **The macOS ngrok tunnel no longer lets a remote client choose the audited proxy user.** (#572)
  In hosted mode, xezar's audit trail trusts an `X-Xezar-User` header sent by a loopback peer — the
  bundled nginx site sets it from the authenticated user and overwrites any client value, but the
  ngrok tunnel (`server-install --platform macosx-ngrok`) is itself that loopback peer and passed a
  remote client's own header straight through, so a signed-in client could pick the identity stored
  as `asserted-by-proxy`. The installer now writes an ngrok Traffic Policy file that strips
  `X-Xezar-User` from every request before it reaches xezar (`--request-header-remove` is
  deprecated by ngrok; `--traffic-policy-file` with a `remove-headers` action is the current
  mechanism). Existing installs pick this up on the next `server-install --reconfigure ngrok` or
  `--reinstall`. Also corrects the installer's "Identity check" step title, which claimed basic-auth
  was "active" though the step only confirms the tunnel process is up and never probes the gate.
- 🐛 GitHub, Compare and Automations now use the same page title and margins as the other pages, and on a phone every GitHub, Compare, Automations, Inbox, New task, plan review, Skills, Workflows, not-found and unknown-project control is a 44 px target at every density. A GitHub or Automations load that fails says so instead of looking like an empty list, a missing automation says it was not found instead of loading forever, overwriting a saved workflow or chain uses the danger button, the Workflows Copy button says Copied only when the clipboard really took the YAML, the New task and GitHub spinners stop under reduced motion, and the agent config editor shows keyboard focus. (#453)
- 🐛 The review gate and the variants compare view now show a run's diff the way the Git tabs do: line numbers, word-level changes, a `copied` badge and every line of a long file (no more 300-line cut or 20-file limit). On a phone, every Git-tab and diff control is a 44 px target at every density; the Git pages line their title, toolbar and content up on one gutter; diff line numbers are readable in both themes; closing the Commit dialog returns keyboard focus to the Commit button; a refused clipboard on the Changes tab shows the command instead of saying it was copied. (#453)
- 🐛 On a phone, every task-thread, composer, dock, review, question and Tools-menu control is a 44 px target at every density; a message's edit and remove, the title pencil and an attachment's remove mark show without hover; thread spinners stop under reduced motion; a refused clipboard shows the command instead of saying it was copied; and the run's delete confirm uses the danger button. (#453)
- 🐛 Keep pi `write` and `edit` calls in an isolated task worktree out of the primary checkout, whatever path spelling pi would accept (absolute, `..`, symlink, `~`, a leading `@`, a `file://` URL, Unicode spaces or different letter case); a spelling the guard cannot resolve with confidence is refused. Shell commands get a best-effort check only – it refuses commands that name the primary checkout – including a relative path read from the folder an earlier `cd` or `pushd` reached, or one through an existing symlink – or change into it through ordinary `cd`, `pushd`, `git -C`, `env -C`, `--git-dir`/`--work-tree` or `GIT_DIR` forms, and a directory change whose target is not one literal path (a variable, a substitution, a glob or brace pattern, `~user`, a `CDPATH` change, or `..` after a symlink) is refused rather than guessed, but a shell command cannot be parsed completely, so it is not containment. The primary checkout now comes from xezar itself, so bare-repository and submodule layouts keep working, and the run's handoff and temp folders stay writable. In-place and non-Git runs, plus temporary and home-directory paths outside the primary checkout, retain their existing behavior. (#537)
- 🐛 Balance the nightly MCP mutation gate's shards on measured per-file cost instead of byte size, raise the shard count from 6 to 9, and isolate the two files whose carried-over weight was still under-counted (`bridge.ts`, `tools/task-create.ts`) into their own shard, after two consecutive nightly runs were cancelled at the 5-hour job ceiling. (#443)
- 🐛 **An OpenCode run no longer hangs on a permission ask.** (#578) OpenCode asks before a tool reaches a folder outside the task (the hand-off file, attachments, the run's own files), and nothing answered, so the run waited until its 30-minute step limit with no named cause. xezar now answers each ask at once and fails closed: a folder ask inside the run's own directories (symlinks resolved) is allowed for that one call; every other ask – a folder outside them, a web fetch, a shell command, a repeated-call warning – is denied and shown in the transcript. The same denial three times in a row, 20 denials in one session, or a reply OpenCode refuses stops the run with a named error. The claim that OpenCode approves every permission automatically is removed from the docs.
- 🐛 **The OpenCode leader now gets the decision version on every pushed run event.** (#535, #532) `renderDispatch` in the OpenCode reaction adapter omitted `subject.version` from every rendered event, unlike the Claude Code, Codex and pi adapters, so an OpenCode leader could not pass it as `expectedVersion` without an extra `task_read`. The adapter now renders it the same way the other three do.
- 🐛 **The Codex probe now honours `XEZ_DRY_RUN=1`, like the claude and pi probes beside it.** (#549) `GET /api/v1/health` under `XEZ_DRY_RUN=1` spawned the real system `codex --version`, writing `logs_2.sqlite` and `models_cache.json` into the real `~/.codex` even when `CODEX_HOME` is pinned to a sandbox — found by the QA of #579. `probeCodex` now answers with the same bundled mock the other backends already use, and never spawns anything.
- 🐛 **A project re-registered outside the removal route no longer keeps serving its old, deleted folder.** (#591) `ProjectContexts` cached one `{store, manager, dataDir}` bundle per project id for the life of the process, and only the project-removal route ever threw it away — a second xezar process editing the registry, a hand edit to `~/.xezar/config.json`, or a test seeding it directly all left a re-registered id resolving to the FIRST folder's now-deleted `dataDir`, and a run against it crashed with `ENOENT`. Every scoped request now re-checks the id's current registry root before serving a cached context, and disposes and rebuilds it the same way removal would when the root has moved on.
- 🐛 **A secret written as `\uXXXX` escapes could pass the audit redaction seam.** (#306, #586 follow-up) `redactAuditInput`'s secret check was a literal substring match, so a host or door secret copied into an MCP argument as JS/JSON unicode escapes (no literal secret bytes present) matched neither an identifier field nor a payload leaf, letting the escaped copy reach the digest — and, for the `identifier-secret` payload rule, the record itself — unmasked. Both checks now also try the value with `\uXXXX` sequences decoded before deciding a field is clean; a value with no such escape is unaffected. Also adds a guard test pinning the four MCP `config-value` body keys (`config`, `project`, `promptTemplates`, `content`) against a live call through each of the four config-write actions, closing the "no guard test" gap the #586 review left open.
- 🐛 **An autonomous Continue can no longer re-prompt a turn 40 times before failing.** (#613) When a Continue finishes an interrupted workflow step, whose remaining steps need `XEZ:DONE`, an autonomous run now gets at most 3 automatic re-prompts (was 40, then a 15-minute idle close) and fails at once with `… requires XEZ:DONE from the continued turn — automatic re-prompting stopped after N turns — <cap or idle reason>`. In every autonomous run, a re-prompted turn that made no tool call now ends the re-prompting: a finished last step parks for you, a gated Continue fails. Busy last steps keep their 40-re-prompt budget. That small budget stays with the continued turn alone: once it says `XEZ:DONE` and the remaining workflow steps start, the last step gets the usual 40 re-prompts again instead of stopping after 3 and parking mid-work. Details: `BACKWARD_COMPATIBILITY.md` § 8.
- 🐛 **A Claude weekly-limit auto-resume no longer wakes a day early.** (#581) `parseUsageLimit` only ever read the trailing clock out of Claude Code's weekly-limit prose (`resets Sep 19 at 6pm (Europe/Warsaw)`), dropping the named month and day, and then guessed "the next occurrence of that clock time from now" — landing one day early whenever today's occurrence of that time had already passed. It now reads the named date first when the message carries one, and falls back to the clock-only guess only for the session-limit prose that has no date at all (unchanged).
- 🐛 **`engine-leader-incidents.test.ts` no longer times out under coverage instrumentation.** (Refs #603) Four `expect.poll()` waits raced an unwanted nudge/message against the real agent-turn → event → journal → run-store completion chain on vitest's default 1000ms/50ms poll budget — too tight once `npm run test:coverage:mcp`'s v8 instrumentation and its 72 concurrent test files slow that chain down. Main CI run 35323455608 failed this way (`Matcher did not succeed in time`) though the same commit's PR CI and the prior main commit were both green; reproduced locally under CPU load with `--coverage`. All four now use the 3000ms/10ms budget the file's own `terminal()` helper already used for the identical chain. Test-only; no production code changed.

## Tests

- Added a reusable POSIX authenticated reverse-proxy harness (`npm run test:server-mode`), a dedicated bounded CI job, and registration-derived coverage of local-only routes. The harness exercises the built CLI, isolated homes, spoofed headers, rejected writes, event-stream reconnects and exact-PID cleanup.
- test(mcp): cover fragile leader delivery across owner switches, ack/journal epoch boundaries and the opt-in acceptance judge, plus an executable inventory assertion (#532 slice 3, G4/G5/G6/G11/G12).
- Added a saved, re-runnable deterministic two-project product harness (`npm run test:multi-project`, `packages/xezar/scripts/multi-project-harness.mjs`) proving registry/context composition, route aliases, the shared workspace cap, the cross-project runs index, workspace SSE stamping, and per-project MCP ownership for the boot project, all against one built cockpit with two registered scratch repositories in one isolated `XEZ_HOME`. See `docs/testing/multi-project-harness.md`.
- Added a focused in-process test covering a route-level A/B lifecycle the deterministic harness only smoke-tests: a late-built project B's runs join the cross-project runs index and the one open workspace SSE stream (each stamped with B's own project id), and removing then re-adding B on the same slug leaves project A untouched while B's rebuilt store resumes flowing on the already-open stream instead of being silently dropped by a stale attach entry (`packages/xezar/src/server/multi-project-composition.test.ts`).
- Added a real-browser project-switch journey (`packages/web/e2e/project-switching.e2e.ts`, #548): clicking from one registered project into another resets the destination page's own mount-time state (no stale filter carried over) and issues that project's own scoped requests with no reload; a cross-project task opened from the workspace-wide All tasks page lands at its owner project even while a different one is active; a registered project whose folder is gone stays listed and inert. A retained regression proof on a scratch branch (never landed) confirmed the existing `routes.test.tsx` remount case and this new browser file both fail the same way when the routed outlet stops remounting on a project change.
- Reconciled the remote-access docs with verified behavior and pinned both claims with a new test: a normal launch no longer claims an unconditional starting port of 4321 (it actually prefers a saved port, then `XEZ_PORT`, then the port it last listened on), and the macOS/ngrok installer's success message no longer says basic-auth was "enforced" when it was only configured, never probed through the tunnel. (#547, SM2)
- Added `guide-02-running-a-task.e2e.ts` and the shared `guide-browser.ts` semantic-locator helper: one scripted browser journey against a live dry run covering guide 02's compose, mode toggles, queueing, thread output, Finish/review and Changes/Files/Commits tabs, the Draft PR/Accept hand-off, and the finished run's own action menu (Archive/Unarchive, Open in…, Notes and Continue). Locators are role, accessible label or visible text only — never a class, id or `data-*` attribute. (#549)
- Added `npm run check:links` (`scripts/check-links.mjs`), an offline relative-link and anchor checker for `docs/`, the root `README.md`, `.xezar/docs/` and `designs/**/README.md` — no network calls, so it runs in a task worktree and in CI alike. (#447)

## 📝 Specs & Documentation

- Brought the design system up to date after #424 (#447): decision D-03 now lists the Git, GitHub, Compare and Automations pages and the task Git tabs as moved to the `section` gutter, with the Settings loading lines as the one remaining follow-through; D-06 and [foundations](docs/design-system/foundations.md) explain the two remaining spacing-allowlist rows as WCAG 24 px floors (#445 closed as met); the shared specimen stylesheet now switches to the phone shell below 768 px, like the cockpit, instead of 860 px; and the counts in `components.md`, `behaviour.md`, `known-gaps.md` and `coverage.md` were re-measured.
- Documented single-project ROOT mode's symbolic-link refusal and its independence from hosted mode's own local-machine `409`s in [guide 09](docs/guide/09-projects.md), and added a new [guide 17](docs/guide/17-audit-trail.md) covering the 0.16.0 audit trail: the four doors, `audit.ndjson` and its read-only `mcp-audit.ndjson` alias, rotation, redaction and its honest limits. (#306, #600, #447)
- Docs wave 5/6 (#447, #424): applied #621's design-review follow-ups – named WCAG 2.5.5 beside 2.5.8 for the phone tap-target floor and explained why the two `min-h-[24px]` allowlist rows keep their raw spelling in [foundations](docs/design-system/foundations.md), gave D-03's Settings-gutter follow-through an owner (#424) in [decisions](docs/design-system/decisions.md), moved every remaining local 860/861 px phone breakpoint under `designs/` to the shared 767.98/768 px edge (`designs/design-system-air`'s seven sheets, `designs/quality-checks`, `designs/issue-filing`, `designs/cli-terminal`, `designs/decisions` and `designs/onboarding`), and fixed three em dashes in [behaviour.md](docs/design-system/behaviour.md) and [components.md](docs/design-system/components.md) – both files, and `known-gaps.md`, still carry a house-style em-dash backlog this PR did not attempt. Verified in a real Chrome (agent-browser) at 375/767/768/800/1280 px, both themes: `settings.html`, `inbox.html` and `thread.html` no longer overflow; `tasks.html` still does between 768 and 896 px at comfortable density for an unrelated reason (its desktop header needs that much width beside the sidebar), recorded as `known-gaps.md` G-48 rather than silently fixed, since fixing it would touch `packages/web/src`. Read the three unread `components.md` gap rows against the code: G-05 is fixed (the route error boundary now renders `CenteredState`; `skills-loading.tsx` is a disclosed exception), G-11 is kept with a reason (folded into G-20), and G-12 is fixed (every search route uses `Input`; the remaining wrapper duplication is G-42/#598). Verified the sidebar-removal and #600/#306 sweep: no guide prose names the removed sidebar tasks panel, the OpenCode auto-approve claim is already gone, `docs/testing/multi-project-harness.md` now has a named row in `docs/README.md`, and added a README section for #342 alongside its existing #324 one.
- Docs wave 6/6, slice B (#447, #424): the root README's "Upgrading to 0.16.0" section now covers the sidebar tasks-panel removal (#546) and single-project mode (#600), alongside the already-documented audit-trail rename and #342 MCP-bridge change. Closed #626's remaining follow-ups: [foundations](docs/design-system/foundations.md) names the picker pill's `max-md:min-h-tap` and the reference chip's separate phone-hit-area overlay as the two distinct 44 px mechanisms rather than one shared class; `known-gaps.md` G-48 now gives the Tasks-header overflow floor as 896 px at comfortable density (835–958 px across the four densities) and says the gap pre-dates the docs-wave-5 breakpoint move rather than being caused by it; `designs/design-system-air/README.md` §5(h) now discloses that overflow and links G-48/#625; and the new em dashes #626 introduced in `known-gaps.md`, `components.md`, `README.md` and this file are en dashes, matching [writing.md](docs/design-system/writing.md)'s convention for repository docs.
- Docs wave 6/6, slice C (#447, #424): re-shot every screenshot in `docs/screenshots/0.16.0/` from the current cockpit (39 PNGs plus the tour GIF, one new state — `settings-projects`, previously planned for this release — showing G-30's sideways-scrolling registered-projects table on a phone) and moved every `docs/screenshots/0.15.0/` reference in the guide and the README to it; the 0.15.0 folder is removed, nothing still needs it. The root README's "Upgrading to 0.16.0" section gains the MCP-door-per-registered-project note (#557, merged as fb0f1c50) and the previously stray "Hosted WebSocket migration" subsection, which had landed after the License section instead of inside the upgrade notes. Design review follow-ups from the same re-shoot: the capture harness now pins the footer's version chip to v0.16.0 instead of the pre-release build's own `package.json` version (NB-1), the MCP connection capture selects OpenCode instead of the client picker's Codex default so it matches [guide 13](docs/guide/13-mcp-leader.md)'s "person-driven OpenCode attachment" caption (NB-2), the tour's done-frame event URL now rewrites correctly to the fixture repository (its source string had never matched the dry-run forge's real stand-in — NB-10), and two captions in [guide 07](docs/guide/07-github-and-automations.md) and the README now say what their picture/tour actually shows instead of promising activity or an Inbox frame neither has (NB-3).

## 🚀 CI/CD & Infrastructure

- 🚀 **Browser tests no longer share a server with the task that launched them.** The shared
  browser-test server boot (`scripts/test-env-up.sh`) now unsets `XEZ_HANDOFF_FILE`,
  `XEZ_TODOS_FILE` and `XEZ_TASK_ID` before launch, so a dry-run mock server it starts can no
  longer write into the parent xezar task's own handoff or todos files. The skill-search E2E's
  fixture servers also pin `HOME`, not only `XEZ_HOME`, so the picker's multi-keyword search no
  longer returns the developer's own machine-local skills alongside the fixture's. (#553, #554)
- 🚀 **The MCP per-file coverage floor runs on every pull request.** `npm run test:coverage:mcp`
  (SDLC.md § The MCP test floor) is now a separate, unconditional `mcp-coverage` CI job with a
  10-minute timeout, so it enforces the 80% per-file lines/branches floor without slowing the main
  typecheck/test/build lane and without depending on a path filter that could skip a required
  check. `.xezar/pipeline/config.json` is unchanged — this command was never meant to become a
  sixth local-gate command. (#550)

# 0.15.0 (2026-09-17)

## Highlights

The terminal now reports live task activity, and projects remember their cockpit ports.
Guided project setup, issue drafting and a complete user guide make the first steps clearer.
Leaders gain event delivery, progress advisories and more reliable steering and recovery.
The cockpit adds Roomy density and larger phone controls, alongside dependency and isolation fixes.

## 💥 Breaking

- 💥 **`xezar` remembers which port a project ran on, and starts there next time.** (#467, PR 2) This changes a default, accepted by the owner on 2026-09-16 and shipped through the minor-release path in `BACKWARD_COMPATIBILITY.md`. Without `-p/--port`, a project now starts from the port you pinned for it (`xezar projects port <id> <port>`), then `XEZ_PORT`, then the port it last listened on, then 4321 — and takes the next free port from there, exactly as before. A start from memory or from 4321 also steps over ports other registered projects hold or remember, so two projects stop swapping ports and breaking each other's bookmarks. **`xezar --port 4321` restores the old start point** for one launch, and `xezar projects port <id> 4321` makes that permanent. Unchanged: the 50-bind budget (a port skipped for another project does not spend from it), the 65535 ceiling, `EADDRINUSE`-only retry, the printed port always being the one the server really holds, `--port 0` (which ignores memory and is never remembered), every exit code, and `server-install`'s own ports, which are never reinterpreted with `serve` memory.

- 💥 **`xezar serve` now tells you what your tasks are doing, on stderr.** (#467, PR 3) It used to print a banner and then go almost silent, so the only way to see that a task had finished, failed or was waiting for you was to open the browser. It now reports each of those as it happens. Every new line is on **stderr**: stdout keeps the banner, the agent and tool checks and the `cockpit → <url>` line byte for byte, so anything that pipes, tees or greps stdout is unaffected, and `xezar mcp` still writes JSON-RPC and nothing else. Off a terminal — a file, a pipe, a non-empty `CI`, `TERM=dumb` — the output is plain append-only lines with **no escape byte at all**, even when `--output rich` was asked for. **`2>/dev/null` restores the old near-silence exactly**, and `--output lines` keeps the words without the live table.

- 💥 **A Codex run xezar starts no longer loads your own Codex MCP servers, plugins or apps.**
  (#324, #323) Every Codex task run used to load each MCP server and plugin in
  `$CODEX_HOME/config.toml` – a browser, the Messages plugin, ChatGPT connectors – and
  `approvalPolicy: never` let the agent call them with no prompt. The runner now asks the Codex
  app-server which servers it would load (`config/read`) and starts the thread with only the
  servers that the project's own trusted `.codex/config.toml` alone declares. Servers from your
  home config, plugins, apps and xezar's own leader bridge are switched off for that thread, and
  the run transcript names what was switched off. The bridge is known by its launch line
  (`npx @qodeca/xezar mcp`, `xezar mcp`, `env … xezar mcp`, `sh -c "…"`,
  `node …/@qodeca/xezar/dist/index.js mcp`) and by the name `xezar`, which is now reserved: a
  project server called that is switched off too, so rename it. Your config files are not
  changed. To use a server in Codex runs, declare it in the project's `.codex/config.toml` and
  keep your home config from adding keys to it. A Codex CLI that cannot answer `config/read`
  now fails the run with a message instead of starting it. No setting and no environment
  variable. Migration: README § "Codex runs and MCP servers".

- 💥 **Agent config no longer follows individual file symlinks (#363); ship in the next minor release.** Reads and writes return 409 with the existing error body; listings expose no hash and seeding skips the link. Directory links below an agent home or repository may not escape that root. Replace file links with regular config files; relocating an entire configured home remains supported.

- 💥 **The default team skills source is now `qodeca/xezar-skills`, and the skills are named
  `xez-*`.** (#394) The previous default repository is no longer loaded, and the automatic updater no
  longer recognises it: an `npx skills` install from the old source is reported as "Installed
  skills come from another source; xezar does not update them" and is never touched. Existing
  installs are not migrated – run `npx skills remove <om-* names> -p` (or `-g`), then
  `npx skills add qodeca/xezar-skills --skill '*'`; `~/.cache/xez/skills/open-mercato__skills`
  and `.claude/skills/om-*` are orphaned afterwards and safe to delete. A curated Manage-skills
  selection that still names `om-*` skills keeps working: each `om-<name>` is read as
  `xez-<name>`, and the stored list is never rewritten. An explicit
  `"skillsRepos": [{ "repo": "open-mercato/skills" }]` in `.xezar/config.json` restores loading of
  the old collection (ungated) but not automatic updates. The cockpit, the `xezar serve` banner
  and `--help` name the new repository.

Merged PRs for the preserved entries above: (#394), (#410), (#415), (#488), (#505).

## 🔒 Security

- 🐛 Update Hono and its Node adapter to clear the shipped server advisories. (#428)

- 🐛 Fix agent-config API tests reading inherited agent homes; isolate all four agent config directories and HOME per test (#362).

- 🔒 **Two high-severity advisories in shipped dependencies are fixed.** (#426) `smol-toml` 1.7.0 → 1.8.0 fixes GHSA-7w5x-hrqm-74c2: a malformed TOML document – a comment with no trailing newline inside an array or inline table – made the parser loop for ever at full CPU, and xezar parses TOML agent config with it. Its minimum is now 1.7.1, so every install of `@qodeca/xezar` gets the fix, not only builds from the lockfile. The cockpit's `react-router` 7.18.1 → 7.18.3 fixes GHSA-qwww-vcr4-c8h2, which affects only the unstable RSC APIs; the cockpit uses only `BrowserRouter`, so that bump is precautionary. The dev-only `nanoid` (3.3.19) and `undici` (7.29.1) move too, and `npm audit` reports no high or critical finding.

Merged PRs for the preserved entries above: (#410), (#427), (#525).

## ✨ Features

- chore(mcp): the leader role, the `initialize` instructions and the `leader_events` description now suit any project – GitHub and worktrees are named only as capabilities a project may have, and the leader role adds the work order, restart reconciliation, authority and a local path when a capability is missing; the generic-instructions guard carries no software-framing exceptions any more (#466, P3)

- feat(onboarding): project setup now discovers whether issue filing works here (GitHub CLI signed in, a GitHub remote, the `xez-issue-create` skill) and reports it – `issueFiling` on `GET /api/v1/onboarding` and in `discover_project`, plus an "Issue filing:" line in the setup and re-check report; a missing part is a reason, never an error (#468, step 3)

- Terminal recovery now preserves the boot banner and counts only new task failures, including projects opened later. Step text is sanitized before display, quiet mode has no live region, and pipes remain free of escape codes even when colour is requested.

- ✨ **The terminal and a project leader now use the same event names.** (#467, PR 4) Every `event=` in `xezar serve`'s activity is either a kind from the MCP event catalog or one of a short list of terminal-only names, and one table decides whether the task store or the MCP journal prints each catalog kind, so no fact prints twice. A task waiting with no structured question is now `event=task.blocked`, as the leader sees it (it was `question.asked`; the words on screen are unchanged). A check marked `resultScope: routine` prints its success at `debug`, the same rule that keeps it from waking a leader, and every check line carries `result_scope`. The terminal now also shows the stall advisory (`task.stalled` / `task.resumed`), recorded reviewer verdicts, agent providers becoming available or unavailable, configuration and workflow changes, and (at `debug`) a person's edits to a queued task – each printed from the MCP journal row, so these lines need the project's MCP service and are absent when it is unavailable. A stall warning is always followed by the line `still running — nothing was stopped` and, when the cockpit address is known, the task link (in plain output, a `url=` field), so it cannot be read as a task that is waiting for you. `--output rich` is documented as it behaves: on a narrow terminal it gives one line per event with no notice, and only a file, a pipe, CI or `TERM=dumb` prints the `output.fallback` notice and switches to plain lines. The CLI guide now covers port memory, the live activity, every output flag and the full list of event names. No new setting, flag or environment variable.

- ✨ **onboarding: leader setup verification – prepared, connected, attached, delivery verified – and recovery after a restart (#464, P3).** The bundled setup fallback carries project-only Claude Code, Codex and pi snippets plus their trust, launch, adapter or shared-home prerequisites. Its checklist keeps four facts separate: a candidate file is only **files prepared**; a real MCP tool result proves **connected**; `leader_events` attach/status proves **attached**; and only a real pushed event or an attached-session `read` proves **delivery verified**. `leader_events` reports that progression around its existing result without another status mechanism or a structured-shape change. It never promotes durable counters from an earlier process into current-session proof: after a restart the leader is connected but unattached, attaches with a new operation ID, then checks retained replay. Hosted mode and client blockers stay pending with their existing fix; stalls remain advisory, verdicts remain unproved until reported, and replay keeps its documented limits. No setting, environment variable, route, home write or cockpit surface was added.

- design-system: batch B2 – shell, page states, palette and project dialogs (#453)

- ✨ mcp: routine gate events are omitted from leader pushes; `resultScope` on check steps and `omittedRoutineCount` on pages (#460, PR 4)

- design-system: batch B3 – every Settings control is a 44 px target on a phone at every density, settings fields share one look and one field chassis, confirmations use the danger button and give focus back, and settings copy follows the house wording (#453)

- design-system: batch B4 – on a phone every task-list control is a 44 px target at every density: pins, tabs, rows, filter chips, composer pills, the template menu, the default-agent picker and the task page tabs. PR and issue chips keep their small look with a 44 px tap area. The Tasks pages show their tabs, actions and search on a phone, and the cross-project Tasks page shows cards there. Both task tables share one header, cell and usage style, and there is one byte formatter with two named precisions (#453)

- ✨ **A project can offer to set itself up, and says so once when xezar changes.** (#464 P2) A project with no tasks yet shows a quiet second block under the "No tasks yet" hero — **Set up this project** — and the same entry has a durable home in **Settings → Project setup**, which also answers "what was actually checked, and when". Both start an **ordinary task** from a new bundled workflow, `project-setup`: it appears in the task list like every other task, you can open it, read what it did and cancel it, and it shows you a preview of every change before writing anything. Nothing starts on its own — not at boot, not on registering a project, not on any event except your click or a project leader's call. When the running xezar or its pinned setup templates differ from what a finished check covered, one non-blocking row appears above the page with exactly two actions, **Re-check** and **Later**; it appears once per version pair and never comes back for that pair, and Settings still shows the change and a working re-check at any time. Pressing **Set up this project** or **Re-check** twice in quick succession starts one task, never two — the rule is held where the task is created, so it covers the cockpit's three buttons and a project leader's own call alike, and the control reads **Starting…** until the state catches up. Three separate rows — *last observed*, *last offered*, *last successfully checked* — keep the distinction the surface exists for: only a check that finished moves the last one, and a cancelled or failed check leaves it exactly where it was. Missing, corrupt and read-only state are all designed states: the record at `.local/xezar/onboarding-state.json` is disposable local scratch, deleting it loses the history of checks and nothing else, and none of those cases blocks boot or any ordinary task. New routes `GET /api/v1/onboarding` (read-only — it creates nothing) and `POST /api/v1/onboarding/offered`. A project leader gets the same picture through the MCP: `discover_project` carries an `onboarding` block with the three identities and the launch definition to name, and `project_config` gains `dismiss_onboarding_offer`. No new setting, no new environment variable and no file anyone has to create.

- ✨ **Every control in the cockpit's building blocks is big enough to tap, quiet under reduced motion, and readable.** (part of #453, batch 1 of 8) Buttons, fields, menu rows, tab segments, the switch and the dialog and drawer close buttons now keep a 44 px touch area on a phone at **every** density, including Compact and Compact for real, where they used to shrink to 27 px; on a desktop they keep the size they had. Overlays, menus, popovers and tooltips no longer move for anyone whose system asks for less motion, and neither do the loading placeholder or a pulsing status dot. Three colours changed so small text passes the AA readability bar: the faint grey text in both themes, and the label printed on a red button or toast and on the violet Inbox count, which are now dark instead of white. A popover's heading is a real heading, so a screen reader can find it. Four shadcn files nothing imported (card, select, separator, scroll area) were deleted. No setting, no flag, and no page or route changed.

- ✨ **A project leader is told when a task goes quiet — and told, in the same breath, that nothing was stopped.** (#460, PR 3) A leader learned when a task finished, failed, blocked or asked a question, and nothing at all about the long middle: a task that wedged twenty minutes ago and a task working hard looked identical until one of them ended. xezar now watches its own running steps and publishes two advisory events. `task.stalled` says a step has shown no agent activity for **five minutes**, or has used **80 %** of a finite step time limit — two independent conditions, so a busy step still gets warned about an approaching limit, and a quiet one still gets warned about with no limit in sight. `task.resumed` says real activity came back. Both reach the leader the way every other event does, through the pushed channel and `leader_events`, and the task record carries the same observation on the step: when it last showed activity, the time limit it actually spawned with, its deadline, and the current suspicion. **It is an observation and nothing else** — nothing is cancelled, no timeout moves, no status changes, and the wording of every row says so, because the cheapest way to misuse this signal is to read it as a failure. No model is involved: it is arithmetic on timestamps, on a 30-second timer that exists only while a step is executing. There is **no setting and no environment variable** — an advisory that needs configuring before it is useful is not one. Two rules are load-bearing in the detail: the time limit is asked of the backend that is really running the step, so a step with no limit at all is never rendered as one about to expire; and a step xezar has not been watching has **no** activity baseline, so it reads as unknown rather than stalled — the earliest a restarted cockpit can warn about anything is a full five minutes after it starts watching.

- ✨ **A reviewer's verdict is on the task record, in the reviewer's own words.** (#460, PR 2) A finished task told a project leader only that the chain ran to the end — whether anyone had reviewed the work was a question the leader had to answer by going and reading a pull-request comment. A reviewing task now writes one small JSON packet beside its handoff journal after it has posted its review and attempted its labels, and xezar records it on the task when that step settles. `task_read view=task` returns it inside the record it already answers with: the role, the verdict **verbatim** (`APPROVE` / `REQUEST CHANGES` for a code review, `PASS` / `FAIL` for QA, `PASS` / `PASS WITH FOLLOW-UPS` / `FAIL` for a design review — a design review's follow-ups are never flattened into a pass), the full commit sha it was made against, a bounded summary, an optional link to the posted review, and what the label changes actually did. That last part distinguishes "we read the labels and there were none" from "we could not read them at all", because against a fail-open reader those are the same empty list. A new `verdict.posted` event (E-03) is journalled only after the verdict is durably on the record, and the completion event now says whether any verdict is recorded — **an absent verdict is not a pass**, and `task done` on its own still proves no quality gate. Nothing a task reports is treated as proof of GitHub state: the record says the verdict is task-reported, ingestion never touches a forge, and a packet that is oversized, malformed, a symlink, or about another task or step is refused into a bounded note on the record rather than becoming a verdict. A reviewing task is told which step it is running as, through a new `XEZ_STEP_ID` variable on the agent's environment beside the task id and the handoff path, so the packet's step never has to be guessed. Task agents gain no new MCP write capability, and there is no setting, flag or route.

- ✨ **A live view of your tasks, in the terminal you started xezar in.** (#467, PR 3) On a terminal at least 60 columns wide, the bottom few lines are a small table of the tasks that are active right now — their state, the step, the agent, how long they have been going and their title — redrawn in place, at most ten rows plus a count of the rest, and at most four times a second. Above it, one line each time something happens: a task queued, started, finished, failed, cancelled or parked for review; a question, with the cockpit link to answer it; a check that passed or failed, with its exit code when the check reported one; a backend that broke, with a short cause. Nothing spins: a task that is waiting says what it is waiting for, in words. Stopping prints a session summary — how many finished, need review, failed or were cancelled, and how many were still running. **Colour only ever repeats a word that is already there**, so `NO_COLOR=1`, a screen reader and a log file lose nothing. Below 60 columns the table gives way to lines, and the terminal being resized is handled while it runs. Untrusted text — a task title, a path, an agent's own words — is stripped of escape sequences and control characters, bounded in length and scanned for known credential shapes before it can reach your terminal, so a task cannot repaint your screen or forge a log row. Failed HTTP requests are reported as `<status> <method> <route template>` with no body, query string or header, and a burst of the same failure folds into one line and a count. When the output closes, the drawing stops and your tasks and the server carry on.

- ✨ **Four new command-line settings for the terminal, with working defaults.** (#467, PR 2) `--output <auto|lines|rich>` / `XEZ_OUTPUT` / `cli.output`, `--color <auto|always|never>` / `XEZ_COLOR` + `NO_COLOR` / `cli.color`, `--log-level <debug|info|warn|error>` / `XEZ_LOG_LEVEL` / `cli.logLevel`, and `-q/--quiet` / `XEZ_QUIET`. A flag beats a saved value, and a saved value beats the environment — the pattern `followups` and `agentEnvPassthrough` already follow, so a variable exported once in a shell profile cannot outrank a preference you saved. A flag or `XEZ_*` value the vocabulary does not know refuses the start with the accepted values and exit 1, **before** the registry is read, the project writer is claimed or any port is bound; a saved value that is broken degrades to absent with one warning and the file is left as it is. These values are accepted and resolved now and are painted by the terminal renderer that follows — nothing about the current output changes.

- ✨ **`xezar projects port <id> [<port>]`.** (#467, PR 2) Pins the cockpit port of one project, or clears it when you name no port. It is the only writer of that preference: `--port` and `XEZ_PORT` are instructions for one launch and are never saved as configuration. Refused in single-project mode, like `add`, `remove` and `tag`.

- ✨ **Every writer of `~/.xezar/config.json` now takes a bounded cross-process lock.** (#467, PR 2) The atomic write already stopped a torn file; it did not stop a lost update, and two xezar commands that start at the same moment could drop each other's registry row. `serve`, `xezar projects`, the settings routes, migrations and the MCP all inherit the lock by writing through the one merge function. It is fail-open by design: a lock held past its bound, a crashed holder's leftover lock, or a home it cannot be written into all degrade to the previous behaviour with one warning, and never block a start.

- ✨ **A leader attaches itself over MCP, and acks a pushed event without reading.** (#450) `leader_events` gains `attach`, `stop` and `status`: a Claude Code, Codex or pi leader attaches its own session (xezar takes the client from the session, never from an argument), sees whether it is attached and can receive pushes, and stops. It calls the same delivery path as Settings → MCP connection → Attach leader and `POST /api/v1/mcp/leader`, whose bodies, answers and refusal texts are unchanged. Hosted mode refuses attach and stop, and a leader never replaces or detaches a leader that another session or a person attached. An OpenCode leader is still attached by a person, because xezar takes no `opencode serve` address from an MCP session. Each pushed event names its cursor (`next_cursor` on a Claude Code channel message, a sentence in the Codex, OpenCode and pi turn text), so the leader acks it with no read. The bridge registers the Claude Code channel only when xezar says it can push, or cannot be reached yet; `session/open` gains an additive `canPush` answer and `channelAdvertised` parameter within bridge protocol 2. A Claude Code session whose handshake did not register the channel reads `claude-code-channel-not-advertised`, fix: Reconnect the xezar MCP server in Claude Code. An attachment ends when xezar restarts (observed in the restart test): a Claude Code leader whose channel is registered gets one notice from its bridge, and `status` says to attach again. Every instruction, description and blocker a leader reads now names `leader_events` action `attach` instead of the HTTP call. No setting, no environment variable and no new route.

- ✨ **The nightly MCP mutation gate tells new survivors from known ones.** (part of #377) Its report now sorts every surviving and uncovered mutant into three groups: **known** – in the committed starting list `docs/testing/mcp-mutation-survivors.json`, the 2 171 survivors of the first complete nightly run (34999068325 on `fe33541`), with their #338 or #353 tag; **already seen** – in the previous complete run on `main`; and **new**. A survivor is matched by file, mutator and the text it mutates, not by line, so moving code does not make it new. When new survivors appear and the score still clears the floor, the run stays green and the `mutation-nightly` tracking issue gets one comment listing them; the run still fails only below the floor, and the grouping never changes the verdict. One run posts at most one comment, also when its report job is re-run. A new `force_red` input on the manual dispatch skips the shards and takes the red path on purpose, so the path a real failure takes can be proven in minutes. The six-shard split, the summed counts, the one floor and the open/close behaviour of the tracking issue are unchanged. How to refresh the starting list is in `docs/testing/coverage-gaps.md` § 10.8. Fixture-tested; not yet live-verified: the first dispatched run happens after merge.

- ✨ **Xezar's own instructions now suit any project, and a guard keeps it that way.** (part of #466) A released xezar no longer tells users or agents to follow the project it is developed in. The missing-cockpit page now says to reinstall xezar instead of naming a build command of xezar's source repository. `xezar init` writes a `fix-and-verify` workflow whose last step runs the check your project really has (`npm test`, `make test`/`make check`) or, when there is none, reviews the result and reports what it could not verify – never an `echo` that always passes. Its `project-conventions` skill asks for the outcome, deliverables, constraints and evidence, with labeled software, advertising-agency and research examples. The planner and the task namer describe any kind of project, and the planner no longer invents a check command when the project has none. The handoff contract uses general milestones, with Git and GitHub examples only where they apply (every marker is unchanged). The dry-run mocks use a fictional `example-org/example-project` pull request, and Settings → Agents mentions a draft pull request only for a GitHub project and says "Review changes" in its toast. The package description and CLI help name all four agent CLIs. A new vitest guard (`generic-instructions.test.ts`) scans every instruction producer – prompts, init output, the MCP surface, cockpit copy, the npm README and the mocks – and `npm run check:pack` now packs a real archive and scans its text; both carry a small, shrink-only list of known remaining items owned by #448 (README) and the MCP wording work. The published JavaScript and type declarations no longer include source comments.

- ✨ **A red "D" on the logo tells you the cockpit is the development build.** (#442) When xezar runs from a source checkout – `npm run dev`, the checkout's own `dist`, or an `npm link` – the X logo in the sidebar and the phone menu carries a small red badge with a dark "D", announced as "Development build". The released package from npm shows the plain logo, with no badge and no placeholder. xezar decides this by itself (a checkout has `packages/xezar/src/index.ts`, the published package never does), so there is no setting or flag. `GET /api/v1/health` gains a top-level `channel` field, `"dev"` or `"release"`; every other field is unchanged, and `npm run check:pack` now refuses a tarball that would ship `src/index.ts`.

- ✨ **Settings has a little more room, and the design system gains a rhythm scale.** (part of #424) Settings fields now sit 32 px apart instead of 28, and a field's title, control and hint 12 px apart instead of 8, at the default density; Compact and Compact for real scale the same change down. Behind it are six named spacing steps – `row`, `stack`, `list`, `inset`, `group` and `section` (8 to 32 px) – built on the density unit and documented in `docs/design-system/foundations.md` §4.1. No other page changes yet, and there is no setting or flag.

- ✨ **The whole cockpit has more space between blocks.** (part of #424) Page gutters grow from 20 to 32 px on desktop and from 12 to 16 px on phone, and a page body starts 32 px under its header. Cards get 20 px inside and 16 px between them. In a thread, rows of one turn sit 8 px apart and a change of speaker opens 24 px. The run header, composer dock, Inbox, task table cells, provider banner and sidebar groups loosen to match. This is the shipped default with no switch; Compact and Compact for real scale the same spacing down, so no density reproduces the old look. Table rows stay 44 px, and no text size, colour or radius changes.

- ✨ **A new Roomy density.** (part of #424) Settings → Appearance offers Roomy first, at the loose end of the density setting: the spacing unit is 5 px instead of Comfortable's 4, so every gap, gutter and padding is 25 % larger while text stays the same size.

- ✨ **Sidebar rows, the table header and tool rows now follow the density setting, and small chips never drop under 24 px.** (part of #424) At the default density the sidebar nav rows and project headers grow from 34 to 36 px, the New task button from 36 to 40 px, the task table header from 38 to 40 px, a thread's tool row from 28 to 32 px and a quick-list row by 2 px; the brand row gap moves from 9 to 8 px. These were fixed pixels before, so Roomy now grows them and Compact and Compact for real shrink them like everything else. The composer's picker pill goes from 26 to 28 px and the PR/issue reference chip from 22 to 24 px; both follow density but never shrink under 24 px, the WCAG 2.2 minimum target size, so the reference chip in the quick list and on the phone task card grows to 24 px too.

- ✨ **Codex leaders can opt into project-event delivery through their existing local app-server.** (#374, part of #73)
  - Wired: the Codex session's own `xezar mcp` bridge announces only its thread id (Codex passes the MCP server no `CODEX_HOME`). `xezar serve` looks for the control socket in its own Codex home – `CODEX_HOME` when the serve process has one, else `~/.codex` – and trusts it only after the app-server's `initialize` answer names that same home. It attaches only when exactly one thread is both saved for this project folder and loaded, and it is the announced one. It never starts Codex, a daemon or a thread, and it holds the thread's subscription only while it hands an event over, so an exited TUI's thread unloads normally. An approval or question already open at attach, or opened later, is never spoken over. A hand-off whose acceptance was lost is checked against the thread's own turns before anything is sent again, also after a re-attach. After the TUI or the app-server goes, events stay in the journal for `leader_events`, and the cockpit names a recoverable blocker.
  - Measured once with the real bridge, service and a real `codex app-server --listen unix://` (codex-cli 0.154.0, macOS, scripted model endpoint): one event-caused model request and none more in a 30-second quiet window, shown in the person's own TUI; the wrong-home, missing-socket and unloaded-thread refusals; TUI exit and app-server exit.
  - Fixture-tested only: open prompts at attach, lost acceptance and replay, request counting.
  - A real model's decision to react was verified on 2026-09-15 with the owner's own Codex login (`gpt-6-astra`, see the 📝 entry for #67). Not verified: Linux and Windows; other codex-cli versions; a Codex session whose home differs from the one `xezar serve` looks in – it is refused and falls back to `leader_events`.
  - A thread status the app-server sends in a shape xezar does not recognise now holds events, and keeps an open approval's wait, until a status it can read arrives. It used to read as "idle" and could start a turn through an open approval. This includes a status whose `activeFlags` list holds an entry xezar does not recognise, such as an object or an unknown word: at attach it is refused as `codex-thread-state-unknown`, and while attached it keeps the wait.

- ✨ **Settings → MCP connection can attach a leader.** (#374) Connection status shows who owns the project, whether a leader is attached and, when events are waiting, the server's own reason with a `Fix:` line. Attach leader takes its client from that status: a Codex session that runs on Codex's shared app-server in the Codex home xezar uses, is loaded, and has called a xezar tool attaches without typing anything, OpenCode takes the address and session id of its `opencode serve`, pi works when it runs xezar's leader extension, and Claude Code attaches once it was started with `--dangerously-load-development-channels server:xezar` (below). A refused Codex attach names which cause it was – no tool call yet, no shared app-server, another Codex home, a session that is not loaded, or a session state xezar does not recognise – with its own fix. The Codex setup card moves its attach guidance out of the small footnote into the card body. When the project's owner changes under an attached leader – a Claude Code leader whose session closed, then a Codex session that took the project – the server keeps the attachment and names `claude-code-not-owner`; the control then shows its client selector again, defaulting to the new owner, and Attach leader replaces the stale attachment with the client you choose. Fixture-tested in the cockpit's unit suite; the real-client Codex leg attaches through the same route the button calls. `GET /api/v1/mcp/leader` gains an additive `owner` field.
  - The status is live while the page is open. The server pushes each change – a leader attached or stopped, an owner session that opened, announced itself or went away, a delivery that worked or failed, an app-server or thread that was lost – over the cockpit's existing WebSocket as a new `mcp-leader` topic, only while the page is on screen and only when something changed. It is also re-read when the window regains focus and after the event stream reconnects. A remote cockpit opens no WebSocket and keeps the HTTP read. Refresh is in every state, including when the first read fails and when the MCP service is not running, and Attach leader is a 44 px touch target on a phone.

- ✨ **A Claude Code leader can be woken by a project event, over Claude Code Channels.** (#374, part
  of #73) Until now a project leader you run pulled its events with the `leader_events` MCP tool and
  nothing was pushed to it. A **Claude Code** leader can now be **woken**: xezar turns a project event
  into a `notifications/claude/channel` message in the running session. Nothing is pushed until a
  leader is attached, and xezar gains no setting and no environment variable; an attached leader
  receiving pushed events is the normal path, and the `leader_events` pull is the fallback (#439).
  For Claude Code the other switch is a flag you add when you launch it from the project root:
  `claude --dangerously-load-development-channels server:xezar`. That flag is how Claude Code lets a
  server that is not on Anthropic's approved list push messages into your session, and **Claude Code
  shows a warning on every launch** with it — choose "I am using this for local development" if you
  accept it. Then the leader attaches itself with `leader_events` action `attach` (#450), or a
  person uses **Attach leader** in **Settings → MCP connection** → Connection status, the same
  control that attaches Codex, OpenCode and pi. Channels are a Claude Code
  research preview: they need a claude.ai or Anthropic Console API-key login, they do not work on
  Amazon Bedrock, Google Vertex or Microsoft Foundry, a Team or Enterprise admin must turn them on,
  and they are off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. When a condition is not
  met the event is never lost — it stays in the journal and the cockpit shows a recoverable reason
  (`claude-code-push-unconfirmed`, `claude-code-not-owner`, `claude-code-bridge-too-old` or `claude-code-channel-not-advertised`) naming
  what to change. xezar never declares Claude Code's permission-relay capability and never answers an
  approval on your behalf. Starting a real model turn from a project event is now wired for Claude
  Code, pi and OpenCode.

Launch with `claude --dangerously-load-development-channels server:xezar` to let xezar wake this leader. The flag lets a custom server push messages into your session because custom servers are not on the channel allowlist. Claude Code shows a confirmation screen on every launch: choose “I am using this for local development” if you accept it. The feature-flag service must be reachable and enable Channels. A Team or Enterprise admin must enable Channels. Channels need a claude.ai or Anthropic Console API-key login, do not work on Bedrock, Vertex or Foundry, and are off while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.

**`claude-code-not-owner`** — The MCP session that owns this project is not a Claude Code session, so there is no Claude Code leader to push events to. Events are kept in the journal.

fix: Start Claude Code in this project with --dangerously-load-development-channels server:xezar, let it call a xezar tool once, then attach it again.

**`claude-code-bridge-too-old`** — This Claude Code session is connected through an older xezar MCP bridge that cannot push events. Events are kept in the journal.

fix: Restart Claude Code so it starts the current xezar bridge (npx -y @qodeca/xezar mcp), then attach it again.

**`claude-code-channel-not-advertised`** — This Claude Code session connected while xezar could not push to it, so its xezar MCP server did not register the channel and a pushed event would never reach the model. Events are kept in the journal.

fix: Reconnect the xezar MCP server in Claude Code (/mcp, then reconnect xezar) or restart Claude Code while the cockpit runs, then attach it again (from Claude Code: leader_events with action attach). Until then, read events with leader_events.

**`claude-code-push-unconfirmed`** — xezar pushed events to the attached Claude Code session, and they are not acknowledged yet. Claude Code does not confirm delivery, so xezar cannot tell a leader that is still working from one that never received them. Nothing is lost: the events stay in the journal.

fix: If the leader is working, nothing is needed. Otherwise check that Claude Code was started with --dangerously-load-development-channels server:xezar and that its startup notice says channels from server:xezar inject into the session. Channels need a claude.ai or Console API-key login, do not work on Bedrock, Vertex or Foundry, must be enabled by a Team or Enterprise admin, and are off while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set. Until then, read events with leader_events.

- 📝 **The development process now checks itself: security before the verdict, a phase record readiness refuses without, and repair counters that survive a resume.** (part of #469, P2) Nothing about the published package changes — this is xezar's own `.xezar/` kit and its root contracts. `.xezar/checks/security-scan.sh` is a new gate 2 of the canonical run, straight after the install and ahead of every gate that produces a quality signal: it reads the lines this candidate added over its base, records one entry per check as `pass`, `findings`, `unknown` or `not-applicable`, and writes a structured `security.json` into the gate attempt. Sealing refuses an attempt that carries no such result, the seal records its status, and `unknown` is carried as `unknown` — it is never rewritten into a pass. `.xezar/checks/phase-record.sh` writes and validates the phase record `SDLC.md` § Task phases names, and `worktree-preflight.sh --readiness` now refuses a writing task whose record is incomplete, with the predicate and the command that fixes it; the accepted-criteria record is validated rather than counted, so a file that names no criterion and no accepting authority is not acceptance. The same command owns the three durable repair counters: a round is counted before it is applied, an exhausted counter or an unreconciled history blocks another one, and `resume-complete.sh` refuses to re-run the gates on a spent `gate-return` budget — a resume continues the count and never starts a fresh allowance. The eight-step workflow shape and the five validation commands in `.xezar/pipeline/config.json` are unchanged.

- 🚀 **The MCP mutation gate runs nightly on GitHub Actions.** (part of #377) A new
  `.github/workflows/mutation.yml` runs `npm run test:mutation:mcp`'s scope against `main` every
  night and on manual dispatch – never on a pull request and never in the release path. The scope
  is split across six parallel jobs so no job meets GitHub's 6-hour limit; each job runs with no
  floor of its own, and one aggregate step applies the unchanged 80 % `thresholds.break` from
  `packages/xezar/stryker.config.mjs` to the summed counts. It fails closed on a missing or broken
  shard report, a shard or run that tested nothing, and a file reported twice, outside its shard or
  never. On `main` a red night files, comments on or reopens one `mutation-nightly` issue, and the
  next green night closes it. The scripts live in `packages/xezar/mutation/`, outside the npm
  tarball. `publishing-surface.test.ts` now forbids publish power by role – only `release.yml` may
  hold `id-token` or a publish command – instead of pinning the list of workflow files. Not yet
  live-verified: the first dispatched run on `main` happens after merge. Telling new survivors from
  known ones is the second half of #377.

- ✨ **The project kit can author and review designs as separate tasks.** The design workflow
  produces mockups and a handoff; design-review reads the result and records its verdict without
  editing it. (#389)

- ✨ **Terminal activity and project port behavior have an implementation design.** Text mockups
  cover wide terminals, narrow terminals and pipes, with a handoff for the later CLI implementation.
  (#467, #482)

- ✨ **First setup and post-update re-checks have reviewed mockups.** The design covers the task-page
  entry and Re-check / Later offer, with a developer handoff; this PR itself changes no product
  code. (#464, #489)

- ✨ **The project kit can run the shared issue-creation procedure.** Its local wrapper adds
  repository policy to the pinned reusable skill while retaining the draft and approval boundary.
  (#468, #493)

- ✨ **New issue starts a drafting task from the GitHub tab.** The dialog identifies the destination
  and launches the issue-filing skill with the supplied brief. The task asks Create or Revise
  against the proposed title, body and labels before filing, and MCP can launch the equivalent task.
  (#468, #502)

Merged PRs for the preserved entries above: (#403), (#404), (#432), (#433), (#437), (#438), (#441),
(#444), (#474), (#481), (#486), (#488), (#495), (#497), (#500), (#503), (#504), (#505), (#510),
(#511), (#512), (#519), (#522), (#523), (#528), (#529).

## 🐛 Fixes

- Fixed: a standalone `XEZ:DONE` line before a final-turn checkpoint stops autonomous nudges (#524), while fenced examples never count.

- Fixed: Continue resumes the failed workflow step and remaining steps after repair, and reports success only after the workflow finishes (#520).

- Fixed: known MCP `applied:false` refusals replay as rejected after retry or restart (#536).

- Fixed: replacing a pending question invalidates and persists the MCP decision token (#534).

- Fixed: #449 — decision-only run versions keep busy-task steering valid while detecting reversed decisions.

- Fixed: #530 — rejected operations cannot claim or suppress later task outcomes.

- fix(runners): keep timeout SIGKILL escalation armed until Claude and Codex child processes exit (#462)

- 🐛 Keep contract test declarations out of the published package, and make the archive gate reject test artifacts if they return. (#466, P7)

- 🐛 fix(release): stage the web manifest in version-bump PRs so main keeps every stamped release manifest aligned (#461).

- A live task now stays pinned to its tail when the late current-state response mounts the Plan and Agents docks; slower machines no longer leave the thread exactly 130 px above the bottom.

- 🐛 fix(test): the Claude Code adapter's source guard (no process, no environment – #311) now ignores the helper functions Stryker injects into the file it reads, so the nightly mutation run's dry run no longer fails on Stryker's own `process.env` read; a real `child_process` or `process.env` in the adapter still fails it (#436, #377).

- 🐛 Stamp the private cockpit workspace and its internal dependency ranges during releases, so minor and major bump PRs keep npm workspaces linked. (#382)

- 🐛 **MCP integration harnesses now use the port actually bound by xezar.** (#325)

- 🐛 **A xezar tool gated behind pi-mcp-adapter's `approveTools` no longer stalls a pi run.** (#369) pi's
  approval dialog (`extension_ui_request`, `method: "select"`, no `timeout`) blocks pi until a client
  answers it, and xezar's pi runner never did: a step that reached a gated tool died on the runner's
  timeout, and a leader turn nobody was watching waited for ever. The runner now answers it. In an
  autonomous run it refuses at once with `Deny` and records the refusal in the transcript, so the model
  sees `approval_denied` and the turn ends. In an interactive run the dialog reaches the cockpit as a
  question card carrying pi's own choices (Allow once / Allow for session / Deny), and the answer goes
  back to pi on its own sub-protocol, correlated by the dialog's id; a reply that names none of them
  dismisses the dialog rather than guessing. A choice longer than the card's 60-character label is
  shown shortened and still answered with pi's full value, a choice with a comma in it is one
  choice, and two choices that differ only by case are answered as the one clicked. A dialog the card cannot show (`input`, `editor`, or two choices that would read as one
  label) is dismissed at once, and a dialog still open at session close or interrupt is dismissed before the
  process is. pi-mcp-adapter's `notify` notices (`MCP: 1 servers connected`) now appear as transcript
  notes. A pi that is never offered a xezar tool is unchanged, and a leader in your own pi window was
  never affected; a headless pi that some other RPC client drives remains that client's to answer.

- 🐛 **The `bug-fix` workflow now names and instructs its only writing step as the complete
  repair stage.** (#408) Agents are told to reproduce, add the red test, apply the fix, run
  focused tests and commit before finishing, instead of deferring the repair to a nonexistent
  later step and then failing readiness with an empty branch.

- 🐛 **Two project-kit readiness checks no longer fail correctly-completed work.** (#356, #402)
  Independent QA of another PR always ended `failed` — reviewing a PR's head detaches HEAD, and the
  kit's `branch.owned-by-run` check refused that before the PR's `VERIFICATION` record was ever
  read. A new read-only `qa` kit workflow (shaped like `code-review`) never runs that check at all.
  Separately, `address-review-findings` ended `failed` after correctly pushing its fix to the PR's
  own branch, because readiness only recognised commits on the run's own branch; it now recognises a
  `DELIVERED` record naming the branch, the pushed commit and the commit it was fixing — verified
  LIVE against `git ls-remote origin`, never a local or remote-tracking ref, since either of those
  is writable by the same agent the check exists to hold accountable and proves no push at all
  (#416 review).

- 🐛 **Two flaky tests no longer race a live child process during their own teardown.** (#326, #346)
  `skills-remote-git.test.ts`'s fixture commits armed git's detached auto-maintenance, whose
  `objects/maintenance.lock` vanished between `git clone --bare`'s stat and copy of the source
  `objects/` directory — the fixture now commits with `-c maintenance.auto=false -c gc.auto=0`.
  `mcp-upgrade.test.ts` (A-16) created a `mock:done` task and never waited for it, so the mock agent
  CLI it spawned as a child of the cockpit kept appending `notes.md` to the project root after the
  cockpit was SIGKILLed, colliding with the teardown `rm`; the test now waits for the run to reach a
  terminal state before the cockpit is stopped. No product behaviour changed.

- 🐛 **The cockpit's take-over hint now shows the correct CLI for each backend.** The pi runner
  was silently falling through to `claude --resume` instead of showing `pi --session`. A Node-free
  helper in the shared contract now builds both the cockpit hint and server handoff command, with
  an exhaustive runner switch that makes an unmapped backend fail typecheck. (#354)

- 🐛 **The 0.14.0 changelog distinguishes wired delivery from measured reactions.** Its historical
  claims are corrected to identify the clients that actually had a wake path in that release; the
  original package, tag and GitHub Release are unchanged. (#383, #398)

Merged PRs for the preserved entries above: (#409), (#411), (#412), (#413), (#416), (#417), (#418),
(#440), (#514), (#526), (#527), (#531), (#539), (#541), (#543).

## 🔧 Changed

- 📝 **`SDLC.md`, `CODE_REVIEW.md` and `CONTRIBUTING.md` name the kit roles.** (#396) The process documents
  name the `.xezar/workflows/*` workflows and `xezar-*` roles that run this repository's pipeline
  instead of the previous team skill names, and the optional `xez-*` collection only where a
  document describes it. Links to the pre-rename issue tracker were replaced with plain
  `pre-rename issue n` text across the maintained documents.

- 🚀 **The pipeline files moved to `.xezar/pipeline/`.** (#396) `.ai/agentic.config.json` is now
  `.xezar/pipeline/config.json` and `.ai/trackers/github.md` is `.xezar/pipeline/trackers/github.md`;
  the `.ai/` directory is gone from the repository, and `pipeline` joined the fingerprinted kit set
  (`tree_fingerprint` in `.xezar/checks/lib/common.sh`).

Merged PRs for the preserved entries above: (#396).

## 📝 Specs & Documentation

- docs(guide): getting started and project kit pages for the onboarding flow – guided setup, re-check offer, project and machine configuration, optional agent pipeline (#464, P4)

- docs(guide): make the MCP project-leader guide the canonical per-client setup, launch, delivery and recovery reference (#515, PR 1)

- docs(guide): filing an issue from the cockpit and the issue-filing skill (#468, step 4)

- docs(project): leader run guidance for contributors – per-client pointers and kit tips (#515, PR 2)

- ✨ **A leader that lost its context is told how to get its events back.** (#460, PR 1) After a context compaction a project leader cannot know which pushed messages it still holds, and xezar re-pushes nothing on a timer — so the recovery is a read, and xezar now says so where a leader actually reads it: in the `leader_events` tool description, in all three MCP `initialize` instruction variants, and in the README and the MCP API reference. The wording is the same everywhere: after a compaction call `leader_events` with action `read` and no cursor, page through with `nextCursor` while `hasMore` is true, deduplicate by `eventId`, reconcile the current task state, then acknowledge only what you accounted for — a transport receipt is not an acknowledgement — and if the journal reports a gap, reconcile the returned current state before acknowledging `resumeCursor`. Do not poll while idle. The guarantee is now stated as it is: **at-least-once within retained durable state, not exactly-once**. The journal keeps at least the newest 10 000 events per project and evicts none younger than 14 days, a page carries at most 100 events or 40 000 bytes, anything outside that is an explicit gap rather than silence, only `ack` advances the acknowledged position (and it is cumulative, monotonic and idempotent), and nothing already delivered to a session is pushed again on a timer. Text and documentation only: no behaviour, schema, action, answer or retention value changed, and there is no new setting, flag or route.

- docs(kit): model routing map for the project leader (`.xezar/docs/model-routing.md`, loaded through `CLAUDE.md`)

- 📝 **The 0.15.0 user guide has a complete index and navigation.** (part of #448) All 16 parts are linked from the guide index, with cross-part and Next links, and the README and documentation map point to the guide.

- 📝 **A project leader works through the MCP tools only, attached so events are pushed.** (related #439) The owner's operating rule of 2026-09-15 is now stated in the README, `AGENTS.md`, the MCP API reference, the dogfooding findings and the `.xezar` kit: a leader uses the xezar MCP tools, never the cockpit UI or the HTTP API; it is attached so events arrive as `<channel source="xezar">` messages (a started turn for Codex, OpenCode and pi); `leader_events` is the fallback for a leader that is not attached; `gh` stays the way to read GitHub facts. The strings a leader reads follow it: the MCP `initialize` instructions and the `leader_events`, `discover_project` and `health` descriptions no longer promise pushes to an unattached session and name the attach door (Settings → MCP connection → Attach leader, or `POST /api/v1/p/<projectId>/mcp/leader {"action":"attach","client":"claude-code"}` against the cockpit, with `<projectId>` from `discover_project` and the leader's own client – OpenCode also sends `baseUrl` and `sessionId`), the `no-leader-session` blocker names it too, the role text pushed with each event states the rule, and a tool that is not connected tells the leader to report the blocker instead of using the cockpit. No behaviour changes; there is still no MCP action that attaches a leader. #450, in this release, adds that action (✨ above), and the strings now name it instead of the HTTP call.

- 📝 **Staleness sweep area A: root contracts.** (#447)

- 📝 **MCP real-model leg for A-19 passed post-release on pi.** (#373) The manual measurement uses the bare model id and verifies nonce/cursor acknowledgement. The logged revision is `7aa4a0258cd99852ff0a6878dff1c96257f49024`, stamp `2026-09-13T17-43-42.875Z`, model `deepseek-v4-flash-vision`, and the ack arrived +15.8 s after delivery in a 120 s window.

- 📝 **MCP real-model leg for A-19/A-23 passed for Claude Code and Codex.** (part of #67) On revision `a6d53b4bccfe07803a792c54ff335432d4ad0b49` (`main` at `ab28cb0` plus test-only commits), a real model read a delivered `task.done` event and acknowledged it through `leader_events` with the exact run-id nonce and the cursor of its own read: Claude Code 2.1.272 with `sonnet` over Channels (stamp `2026-09-15T10-42-29.522Z`, ack +8.6 s) and Codex CLI 0.154.0 with `gpt-6-astra` through its shared app-server (stamp `2026-09-15T10-41-35.784Z`, ack +11.9 s), each with the owner's own login. OpenCode is out of scope for this clause by the owner's decision of 2026-09-13 (#340). The Definition of Done record now reads 8 of 8, clause 2 by the owner's acceptance of 2026-09-15: the rows span three revisions and never all passed on one.

- 📝 Leader dogfooding record of the 2026-09-13 MCP campaign: findings, trust ledger per model, gate cost, close-out and numbers (`docs/features/mcp-server/leader-dogfooding-2026-09-13.md`).

- 🚀 Extend that harness with opt-in Claude Code and Codex real-model legs (`XEZ_REAL_MODEL_CLIENTS`) that drive a real `xezar serve` and judge the ack on the wire through a pass-through stdio tee and in the service's `leader-cursors.json`. (part of #67)

- 📝 **The cockpit design system and quality-checks mockups are documented.** Tokens, components and
  patterns now have a shared reference and static specimens, with a drift test to flag missing
  documentation. The quality-checks pages are designs, not a shipped screen. (#384)

- 📝 **UI changes have an explicit design-review gate in this repository.** The development process
  and merge policy distinguish design approval from QA approval and record the applicable labels.
  (#385)

- 📝 **Review checklists and templates ask for design evidence.** UI review guidance now covers
  states, phone layouts, shared components and documentation alongside the existing code checks.
  (#386)

- 📝 **Design contributions have criteria and a documented lifecycle.** The reference explains token
  and component proposals, deprecation, decision records and the transitions from draft mockup to
  implemented or archived design. (#390)

- 📝 **The first quality-checks design review is recorded with its findings.** The design remains in
  review, and the review skill now explicitly ends its turn after delivering a verdict. (#393)

- 📝 **The quality-checks mockup uses the Xezar name.** The collapsed-project example no longer names
  the previous team skills source. (#395)

- 📝 **A Codex wake-path decision record separates measurement from implementation.** It records
  external-turn delivery into an existing TUI through a shared app-server, with isolation limits and
  a bounded quiet-window measurement. (#400)

- 📝 **The Claude Code Channels wake-path investigation is documented.** The record describes
  measured event-triggered turns and the conditions required to deliver them to an existing leader
  session. (#374, #401)

- 📝 **The OpenCode wake-path record identifies what already works and what is missing.** It
  documents a measured prompt delivery and quiet window, while keeping discovery and attachment
  limitations explicit. (#374, #405)

- 📝 **Four release and testing documentation claims are corrected.** The prose now reflects the
  removal of mutation testing from the release path and the evidence from its QA review. (#379,
  #406)

- 📝 **The leader campaign record captures a missing product-approval check.** It records that an
  attachment control passed technical review without establishing owner demand; the proposed process
  improvement is not presented as implemented. (#423)

- 📝 **Decision handling and roomier layouts have design proposals.** Static mockups and requirements
  describe an owner decision gate and the cockpit spacing proposal. This PR adds no application
  behavior. (#425)

- 📝 **The spacing proposal has full-page before-and-after mockups.** The comparison provides the
  design-review input for the later spacing rollout without changing the product stylesheet. (#424,
  #429)

- 📝 **The README has themed product graphics.** Hero, architecture and lifecycle SVGs and a
  consistent icon set provide the assets for the product overview. (#448, #452)

- 📝 **The user guide explains backends, workflows and skills.** Three chapters cover the available
  agents and how task workflows and skill discovery fit together. (#448, #454)

- 📝 **The user guide covers installation and the first task.** The opening chapters also explain
  task controls, review, isolated working copies, retention and Git. (#448, #455)

- 📝 **Campaign notes have a durable home and a recovery format.** The development process records
  decisions, open work and next steps across sessions and context compaction. (#456)

- 📝 **Design-system users have a reading route and verification matrix.** Source-backed walkthroughs
  distinguish phone touch targets from chip floors and connect implementation changes to evidence.
  (#453, #457)

- 📝 **The documentation gains reproducible cockpit screenshots and a tour GIF.** A capture harness
  uses isolated state and scripted agents to produce the recorded views. (#448, #458)

- 📝 **The user guide covers GitHub, automations, inbox, projects and settings.** These reference
  chapters describe the existing controls and their source-checked availability and limitations.
  (#448, #459)

- 📝 **Issue creation has a documented reusable contract.** It defines draft contents, authority
  modes, questions and receipts; selecting or launching a skill alone does not authorize filing.
  (#473)

- 📝 **Onboarding has a documented reusable contract.** It defines minimal project writes and
  customization-preserving re-checks, with inspection and preview separated from approval to apply
  changes. (#475)

- 📝 **Project-kit documentation is reconciled with current behavior.** Workflow counts, pointers and
  qualification limits are corrected while historical observations retain dated updates. (#447,
  #476)

- 📝 **The documentation tree has a source-backed staleness sweep.** Setup, implementation,
  acceptance and testing claims are corrected, and retired pilot material is removed or relocated as
  recorded. (#447, #477)

- 📝 **The README becomes a concise product overview with a tour and guide links.** Contributor setup
  moves to the contributor guide, and npm README generation also rewrites picture source sets.
  (#448, #479)

- 📝 **Configuration, CLI and MCP leader references are available in the user guide.** Three chapters
  document the existing settings and operational interfaces. (#448, #480)

- 📝 **The user guide covers remote access and troubleshooting.** The final chapters explain project
  kits and common recovery paths alongside remote usage. (#448, #483)

- 📝 **Design lifecycle and storage responsibilities are documented.** The guide assigns transitions,
  evidence, capture provenance and retirement to their corresponding roles. (#453, #484)

- 📝 **The design system includes recipes for common cockpit surfaces.** Task tables, threads,
  settings, overlays and state markers link back to their source, interaction rules and verification
  evidence. (#453, #485)

- 📝 **Release guidance requires instructions that suit any project.** The repository rules
  distinguish client capabilities from project-specific process and require producer-guard and
  packed-archive evidence. (#466, #490)

- 📝 **The development contract names task phases and durable repair limits.** It distinguishes
  accepted criteria, self-review and independent evidence, and requires security assessment before a
  quality verdict. (#469, #492)

- 📝 **Design-system documentation reflects the delivered spacing work.** The inventory, coverage
  claims and mockup statuses are reconciled with source, while the original proposal remains dated
  history. (#447, #494)

- 📝 **The New issue flow has a design and developer handoff.** Static mockups describe the
  GitHub-tab entry, drafting dialog and ordinary task launch without implementing the control in
  this PR. (#468, #496)

- 📝 **Design entry points lead to the same maintained guidance.** Skills and workflows route authors
  and reviewers through usage, verification, recipes, lifecycle and storage documentation. (#453,
  #498)

- 📝 **Authorship and project lineage are stated consistently.** Licences, the README and package
  metadata name Qodeca, retain the open-mercato/cezar lineage and update release-text checks. (#499,
  #501)

- 📝 **The leader model-routing guide includes recent operating findings.** It records explicit
  action boundaries, checks against the exact revision and whole-workflow verification after
  quota-related continuation. (#516)

Merged PRs for the preserved entries above: (#414), (#422), (#434), (#451), (#465), (#487), (#491),
(#508), (#509), (#517), (#518), (#521).

## 🚀 CI/CD & Infrastructure

- test(engine): cover MCP–leader engine incidents, nudges, continuation and quota clocks (#532 slice 2, G7/G8/G9; supersedes #538).

- test(mcp): cover fragile leader delivery, causal outcomes, decision tokens and receipt replay invariants (#532, slice 1).

- 🚀 Add an opt-in pi real-model MCP harness that judges a delivered event by its exact nonce/cursor acknowledgement, with a scripted request-only negative control. (#373)

- 🚀 **Automated checks catch undocumented colours and incomplete design handoffs.** Colour guards
  flag unsupported tokens and inline colour functions, and a browser sweep checks accessible names,
  focus and overflow. Existing warning colours now use the documented conflict token. (#391)

- 🚀 **Skill fixtures use the current xez-* names.** Unit and browser examples now match the default
  collection, including the search and caret expectations affected by longer names. (#397)

- 🚀 **A design guard prevents new arbitrary spacing values.** An explicit occurrence allowance
  retains existing debt, while fixture controls verify both rejected and permitted spellings. (#431)

- 🚀 **The development kit records its selected local OpenCode model.** Keeping the chosen setting in
  the kit prevents new task snapshots from disagreeing with the installed configuration; published
  runtime defaults are unchanged. (#513)

Merged PRs for the preserved entries above: (#407), (#533), (#542).

---

# 0.14.0 (2026-09-12)

## Highlights
The headline is the **MCP project leader**: a coding agent can now drive a xezar project from the
outside. `xez mcp` is a new subcommand — a stdio bridge to the cockpit you are already running —
and through it an agent can read tasks and evidence, create and organise work, control execution,
hand work onward through git and GitHub, and change project settings, with one owner per project,
version-checked writes, retry-safe operations and an audit trail. It works with Claude Code, Codex,
OpenCode and pi for reading and driving a project; starting a real model turn from a project event
is wired for pi and OpenCode only (see #73). The cockpit gains two new Settings sections for it:
**MCP connection** and a browsable, read-only **MCP API** reference. The rest of the release is a
long run of safety fixes around worktrees, secrets, cancellation and the project kit, plus the
repository's first security policy, contribution path and code of conduct.

## ✨ Features
- ✨ **A coding agent can now lead a xezar project over MCP.** `xez mcp` is a new subcommand: the
  stdio MCP endpoint an agent spawns. It starts no server and opens no port — it talks to the
  cockpit you are already running over a private per-project socket in your own home folder, so
  there is no token, no port and no configuration to author. The session is bound to one project by
  that socket, and a call that names a different project still answers the bound one. Through it a
  leader does the work you do in the cockpit: discover the project, its capabilities, its limits and
  the reason any action is unavailable; read tasks, history, the Inbox and variant groups; create a
  task with full composer-form parity; organise work (queue, title, brief, pin, archive, delete,
  variants); control execution and send a message into a running session; read a task's result and
  evidence identified by revision; hand work onward with commit, push, draft PR, merge and branch;
  read and change project configuration behind the settings boundary; and ask for the
  local-machine handoff, which is reported honestly and keeps the goal and the Definition of Done
  with you rather than with the model. Every operation goes through one shared service adapter and
  one ownership check, so a nested id or a bulk list cannot reach another project's resource.
  (#86, #87, #88, #89, #90, #91, #92, #93, #94, #95, #96, #97, #98, #213, #214, #215, #217, #222,
  #223, #224, #225, #226, #227, #228, #230, #231, #243, #247)
- ✨ **A leader's write cannot silently overwrite yours.** Every MCP read of a task returns a
  version token, and every mutating MCP tool action requires it back as `expectedVersion`. When the
  stored state moved on in between, the call is refused with `stale_version`, nothing is written,
  and the refusal is audited. The same guard reached fifteen single-task HTTP routes as an
  **optional** field, so the cockpit behaves exactly as before, and `GET /api/v1/runs/:id/version`
  reads the token on its own. One measured limit: a running task's version moves with every agent
  event, so cancelling a busy task through MCP may need a re-read and a retry. (#100, #216, #250,
  #258)
- ✨ **Every MCP operation is recorded.** `mcp-audit.ndjson` holds one row per call: what was
  asked for, the resource it touched, its operation key, and an origin the server derived rather
  than one the caller claimed. It carries no secrets — the host's own secret values are scrubbed
  before a row is written — and no account identity. (#102, #220)
- ✨ **The project keeps an event journal, and a leader reads what it missed.** Every significant
  thing that happens to a project — the E-01 to E-06 catalog — is written to a per-project journal
  with its origin, the versions it changed and a replay cursor, including the config, workflow and
  agent-config edits a human makes in the cockpit. A new `leader_events` tool reads the rows after
  the leader's acknowledged cursor together with the current state of the tasks they name, and
  acknowledges them; the acknowledgement only ever moves forward, an unacknowledged row is offered
  again, and rows the journal has dropped are reported as an explicit gap rather than replayed
  partially. Another project's cursor is refused, and the host's own secret values are scrubbed on
  the way out. (#103, #104, #105, #221, #232, #233, #251, #252, #254)
- ✨ **A leader's changes reach your open cockpit, and it never hears its own echo.** A change made
  through MCP updates every open cockpit view live, over the connection that is already there, and
  the leader that made it is not told about it again. A non-model event controller owns the logical
  project session, so the bookkeeping happens without spending a model turn. (#106, #107, #234,
  #235)
- ✨ **A project event can start a real turn in pi and OpenCode.** Each has a reaction adapter
  measured against the real client rather than a mock: pi through the leader extension's socket,
  OpenCode over `opencode serve`. Claude Code and Codex have their adapter groundwork in
  `src/mcp/adapters/` but no attach path reaches them — `LeaderDelivery.#act` admits `pi` and
  `opencode` only, and the acceptance case is recorded BLOCKED for every client
  (`mcp-definition-of-done-record.md`). Finishing them is #73 / #374. (#108, #109, #110, #239,
  #241, #244)
- ✨ **MCP connection is a section in project Settings.** It shows the project the connection is
  bound to, that it works on this machine only, what a leader can and cannot do and the limits that
  apply, and the one-time setup for each client. It does not show whether a client is connected or
  how a leader's operations turned out: no route reports either yet, so the page says who does
  instead of guessing, and the empty outcomes list is left out (see the MCP API fix below).
  (#111, #112, #113, #114, #236, #245, #246, #255)
- ✨ **A pi leader can now be woken by a project event.** xezar has a pi reaction adapter, so a
  significant event can start a real pi turn that carries it — no polling, no "anything new?" turn.
  It uses pi's own session interface: it prompts pi when pi is idle, and steers when pi is in the
  middle of a turn, which never cuts that turn short. The event says in so many words that it comes
  from xezar and is not an instruction or an approval, and it carries your leader's role every time,
  because pi does not keep one across a resume. A leader never hears the echo of its own change, an
  event is never put to the model twice — not after a lost answer and not after xezar restarts — and
  xezar's liveness check reads pi's session state without waking the model. One honest limit,
  measured against pi 0.85.1 over the extension: an event handed over while your pi is working is
  queued rather than sent, and goes to the model once the turn in flight has finished — including
  whatever tool that turn is running. Measured twice, because the two halves of a turn take
  different lengths of time: the event waited 16 seconds behind a 20-second model call, and 20
  seconds behind a 25-second tool. Each time it reached the model in the next turn of the same run,
  before that run ended; xezar will not cut a turn short to deliver an event. It also never takes
  pi's "accepted" for "the model has it": every handover is checked against pi afterwards, and an
  event xezar cannot confirm reached the model is handed over again rather than counted as
  delivered. (#330, #358)
- ✨ **And a pi you run in your own terminal can now be reached.** pi speaks its session interface
  over its own input and output only, and xezar never starts an agent process for you, so until now
  a pi you started yourself had no address and got no push. xezar now ships a small pi extension:
  load it, and your pi tells xezar where to reach it, for this project only. Then a project event
  wakes that pi for real — measured end to end against pi 0.85.1, with nobody typing anything. It is
  yours to opt into: without the extension nothing changes, asking to attach answers with pi's own
  reason and tells you how to fix it, and that pi keeps reading its events with `leader_events`. The
  extension answers xezar and forwards pi's own events; it reads none of your files and opens
  nothing to the network. Its socket lives in a private folder only your own account can open, so
  nobody else with a login on the same machine can read your leader's conversation or type into
  it. (#330)
- ✨ **Project events can now be pushed to a leader you attach.** The event controller and the
  reaction adapters were built and tested but never connected, so no event ever reached a client.
  Now every MCP session that owns a project gets push delivery the moment it opens — nothing to set
  up. An event can only wake a session xezar can address, so a new route,
  `POST /api/v1/mcp/leader`, attaches the OpenCode session you run with `opencode serve` (or
  detaches it), and `GET /api/v1/mcp/leader` says what is delivered and, when nothing can be, why.
  xezar never starts an agent process for you. A Claude Code or Codex session in your terminal has
  no address to attach to, so it gets no push: it reads its events with `leader_events`, as before.
  A leader never receives the echo of its own change, and each event sent to OpenCode allows only
  the `xezar_*` tools — OpenCode keeps that rule on the attached session, so your own messages in it
  get only the xezar tools too. Attaching is refused, and the status says why, when the project's
  event journal cannot be written. An attached leader whose MCP connection has not opened yet is
  reported as such, instead of as nothing wrong (#331), and what the leader acknowledged with
  `leader_events` is never pushed to it again, not even into a fresh session (#332). Events that
  arrive before the leader's first MCP session are pushed when it opens, and the delivery status
  and `leader_events` report only what really happened — nothing delivered, acknowledged or
  reacted to is ever claimed for a row that was not, and a leader that stops answering (even one
  that still accepts connections) is reported as soon as an attempt fails, whatever the delivery is
  doing. There is no cockpit button yet. (#309, #311)
- ✨ **pi has a setup card in MCP connection.** Project Settings → MCP connection now shows pi's
  one-time setup next to Claude Code, Codex and OpenCode. pi adds MCP through an extension, by
  design, so the card starts with installing the third-party `pi-mcp-adapter` extension
  (`pi install npm:pi-mcp-adapter@2.32.1`, the version tested with xezar, linked to its source),
  then gives the `xezar` entry for the project's `.pi/mcp.json`. The entry keeps pi connected while
  it is idle; without that, pi would give the project up after ten idle minutes. The card also says
  the cost: any pi started in the project folder becomes its leader client, and other clients,
  Claude Code included, are refused until that pi exits. It says how to check the extension is
  there (`pi list`), that the file is safe to commit, that the `.pi/mcp.json` entry wins over the
  other five files pi reads MCP config from, and that the project `.mcp.json` is read by Claude
  Code too. xezar still starts no leader: you point your own pi at it. (#341, #343)
- ✨ **One MCP client owns a project at a time.** A second coding agent that connects to a
  project another MCP client already holds is now refused with the project-occupied error
  (`-32080`, `com.qodeca.xezar/project-occupied`), which names nothing about the other client; the
  owner's own concurrent requests and every other project are unaffected. An owner that simply
  goes quiet keeps the project for as long as its client runs — xezar renews the hold itself, with
  no model turn. The project is freed the moment the owning client exits or is killed, or when
  xezar restarts; a client that lost its hold is told once (`-32081`, session expired) and its
  bridge reconnects on its own. Nothing here stops, cancels or pauses a running task, and there is
  still no disconnect or take-over button. Under the hood `xez mcp` now keeps one connection to
  xezar for its whole life instead of one per tool call, so run the bridge and the cockpit from
  the same xezar version: an older bridge is told so in plain words. Nothing to set up.
  (#99, #218, #302, #305)
- ✨ **Browse the MCP API in the cockpit.** Project Settings has a new **MCP API** section, next to
  MCP connection: every tool the MCP server exposes, one collapsed row each with its effect in
  words (read-only, changes project state, destructive), and on expand its actions, its arguments
  with the schema's own descriptions, whether it needs `expectedVersion` or takes an `operationId`,
  and what it refuses. It reads one new route, `GET /api/v1/mcp/reference`, whose tool list is
  exactly what the server's `tools/list` answers, and it works even when the MCP service is not
  running. It is read-only by design: there is no "Try it", because running a tool from the cockpit
  would make it a second leader on the project. Nothing to set up. (#284, #291)
- ✨ **A leader can mark its own draft pull request ready through MCP.** `handoff_git` gains a
  `ready` action (the pull request number plus the head sha the leader reviewed), backed by a new
  `POST /api/v1/github/prs/:number/ready` route that re-reads the forge and runs `gh pr ready`.
  Until now `create_pr` opened a draft and nothing could move it forward without a browser or a
  shell. A moved head is refused, an already-ready or closed pull request is refused in the
  service's own words, and a failing required check or a changes-requested review is reported as a
  blocker that no argument bypasses. (#262, #275)
- ✨ **Xezar now writes the MCP connection file itself.** When the MCP service starts it writes
  `.local/xezar/mcp-connection.json` (D-04) atomically at mode `0600`, after making sure
  `.local/.gitignore` exists: the project, this service process and the socket that really
  listens. It holds no token and no secret. Nothing to author, no setting; a write that fails is
  one warning and the MCP keeps working. This closes acceptance case A-01. (#262)

## 🐛 Fixes
- 🐛 **If xezar cannot reach your pi leader, the fix it gives you now names a file that exists.** The
  one instruction on that path told you to load `scripts/pi-leader-extension.mjs`. Nothing of that
  name is built, packed or shipped — the extension is `scripts/pi-leader-extension.ts` — so anyone
  following the advice got "file not found" and no second hint. Also measured, and written down
  rather than left to be discovered: a xezar tool you put behind pi's tool-approval setting stops a
  pi nobody is watching from finishing its turn at all, because the approval question waits for an
  answer and xezar never gives one. Nothing is lost while that holds and your events stay in the
  journal, but do not gate xezar's tools on a leader you leave alone. (#330, #367, #368)
- 🐛 **pi now has a column in the real-client acceptance record, measured on one revision with the
  other three** — and two of those three clients' rows improved while nobody was looking. Exclusive
  project ownership shipped hours after the record was last written, so the record still said a
  second client could quietly take over a project it cannot. It cannot, for any of the four clients,
  and the record now says so with the evidence beside it. For pi the whole delivery path is measured
  end to end on one pi process: nothing reaches the model while pi sits idle, one real model request
  follows a project event and carries it, none follow it, and that same request still sees every
  xezar tool. No product behaviour changed by the measurement itself. (#330)
- 🐛 **pi can carry a second account, and its config folder is finally its own.** xezar said pi had
  no way to move its home, so "Add account" was never offered for it – and worse, the pi row in
  Settings → Agent accounts showed Claude Code's folder as pi's, because the lookup behind it fell
  through to Claude for any agent it did not name. pi does have a home variable
  (`PI_CODING_AGENT_DIR`), it moves the login as well as the settings, and xezar now honours it:
  set it and pi's discovered account moves with it, or add a second pi account in Settings and pick
  it per project the way you already can for Claude Code and Codex. pi's own folder is what every
  pi row, model list, account probe and "Show details" now reads – and "Show details" on a pi
  account says which model providers it is signed in to, in pi's own words rather than OpenCode's.
  Nothing to set up, and nothing changes for anyone who has not set `PI_CODING_AGENT_DIR`; if you
  already export it, xezar's pi model list now comes from that folder instead of `~/.pi/agent`,
  which is the correct answer and the point of the fix. OpenCode still cannot carry a second
  account – its credentials live apart from its config, so a second one would quietly bill the
  first. (#329, #349, #361)
- 🐛 **A leader that loses the answer to an MCP call can now ask again safely — for every tool, not
  just one.** Every MCP tool action that changes something takes a required `operationId`, so
  sending the same call again returns what the first one did instead of doing it a second time.
  Until now only `task_create` took one: `organise_work`, `execution_control`, `handoff_git`,
  `project_config`, `local_handoff` and `leader_events` rejected the key outright, so a dropped
  answer left a leader with no safe way to find out whether its message was queued, its branch
  created or its app opened. Read actions of those same tools deliberately take no key and refuse
  one — a read has nothing to repeat, and `leader_events read` is meant to return the same events
  again until you acknowledge them. The tool reference lists which actions need the key.
  (#101, #219, #264, #359)
- 🐛 **A workflow step that stops for an answer now stops the workflow.** A step before the last
  one runs a single turn, and it used to be marked done whenever its session closed without an
  error – so a step that ended on a question, `XEZ:ASK` or plain prose, was treated as finished
  and the workflow carried on into the checks after it without the answer. Such a step is now
  done only when its last message ends with `XEZ:DONE`, the marker every agent step is already
  told to end with. Otherwise it fails and says why; Continue reopens that step's conversation so
  you can answer. The last step is unchanged: it still waits for your reply. A custom workflow
  whose earlier agent steps finish without `XEZ:DONE` now stops there – see
  BACKWARD_COMPATIBILITY.md §8. (#317, #322)
- 🐛 **The project kit refuses uncommitted work before the gates, not after them.**
  `worktree-preflight.sh --readiness`, the step right before the gates, now refuses a task tree with
  uncommitted changes or new files (`gitstate.committed`) and says to commit, then re-run readiness
  and the gates. The evidence step already refused such a tree, but only after a complete gate run
  had been paid for. Plain preflight and the read-only roles are unchanged. (#320, #322)
- 🐛 **The project kit no longer seals gate evidence for a branch with none of the task's work.**
  An author step that ended on a question in prose – no code and no `BLOCKED` file – was marked
  done. Readiness then passed, because its only scope check read "no `BLOCKED` file" as "not
  blocked", and the evidence step sealed the base commit itself. `worktree-preflight.sh
  --readiness`, `--record-gate-evidence` and `--verify-gate-evidence` now refuse a branch whose HEAD
  is already in its base (`branch.has-own-commits`), even after the base moved on. Plain preflight
  and the read-only roles are unchanged. The shared contract of all 18 kit skills now says a
  non-final step that stops for a decision writes `BLOCKED` first. (#312, #315)
- 🐛 **The project kit no longer refuses an honest QA run for making no commits.** The empty-branch
  refusal above also fired on a `testing-and-verification` run that only verified another PR – it
  reads, runs and posts findings, and has nothing to commit. Such a run now writes a `VERIFICATION`
  record in its evidence directory naming the commit it verified and where its findings are, and
  readiness and both evidence modes accept it with no commits; handoff then opens no pull request.
  Without the record the refusal is unchanged, a record that does not name a real commit refuses
  (`scope.verification-record`), and `BLOCKED` still stops the run first. (#312, #315)
- 🐛 **Settings → MCP API no longer tells a reviewer a guard is optional when it is not.** The page
  read "accepted, not required" for `organise_work`'s `expectedVersion`, while that tool refuses
  ten actions without it; `handoff_git` and `project_config` read the same. The reference route now
  derives, from each tool's own input schema, which actions are refused without `expectedVersion`
  or `operationId` (a new `guards` field), and the page names them: "required by 10 of 17 actions:
  set_title, …". `handoff_git`'s per-action argument check moved into its schema so the schema is
  the one place that both enforces the rule and answers the question; its answers are unchanged.
  The same pass acts on the rest of the design review (#296): no "Reads or changes" filler on every
  action, no per-tool "Do this in the cockpit" sentence that was false for `health`, a summary that
  names tools instead of counting them, refusals grouped by boundary, a stated "coverage is not
  shown here" instead of silence, and a close control at the end of each open tool. MCP connection
  shows names as code instead of literal backticks, drops the requirement document's "stated
  plainly" wording, leaves out the "Operation outcomes" section no route can fill yet, and moves
  the one-time setup up. (#296, #299, #301, #304)
- 🐛 **The project kit refuses to judge a task whose workspace packages load from another
  checkout.** A task worktree lives inside the primary checkout, so when its own
  `node_modules/@qodeca/xezar-contract` link is missing, node does not fail — it walks up and loads
  the primary checkout's `packages/contract` source instead, whatever branch and edits that has. A
  test in a bare task worktree was seen importing the primary's contract and missing the branch's
  own change. `worktree-setup.sh` and `repo-gates.sh` now check that every workspace package
  resolves to the task's own copy before they stamp the install or run a gate, and stop with the
  exact borrowed path when it does not; a `--fast` gate treats such a tree as stale and reinstalls.
  Commands run by hand before setup are not covered. (#286, #294)
- 🐛 **One resumed task no longer freezes its account's whole queue.** After a provider usage
  limit, a task that resumed itself held every other task on the same agent account in the queue
  until its first resumed turn completed — hours, for a long turn — even with most slots free. The
  hold now lasts only while the resume is testing whether the limit has lifted: once the resumed
  turn has stayed live for two minutes, the tasks behind it start. A task waiting out a limit still
  holds its account, other accounts are still untouched, and cancelling a running resume's
  auto-resume now starts the waiting tasks at once. (#285, #292)
- 🐛 **Picking a variant or reclaiming worktrees in one project can no longer delete another
  project's worktree.** A copied or hand-edited `.local/xezar` (copying a repository folder is
  enough) leaves task records whose worktree path names the ORIGINAL project's worktree. Picking a
  variant deleted the losers' paths, reclaiming deleted every over-limit path, and reading the
  variant group ran git inside each member's path, all without checking whose path it was. The
  group read and the pick now refuse a group with such a member (the same `404` an unknown group
  gets, naming nothing of the other project), and reclaim — through Settings, MCP, boot and every
  task's end — leaves such records alone and still reclaims this project's own. Both use the
  existing MCP ownership checks. A caller could never NAME another project's group, task or
  automation at this project's routes, and still cannot. (#288, #293)
- 🐛 **Deleting a task, removing its worktree, committing, pushing, opening its draft PR, or
  viewing its diff or changes can no longer reach another project's worktree.** The same stray
  records as above also drove these seven task actions: delete and Remove worktree ran `rm -rf` on
  the other project's worktree, commit, push and draft PR wrote to it, and the diff and changes
  views ran git inside it. Each now checks the task's worktree with the same rule reclaim uses and
  refuses a stray record, and the cockpit says why in plain words: the task's worktree is outside
  this project, xezar will not touch it, and archiving the task moves it out of the list. This
  project's own tasks work as before. (#316, #321)
- 🐛 **Running the test suite inside a xezar task no longer writes into that task's handoff file
  and your follow-up inbox.** A gate inherits the task's `XEZ_HANDOFF_FILE`, `XEZ_TODOS_FILE`,
  `XEZ_TASK_ID` and `XEZ_ENV_PASSTHROUGH`, and a test that drove the dry-run mock agent handed them
  on — so every gate run added a "Follow up: verify the mock change" entry to the real inbox and a
  mock line to the real handoff file (more than half of one live inbox was that one entry). The
  shared test preload now drops those four variables once, so every test and every child process it
  starts begins without them. (#281, #282)
- 🐛 **A corrupt `~/.xezar/config.json` is reported once per boot, not twice.** Boot reads the file
  and then the first migration reads it again before replacing it, and each read printed the same
  warning. The warning is now remembered per broken state; every read still goes to the file, so a
  repaired or newly broken config is seen immediately. (#281)
- 🐛 **Three MCP scope and safety holes are closed.** `task_read`'s list view now holds every row
  to the same ownership rule as a single-task read, so a record whose worktree is another
  project's no longer appears in the list, its total, its search or any page — it used to carry
  that project's branch name (#240). `organise_work`'s `pick_variant` — the one action that
  deletes the other variants' worktrees and branches — now requires `expectedVersion` like every
  other mutating action, and `POST /groups/:groupId/pick` accepts an optional `expectedVersion`
  for the kept variant and refuses a stale one with nothing applied; without one the route
  behaves exactly as before, so the cockpit is unchanged. And `organise_work` now refuses an
  argument it does not declare instead of dropping it, so a stray `projectId` can no longer look
  like it scoped a call — including the bulk `archive_finished` — to another project.
  (#271, #278)
- 🐛 **A leader can no longer delete a quality gate through MCP.** `project_config save_workflow`
  with `overwrite: true` could replace a human's workflow and drop its `command: npm test` check
  step with no refusal. An overwrite, a same-name save that would shadow a workflow, or a delete
  that would remove a check step on disk is now refused as a quality-gate blocker naming the step,
  and nothing is written. Saving a check step stays refused as before. D-03 now states the rule.
  (#262)
- 🐛 **Secret redaction is no longer defeated by a change of case.** The credential shapes were
  matched in one case only, so a lower-cased AWS key id (which loses nothing by being lower-cased)
  or an upper-cased GitHub, Slack, GitLab or Google token passed straight into run transcripts,
  the MCP audit trail, the event journal, automation logs and MCP tool responses. The shapes now
  match in any case, except the two whose prefix in another case is ordinary text (`sk-`, which
  ends `TASK-` branch names, and `github_pat_`, which is also an env var name). The host's own
  secret values now match in any case and in their URL-encoded form. (#272, #277)
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
  refusal now names the file, both hostnames and the PID so clearing it is one obvious step.
  (#199, #249)
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
  git it is waiting on is wedged, rather than leaving the request hanging. (#200, #249)
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
  reproduced as a 90-second timeout on CI. (#199, #229, #249, #310)

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
- 🐛 **The opencode runner no longer picks its own port — and it finally tells you why a
  server did not start.** It drew one random port in 40000–60000 with no probe and no retry, so a
  port that was already taken killed the child and reported `opencode serve exited before it
  started listening` with no port, no code and no reason. `opencode serve` has handled this itself
  all along: `--port 0` prefers 4096 and falls back to a free ephemeral port, and the runner
  already reads the bound URL back from stdout. So the draw is gone rather than replaced. The
  child's stderr is now folded into both start-failure messages, the way the Codex and Claude
  runners already did, and the 30-second window rejects with what happened instead of resolving a
  URL nothing is listening on. (#184, #198)
- 🐛 **Two cockpit browser specs stopped racing their own data.** `settings-agents.e2e.ts`
  navigated to `/settings/agents` from `/settings/agents`, where every predicate about the section
  is equally true of the page being left — so a cold load could assert against the outgoing
  document and count 0 checked radios. `gotoAgents()` now waits for a marker only the incoming
  document carries, and the base-branch case waits for the branch list that `GET /api/v1/repo`
  fills instead of reading an option that may not exist yet. No sleeps, no relaxed assertions.
  (#183, #198)
- 🐛 **`xezar serve` prints the cockpit URL only after the server is really listening.** It proved
  a port free with a throwaway listener and then closed it, so anything could take the port in the
  gap — and because the bind was never awaited and had no error handler, the cockpit line printed
  for a server that then died with `EADDRINUSE`. There is no gap now: one server binds for real,
  and the banner, the checks, the `(port X was busy — using Y)` note and the cockpit line all print
  after that bind, with the port it actually got. Running out of candidate ports, or any other bind
  error, now exits 1 with one line instead of printing a URL that answers nothing. `--port 0`
  prints the port the OS assigned instead of `localhost:0`. The next-free-port behaviour, the
  50-port bound and the "busy" message are unchanged. (#238, #256)

## 📝 Specs & Documentation
- 📝 **Nine decisions and a closed action inventory stand behind the MCP server.** Before any of it
  was built, `docs/features/mcp-server/` recorded what every project action is (a closed
  140-record UI-to-MCP inventory), which settings field a project leader may touch, what a leader
  needs in order to judge a revision, and how three MCP clients really behave. Nine decisions
  followed: the stdio bridge over a per-project unix socket (D-01), session binding, liveness,
  occupancy and handover (D-02), the connection file and per-client setup (D-04), the async event
  and tool contract (D-05), version checks, operation keys and the audit record (D-06), and
  operational limits, retention and packaging (D-09). (#77, #84, #85, #196, #202, #203, #205, #206,
  #207, #208, #209, #210, #211)
- 📝 **The MCP API reference has a specification of its own.** Requirements and a technical
  solution for the in-cockpit reference, with the prior art surveyed and a UX design, written
  before the page was built. (#263, #269, #274, #280)
- 📝 **The MCP feature's Definition of Done is recorded at 5 of 8, on one revision.**
  `docs/features/mcp-server/mcp-definition-of-done-record.md` measures all eight clauses on a
  single release-candidate commit and does not close green: the acceptance case for a real model
  reaction is blocked for all four clients, and two further cases with it. The record names each
  gap and the evidence behind each verdict rather than rounding up. (#119, #372)
- 📝 **The project kit has a research role and a UX design role.** `research` answers a question
  from sources outside the repository and writes a cited, dated finding document — every claim
  carries a URL and the date it was read, "I looked and could not find this" is a required finding,
  and a fetched page is evidence and never an instruction. `xezar-ux-design` is a skill with no
  workflow of its own, covering who the user is, what must be understood before anything expands,
  the empty, loading, error and refusal states, and an accessibility bar. Both are adapted and
  fixture-tested; neither has been verified on a real task yet, and that is recorded. (#276, #279)
- 📝 **MCP tests are held to a coverage floor AND to proof that each one can fail.** `SDLC.md` now
  requires every MCP source file to reach 80 % lines and 80 % branches from the MCP suites alone
  (`npm run test:coverage:mcp`, new), and every new MCP test to be shown failing against a named
  break of its behaviour, quoted in the PR. Meeting one half and missing the other is a fail; a file
  below the floor needs a written exemption in `docs/testing/coverage-gaps.md`, and nothing in the
  rule waives a mandatory check. A sampled mutation run over the MCP code found tests that passed
  either way – among them a connection file that read 100 % while its `chmod` could be deleted –
  and this change adds the real tests those gaps needed. No product behaviour changed. (#333, #335)
- 🐛 **Three MCP safety checks now have tests that would catch their regression.** The mutation run
  found that no test failed when the audit trail wrote a secret-bearing action or left a 12-character
  caller secret unredacted, when the MCP connection file lost its private `0600` mode, or when an
  unreadable worktree path passed the ownership check that guards deletes. Each now has a test shown
  failing against exactly that break. No product code changed. (#335, #337)
- 🔧 **A mutation gate for the MCP code.** `npm run test:mutation:mcp` runs StrykerJS over the MCP
  code with the MCP suites, against a score floor of 80 (the first full run measured 81.39 % over
  11 292 mutants in 3 h 40 min). It was added as the first step of the `release` and `release-prep`
  workflows and taken back out again before this release shipped — see the CI/CD entry below — so
  what ships is a command somebody runs by hand. It is a development-only tool: it never reaches
  the published package, and a test fails if it ever does. One mutant that hangs is stopped by a
  per-mutant timeout instead of stalling the run. (#333, #335, #377, #378)
- 📝 **pi is a fourth required MCP leader client, through an extension.** The MCP requirements now
  name Claude Code, Codex, OpenCode and pi as the required initial clients. pi itself ships no MCP
  support, by design, so it counts through the third-party `pi-mcp-adapter` extension, which pi's
  one-time setup installs; the requirements say so in the text. The connection-file decision (D-04)
  gains pi's one-time setup and a four-client comparison, and the client compatibility report gains
  a dated pi addendum. A requirements change only: pi's reaction adapter and acceptance column came
  later in this release, in the pi entries above. (#330, #334, #339)
- 📝 **A named limitation of this release: do not gate xezar's tools with pi's `approveTools`.** The
  `pi-mcp-adapter` extension can be told to ask before a tool runs. If you point that at xezar's
  tools, the question goes to a dialog only a person at their own pi window can answer, and nothing
  in xezar answers it — so a pi that xezar runs sits there until it is killed, and a leader turn
  nobody is watching waits for ever, because nothing ends that one at all. Measured: a step whose
  own tool list named `xezar_health` failed after two minutes, while an ordinary pi task with the
  same gate on was unaffected and finished in 2.8 seconds, because the tools xezar gives a task by
  default include no xezar tool at all and the question is never asked. You set this yourself and
  nothing is on by default, so leave xezar's tools ungated and nothing changes for you. The pi setup
  card, the pi extension guide and the client compatibility report all say so now. Making xezar
  answer that dialog, with a refusal, is #369 and is deliberately not in this release.
  (#369, #370, #371)
- 📝 **A release-level Definition of Done for 0.14.0.** `docs/releases/0.14.0-definition-of-done.md`
  sits beside the MCP feature's own eight clauses and covers the rest of the release: the security,
  engine and gate fixes, open-source readiness, documentation, the kit roles, the UI design review
  and the release act. Each clause says what evidence settles it and what does not count, and a
  clause with no evidence is failed. A draft for the owner's decision; nothing in it is assessed
  yet. (#300, #303)
- 📝 **Conduct reports have a private address, and the 0.14.0 questions have answers.**
  `CODE_OF_CONDUCT.md` named a GitHub organisation, which cannot receive a private message; it now
  names `hi@qodeca.com`, read by Qodeca, and says a report sent there is private. The #184 and #183
  fixes move out of the `0.13.1` section into this one: their commit is not in the `v0.13.1` tag,
  so the published 0.13.1 never contained them. The release Definition of Done now records the
  owner's answer, or the evidence that settled it, for each of its six questions, beside the
  recommendation it first made. No quality clause changed. (#318, #319)
- 📝 **A design review is part of done for UI work.** The project kit, the implementation and
  testing roles and the leader prompt now say that work with UI in scope, where such a review makes
  sense, needs a UX/UI design review (`xezar-ux-design`) before it is done, and that the author's
  manual QA is not one: it shows the surface works, not that it is the right design. (#297, #298)
- 📝 **The npm package page shows its screenshots and working links again.** npm publishes a copy
  of the root README, and its relative `docs/…` and `LICENSE` links pointed at files the package
  does not contain — 13 broken links on the 0.13.1 page, all six screenshots among them, and 23 in
  the next release. The build now rewrites every relative link and image in that copy to an
  absolute GitHub URL; the root README keeps its relative links, and a test fails if a relative
  link survives the copy. (#287, #290)
- 📝 **A map of `docs/`.** `docs/README.md` says what each directory holds and who it is for, and
  `docs/features/README.md` says up front that those files are the internal engineering and
  decision record, not a user guide. Four MCP records no longer claim the shipped feature is
  unimplemented, the README documents `XEZ_CODEX_REASONING`, and the README and `--help` say that
  the default team skills repository is not a leftover of the Cezar rename. (#287)
- 📝 **The MCP server has a reviewable API reference.** `docs/features/mcp-server/mcp-api.md`
  lists every tool, its arguments (the schema's own descriptions), the results each tool really
  returns — including where the tools' status words disagree — the two meanings of `origin`, and
  the rules each call follows, with links to the decision records. `mcp-api.json` beside it is
  exactly what `tools/list` answers, for diffing and JSON Schema viewers. A new traceability table
  maps every `covered` inventory record to the tool action that serves it, checked both ways. The
  tables and the JSON are regenerated from the real tool registry, so a tool change that is not
  reflected in the reference fails `npm test`. (#261, #268)
- 📝 **The repository now has a security policy, a contribution path and issue templates.**
  `SECURITY.md` says in its first sentence that xezar runs AI agents with shell access on your
  machine, then draws the line between "working as designed" and "a vulnerability", naming the
  guard in the code behind each claim. It sends reports to GitHub's private reporting and gives a
  fallback that discloses nothing. `CONTRIBUTING.md` is the short human path to a merged pull
  request and says plainly that the team skill pack named in `SDLC.md` is internal automation an outside
  contributor does not need. Also added: `CODE_OF_CONDUCT.md` (Contributor Covenant 3.0), bug and
  feature issue forms, a pull-request template, and a CI badge and project-status note in the
  README. (#283, #289)
- 🐛 **The MCP coverage floor now passes on `main`.** The floor arrived red: `npm run
  test:coverage:mcp` failed on three thresholds the day it shipped, so every MCP pull request met a
  gate that was already failing before its author started. Two of the three left when #311 merged.
  The last one, the MCP API reference page, is now fully covered by tests for the cases its live
  registry cannot produce — a listed tool that declares nothing, a guard on a tool with no action
  list, and a refused argument whose description is gone — each shown failing against a named break
  of the code it covers. The written exemption that stood in for those tests is retired, and
  `docs/testing/coverage-gaps.md` records the new measurement, why the old exemption's reasoning was
  wrong, and that the command can now become a CI check. No product behaviour changed. (#352, #355)
- 📝 **The coverage record no longer claims more than it proved.** `docs/testing/coverage-gaps.md`
  said every case of the new MCP API reference test carries its own populated-input control; for one
  of the three it does not, and the control lives in the live-registry test instead. The sentence is
  corrected, both halves re-measured, and the document now also records a mutation of that file that
  survives the whole MCP test suite even though the file reads 100 % branch coverage — the plainest
  evidence that a coverage number is a floor, not a proof. No product behaviour changed, and no test
  or source file was touched. (#357, #360)
- 📝 **The audit trail now says which origins it really records.** `mcp-audit.ndjson` lists four
  possible origins — `ui`, `mcp`, `automation`, `cli` — and writes exactly one of them: `mcp`. The
  cockpit, the automation scheduler and `xezar run` record nothing, so the file holds a leader's
  operations and never a human's beside them. That is the decision for this release, and it is now
  written down where anyone would look: in the schema itself, in the audit module, in the MCP API
  reference and as a dated decision in D-06 § 10.6. The four origins are kept, because they are the
  right eventual set and removing one would break the record format; wiring the other three doors is
  its own issue (#364) for a later release. No product behaviour changed. (#266, #365)

## 🚀 CI/CD & Infrastructure
- 🚀 **The MCP feature has an acceptance suite, A-01 to A-23.** A shared A/B acceptance world backs
  an isolation suite, a parity and collaboration suite, a correctness and durability suite, and a
  real-client suite that drives the actual bridge — with the browser half of the live-sync case run
  in a real Chrome. The cases run through the composed MCP service rather than against mocks, so a
  gap in the feature shows up as a failing case rather than as an untested claim. (#116, #117,
  #118, #242, #248, #253, #257, #259, #273)
- 🚀 **Four false test signals are gone.** `npm test` went red from a plain shell on changes that
  could not have caused it, because the scratch `TMPDIR` was exported unresolved and macOS
  resolves `/var` to `/private/var` — invisible from inside a xezar task, which exports a
  symlink-free one. `cli.test.ts` probed a port and reached a neighbouring cockpit, which made it
  pass for the wrong reason. Five more suites asserted things that were true either way. And the
  mutation run's warm-up died on a guard test that reads an adapter's source as text and asserts it
  never says `process.` — Stryker's own instrumentation header does; the guard now excludes those
  tests by class rather than by one file name. (#194, #201, #204, #212, #237, #260, #295, #307,
  #314, #328, #376)
- 🚀 **A release no longer waits on the MCP mutation gate.** That check took nearly four hours,
  ran only at release time, and a failure in it means a weak test — work for next week, not a
  reason to hold code that already passed the full test gate and independent QA. Its first real
  exercise arrived at the worst possible moment: the 0.14.0 attempt died in the tool's own warm-up
  on a configuration mismatch and found no product defects at all. The check is not weakened —
  same code, same tests, same 80 % floor — but for now it is a command somebody runs by hand
  rather than something a release waits on. Giving it a schedule so a weak test still reaches
  somebody who can fix it is #377, and until that lands nothing runs it automatically. (#377, #378)

---

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
- 🐛 **The team skill pack finds its pipeline config and tracker descriptor again.** 0.11.0 moved
  `.ai/agentic.config.json` into `.xezar/` and dropped `.ai/trackers/github.md`, but the pack's
  skills hard-code those `.ai/` paths, so every skill in the pack failed to find them. Both files are
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
> called Cezar, published first as `@pat-lewczuk/cezar` and then as the pre-rename scoped package
> with the unscoped `cezar-cli` alias. The entries keep the wording that was true when they were
> written, because a changelog records what actually shipped; the one exception is that the
> pre-rename organisation's name and its issue links were removed on 2026-09-13. The old packages
> remain on npm, unchanged.

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
