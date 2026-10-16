# Qwen Code parity proof – live checklist and dogfood

Date: 2026-10-16. Issue: #1042 (part of #1041). Qwen Code versions seen: **0.25.2** on every run;
**0.22.3** once, refused by the version gate (accounts item, below).

## Verdict

Qwen Code works in xezar like Claude Code, as task runner and as leader client. Every checklist
item passes on a local model and on a cloud API, except two model limits that are not xezar faults
(images on a text-only cloud model; obeying a system-prompt rule on the local model – delivery is
proven on both). The live proof found **five faults in xezar's own Qwen code**. All five are fixed
on `feature/1041-qwen-code-backend`, each with a test that fails without the fix. The plan B
trigger in #1041 is **not** reached.

Dogfood, counted on the fixed code: **50 Qwen task runs**, 48 done and 2 failed by a model
error, and **5 leader sessions** whose pushed events all reached the session. **Zero failures
caused by Qwen Code.** An earlier batch found the fifth fault, so the count restarted, as #1042
requires (§ Dogfood).

## Models and setup

| Name in this report | Kind | Endpoint |
| --- | --- | --- |
| `deepseek-v4-flash-vision` | local OpenAI-compatible server, vision | a machine on the local network |
| `qwen38-flash-next` | local OpenAI-compatible server | a laptop on the local network (Qwen Code's default model on this machine) |
| `deepseek-flash` | cloud API (DeepSeek), text only | `api.deepseek.com` |

Both local and cloud models come from the person's own Qwen Code `modelProviders`. No model
pricing is configured, so runs report tokens and a cost of 0.

## Live checklist

The checklist drives xezar's `QwenRunner` against the real `qwen` CLI, one item per
`AGENT_PROTOCOL.md` feature. Each item saved its full v1 and v2 event record as evidence; the result
per item and model is in `qwen-code-parity-2026-10-16/checklist-<model>.json`. Command:
`tsx live-checklist.mts <model> [item …]` (a scratch script outside the repository).

| Item | What is checked | `deepseek-v4-flash-vision` (local) | `deepseek-flash` (cloud) |
| --- | --- | --- | --- |
| session | one `session.started`, a session id, `end_turn`, the answer | PASS | PASS |
| termination | interrupt during a running `sleep 50`; a 45 s step limit | PASS – ended 0.1 s after the interrupt, timed out at 45.0 s, no leftover process | PASS – same |
| resume | a second turn, and a new process with `--resume`, recall a code word | PASS | PASS |
| read-only | `git status` allowed; `touch` and an edit refused; files unchanged | PASS – 2 declined | PASS – 2 declined |
| questions | a choice the user must make ends the turn as a valid `XEZ:ASK` | PASS | PASS |
| MCP isolation | the project's own MCP server starts and its tool answers | PASS | PASS |
| events | plan updates, tool items, diffs | PASS | PASS |
| usage | input and output tokens on the turn and in `usage.updated` | PASS | PASS |
| system prompt (delivery) | the answer exists only in the system prompt | PASS | PASS |
| system prompt (obedience) | "end every answer with ZEBRA-42" | model error, passed 1 of 6 runs (see below) | PASS |
| images | the colour of an attached image | PASS ("Green") | model limit ("White"; the model has no vision) |
| dry run | `XEZ_DRY_RUN=1` uses the bundled mock, no model | PASS | PASS |
| model selection | the chosen id starts; an id not in the settings is refused before start | PASS | PASS |
| accounts | a run with its own Qwen home uses that home's models and stores its session there | PASS | PASS |
| leader push | a running Qwen Code leader receives xezar's events and acknowledges them | PASS – sessions 6 and 8 (below) | PASS – sessions 7 and 9 (below); also the #1045 live proof (task.done to the session in 30 ms) |

Notes per item:

- **System prompt.** xezar passes it as `--append-system-prompt` on every turn (shown by logging
  the arguments of 3 runs), and Qwen Code appends it to its own system prompt. The local model
  answered the code word from the system prompt every time, but followed the "end with ZEBRA-42"
  rule in 1 of 6 runs. A model that does not follow an instruction is a model error under #1042.
- **Images.** The local vision model answers "Green". The cloud model is text-only. The image
  reaches the model in both cases (as an `@path` file reference).
- **Accounts.** The account home holds its own `settings.json` with a model id that only it lists.
  xezar accepted the id, Qwen Code started it, and the session record was written under the
  account home; the same id is refused for the default home. The model call itself was not made:
  the account home has no key, and its Qwen Code was the npm install's own 0.22.3, which xezar's
  version gate refused with the update command. Qwen Code keeps its self-updates inside each home
  (`<home>/updates/npm/…`), so a new account home starts on the npm install's version until it
  updates. This is a Qwen Code property; the version gate already names the fix.
- **Termination.** Before the fix below, an interrupt did not stop the turn at all (it ran to its
  end after 69 s), and a step time limit left Qwen Code running in the worktree.

## Leader sessions

Each session: a real Qwen Code TUI (in a pseudo-terminal), xezar's MCP bridge attached as the
leader, then one real Qwen task (`qwen-review` workflow, local model) created while it waited. The
leader was told to read the task an event names and then acknowledge the event. Sessions 6–10 ran
on the fixed code and are the counted ones; 1–5 ran before the restart. Evidence:
`qwen-code-parity-2026-10-16/leader-sessions.json`.

| Session | Batch | Leader model | Attached | Events delivered / acknowledged (cumulative) | Task | Task result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | earlier | `deepseek-v4-flash-vision` | yes | 2 / 2 | `0844f09e` | failed – step time limit (model error) |
| 2 | earlier | `qwen38-flash-next-mlx-mixed-4-8bit` | yes | 3 / 3 | `d5424786` | done |
| 3 | earlier | `qwen38-flash-next-mlx-mixed-4-8bit` | yes | 5 / 5 | `b92fb8be` | failed – step time limit (model error) |
| 4 | earlier | `qwen38-flash-next-mlx-mixed-4-8bit` | yes | 6 / 6 | `1a414083` | done |
| 5 | earlier | `qwen38-flash-next-mlx-mixed-4-8bit` | yes | 7 / 7 | `1d2b6a34` | done |
| 6 | counted | `deepseek-v4-flash-vision` | yes | 8 / 8 | `56a54054` | done |
| 7 | counted | `deepseek-flash` | yes | 9 / 8 (the last one after the window closed: the leader was still reading the task) | `e2b08ffa` | done |
| 8 | counted | `deepseek-v4-flash-vision` | yes | 10 / 10 | `4525a77e` | done |
| 9 | counted | `deepseek-flash` | yes | 11 / 11 | `4a54a72e` | done |
| 10 | counted | `qwen38-flash-next-mlx-mixed-4-8bit` | yes | 12 / 12 | `b2c1fd55` | done |

Every push reached the session: Qwen Code shows it as a `cross_session_message` from `xezar`.
There was no blocker except one. In session 7 the leader was still reading the task's evidence
when the session window closed, and xezar's status said so in plain words
(`qwen-push-unacknowledged`: "Qwen Code took them, but the leader has not acknowledged them yet").
In sessions 1 and 3 the task step answered, but its last turn did not end with `XEZ:DONE`. So the
interactive run waited for the user, as it does on every backend, until the step's 10-minute
limit. That is the model not following the handoff contract, not a delivery fault. In sessions 2–5
the session script lost the `-m` flag, so the leader ran on Qwen Code's own default model.

## Dogfood

The owner chose scripted runs instead of this repository's daily work (see the end of this page).
Each run is a real `xezar run "<task>" --workflow <name>` (headless: the engine without the
cockpit) on a small scratch project with code, tests and git, against the local model
`deepseek-v4-flash-vision`. Ten tasks rotate. Six change code, run the tests and commit
(`qwen-change`, one writing step). Four only read and report (`qwen-review`, a read-only step with
a `bashAllowlist`). Three workers run at once, each on its own clone, because one project folder
accepts one headless run at a time.

**Earlier batch (not counted).** 50 runs. It found the fifth fault. When a turn ended without
`XEZ:DONE`, the headless process exited with code 0 and left the run `running`. The next run in
that folder then marked it "interrupted – xezar process exited during the run" (6 runs). Qwen Code
runs one process per turn, so nothing held the event loop while the session waited: the #793
trap. Fixed in `0deca486`. One more run hit the step limit while Qwen Code's auto-memory pass ran
after the answer (fixed by switching auto-memory off, `cd40a9e1`). Per #1042 the count restarted.

**Counted batch, on the fixed code.** 50 runs: 30 `qwen-change` and 20 `qwen-review`, every step
on the `qwen` backend. Run ids and results: `qwen-code-parity-2026-10-16/dogfood-runs.json`.

| Result | Runs |
| --- | --- |
| done | 48 |
| failed – model error (last turn without `XEZ:DONE`, then the 10-minute step limit) | 2 (`d8d9f933`, `c39968e0`) |
| failed – Qwen Code or xezar's Qwen code | 0 |

Median run time 3.0 minutes; the longest, 10.0, are the two time limits. 7.25 M tokens in total,
all on the local model, so the cost is 0.

## Failures and their classification

| Where | What happened | Class | Evidence |
| --- | --- | --- | --- |
| Checklist, local model | "End every answer with ZEBRA-42" followed in 1 of 6 runs | model error | the delivery check passes; the arguments carry the prompt |
| Checklist, cloud model | Image colour "White" | model limit (no vision) | the local vision model answers "Green" |
| Leader sessions 1, 3 | Task step waited after an answer without `XEZ:DONE`, then hit 10 min | model error | `leader-sessions.json` |
| Leader session 7 | Last event acknowledged after the window closed | model behavior (still working) | delivered 9, acknowledged 8, blocker `qwen-push-unacknowledged` |
| Dogfood, earlier batch | Headless run exited early, run left `running` (6 runs) | **xezar Qwen fault**, fixed in `0deca486`; count restarted | — |
| Dogfood, earlier batch | A finished turn held open by Qwen's auto-memory pass until the step limit (1 run) | Qwen Code behavior; switched off for task runs in `cd40a9e1` | Qwen's session record shows `managed-auto-memory-extractor` after the answer |
| Dogfood, counted batch | 2 runs: no `XEZ:DONE`, then the step limit | model error | `dogfood-runs.json` |

## Faults found in xezar's Qwen code, and their fixes

| Fault | Fix | Test that fails without it |
| --- | --- | --- |
| A tool call refused by the read-only hook showed twice in the thread; the second row had no reason. Qwen Code reports it as the tool result and again in `permission_denials`. | #1060 · `de69c484` – the mapper skips ids already declined | `qwen-ui-mapper.test.ts` ("keeps the refusal reason …") and the `hook-refusal` / `permission-denied` golden fixtures |
| Stopping a Qwen step (interrupt, step time limit, refused turn) stopped only the `qwen` launcher. Qwen Code runs as the launcher's child, so it and its commands kept running. | #1061 · `63009630` – `stopChildWithDescendants` (platform layer) also signals the descendants on Linux and macOS | `qwen-runner.test.ts` ("an interrupt stops the program behind the `qwen` launcher …"), `process-tree.test.ts` |
| A headless `xezar run` whose session waited after a turn exited with code 0 and left the run `running`. Qwen Code runs one process per turn, so nothing held the event loop. | #1063 · `0deca486` – the session holds the loop while it is open and waiting | `qwen-runner.test.ts` ("an open session waiting for its next message keeps a headless process alive …") |
| The cockpit offered no Qwen Code in the runner menus (new task, default agent, accounts, agent settings). | #1062 · `794f509c` – a `qwen` row in `RUNNERS` | `new-task-form.test.ts` ("offers every backend xezar runs …") |
| Qwen Code's managed auto-memory ran one more model call after each answer and wrote a memory folder per task worktree into the person's Qwen home. On a slow model it held a finished turn open until the step limit. | `cd40a9e1` – off in each run's private settings (owner decision) | `qwen-runner.test.ts` (the run's settings file); live: 0 memory-pass calls, 3 before |

The first four fault rows are filed as #1060, #1061, #1062 and #1063, each with its fix. The auto-memory row was an owner decision (off for task runs), not a filed fault. A test that fails only on a busy machine, older than this work, is filed as #1064.

The count restart rule of #1042: the early-exit fault was in xezar's Qwen code and was found in
the earlier dogfood batch, so the count restarted, and the counted batch ran on the fixed code.
The checklist and the cockpit check found the other faults before any counting.

## Cockpit check

Two tasks were run in the cockpit on real Qwen Code with the local model (the #1044 verification).

- **Normal task** (`66f8b826`, quick-task, runner and model picked in the composer): the thread
  shows reasoning, tool rows (read, edit, `npm test`, `git commit`), the answer, "goal achieved –
  session closed", status **done**, a diff of +3 −2, usage **IN 186.3k · OUT 2.9k**, the agent
  line "qwen · default · deepseek-v4-flash-vision", and a take-over command `qwen --resume …`.
- **Read-only step** (`3eb5ecca`, `qwen-review`): `npm test` ran; the attempt to create a file was
  declined ("Matching deny rule: edit"); status **done**, diff +0 −0, usage **IN 124.2k · OUT 4.5k**.

This check found the missing runner menu entry (fixed, above) and the runner label finding below.

## Other findings (not Qwen faults)

- **Runner label for a per-step runner.** When a workflow step names a runner that differs from
  the project's default, the run header and the "take over interactively" command show the
  project default (for example `claude --resume …` for a Qwen step). The step itself records the
  right backend. It affects every backend, so it is outside #1041.
- **Browser tests and Chrome 155.** Three `screenshot-states` checks failed on `main` too: under
  Chrome for Testing 155, the test tool's `press Escape` hides the page for the rest of the session.
  Fixed in the test helper (`9b1400f1`).
- **Headless runs share one project lock.** Two `xezar run` processes cannot use one project
  folder at once ("Project data is already in use"). The dogfood batch therefore gives each
  worker its own clone. This is existing, intended behavior.

## Routing (criterion 1)

This project's routing (`.xezar/routing.json`) now names Qwen Code lanes where it named pi lanes, in the same
place in every row, so Qwen is preferred wherever pi was. The pi lanes are not kept as a fallback: pi is removed
in the same change set (#1046), and the owner accepted that on 2026-10-16. `qwen/deepseek-flash` is text only
through Qwen Code (see Images above), so the rows that must see a screen do not list it.

## What this does not cover

- Dogfood on this repository's own daily work through `.xezar/routing.json` lanes: that file
  changes only through its own pull request. The owner chose scripted runs on scratch projects
  instead.
- A cloud model with vision.
