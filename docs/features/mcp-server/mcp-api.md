# MCP API reference

Status: **reference for the implemented MCP server; tables generated from the code, checked by `npm test`**.
Date: 2026-09-11. Audience: product owner, reviewers and the engineering team.

Tracked by [#261](https://github.com/qodeca/xezar/issues/261), under [epic #67](https://github.com/qodeca/xezar/issues/67).
Contract it implements: [MCP requirements](mcp-project-leader-requirements.md).

This page lets a person review the MCP server's design and API without reading the tool source.
It covers what a client can call, what each call accepts and returns, and which inventory outcome
each call serves. For how to launch and configure Claude Code, Codex, pi or OpenCode as a project
leader, see the end-user runbook [`docs/guide/13-mcp-leader.md`](../../guide/13-mcp-leader.md);
this page does not repeat those per-client steps.

Its machine-readable twin is [`mcp-api.json`](mcp-api.json). That file is exactly what `tools/list`
answers: every tool's name, title, description, JSON Schema and annotations. You can diff it in a
pull request, or load it into any JSON Schema viewer.

## How this page stays true

Two kinds of content live here, and they are checked differently.

- **Generated (between `<!-- mcp-api:… -->` markers).** The tool summary, the argument tables and the
  two traceability tables come from the real tool registry
  ([`packages/xezar/src/mcp/tools/index.ts`](../../../packages/xezar/src/mcp/tools/index.ts)).
  They use the same `toolListing()` the bridge sends on the wire, plus the record-to-action mapping
  in [`api-coverage.testkit.ts`](../../../packages/xezar/src/mcp/tools/api-coverage.testkit.ts) and
  the closed [inventory](mcp-ui-action-inventory.md).
  [`mcp-api-doc.test.ts`](../../../packages/xezar/src/mcp/mcp-api-doc.test.ts) regenerates them and
  requires this file and `mcp-api.json` to match byte for byte. If a tool is added, removed, renamed,
  re-described or has its schema changed without regenerating, `npm test` fails. To regenerate after
  a deliberate change, run `npm test -- packages/xezar/src/mcp/mcp-api-doc.test.ts -u`. This keeps
  the prose outside the markers.
- **Hand-maintained (everything else).** This covers the result shapes, the two `origin`
  vocabularies, the cross-cutting rules and the findings. None of them can be read out of a JSON
  Schema, because the tools declare no output schema. They were checked against the source at
  revision `ef4b768` (2026-09-11), with `file:line` anchors valid at that revision. Re-check them by
  symbol after the result code changes.
  **One exception, re-checked later:** the four anchors used by [the two meanings of
  `origin`](#the-two-meanings-of-origin) and [the audit record](#the-audit-record) —
  `mcp/index.ts:254` and `:267`, and `contract/src/mcp-audit.ts:44` and `:72` — were re-read at
  `87d9f0d` (2026-09-12) while [#266](https://github.com/qodeca/xezar/issues/266) was resolved.
  Nothing else on this page was re-checked then, so an anchor outside that list is still an
  `ef4b768` anchor.
  **A second re-check, 2026-09-17 ([#306](https://github.com/qodeca/xezar/issues/306) part 1):** the
  audit anchors in those two sections, and Findings 3, were re-read when the trail moved to
  `audit.ndjson` and record version 2. They cite symbols, not line numbers.

Evidence level: this is an **observed** description of the code. It is not a live-client
certification; that is the [client acceptance record](mcp-client-acceptance-record.md).

## The wire

- **Transport.** JSON-RPC 2.0, newline-framed, on the stdio of `xezar mcp`: a bridge that forwards
  each call over the project's local socket to the running `xezar serve`
  ([D-01](mcp-d01-transport-decision.md)). The bridge is hand-rolled, with no MCP SDK dependency
  ([D-09 B-35](mcp-d09-limits-retention-packaging-decision.md)).
- **Methods.** `initialize`, `ping`, `tools/list` and `tools/call`. Any other method answers
  `-32601` (`packages/xezar/src/mcp/protocol.ts`).
- **Protocol revisions.** `2025-11-25` and `2025-06-18`. The bridge echoes the client's revision when
  it supports it, and otherwise offers the newest.
- **Capabilities.** `{ tools: { listChanged: false } }` and nothing else. The tool list is fixed for
  the life of the process.
- **Tools.** Eleven in total: the bridge's own `health`, plus ten from the registry, which run inside
  the xezar service and never in the bridge.

## Tools at a glance

The four hint columns are the tool's MCP `annotations`. "not set" means the tool leaves that hint
out, and the MCP defaults then apply: not read-only, destructive, not idempotent, open world.

The `expectedVersion` and `operationId` columns read:

- **required**: every call must carry it.
- **some actions**: the schema accepts it, and the tool's description names the actions that need it.
- **—**: the tool does not accept it.

<!-- mcp-api:tools:start -->
| Tool | Title | Purpose (first sentence of its description) | Read-only | Destructive | Idempotent | Open world | `expectedVersion` | `operationId` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `health` | xezar health | Report whether the xezar cockpit is running for the project this session was started in, and which project that is. | yes | not set | yes | no | — | — |
| `task_read` | Read tasks | Read this project’s tasks. | yes | no | yes | no | — | — |
| `execution_control` | Control a task and talk to its session | Control one of this project's own tasks, as the cockpit's buttons and composer do. | no | yes | no | no | required | required |
| `discover_project` | Discover the bound project | Read which xezar project this session is bound to, its effective capabilities and limits, and which actions are available. | yes | not set | yes | no | — | — |
| `organise_work` | Organise tasks | Organise this project's tasks the way the xezar cockpit does. | no | yes | no | no | some actions | some actions |
| `task_create` | Create or plan a task | Create a task in this project with the New task form's options, defaults and validation, plan one first, start an Inbox entry, or save a planned step list as a workflow. | no | no | no | no | — | required |
| `handoff_git` | Hand work onward: commit, push, draft PR, ready, merge, branches | Hand a task's work onward through the cockpit's own operations: commit a task's worktree, push its branch, open its draft pull request, mark a draft pull request ready for review, read a pull request's merge readiness, invoke the existing merge, and switch or create branches of the main checkout. | not set | yes | not set | yes | some actions | some actions |
| `read_results_evidence` | Read task results and evidence | Read what a task produced and the project's GitHub state, each answer identified by the revision it describes. | yes | no | yes | yes | — | — |
| `project_config` | Project configuration | Read and change THIS project's own configuration: its settings (agent, models, system prompt, review gate, base branch, worktree retention, memory limit), its registry entry (concurrency cap and tags), prompt templates, in-repo agent config files, workflows, skills, GitHub automations and worktrees. | no | yes | no | no | some actions | some actions |
| `local_handoff` | Open a task or the project in an app on the xezar host | Hand a task or the project off to a desktop app — a terminal resuming the task’s agent session, an editor, the file manager. | no | no | no | no | — | some actions |
| `leader_events` | Attach, read and acknowledge project events | Attach this session as the project's leader so xezar pushes its significant events to it (task outcomes, questions, required check results, human changes, executor availability), and read and acknowledge those events. | no | no | yes | no | — | some actions |
<!-- mcp-api:tools:end -->

## Arguments

Each description below is the schema's own text, quoted without rewording. The schema is the source
of truth. Nested object and array-item properties appear as dotted paths.

<!-- mcp-api:arguments:start -->
### `health`

> Report whether the xezar cockpit is running for the project this session was started in, and which project that is. To see whether this session is attached as leader and can receive pushed events, call leader_events with action status.

Takes no arguments. Unknown arguments are rejected.

### `task_read`

> Read this project’s tasks. Choose one view:
> - list: task summaries, newest first, filterable by status, archived, groupId and query.
> - task: one task’s full record. history: its events, newest page first; follow nextCursor for older events.
> - context: the plan and agent episode that frame the history. handoff: the task’s handoff journal.
> - inbox: the project’s Inbox items. group: one variant group, its tasks side by side.
> Pages are bounded: at most 100 items and 40000 bytes. When an answer has a nextCursor, call again with the same view, task and filters plus that cursor.
> An item too large for one answer comes in parts ("part" of "parts"): join the "text" of every part in order, then parse it as JSON.
> The first answer of a task, history, context or handoff read (no cursor) carries the task’s "version": send it as expectedVersion when you then change that task (organise_work, execution_control, handoff_git, project_config). A change is refused if the task moved after this read.
> This reads only the project this connection is bound to. Use it to assess state or recover after a lost answer, not to poll: task events are pushed to an attached leader (see leader_events).

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `view` | `list` \| `task` \| `history` \| `context` \| `handoff` \| `inbox` \| `group` | yes |  | list = the project’s tasks (summaries, newest first); task = one task’s full record; history = one task’s event history, newest page first; context = the plan and agent episode that frame a task’s history; handoff = a task’s handoff journal (markdown); inbox = the project’s Inbox items; group = one variant group, its tasks side by side. The task record includes reported reviewer verdicts when available. Each names its role, reviewed commit and label evidence state. Missing or partial evidence is not approval. Compare the reviewed commit with the target before acting; task done alone proves no quality gate. A running step may also carry an advisory progress observation — when it last showed activity, its time limit, and whether it currently looks quiet. It is an observation, not a fault: nothing is stopped, and an absent one means unobserved, not healthy. |
| `taskId` | string | no | min length 1, max length 128, pattern `^[A-Za-z0-9._-]+$` | Task id. Required for task, history, context and handoff. |
| `groupId` | string | no | min length 1, max length 128, pattern `^[A-Za-z0-9._-]+$` | Variant group id. Required for group; with list, keeps only that group’s tasks. |
| `cursor` | string | no | min length 1, max length 2048 | The nextCursor of a previous task_read answer, to read the next page or part. Send it with the same view, task and filters as that call. |
| `limit` | integer | no | min 1, max 100 | list and history: at most this many tasks or events per page (default and ceiling 100). |
| `status` | array of `queued` \| `running` \| `waiting` \| `review` \| `done` \| `failed` \| `cancelled` | no | min items 1, max items 7 | list: keep only these statuses. |
| `archived` | `exclude` \| `include` \| `only` | no |  | list: exclude archived tasks (default), include them, or show only them. |
| `query` | string | no | min length 1, max length 200 | list: case-insensitive text to find in a task’s title, prompt or branch. |

### `execution_control`

> Control one of this project's own tasks, as the cockpit's buttons and composer do. Each action is allowed only in the states the cockpit allows it and is otherwise refused with nothing changed (status "conflict" and a reason).
> cancel — stop a queued, running or waiting task; it ends cancelled and keeps its worktree.
> finish — finishAs "close_session" closes a waiting task's session; finishAs "accept_review" accepts a task at review without a PR.
> continue — reopen a closed task's last session, with optional text; for a task at review, text is required and is sent back as review feedback.
> send_message — routed by state: an open session receives it, a queued task gets it folded into its prompt, a closed task with a session is continued with it; otherwise refused.
> answer_question — answer the task's pending question by its questionId, with the option labels (answers) or free text; only the pending question can be answered, and a closed session is reopened to deliver it.
> edit_queued_message / remove_queued_message — change a message stacked on a queued task.
> cancel_auto_resume — stop a scheduled automatic resume after a usage limit.
> Every action needs expectedVersion: the `version` task_read (view task) returned for this task. If the task changed since you read it, nothing is applied and the answer is status "conflict" with error "stale_version": read it again and decide again. The token tracks decision state, including pending question replacement (ID or content) and changes later reversed; transcript, tool and usage progress alone never invalidate it.
> Targets tasks only by run id in the bound project; there is no process-level control. Plan approval and decisions outside the approved goal stay with the human.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `cancel` \| `finish` \| `continue` \| `send_message` \| `answer_question` \| `edit_queued_message` \| `remove_queued_message` \| `cancel_auto_resume` | yes |  | What to do with the task. |
| `runId` | string | yes | min length 1, max length 128 | The task's run id, in the project this connection is bound to. |
| `expectedVersion` | string | yes | min length 1, max length 512 | The `version` task_read returned for this task. Echo it verbatim; if the task changed since, nothing is applied. |
| `operationId` | string | yes | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | Client-generated key for this operation (8–128 chars). Reuse it only to repeat the same operation: a repeat returns the first answer and controls the task once. |
| `text` | string | no | max length 100000 | Message, continuation prompt, review feedback, free-form answer, or the new text of a queued message. |
| `images` | array of object | no | max items 4 | Attachments (base64) for send_message, continue or edit_queued_message — the same four the composer allows. |
| `images[].mediaType` | string | yes |  |  |
| `images[].data` | string | yes | min length 1, max length 7000000 |  |
| `finishAs` | `close_session` \| `accept_review` | no |  | Which finish you mean: close_session for a waiting task, accept_review to accept a task at review without a PR. Refused when it does not match the task. |
| `questionId` | string | no | min length 1, max length 128 | The pending question's id (its ask requestId). |
| `answers` | array of object | no | min items 1, max items 4 | One entry per question, in the order the question card lists them. |
| `answers[].choices` | array of string | yes | min items 1, max items 4 | Option labels for this question, exactly as the question lists them. One for a single-select question. |
| `messageId` | string | no | min length 1, max length 128 | A queued message's id. |

### `discover_project`

> Read which xezar project this session is bound to, its effective capabilities and limits, and which actions are available. Every action that is unavailable or read-only says why. The answer also carries the project setup block: which identity is running, which was offered, which a finished check actually covered, whether setup can run here at all, the launch definition to name when dispatching one, and whether issue filing works here (the skill to select, or why not). Reading it changes nothing and authorises nothing. Call it at the start of a session and again after a person changes settings. It takes no arguments: the project comes from the connection, never from a parameter. A project leader works through these tools only, never the cockpit UI and never the HTTP API. Whether this session is attached as leader is not part of this answer: call leader_events with action status.

Takes no arguments. Unknown arguments are rejected.

### `organise_work`

> Organise this project's tasks the way the xezar cockpit does. Pick one `action`:
> - list_queue: the queued tasks, oldest first (the order they start in), with their brief and queued message ids. Paginated: pass `next` back as `cursor`.
> - set_title: rename a task (any status).
> - edit_brief / edit_queued_message / remove_queued_message: change a queued task before it starts. Refused once the task has started.
> - pin / unpin, archive / restore, mark_read / mark_unread: per-task flags. Archive is refused while the task is queued, running or waiting.
> - archive_finished / mark_all_read: sweep every finished task of this project.
> - delete: remove a task, its transcript, its worktree and its branch. Irreversible. Refused while the task is active.
> - start_inbox_item / remove_inbox_item: act on an Inbox item (needs the Inbox to be on).
> - pick_variant: keep one variant of a group. Refused until every variant has finished; then every other variant is archived and its worktree and branch are deleted. Irreversible.
> Every action that changes one task needs expectedVersion: the `version` task_read (view task) returned for it — for pick_variant, the variant you keep. If the task changed since you read it, nothing is applied and the answer is status "conflict" with error "stale_version": read it again and decide again.
> No confirmation is needed for any action. Tasks have no priority and no dependencies: there is nothing to reorder. A refusal the task state caused comes back with status "conflict" and the reason.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `list_queue` \| `set_title` \| `edit_brief` \| `edit_queued_message` \| `remove_queued_message` \| `pin` \| `unpin` \| `archive` \| `restore` \| `archive_finished` \| `mark_read` \| `mark_unread` \| `mark_all_read` \| `delete` \| `start_inbox_item` \| `remove_inbox_item` \| `pick_variant` | yes |  | What to do. See the tool description for each action. |
| `runId` | string | no | min length 1, max length 128, pattern `^[A-Za-z0-9._-]+$` | The task id. For pick_variant: the variant to keep. |
| `expectedVersion` | string | no | min length 1, max length 512 | Required by every action that changes one task (set_title, edit_brief, edit_queued_message, remove_queued_message, pin, unpin, archive, restore, delete) and by pick_variant: the `version` task_read gave you for that task — for pick_variant, the variant you keep. Echo it verbatim. |
| `operationId` | string | no | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | Client-generated key for this operation (8–128 chars). Required by every action except list_queue, which reads and takes none. Reuse it only to repeat the same operation: a repeat returns the first answer and organises nothing twice. |
| `title` | string | no |  | set_title: the new title. |
| `task` | string | no |  | edit_brief: the replacement brief. Only while the task is queued. |
| `messageId` | string | no | min length 1, max length 128, pattern `^[A-Za-z0-9._-]+$` | edit_queued_message / remove_queued_message: the queued message id (list_queue shows them). |
| `text` | string | no |  | edit_queued_message: the replacement text. |
| `todoId` | string | no | min length 1, max length 128, pattern `^[A-Za-z0-9._-]+$` | start_inbox_item / remove_inbox_item: the Inbox item id. |
| `runner` | `claude` \| `codex` \| `opencode` \| `pi` | no |  | start_inbox_item: the agent backend; omitted means the project default. |
| `model` | string | no |  | start_inbox_item: the model; omitted means the backend default. |
| `prompt` | string | no |  | start_inbox_item: extra instructions appended to the item. |
| `groupId` | string | no | min length 1, max length 128, pattern `^[A-Za-z0-9._-]+$` | pick_variant: the variant group id. |
| `cursor` | string | no | min length 1, max length 2048 | list_queue: the `next` value of the previous page. |
| `limit` | integer | no | min 1, max 100 | list_queue: at most this many items (default and maximum 100). |

### `task_create`

> Create a task in this project with the New task form's options, defaults and validation, plan one first, start an Inbox entry, or save a planned step list as a workflow. Options you omit resolve exactly as the form resolves them for this project. `start` returns promptly with the run id and status `accepted`; it does not wait for the task, so read the task status separately. A git task that asks for a worktree and cannot get one is marked failed before any step runs; it never falls back to the checkout.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `start` \| `plan` \| `start_from_inbox` \| `save_plan` | no | default `"start"` | `start` (default) creates a task like the New task form. `plan` asks the planner for steps. `start_from_inbox` starts an Inbox entry. `save_plan` saves a step list as a project workflow. |
| `operationId` | string | yes | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | Client-generated key for this operation (8–128 chars). Reuse it only to repeat the same operation. |
| `prompt` | string | no |  | The task text (start, plan; up to 100000 chars), or extra instructions (start_from_inbox; up to 20000 chars). |
| `images` | array of object | no | max items 4 | Attachments (start): up to 4, base64 images, plain text, markdown or PDF. |
| `images[].mediaType` | string | yes |  |  |
| `images[].data` | string | yes | min length 1, max length 7000000 |  |
| `source` | object or null | no |  | What the task runs (start): a skill or a workflow by name. Omit or null for the plain built-in `quick-task`. |
| `source.source` | `skill` \| `workflow` | yes |  |  |
| `source.ref` | string | yes | min length 1 |  |
| `steps` | array of object | no | min items 1, max items 8 | An inline step list (start from a reviewed plan, or save_plan). Not combined with `source`. |
| `steps[].id` | string | yes | min length 1 |  |
| `steps[].name` | string | no |  |  |
| `steps[].prompt` | string | no |  |  |
| `steps[].skill` | string | no |  |  |
| `steps[].model` | string | no |  |  |
| `steps[].runner` | `claude` \| `codex` \| `opencode` \| `pi` | no |  |  |
| `steps[].allowedTools` | array of string | no |  |  |
| `steps[].bashAllowlist` | array of string | no |  |  |
| `steps[].timeout` | string | no |  |  |
| `steps[].command` | string | no |  |  |
| `steps[].resultScope` | `routine` \| `stage` | no |  |  |
| `steps[].onFail` | object | no |  |  |
| `steps[].onFail.retry` | string | yes | min length 1 |  |
| `steps[].onFail.max` | integer | no | max 9007199254740991, default `2` |  |
| `model` | string | no |  | Model id (start, start_from_inbox). Omit for the runner's configured default; '' means auto. |
| `runner` | `claude` \| `codex` \| `opencode` \| `pi` | no |  | Agent backend (start, start_from_inbox). Omit for the project default. |
| `agentProfile` | string | no | max length 64 | Agent account id (start only). Omit to follow the project's selection. |
| `variants` | integer | no | min 1, max 3 | 1–3 competing runs (start). Above 1 needs git and always uses worktrees. |
| `worktree` | boolean | no |  | false runs in the repo working tree (start, single runs only). Omit for the workspace default. |
| `autonomous` | boolean | no |  | true never pauses for the user (start). Omit for the workspace default. |
| `generateFollowups` | boolean | no |  | false stops follow-up inbox entries (start). Omit for on. |
| `todoId` | string | no | min length 1, max length 200 | The Inbox entry: the one to start (start_from_inbox), or the one this task came from (start). |
| `name` | string | no |  | Workflow name (save_plan, up to 80 chars). |
| `description` | string | no |  | Workflow description (save_plan). |
| `overwrite` | boolean | no |  | save_plan: replace an existing workflow of that name. Ask the user first. |

### `handoff_git`

> Hand a task's work onward through the cockpit's own operations: commit a task's worktree, push its branch, open its draft pull request, mark a draft pull request ready for review, read a pull request's merge readiness, invoke the existing merge, and switch or create branches of the main checkout. Every action runs at once, with the same checks the cockpit applies; a refusal carries the service's own reason unchanged. commit, push and create_pr need the task's expectedVersion (from task_read) and do nothing, answering status "conflict" with error "stale_version", if the task changed since. ready and merge need the headSha you reviewed and are refused if the head moved. Failing, pending or unreadable required checks and missing reviews are merge blockers, and a failing required check or a changes-requested review blocks ready; no argument bypasses a blocker: repair the cause or report the blocker.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `repo` \| `commit` \| `push` \| `create_pr` \| `merge_state` \| `ready` \| `merge` \| `branch` | yes |  | repo: read the main checkout (branch, branches, base, whether a remote exists, uncommitted count). commit / push / create_pr: act on one task (taskId). merge_state: read one pull request (number) fresh, with its quality blockers. ready: mark a draft pull request ready for review (number, expectedHeadSha). merge: invoke the existing merge (number, expectedHeadSha). branch: switch to, or create and switch to, a branch of the main checkout (name, from). |
| `taskId` | string | no | min length 1, max length 128 | The task to commit, push or publish. |
| `expectedVersion` | string | no | min length 1, max length 512 | commit / push / create_pr: the `version` task_read returned for the task. If the task changed since, nothing is done. |
| `operationId` | string | no | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | Client-generated key for this operation (8–128 chars). Required by every action that hands work onward (commit, push, create_pr, ready, merge, branch); the two reads (repo, merge_state) take none. Reuse it only to repeat the same operation: a repeat returns the first answer and never commits, pushes, readies or merges twice. |
| `message` | string | no | min length 1, max length 5000 | commit: the commit message. |
| `number` | integer | no | max 9007199254740991 | merge_state / ready / merge: the pull request number. |
| `expectedHeadSha` | string | no | pattern `^[0-9a-f]{40}$` | ready / merge: the headSha of the state you reviewed. A moved head is refused, never readied or merged. |
| `method` | `merge` \| `squash` \| `rebase` | no |  | merge: one of the state's methods; defaults to its defaultMethod. |
| `name` | string | no | min length 1, max length 200 | branch: the branch to switch to or create. |
| `from` | string | no | min length 1, max length 200 | branch: start point when creating. |

### `read_results_evidence`

> Read what a task produced and the project's GitHub state, each answer identified by the revision it describes. Task reads (need runId): summary, history, changes (the task's own diff, anchored like the cockpit's Changes tab), files (path), commits, commit (sha), handoff. Repository reads: repo, repo_changes, repo_commit (sha). GitHub reads: github, github_comments, github_checks, github_search, github_ref_status, pr_merge_state, pr_changes. Every task read returns revision.headSha. Pass it back later as expectedHeadSha to learn whether that evidence is still current (freshness: 'stale' when the tree moved). evidence: 'unavailable' means it cannot be read now (for example the worktree was reclaimed) — never that nothing changed. 'done' is not proof that checks passed. Answers are paged (page.next); a page that is one large item comes as fragments to concatenate. This is a read for assessment, not a status poll.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `read` | `summary` \| `history` \| `changes` \| `files` \| `commits` \| `commit` \| `handoff` \| `repo` \| `repo_changes` \| `repo_commit` \| `github` \| `github_comments` \| `github_checks` \| `github_search` \| `github_ref_status` \| `pr_merge_state` \| `pr_changes` | yes |  | Which evidence to read. |
| `runId` | string | no | min length 1, max length 256 | The task id. Required by every task read. |
| `path` | string | no | max length 4096 | files: a path relative to the task working directory; omit for its root. |
| `sha` | string | no | pattern `^[0-9a-fA-F]{4,40}$` | commit / repo_commit: the commit to read. |
| `number` | integer | no | max 2147483647 | github_comments / pr_merge_state / pr_changes: the issue or PR number. |
| `kind` | `issue` \| `pr` | no |  | github_comments / github_search: issue or pull request. |
| `prs` | array of integer | no | min items 1, max items 100 | github_checks / github_ref_status: PR numbers. |
| `issues` | array of integer | no | min items 1, max items 100 | github_ref_status: issue numbers. |
| `query` | string | no | min length 1, max length 256 | github_search: the search text. |
| `limit` | integer | no | max 100 | github / github_search: how many items to ask GitHub for. |
| `refresh` | boolean | no |  | GitHub reads: bypass the cockpit cache. |
| `expectedHeadSha` | string | no | pattern `^[0-9a-fA-F]{7,40}$` | The revision.headSha of an earlier read. The answer says whether that evidence is still current. |
| `cursor` | string | no | min length 1, max length 2048 | The page.next value of the previous page of this same read. |

### `project_config`

> Read and change THIS project's own configuration: its settings (agent, models, system prompt, review gate, base branch, worktree retention, memory limit), its registry entry (concurrency cap and tags), prompt templates, in-repo agent config files, workflows, skills, GitHub automations and worktrees. Shared settings are readable only as effective limits and capabilities (get_limits, get_capabilities, get_account). Workspace-wide settings, agent accounts, account identity, home files, the project registry and host folders are outside this boundary and are refused with the reason.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `get_config` \| `set_config` \| `get_project` \| `set_project` \| `get_prompt_templates` \| `set_prompt_templates` \| `get_limits` \| `get_capabilities` \| `get_account` \| `list_agent_config` \| `read_agent_config` \| `write_agent_config` \| `list_workflows` \| `parse_workflow` \| `save_workflow` \| `delete_workflow` \| `list_skills` \| `get_skill` \| `list_importable_skills` \| `refresh_skills` \| `check_skill_updates` \| `list_automations` \| `get_automation` \| `create_automation` \| `update_automation` \| `delete_automation` \| `enable_automation` \| `pause_automation` \| `check_automation` \| `get_automation_check` \| `get_automation_log` \| `retry_automation_receipt` \| `list_worktrees` \| `reclaim_worktrees` \| `remove_worktree` \| `dismiss_onboarding_offer` \| `set_provider_enabled` \| `connect_provider` \| `retry_provider` \| `create_account` \| `update_account` \| `remove_account` \| `select_account` \| `check_account_status` \| `get_account_details` \| `open_account_file` \| `set_workspace_config` \| `set_workspace_ui_state` \| `browse_folders` \| `add_project` \| `clone_project` \| `remove_project` \| `apply_skill_updates` \| `import_skills` \| `get_launch_key` \| `open_in_app` | yes |  | What to do in the project this connection is bound to. Actions outside the project boundary (workspace settings, accounts, the project registry, host folders) are answered with a refusal that names the boundary. |
| `projectId` | any | no |  | Never accepted: the project is the one this connection is bound to, and a call that names one is refused. |
| `config` | object | no |  | set_config: the project's own settings to change. null clears a key back to its default. |
| `config.baseBranch` | string or null | no | min length 1, max length 200 |  |
| `config.defaultRunner` | `claude` \| `codex` \| `opencode` \| `pi` | no |  |  |
| `config.systemPrompt` | string or null | no | max length 20000 |  |
| `config.defaultModels` | object | no |  |  |
| `config.defaultModels.claude` | string or null | no | max length 200 |  |
| `config.defaultModels.codex` | string or null | no | max length 200 |  |
| `config.defaultModels.opencode` | string or null | no | max length 200 |  |
| `config.defaultModels.pi` | string or null | no | max length 200 |  |
| `config.memoryLimitMb` | integer or null | no | min 0, max 1048576 |  |
| `config.worktreeRetention` | integer or null | no | min 0, max 1000 |  |
| `config.liveTitleUpdates` | boolean or null | no |  |  |
| `config.reviewGate` | boolean or null | no |  |  |
| `config.plannerModel` | string or null | no | min length 1, max length 200 |  |
| `config.namerModel` | string or null | no | min length 1, max length 200 |  |
| `config.skillsRepos` | array of object or null | no | max items 32 |  |
| `config.skillsRepos[].repo` | string | yes | min length 1, max length 500 |  |
| `config.skillsRepos[].ref` | string | no | min length 1, max length 200 |  |
| `project` | object | no |  | set_project: this project's concurrency cap (maxParallel, null inherits the workspace cap) and/or its tags (whole list). |
| `project.maxParallel` | integer or null | no | min 1, max 16 |  |
| `project.tags` | array of string or null | no | max items 20 |  |
| `promptTemplates` | array of object | no |  | set_prompt_templates: the WHOLE list of follow-up prompt templates; [] is an empty list. |
| `promptTemplates[].id` | string | yes |  |  |
| `promptTemplates[].label` | string | yes |  |  |
| `promptTemplates[].text` | string | yes |  |  |
| `promptTemplates[].skills` | array of string | no |  |  |
| `fileId` | string | no | min length 1, max length 128 | An agent config file id from list_agent_config — never a path. |
| `content` | string | no | max length 2000000 | write_agent_config: the full new file content. |
| `version` | string or null | no |  | write_agent_config: the version from the read you based the edit on; null when the file does not exist yet. |
| `yaml` | string | no | min length 1, max length 100000 | parse_workflow: workflow YAML to validate and normalise. |
| `workflow` | object | no |  | save_workflow: name plus exactly one of steps (agent steps: prompt or skill) or skills. Check steps (shell commands) are not accepted. An existing file is refused unless overwrite is true. |
| `workflow.name` | string | yes | min length 1, max length 80 |  |
| `workflow.description` | string | no | max length 2000 |  |
| `workflow.skills` | array of string | no | min items 1, max items 8 |  |
| `workflow.overwrite` | boolean | no |  |  |
| `workflow.steps` | array of object | no | min items 1, max items 8 |  |
| `workflow.steps[].id` | string | yes | min length 1 |  |
| `workflow.steps[].name` | string | no |  |  |
| `workflow.steps[].prompt` | string | no |  |  |
| `workflow.steps[].skill` | string | no |  |  |
| `workflow.steps[].model` | string | no |  |  |
| `workflow.steps[].runner` | `claude` \| `codex` \| `opencode` \| `pi` | no |  |  |
| `workflow.steps[].allowedTools` | array of string | no |  |  |
| `workflow.steps[].bashAllowlist` | array of string | no |  |  |
| `workflow.steps[].timeout` | string | no |  |  |
| `name` | string | no | min length 1, max length 200 | delete_workflow / get_skill: the workflow or skill name. |
| `wait` | boolean | no |  | Skill reads: wait for a cold team-skill cache to load first. |
| `refresh` | boolean | no |  | get_capabilities: probe provider status now instead of serving the cached answer. |
| `automationId` | string | no | min length 1, max length 128 |  |
| `automation` | object | no |  | create_automation: the cockpit form — name, prompt template, enable. Trigger: new issue, every 5 minutes, last 7 days, at most 25 records; task workflow quick-task. |
| `automation.name` | string | yes | min length 1 |  |
| `automation.prompt` | string | yes | min length 1 |  |
| `automation.enable` | boolean | no |  | Enable from a current-time baseline (existing matches will not launch). Default false. |
| `update` | object | no |  | update_automation: a new name and/or prompt plus expectedRevision from your last read; everything else is kept. |
| `update.name` | string | no | min length 1 |  |
| `update.prompt` | string | no | min length 1 |  |
| `update.expectedRevision` | number | yes |  |  |
| `mode` | `preview` \| `execute` | no |  | check_automation: preview counts matches; execute launches them. |
| `checkId` | string | no | min length 1, max length 128 |  |
| `receiptId` | string | no | min length 1, max length 128 |  |
| `logQuery` | object | no |  |  |
| `logQuery.automationId` | string | no | min length 1, max length 128 |  |
| `logQuery.result` | `launched` \| `no-match` \| `duplicate` \| `rate-limited` \| `error` \| `baseline` \| `preview` | no |  |  |
| `logQuery.event` | `pull_request.opened` \| `issue.opened` \| `issue.labeled` \| `issue.unlabeled` | no |  |  |
| `logQuery.since` | string | no | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$` | ISO timestamp; only newer rows. |
| `logQuery.cursor` | integer | no | max 9007199254740991 | Row sequence to continue from. |
| `logQuery.limit` | integer | no | min 1, max 100 |  |
| `runId` | string | no | min length 1, max length 128 | remove_worktree: the task's run id. |
| `expectedVersion` | string | no | min length 1, max length 512 | remove_worktree: the `version` task_read returned for the task. If the task changed since, nothing is removed. |
| `onboardingIdentity` | object | no |  | dismiss_onboarding_offer: the `onboarding.observed` pair discover_project returned to you. If the running identity has moved on since that read, the answer is a conflict and nothing is written. Omit it to dismiss whatever is running now. |
| `onboardingIdentity.engineVersion` | string | yes |  |  |
| `onboardingIdentity.kitDigest` | string | yes |  |  |
| `operationId` | string | no | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | Client-generated key for this operation (8–128 chars). Required by every action that changes something and refused by every action that only reads. Reuse it only to repeat the same operation: a repeat returns the first answer and changes nothing twice. |

### `local_handoff`

> Hand a task or the project off to a desktop app — a terminal resuming the task’s agent session, an editor, the file manager. Every app opens on the XEZAR HOST MACHINE (the computer running the xezar service), never on the machine your MCP client runs on. When the xezar host has no desktop to hand off to (hosted mode), every action answers "unavailable" with the reason and opens nothing. When no terminal emulator is found, the answer carries fallbackCommand to run in a terminal on the xezar host. No per-operation confirmation is needed: opening an app is a project operation inside the approved goal. Goal and definition-of-done decisions stay with the human and are not offered here, and no parameter can waive a quality gate or an acceptance criterion.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `list_apps` \| `open_task_in_terminal` \| `open_task_in_app` \| `open_project_in_app` | yes |  | list_apps: the apps installed on the xezar host. open_task_in_terminal: resume the task’s agent session in a terminal on the xezar host. open_task_in_app: open the task’s worktree in an app on the xezar host. open_project_in_app: open the project folder in an app on the xezar host. |
| `runId` | string | no | min length 1, max length 128 | The task's run id, in the project this connection is bound to. |
| `target` | string | no | min length 1, max length 200 | An app id from list_apps (for example "finder", "terminal", "vscode", "cli:claude"). |
| `operationId` | string | no | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | Client-generated key for this operation (8–128 chars). Required by every open_ action; list_apps reads and takes none. Reuse it only to repeat the same operation: a repeat returns the first answer and opens nothing a second time. |

### `leader_events`

> Attach this session as the project's leader so xezar pushes its significant events to it (task outcomes, questions, required check results, human changes, executor availability), and read and acknowledge those events.
> attach: make this session the leader xezar pushes events to – a `<channel source="xezar">` message in Claude Code, a started turn in Codex or pi. The client is this session’s own; you never name it. Call it once per session with a new operationId, and again when status says you are not attached. stop: detach this session. status: whether this session is attached and can receive pushes, the delivery cursors, and what blocks delivery. An OpenCode leader is attached by a person in Settings → MCP connection.
> Each pushed message names the cursor of its last event. Once you have taken the events into account, ack that cursor. No read is needed.
> Leader setup has four separate states: files prepared (a project snippet only), connected (a real MCP tool call reached this project), attached (this session owns the attachment), and delivery verified (a real pushed event or an attached-session replay check). Never call a snippet ready. After a restart, status and attach must be repeated with a new operationId before delivery is verified again.
> read is the fallback: call it when you connect or reconnect, when you are not attached, or when a pushed message names a gap. It returns the outstanding events in order, each with a stable eventId and a standing (current, superseded or unjudged), then the current state of the tasks they name — the state is the authority, an event is history.
> When hasMore is true, read again at once; otherwise do not poll.
> After you have taken a page into account, ack its nextCursor. Until you do, read returns the same events again, so drop any eventId you already handled. Acknowledging an older cursor changes nothing.
> status "gap" means events after your position are no longer retained: nothing is replayed, the current state is included, and you continue by acking resumeCursor.
> task.stalled is an advisory observation: no transcript activity for 5 minutes, or at least 80% of a finite step timeout used. It does not prove a deadlock and does not stop the task. Read the task before deciding whether to steer or cancel it. task.resumed says activity came back.
> Pushes omit routine successful setup checks. They include failures and stage results; omittedRoutineCount counts routine passes covered by a pushed cursor. Acknowledging that cursor also accounts for those routine passes. leader_events read returns the full retained journal, including omitted passes.
> After context compaction, call leader_events with action read and no cursor before relying on prior pushes. It replays retained events after your last explicit acknowledgement, including events pushed but not acknowledged. Read every page using nextCursor while hasMore is true. Deduplicate by eventId, reconcile current task state, then acknowledge only the events you have accounted for. A transport receipt is not an acknowledgement. Already acknowledged events are not replayed by default; use a retained earlier cursor if you deliberately need history. If the journal reports a gap, reconcile the returned current state before acknowledging resumeCursor. Do not poll while idle.
> Delivery is at-least-once within retained durable state, not exactly-once: xezar retains at least the newest 10000 events and evicts none younger than 14 days, and a page carries at most 100 events or 40000 bytes. Events outside that are reported as an explicit gap, never as silence. Acknowledgement is cumulative, monotonic and idempotent, and only your ack moves it: reading or receiving an event does not. Nothing already delivered to this session is pushed again on a timer.

Unknown arguments are rejected.

| Argument | Type | Required | Limits | Description (verbatim from the schema) |
| --- | --- | --- | --- | --- |
| `action` | `read` \| `ack` \| `attach` \| `stop` \| `status` | yes |  | read: the events outstanding since your last acknowledged position, then the current state of the tasks they name. ack: record that you have taken every event up to cursor into account. attach: make this session the project’s leader, so events are pushed to it. stop: detach this session. status: this session’s attachment, push capability and delivery state. |
| `cursor` | string | no | min length 1, max length 2048 | read: replay after this cursor instead of your acknowledged position (optional; it never moves the acknowledgement). ack: required — the cursor a pushed message names, the nextCursor of a page, or the resumeCursor of a gap. Not accepted by attach, stop or status. |
| `limit` | integer | no | min 1, max 100 | read: events per page, at most 100. |
| `operationId` | string | no | min length 8, max length 128, pattern `^[A-Za-z0-9_.:-]+$` | ack, attach and stop: required — a client-generated key for this call (8–128 chars). Use a new one for every call; reuse it only to repeat the same call after a lost answer. read and status: not accepted, because they change nothing you would want replayed. |
<!-- mcp-api:arguments:end -->

## Results

### The shared envelope

Every tool answers the same MCP envelope (`toolResultSchema`, `packages/xezar/src/mcp/ipc.ts:92`):

| Field | Type | Meaning |
| --- | --- | --- |
| `content` | array of `{ type: 'text', text }` | Exactly one text block. **It is the authoritative answer** (D-05). |
| `structuredContent` | object, optional | May repeat or add to the text. It may never contradict it. |
| `isError` | boolean, optional | `true` marks the call as failed. Tools disagree about what counts (below). |

Two failures look the same in every tool, because the service produces them before a tool runs
(`packages/xezar/src/mcp/service.ts:195`):

- **Invalid arguments.** Prose `Invalid arguments for <tool>: …`, with `isError: true` and no
  `structuredContent`.
- **A throw inside xezar.** Prose `<tool> failed inside xezar; …`, with `isError: true`.

Nothing else is shared. **Inside the envelope, each tool uses its own vocabulary.** The tools
declare no output schema, so the table below is hand-maintained.

### Per tool

| Tool | Text block | `structuredContent` | Status words it returns today | `isError: true` when |
| --- | --- | --- | --- | --- |
| `health` | JSON `{ ipcVersion, xezarVersion, project: { id, name } }` | — | none | the service cannot be reached |
| `task_read` | JSON, one shape per view (`{ view, … }`) | never | **no `status` field**. The inbox view answers `available: true \| false` with a `reason` | not connected, a bad argument or cursor, an unknown task (`No such task in this project.`) |
| `execution_control` | JSON `ExecutionControlResult` | the same object | `status`: `accepted` · `done` · `cancelled` · `conflict` · `failed`. `accepted`: boolean. `delivery`: `live` · `deferred` · `amended` · `continued` · `resumed` | only `status: 'failed'` |
| `discover_project` | **prose headline** plus one line per closed action, then pretty JSON | the discovery object | per action: `available` · `unavailable` · `read-only`, each with a `reason` | never on its own |
| `organise_work` | JSON | never | `status`: `done` · `conflict` · `accepted` (`start_inbox_item` only, with `accepted: true`) | a refusal that is not a 409, an unowned id, a bad cursor, not connected |
| `task_create` | JSON | the same body | `status`: `accepted` · `running` · `done` · `failed` · `cancelled` · `conflict` (`McpStatus`, `task-create.ts:351`). A replayed or pending operation answers the receipt's own words (below) | a refusal other than 409, and a receipt answer with `error` or `status: 'rejected'` |
| `handoff_git` | redacted JSON | never | `status`: `done` · `failed` · `conflict`. `refusedBy`: `policy` · `service` · `quality` · `forge`. `blocker: true` with `code` (`check-<state>`, `review`, `reviews`, `rules-unknown`, `blocked`, `pending`, `unauthorized`, `terminal`, `unknown`, `stale-head`) | only not connected and argument problems — **`status: 'failed'` is not `isError` here** |
| `read_results_evidence` | JSON envelope | never | `evidence`: `available` · `unavailable` · `stale`. `freshness`: `current` · `stale`. **`status` is a number, the HTTP status** | missing arguments, not connected, bad cursor, not found, 400, 5xx. `evidence: 'unavailable'` is not an error |
| `project_config` | success: pretty JSON `{ action, origin: 'mcp', result }`. Failure: **prose** | success: the same object. Failure: `{ action, origin, status: <number>, error }`. Refusal: `{ action, origin, refused: true, boundary }` | no status word on success. `status` is a number on failure. `boundary` names the refusal (see [Project scoping](#project-scoping-and-what-is-refused)) | every refusal and failure, **except** a stale write |
| `local_handoff` | **prose lines** | the full JSON result | `status`: `done` · `failed` · `conflict`. `outcome`: `opened` · `listed` · `unavailable` · `fallback` · `refused`. `affects`: `xezar-host` · `nothing` | only `outcome: 'refused'` with `status: 'failed'` |
| `leader_events` | **prose headline** plus compact JSON | the same JSON | `read`: `status` `ok` · `gap`. `ack`: `status` `acked` · `no-op`. Each event has `standing`: `current` · `superseded` · `unjudged`. `attach` / `stop`: `ok` with `outcome` `attached` · `already-attached` · `stopped` · `already-stopped`. `status`: `available`, `owner`, `leader`, `delivery`, `blocker`, `canPush`, `pushUnavailable` and `self` (`client`, `isOwner`, `attached`) | a bad or foreign cursor (`error`: `invalid_cursor` · `cursor_project_mismatch`), an `attach` or `stop` refusal (`ok: false`, `code`: `delivery-unavailable` · `hosted-mode` · `not-owner` · `client-unknown` · `client-needs-address` · `leader-attached-elsewhere` · `leader-not-this-session` · `attach-refused`, with `message`, `fix` and, for `attach-refused`, the client's own `blocker`), not connected |

### Where the tools disagree

A client that handles one tool's answers correctly will misread another's. These are the places
where that happens:

1. **What a failure looks like.** `execution_control` sets `isError` on `status: 'failed'`.
   `handoff_git` returns `status: 'failed'` without `isError`. `project_config` sets `isError` on
   every refusal. `read_results_evidence` sets it only when it cannot read at all.
2. **What `status` is.** It is a string word in `execution_control`, `organise_work`, `task_create`,
   `handoff_git`, `local_handoff` and `leader_events`. It is **a number** (the HTTP status) in
   `read_results_evidence` and in `project_config` failures. It is absent from `task_read`.
3. **The success word.** `done` (`organise_work`, `handoff_git`, `local_handoff`), `accepted` or
   `done` (`execution_control`, `task_create`), `ok` (`leader_events`, receipts), `acked`
   (`leader_events`), and no word at all (`project_config`, `task_read`).
4. **`accepted` means two things.** `execution_control` and `task_create` answer both a boolean
   `accepted` and a string `status: 'accepted'`. A refused call answers `accepted: false` together
   with `status: 'conflict'`.
5. **"stale" means three things.** `stale_version` is a task that changed since it was read. It
   appears in `execution_control`, `organise_work`, `handoff_git` and `project_config` as
   `status: 'conflict'` with `error: 'stale_version'`. `code: 'stale-head'` in `handoff_git` is a
   pull-request head that moved before a merge. `evidence` or `freshness: 'stale'` in
   `read_results_evidence` is evidence that no longer describes the tree.
6. **"unavailable" means three things.** In `discover_project` it is an action the project cannot
   offer now. In `local_handoff` it means there is no desktop on the xezar host. In
   `read_results_evidence` it means evidence that cannot be read, such as a reclaimed worktree —
   never "nothing changed".
7. **The refusal field.** `handoff_git` uses `refusedBy` plus `blocker`. `project_config` uses
   `refused: true` plus `boundary`. `local_handoff` uses `outcome: 'refused'`. The state-machine tools
   use `status: 'conflict'` plus `reason`.
8. **Where the answer lives.** Four tools answer in the text only (`task_read`, `organise_work`,
   `handoff_git`, `read_results_evidence`). Four repeat it in `structuredContent`
   (`execution_control`, `task_create`, `leader_events`, `project_config` on success). Two answer
   prose text with JSON in `structuredContent` (`local_handoff`, `project_config` on failure).
   `discover_project` answers prose followed by JSON.

## The two meanings of `origin`

Two fields are both called `origin`. They answer different questions, come from different
decisions, and never share a value.

| | Event origin | Audit origin |
| --- | --- | --- |
| Question it answers | **Who caused this change?** | **Which door did this operation come through?** |
| Values | `human` · `leader` · `system` | `ui` · `mcp` · `automation` · `cli` |
| Defined by | `mcpJournalOriginSchema`, `packages/contract/src/mcp-journal.ts:54` | `auditOriginSchema`, `packages/contract/src/audit.ts` |
| Decision | [D-05 § 6.3](mcp-d05-async-event-contract-decision.md#63-what-enters-the-journal--decided) | [D-06 § 10.2](mcp-d06-versioning-idempotency-audit-decision.md#102-decision--the-field-list) |
| Where a leader sees it | every `leader_events` row | not at all: the audit trail (`.local/xezar/audit.ndjson`) is local evidence, not a tool answer |
| Who sets it | the server. The MCP door marks its own mutations `leader`, with `causedBy` set to the operation id, or to a door-minted id when the call has none (`packages/xezar/src/mcp/index.ts:267`) | the server, fixed once per door (`AuditTrail.channel(origin)`), together with the record's `actor`, whose `type` must equal it. No operation and no client argument carries either |
| Wired today | all three values | all four since [#306](https://github.com/qodeca/xezar/issues/306) part 2: `mcp` in `composeDoor` (`packages/xezar/src/mcp/index.ts`), `ui` on the HTTP routes (`packages/xezar/src/server/audit-ui.ts`), `automation` in the automation runner (`packages/xezar/src/automations/audit.ts`) and `cli` for every command-line subcommand (`packages/xezar/src/cli-audit.ts`). Which operations are recorded, and under which action id, comes from one shared inventory, `packages/xezar/src/mcp/audit-inventory.ts` |

A third, narrower use: some tool results (`execution_control`, `project_config`, `local_handoff`)
carry `origin: 'mcp'`. This is a constant stamp saying "this answer came through MCP"
(`MCP_ORIGIN`, `packages/xezar/src/mcp/service-adapter.ts:49`). It is not a vocabulary.

## Cross-cutting rules

### Project scoping and what is refused

A connection is bound to exactly one project: the one whose socket the bridge reached. No argument
can change that binding ([requirements](mcp-project-leader-requirements.md) F-01, F-02 and F-16,
§ 8; [D-02](mcp-d02-session-binding-decision.md)).

- `project_config` declares a `projectId` argument only in order to refuse it.
- A foreign id is answered as not found, and the answer never says whether the id exists in another
  project (N-01).
- The line between a project write and a global read comes from the
  [settings classification (D-03)](mcp-settings-classification.md).

`project_config` lists 20 actions whose only answer is a refusal, so a leader learns the reason
instead of a schema error (`REFUSED_ACTIONS`, `packages/xezar/src/mcp/tools/project-config.ts:171`).
None of them dispatches anything. Each refusal names its boundary:

- `workspace-settings`
- `agent-accounts`
- `account-identity`
- `host-process`
- `host-filesystem`
- `project-registry`
- `secret`

Three more boundaries (`project-binding`, `home-file`, `outside-project`) answer bad arguments, not
actions. The records each refusal answers are in [Tool action → records](#tool-action--records).

### Stale writes and the version token

This rule comes from [D-06 § 4](mcp-d06-versioning-idempotency-audit-decision.md#4-stale-write-rejection-n-03)
and was shipped by #250.

**Getting the token.** A read returns the task's `version`. Only the first page of `task_read`'s
`task`, `history`, `context` and `handoff` views carries it. The token has the shape
`rev1:<kind>:<id>:<seq>:<digest>`, for example `rev1:run:<runId>:<seq>:<12 hex>`, where `seq` is
`-` when absent (`packages/xezar/src/mcp/stale-write.ts:84`). Treat it as opaque and echo it
verbatim.

**Using it.** A write that changes one task must send it back as `expectedVersion`:

- every `execution_control` action;
- nine `organise_work` actions;
- `handoff_git` `commit`, `push` and `create_pr`;
- `project_config` `remove_worktree`.

**When the task moved.** If the task changed after the read, nothing is applied, and the answer is:

```json
{ "status": "conflict", "applied": false, "error": "stale_version",
  "resource": { "kind": "run", "id": "…" }, "currentVersion": "…", "changedSince": true, "guidance": "…" }
```

It is not `isError`. The leader reads the task again and decides again.

**Other tokens are not this token.**

- `handoff_git` `merge` guards with `expectedHeadSha`, a pull-request head.
- `read_results_evidence` reports freshness against `expectedHeadSha`.
- Automations use `expectedRevision`.
- `write_agent_config` uses the config file's own `version`.

### Operation ids, receipts and idempotency

This rule comes from [D-06 §§ 5–9](mcp-d06-versioning-idempotency-audit-decision.md#5-durable-operation-identity-n-10).
**Every mutating tool action takes a required `operationId`**, and only a call that carries one
creates a receipt (`packages/xezar/src/mcp/index.ts`). The stored key is `<projectId>/<operationId>`.

The exceptions are read actions. Such an action **refuses** an `operationId` rather than accepting
one, because a receipt filed over a read would answer the next identical read with the receipt
instead of with the data. `leader_events read` is the sharp case — returning the same rows again
until they are acknowledged IS its contract.

The test for an exemption is **"a repeat cannot produce a different or a doubled outcome"**, which is
narrower than "it writes nothing", and two of the reads do write. `leader_events read` persists
`deliveredSeq` to `<dataDir>/mcp/leader-cursors.json`, and `project_config get_capabilities` with
`refresh: true` spawns the vendor probes and replaces the process-wide provider-status cache. Both
stay exempt on the narrower test: the first write is monotonic bookkeeping that no user-visible
answer reads back (every consumer of the position reads the **acked** seq, never `deliveredSeq`), and
the second refreshes a cache of an external fact, so a repeat re-reads the world rather than doing
anything twice — serving it a receipt would hand back the stale snapshot `refresh` exists to avoid.
Do not read this list as "these actions are inert".

The tool table above says which actions need the key;
`packages/xezar/src/mcp/tools/operation-id.test.ts` holds every action in the registry to that rule
and lists the reads by name, each with its reason.

When the same id is sent again, the answer is the receipt's, not the original body:

- **Settled.** `{ status: 'ok' | 'rejected' | 'not-applied', operationId, action, replayed, resultRef? }`.
  A replay carries `replayed: true`.
- **Still running.** `{ status: 'in-progress', … }`.
- **Crashed before the outcome was known.** `{ status: 'unverified', reconcile, guidance }`.
- **Same id, different action or payload.** `{ error: 'operation_key_conflict', mismatch }`.
- **The journal cannot be written.** `{ error: 'operation_receipt_unavailable' }`.

Retention is at least 84 hours and the newest 50 000 receipts per project
([D-09 B-21](mcp-d09-limits-retention-packaging-decision.md)).

### The audit record

This rule comes from [D-06 § 10](mcp-d06-versioning-idempotency-audit-decision.md#10-the-audit-record-n-04).
Every mutating call through the MCP door that settles as applied or refused is recorded in
`.local/xezar/audit.ndjson`, one line per operation. Whether a call mutates is decided per action by
the shared inventory (`packages/xezar/src/mcp/audit-inventory.ts`), not by the tool's `readOnlyHint`:
a read action inside a mutating tool, such as `check_automation` with `mode: preview`, is not
recorded. The file is created with mode `0600`.

Since #306 part 3 the trail is bounded and shared safely between processes. Before the append that
would take `audit.ndjson` past 10,000,000 bytes, it rotates to `audit.ndjson.1` (the older files move
on to `.2`–`.4`, and the oldest is deleted), and the new live file starts with one `kind: "rotated"`
marker — five files are kept. Every door takes the same per-project lock for the sequence, the append
and the rotation, and every retained file is kept at mode `0600`. When that cannot be done within two
seconds, or the folder cannot be written, the record is dropped with the same one warning; the tool's
answer never depends on it.

Since [#306](https://github.com/qodeca/xezar/issues/306) part 2 the same file also holds the
cockpit's (`ui`), the automation runner's (`automation`) and the command line's (`cli`) records, so a
leader's change and a human's sit side by side. The same change has the same `action` id through the
cockpit and through MCP (for example `run.pin`). The trail was MCP-only for 0.14.0 and 0.15.0
([D-06 § 10.6](mcp-d06-versioning-idempotency-audit-decision.md#106-recorded-2026-09-12--the-trail-is-mcp-only-for-0140)).

Fields of a version 2 action record (`auditActionRecordSchema`, `packages/contract/src/audit.ts`):

- `v` (`2`), `kind` (`action`), `seq` (grows by one per record), `ts` (UTC), `projectId`;
- `origin`: the door that handled the operation, and `actor`, whose `type` equals it — for this door
  `{ "type": "mcp" }`;
- `action`: the inventory id, and `resource`;
- `fieldNames`: the names of the fields a write changed, when the door knows them;
- `outcome`: `{ "status": "applied" }`, or `{ "status": "refused", "reason": … }`;
- `ownerGeneration`: its millisecond prefix only, and `operationKey` — both MCP-only;
- `versionToken`: kept only when it has the `rev1` shape;
- `payloadDigest`.

How the MCP door settles a call:

- a normal answer is `applied`;
- a stale-version rejection is `refused` with reason `stale_version`;
- a `project_config` boundary refusal (`refused: true` with a `boundary`) is `refused` with the
  boundary as the reason, for example `workspace_settings`;
- a target this project does not have, from the lookup a tool makes before any effect, is `refused`
  with reason `not_found` (#573): `execution_control`'s `failed` answer with reason `not found`,
  `organise_work`'s `not found in this project` or route 404, `task_create`'s inbox 404, and
  `handoff_git`'s `No such task in this project.`;
- an error answer carrying the route's 4xx `status` is `refused` with `http_<status>`; a rejected
  `leader_events` cursor is `refused` with `invalid_cursor` or `cursor_project_mismatch`; a
  `local_handoff` answer with `performed: false` is `refused` with its HTTP status or outcome;
- any other error answer, or a call that throws, may have started its effect, so it is **not
  recorded**; xezar prints one warning per process that the action continued without an audit record.

**Older files.** xezar 0.13.0–0.15.0 wrote version 1 records (`outcome` `ok`, `rejected`,
`not-applied` or `unverified`, plus `errorCode`) to `mcp-audit.ndjson`. That file is read only while
`audit.ndjson` does not exist, with one deprecation line, and is never changed. When both exist, only
`audit.ndjson` is read. The old name stops being read no earlier than 0.18.0
([#563](https://github.com/qodeca/xezar/issues/563)).

**Deliberately left out:**

- every free-text field (prompts, messages, diffs, paths, emails, tokens);
- the raw payload (only its digest is kept);
- the random half of the fencing token.

A field that looks like a secret is dropped, not masked, even when `XEZ_REDACT_SECRETS=0`
(`packages/xezar/src/mcp/audit-trail.ts`, "NO SECRETS, TWICE").

### Events and replay

This rule comes from [D-05 § 6](mcp-d05-async-event-contract-decision.md#6-decisions). Events are
rows of the bound project's own journal. An **attached** leader receives them as pushes – a
`<channel source="xezar">` message in Claude Code, a started turn in Codex, OpenCode or pi – and that
is the normal path (#439). `leader_events` reads the same rows and is the fallback for a leader that
is not attached, and the catch-up after a gap. The unfiltered workspace stream is never forwarded.

A project leader works through these MCP tools only, never the cockpit UI and never the HTTP API,
and that includes attaching (#450). GitHub facts – labels, review verdicts, merge state – are not
carried by the MCP; a leader reads them with `gh`.

- **Attaching.** `attach` makes the calling session the project's leader; call it once per session,
  with a new `operationId`. The client is the session's own – xezar derives it from what the session
  showed (its bridge's client name, or the Codex thread its calls carry) and never takes it from an
  argument. Claude Code, Codex and pi attach themselves; an OpenCode leader is attached by a person in
  **Settings → MCP connection**, because xezar takes no `opencode serve` address from an MCP session.
  Hosted mode refuses `attach` and `stop`, and a leader never replaces or detaches a leader of another
  client. `status` says whether this session is attached and can receive pushes, and why not.
- **Pushed cursor.** Each pushed message names the cursor of its last event (`next_cursor` on a
  Claude Code channel message). Ack that cursor once the events are taken into account; no read is
  needed.
- **Significance.** Pushes omit routine successful setup checks. They include failures and stage
  results; `omittedRoutineCount` counts routine passes covered by a pushed cursor. Acknowledging that
  cursor also accounts for those routine passes. `leader_events read` returns the full retained
  journal, including omitted passes.
- **Restart.** An attachment lives as long as the xezar process. After a restart the leader calls
  `status` and attaches again; events wait in the journal meanwhile. A Claude Code leader whose channel
  is registered gets one notice from its bridge when xezar stops.
- **Reading.** `read` returns the outstanding rows in order, each with a stable `eventId`, followed by
  the current state of the tasks they name. The state is the authority; an event is history.
- **Acknowledging.** `ack` records a position. Until then, `read` repeats the same rows.
- **Gaps.** `status: 'gap'` means rows after the position are no longer retained. Nothing is
  replayed, and the leader continues from `resumeCursor`.
- **No polling.** Attach once; read on connect, after a gap, and when `hasMore` is true.
- **Reused keys.** `attach` and `stop` carry an `operationId`, so a reused key replays its receipt –
  also after a restart that ended the attachment. Use a new key for every attach.
- **After a context compaction** (#460 § 4). A compacted leader cannot know which pushed messages it
  still holds, and xezar re-pushes nothing on a timer, so the recovery is a read: call `leader_events`
  with action `read` and no cursor before relying on prior pushes. It replays the retained events
  after the last explicit acknowledgement, *including events that were pushed but never acknowledged*.
  Read every page with `nextCursor` while `hasMore` is true, deduplicate by `eventId`, reconcile the
  current task state, then acknowledge only what has been accounted for. A transport receipt is not an
  acknowledgement. Acknowledged events are not replayed by default – a retained earlier cursor rewinds
  the read deliberately, and never moves the acknowledgement. On a gap, reconcile the returned current
  state before acknowledging `resumeCursor`. Do not poll while idle.

**The guarantee, stated exactly.** Delivery is **at-least-once within retained durable state** – not
exactly-once, and not a promise about deleted or corrupt runtime state. The journal retains at least
the newest 10 000 rows per project and evicts no row younger than 14 days
([D-09 B-19](mcp-d09-limits-retention-packaging-decision.md)); a page carries at most 100 rows or
40 000 bytes (B-02 / B-01). Anything outside that is an explicit gap, never silence. A read or a
transport receipt never advances the acknowledgement; only `ack` does, and it is cumulative, monotonic
and idempotent, so an older or duplicate cursor is a successful no-op. In 0.15.0 no timer re-pushes a
row already delivered to a session – existing transport retry and heartbeat are unchanged, and a
delivered-but-unacknowledged row is recovered by a read.

### The connection file

The connection data lives in the project's own `.local/xezar/` and never enters Git or a chat
([D-04](mcp-d04-connection-file-decision.md)). Its name, format, creation trigger and the one-time
setup for each client are all in that record.

### Limits

These values come from [D-09 § 3](mcp-d09-limits-retention-packaging-decision.md#3-the-table--every-bound-limit-and-retention-value):

- **Result size.** One tool result is at most 40 000 bytes (B-01) and 100 items per page (B-02).
- **Oversized items.** An item larger than a page comes in `part` of `parts`, never cut (B-03).
- **Cursors.** A cursor is at most 2 048 bytes (B-04).
- **Per-call deadline.** The bridge waits at most 55 seconds for one call (B-09).
- **Input.** Task and plan text is at most 100 000 characters, with at most 4 images per message
  (B-07).
- **Dependencies.** The server adds no runtime dependency (B-35).

## What this server does not expose

- **No resources and no prompts.** It advertises the `tools` capability only. There is no
  `resources/*`, `prompts/*` or logging method.
- **No account identity.** A task read and `get_account` name an agent profile by its local handle
  and label only: never an email, login, organisation or credential (F-12, N-01, D-42). Account
  administration is refused.
- **No secret in any response.** The launch key, credential-bearing agent config values and pasted
  tokens never enter a tool answer (F-15). MCP-carrying agent config files are read as structure
  only (D-113). `mcp-api-doc.test.ts` also scans this page and `mcp-api.json` for emails and token
  shapes.
- **No host-process control.** No argument takes a process id, a signal, a command or a host path
  (F-08, M-04). Desktop hand-off opens apps on the xezar host only, and says so.
- **No other project.** No workspace settings, project registry, other project's data or
  workspace-wide event stream.

## Traceability: inventory record → tool action

This is the mapping that [the inventory](mcp-ui-action-inventory.md) left for later ("naming tools
stays deferred"). Every `covered` record is mapped to the tool actions that serve it. The mapping is
declared once, as data, in
[`api-coverage.testkit.ts`](../../../packages/xezar/src/mcp/tools/api-coverage.testkit.ts), and
`npm test` holds it to the registry **in both directions**:

- **Record to action.** Every covered record names at least one action that the registry really
  exposes.
- **Action to record.** Every action the registry exposes is declared, and each one names at least
  one record or says why it has none.

A mapping that points at a missing action fails. So does an action nobody declared.

A covered record that no action really serves is listed as **(GAP)**, runs as a vitest `todo`, and
is never counted as passing. There is none today.

This table says **which action a record rests on**. The proof that the action reaches the same
business outcome as the cockpit is the separate [parity coverage map](mcp-parity-coverage-map.md)
(A-05).

### Record → tool actions

<!-- mcp-api:records:start -->
| Record | Required outcome (inventory, first sentence) | Served by |
| --- | --- | --- |
| I-001 | Create a task with every field of this form, same defaults and same validation | `task_create:start` |
| I-002 | Request a plan for a brief and receive the same steps/rationale/fallback | `task_create:plan` |
| I-003 | Start a task from an edited inline step list without saving it as a workflow | `task_create:start` |
| I-005 | Save a step list as a project workflow, including the overwrite decision | `task_create:save_plan` |
| I-007 | Choose runner/account/model on task creation, and observe `modelsLocked` | `discover_project`, `task_create:start`, `project_config:get_config` |
| I-008 | Request N variants at creation; refuse when the project is not a git repo | `discover_project`, `task_create:start` |
| I-009 | Set isolation/autonomy/follow-ups at creation and read the effective defaults | `task_create:start`, `project_config:get_limits` |
| I-010 | Read and set the project base branch | `project_config:get_config`, `project_config:set_config` |
| I-015 | List and read the project's tasks with their current state | `task_read:list`, `task_read:task` |
| I-016 | Read and change per-task read state, including the bulk sweep | `organise_work:mark_read`, `organise_work:mark_unread`, `organise_work:mark_all_read` |
| I-017 | One bulk archive of finished tasks (a bulk operation — F-02 requires per-resource ownership validation across it) | `organise_work:archive_finished` |
| I-018 | Change task metadata (title) | `organise_work:set_title` |
| I-019 | Pin and unpin a task | `organise_work:pin`, `organise_work:unpin` |
| I-020 | Archive and restore a single task | `organise_work:archive`, `organise_work:restore` |
| I-021 | Delete a task autonomously. | `organise_work:delete` |
| I-025 | Read the project's Inbox items, and report the capability being off as an understandable reason (F-03) | `task_read:inbox` |
| I-026 | Start a task from an Inbox item with the same, narrower option set | `organise_work:start_inbox_item`, `task_create:start_from_inbox` |
| I-027 | Remove an Inbox item | `organise_work:remove_inbox_item` |
| I-029 | Read a variant group and compare its members. | `task_read:group` |
| I-030 | Pick a variant autonomously, with the same terminal-state precondition and the same effects on the losers | `organise_work:pick_variant` |
| I-032 | Send a "resolve conflicts" instruction to a task about a specific PR | `execution_control:send_message`, `read_results_evidence:github_ref_status` |
| I-033 | Read a task's record, its paginated history and its context. | `task_read:task`, `task_read:history`, `task_read:context`, `read_results_evidence:summary`, `read_results_evidence:history` |
| I-034 | Send a message to a task's open session, with the same state routing (F-09) | `execution_control:send_message` |
| I-035 | Edit a queued brief, edit a queued message, remove a queued message — F-07 names all three | `execution_control:edit_queued_message`, `execution_control:remove_queued_message`, `organise_work:list_queue`, `organise_work:edit_brief`, `organise_work:edit_queued_message`, `organise_work:remove_queued_message` |
| I-036 | Answer a pending question — the correct question receives the answer (A-07) — including multi-question and multi-select forms, and the resu… | `execution_control:answer_question` |
| I-037 | Cancel a running task. | `execution_control:cancel` |
| I-038 | Finish a task in both meanings, and refuse the transition from any other status (A-07) | `execution_control:finish` |
| I-039 | Continue a closed session, with and without accompanying feedback text (F-11) | `execution_control:continue` |
| I-040 | Inspect and cancel a scheduled automatic resume — F-08 names "manage automatic resumes within the available scope" | `task_read:task`, `execution_control:cancel_auto_resume` |
| I-041 | Read the handoff journal | `task_read:handoff`, `read_results_evidence:handoff` |
| I-042 | Decided 2026-09-10 (D-42). | `task_read:task`, `discover_project`, `project_config:get_account` |
| I-044 | M-19: report unavailable desktop capability explicitly. | `discover_project`, `local_handoff:list_apps`, `local_handoff:open_task_in_terminal`, `local_handoff:open_task_in_app` |
| I-045 | Expose the originating automation id on the task read | `task_read:task`, `read_results_evidence:summary` |
| I-049 | Expose the recorded PR and issue references as fields (feeds F-10) | `task_read:task`, `read_results_evidence:summary`, `read_results_evidence:github_ref_status` |
| I-051 | F-11 hand-onward: feedback, continuation, draft PR, accept. | `execution_control:finish`, `execution_control:continue`, `handoff_git:create_pr` |
| I-052 | Read a task's changes and diff, identified by revision (F-10), through the same task-diff anchor — never the whole-branch anchor | `read_results_evidence:changes` |
| I-053 | Browse and read worktree files. | `read_results_evidence:files` |
| I-054 | Read a task's commits and any one commit's diff by sha | `read_results_evidence:commits`, `read_results_evidence:commit` |
| I-055 | Commit a task's work, honouring the same availability policy and surfacing the server's refusal text unchanged | `handoff_git:commit` |
| I-056 | Push a task branch, with the same preconditions | `handoff_git:push` |
| I-057 | Create the draft PR autonomously (F-11) and expose the manual fallback command when it refuses | `handoff_git:create_pr` |
| I-061 | Read the repository working tree's uncommitted changes | `handoff_git:repo`, `read_results_evidence:repo`, `read_results_evidence:repo_changes` |
| I-062 | Read the repository log and a commit by sha | `read_results_evidence:repo`, `read_results_evidence:repo_commit` |
| I-063 | Switch the repository branch. | `handoff_git:repo`, `handoff_git:branch`, `read_results_evidence:repo` |
| I-064 | Create a branch on the main checkout | `handoff_git:branch` |
| I-065 | Duplicate of I-010 — same key, second surface. | `project_config:get_config`, `project_config:set_config` |
| I-068 | M-17: inspect and clean worktrees, project only, same protections. | `project_config:list_worktrees`, `project_config:reclaim_worktrees`, `project_config:remove_worktree` |
| I-069 | List the bound project's issues and PRs, with the same graceful-degradation shape. | `read_results_evidence:github` |
| I-070 | Force a refresh of the forge cache | `read_results_evidence:github` |
| I-071 | Read an issue's or PR's conversation and timeline. | `read_results_evidence:github_comments` |
| I-072 | Read CI check state for PRs. | `read_results_evidence:github_checks` |
| I-073 | Search and filter issues and PRs, including the cross-state forge search. | `read_results_evidence:github`, `read_results_evidence:github_search` |
| I-074 | Read a PR's changed files, including truncation and per-file unavailability as recognisable states (F-10: missing or stale evidence must be… | `read_results_evidence:pr_changes` |
| I-075 | Inspect merge readiness before merging (M-12) | `handoff_git:merge_state`, `read_results_evidence:pr_merge_state` |
| I-076 | D-07 is settled: invoke the existing merge autonomously, no duplicated confirmation click, preserving every quality, branch and state check… | `handoff_git:merge` |
| I-080 | Start a task from a GitHub issue or PR with the same three body shapes and the same ref-prepending rule | `task_create:start` |
| I-147 | Start the same scoped skill task with a brief for the bound project: `task_create` action `start`, `source: {source:'skill', ref:<the proje… | `task_create:start` |
| I-083 | Read the workflow catalog including each entry's source | `project_config:list_workflows` |
| I-085 | Same outcome as I-002 — one planning capability, two surfaces | `task_create:plan` |
| I-086 | Validate a workflow definition without saving it | `project_config:parse_workflow` |
| I-087 | Save a workflow, including the overwrite decision as an explicit parameter rather than a hidden retry | `project_config:save_workflow` |
| I-088 | Delete a project workflow, preserving the built-in protection | `project_config:delete_workflow` |
| I-090 | Read the skill catalog and any skill's body. | `project_config:list_skills`, `project_config:get_skill` |
| I-091 | Refresh the team-skill catalog | `project_config:refresh_skills` |
| I-094 | A specialisation of I-001; no separate tool needed | `task_create:start` |
| I-096 | Read the project's automations and report the capability being off as an understandable reason (F-03) | `project_config:list_automations`, `project_config:get_automation` |
| I-097 | Decided 2026-09-10 (D-97). | `project_config:create_automation` |
| I-098 | Update an automation. | `project_config:update_automation` |
| I-099 | Enable and pause an automation, preserving the baseline semantics | `project_config:enable_automation`, `project_config:pause_automation` |
| I-100 | M-18 names this exactly: "Checks/logs need a project owner even behind an unscoped endpoint." MCP must derive the owning project from the c… | `project_config:check_automation`, `project_config:get_automation_check` |
| I-101 | Read the automation log. | `project_config:get_automation_log` |
| I-102 | Decided 2026-09-10 (D-102). | `project_config:delete_automation`, `project_config:retry_automation_receipt` |
| I-103 | Read and set the project default runner | `project_config:get_config`, `project_config:set_config` |
| I-104 | Read and set per-runner default models, and surface `modelsLocked` as an unavailability reason rather than failing opaquely (F-03) | `discover_project`, `project_config:get_config`, `project_config:set_config` |
| I-105 | Read and set the project system prompt. | `project_config:get_config`, `project_config:set_config` |
| I-106 | Read and set it, and report the inherited effective value | `project_config:get_config`, `project_config:set_config` |
| I-107 | Read and set the review gate. | `project_config:get_config`, `project_config:set_config` |
| I-108 | Third surface for I-010/I-065; one MCP outcome | `project_config:get_config`, `project_config:set_config` |
| I-109 | Read and set worktree retention | `project_config:get_config`, `project_config:set_config` |
| I-110 | Decided 2026-09-10 (D-110). | `project_config:get_prompt_templates`, `project_config:set_prompt_templates` |
| I-111 | Read and write agent config files of catalog `scope:'project'` and `scope:'local'`. | `project_config:list_agent_config`, `project_config:read_agent_config`, `project_config:write_agent_config` |
| I-113 | Decided 2026-09-10 (D-113) — ASYMMETRIC. | `project_config:list_agent_config`, `project_config:read_agent_config`, `project_config:write_agent_config` |
| I-114 | Same rule as I-044: report the missing desktop capability explicitly; never promise a launch on the client's machine (M-19) | `discover_project`, `local_handoff:list_apps`, `local_handoff:open_project_in_app` |
| I-141 | Read who owns the project, whether a leader is attached, the delivery cursors and what blocks delivery; for a leader, whether its own sessi… | `leader_events:status` |
| I-142 | Attach the project leader so events are pushed to it. | `leader_events:attach` |
| I-143 | Read this project's setup state: which identity is running, which was offered, which a finished check actually covered, and whether setup c… | `discover_project` |
| I-144 | Create the setup or re-check task from the bundled launch definition `discover_project.onboarding.launch.workflowId` names. | `task_create:start` |
| I-145 | Record that the offer was made for this identity, so the same pair does not offer again. | `project_config:dismiss_onboarding_offer` |
| I-146 | Learn that the running identity differs from the last one a finished check covered, as a pull. | `discover_project` |
| I-128 | Decided 2026-09-10 (D-128). | `project_config:get_project`, `project_config:set_project`, `project_config:get_limits` |
| I-129 | Decided 2026-09-10 (D-129). | `project_config:get_project`, `project_config:set_project` |
| I-133 | The capability set itself is the requirement, not the nav. | `discover_project`, `project_config:get_capabilities` |
| I-136 | Same read as I-133 (`checks`) | `discover_project` |
| I-138 | This is the state source F-13 and section 8 require MCP to reuse after project filtering, and the unfiltered workspace stream is prohibited. | `leader_events:read` |
| I-139 | The pattern, not a new socket. | `leader_events:read` |
| I-140 | The existing replay-and-dedup precedent F-21 must follow. | `leader_events:read`, `leader_events:ack` |
<!-- mcp-api:records:end -->

### Tool action → records

Roles:

- **Serves:** the action performs or reads a `covered` record's outcome.
- **Safe read of:** the effective-value read that section 3 allows a `global` record.
- **Refuses:** the action exists so that asking gets a reason. It dispatches nothing.

<!-- mcp-api:actions:start -->
| Tool action | Serves (covered) | Safe read of (global) | Refuses | Why it has no record |
| --- | --- | --- | --- | --- |
| `health` |  |  |  | the bridge’s own liveness check: it answers whether the cockpit runs for the bound project, and is no cockpit action |
| `task_read:list` | I-015 |  |  |  |
| `task_read:task` | I-015, I-033, I-040, I-042, I-045, I-049 |  |  |  |
| `task_read:history` | I-033 |  |  |  |
| `task_read:context` | I-033 |  |  |  |
| `task_read:handoff` | I-041 |  |  |  |
| `task_read:inbox` | I-025 |  |  |  |
| `task_read:group` | I-029 |  |  |  |
| `execution_control:cancel` | I-037 |  |  |  |
| `execution_control:finish` | I-038, I-051 |  |  |  |
| `execution_control:continue` | I-039, I-051 |  |  |  |
| `execution_control:send_message` | I-032, I-034 |  |  |  |
| `execution_control:answer_question` | I-036 |  |  |  |
| `execution_control:edit_queued_message` | I-035 |  |  |  |
| `execution_control:remove_queued_message` | I-035 |  |  |  |
| `execution_control:cancel_auto_resume` | I-040 |  |  |  |
| `discover_project` | I-007, I-008, I-042, I-044, I-104, I-114, I-133, I-136, I-143, I-146 |  |  |  |
| `organise_work:list_queue` | I-035 |  |  |  |
| `organise_work:set_title` | I-018 |  |  |  |
| `organise_work:edit_brief` | I-035 |  |  |  |
| `organise_work:edit_queued_message` | I-035 |  |  |  |
| `organise_work:remove_queued_message` | I-035 |  |  |  |
| `organise_work:pin` | I-019 |  |  |  |
| `organise_work:unpin` | I-019 |  |  |  |
| `organise_work:archive` | I-020 |  |  |  |
| `organise_work:restore` | I-020 |  |  |  |
| `organise_work:archive_finished` | I-017 |  |  |  |
| `organise_work:mark_read` | I-016 |  |  |  |
| `organise_work:mark_unread` | I-016 |  |  |  |
| `organise_work:mark_all_read` | I-016 |  |  |  |
| `organise_work:delete` | I-021 |  |  |  |
| `organise_work:start_inbox_item` | I-026 |  |  |  |
| `organise_work:remove_inbox_item` | I-027 |  |  |  |
| `organise_work:pick_variant` | I-030 |  |  |  |
| `task_create:start` | I-001, I-003, I-007, I-008, I-009, I-080, I-094, I-144, I-147 |  |  |  |
| `task_create:plan` | I-002, I-085 |  |  |  |
| `task_create:start_from_inbox` | I-026 |  |  |  |
| `task_create:save_plan` | I-005 |  |  |  |
| `handoff_git:repo` | I-061, I-063 |  |  |  |
| `handoff_git:commit` | I-055 |  |  |  |
| `handoff_git:push` | I-056 |  |  |  |
| `handoff_git:create_pr` | I-051, I-057 |  |  |  |
| `handoff_git:merge_state` | I-075 |  |  |  |
| `handoff_git:ready` |  |  |  | marks the draft pull request create_pr opened (I-057) ready for review, the step before the merge (I-076); the cockpit has no such control, so no inventory record names it (#262) |
| `handoff_git:merge` | I-076 |  |  |  |
| `handoff_git:branch` | I-063, I-064 |  |  |  |
| `read_results_evidence:summary` | I-033, I-045, I-049 |  |  |  |
| `read_results_evidence:history` | I-033 |  |  |  |
| `read_results_evidence:changes` | I-052 |  |  |  |
| `read_results_evidence:files` | I-053 |  |  |  |
| `read_results_evidence:commits` | I-054 |  |  |  |
| `read_results_evidence:commit` | I-054 |  |  |  |
| `read_results_evidence:handoff` | I-041 |  |  |  |
| `read_results_evidence:repo` | I-061, I-062, I-063 |  |  |  |
| `read_results_evidence:repo_changes` | I-061 |  |  |  |
| `read_results_evidence:repo_commit` | I-062 |  |  |  |
| `read_results_evidence:github` | I-069, I-070, I-073 |  |  |  |
| `read_results_evidence:github_comments` | I-071 |  |  |  |
| `read_results_evidence:github_checks` | I-072 |  |  |  |
| `read_results_evidence:github_search` | I-073 |  |  |  |
| `read_results_evidence:github_ref_status` | I-032, I-049 |  |  |  |
| `read_results_evidence:pr_merge_state` | I-075 |  |  |  |
| `read_results_evidence:pr_changes` | I-074 |  |  |  |
| `project_config:get_config` | I-007, I-010, I-065, I-103, I-104, I-105, I-106, I-107, I-108, I-109 |  |  |  |
| `project_config:set_config` | I-010, I-065, I-103, I-104, I-105, I-106, I-107, I-108, I-109 |  |  |  |
| `project_config:get_project` | I-128, I-129 |  |  |  |
| `project_config:set_project` | I-128, I-129 |  |  |  |
| `project_config:get_prompt_templates` | I-110 |  |  |  |
| `project_config:set_prompt_templates` | I-110 |  |  |  |
| `project_config:get_limits` | I-009, I-128 | I-117, I-118, I-119, I-120, I-121 |  |  |
| `project_config:get_capabilities` | I-133 | I-115 |  |  |
| `project_config:get_account` | I-042 | I-122 |  |  |
| `project_config:list_agent_config` | I-111, I-113 |  |  |  |
| `project_config:read_agent_config` | I-111, I-113 |  |  |  |
| `project_config:write_agent_config` | I-111, I-113 |  |  |  |
| `project_config:list_workflows` | I-083 |  |  |  |
| `project_config:parse_workflow` | I-086 |  |  |  |
| `project_config:save_workflow` | I-087 |  |  |  |
| `project_config:delete_workflow` | I-088 |  |  |  |
| `project_config:list_skills` | I-090 |  |  |  |
| `project_config:get_skill` | I-090 |  |  |  |
| `project_config:list_importable_skills` |  | I-092 |  |  |
| `project_config:refresh_skills` | I-091 |  |  |  |
| `project_config:check_skill_updates` |  | I-093 |  |  |
| `project_config:list_automations` | I-096 |  |  |  |
| `project_config:get_automation` | I-096 |  |  |  |
| `project_config:create_automation` | I-097 |  |  |  |
| `project_config:update_automation` | I-098 |  |  |  |
| `project_config:delete_automation` | I-102 |  |  |  |
| `project_config:enable_automation` | I-099 |  |  |  |
| `project_config:pause_automation` | I-099 |  |  |  |
| `project_config:check_automation` | I-100 |  |  |  |
| `project_config:get_automation_check` | I-100 |  |  |  |
| `project_config:get_automation_log` | I-101 |  |  |  |
| `project_config:retry_automation_receipt` | I-102 |  |  |  |
| `project_config:list_worktrees` | I-068 |  |  |  |
| `project_config:reclaim_worktrees` | I-068 |  |  |  |
| `project_config:dismiss_onboarding_offer` | I-145 |  |  |  |
| `project_config:remove_worktree` | I-068 |  |  |  |
| `project_config:set_provider_enabled` |  |  | I-115 |  |
| `project_config:connect_provider` |  |  | I-115, I-123 |  |
| `project_config:retry_provider` |  |  | I-115 |  |
| `project_config:create_account` |  |  | I-123 |  |
| `project_config:update_account` |  |  | I-123 |  |
| `project_config:remove_account` |  |  | I-123 |  |
| `project_config:select_account` |  |  | I-122 |  |
| `project_config:check_account_status` |  |  | I-123 |  |
| `project_config:get_account_details` |  |  | I-124 |  |
| `project_config:open_account_file` |  |  | I-125 |  |
| `project_config:set_workspace_config` |  |  | I-117, I-118, I-119, I-120, I-121, I-127 |  |
| `project_config:set_workspace_ui_state` |  |  | I-024, I-092, I-132 |  |
| `project_config:browse_folders` |  |  | I-126 |  |
| `project_config:add_project` |  |  | I-131 |  |
| `project_config:clone_project` |  |  | I-131 |  |
| `project_config:remove_project` |  |  | I-130 |  |
| `project_config:apply_skill_updates` |  |  | I-093 |  |
| `project_config:import_skills` |  |  | I-092 |  |
| `project_config:get_launch_key` |  |  | I-014, I-095 |  |
| `project_config:open_in_app` |  |  | I-114 |  |
| `local_handoff:list_apps` | I-044, I-114 |  |  |  |
| `local_handoff:open_task_in_terminal` | I-044 |  |  |  |
| `local_handoff:open_task_in_app` | I-044 |  |  |  |
| `local_handoff:open_project_in_app` | I-114 |  |  |  |
| `leader_events:read` | I-138, I-139, I-140 |  |  |  |
| `leader_events:ack` | I-140 |  |  |  |
| `leader_events:attach` | I-142 |  |  |  |
| `leader_events:stop` |  |  |  | detaches the calling session’s own leader; the cockpit has no stop control, only POST /api/v1/mcp/leader {action:"stop"}, so no inventory record names it (#450) |
| `leader_events:status` | I-141 |  |  |  |
<!-- mcp-api:actions:end -->

## Findings this reference surfaced

These were observed on 2026-09-11 at revision `ef4b768`, while writing this page. Nothing here
changes a tool. Each finding is reported for a separate decision.

1. **Only one mutating tool takes an operation id.** [D-06 § 5.2](mcp-d06-versioning-idempotency-audit-decision.md#52-decision--the-operation-id-and-the-stored-key)
   decided that *every* mutating MCP tool takes a required `operationId`. Only `task_create` accepted
   one, so a retried `organise_work`, `execution_control`, `handoff_git`, `project_config`,
   `local_handoff` or `leader_events` call after a lost answer had no receipt to replay. Filed as
   [#264](https://github.com/qodeca/xezar/issues/264) and **fixed there**: every mutating action of
   all seven tools now takes a required key, and every read action of those tools refuses one, for
   the reason given under [Operation ids, receipts and
   idempotency](#operation-ids-receipts-and-idempotency).
2. **`organise_work` silently drops unknown arguments.** Its input schema is the only one that does
   not set `additionalProperties: false`. The argument table shows this. A misspelled argument, or
   an `operationId`, is stripped rather than refused. Filed as
   [#265](https://github.com/qodeca/xezar/issues/265). Fixed by
   [#271](https://github.com/qodeca/xezar/issues/271): the input is strict now, and the argument
   table above is regenerated from it.
3. **The audit origin has one live value.** `ui`, `automation` and `cli` are in the enum, but only the
   MCP door records an audit entry. The audit trail cannot compare a leader's change with a
   human's. Filed as [#266](https://github.com/qodeca/xezar/issues/266) and **decided there**: the
   trail is MCP-only for 0.14.0 and the other three are reserved members, because N-04 only ever
   said history *should* carry an origin and the decision record declined to harden that
   ([D-06 § 10.6](mcp-d06-versioning-idempotency-audit-decision.md#106-recorded-2026-09-12--the-trail-is-mcp-only-for-0140)).
   What was wrong was the silence: the enum read as a promise of four kinds of entry. Wiring the
   three doors was [#364](https://github.com/qodeca/xezar/issues/364) and is now
   [#306](https://github.com/qodeca/xezar/issues/306) for 0.16.0: part 1 moved the trail to
   `audit.ndjson` with version 2 records, and part 2 wired the other three doors, so this gap is
   closed.
4. **The result vocabulary is not uniform** (see [Where the tools disagree](#where-the-tools-disagree)).
   A client has to learn eleven dialects to read success, refusal and failure.
5. **Some outcomes have two doors.** Examples:
   - editing or removing a queued message: `execution_control` and `organise_work`;
   - starting an Inbox item: `organise_work` and `task_create`;
   - reading the handoff journal: `task_read` and `read_results_evidence`;
   - reading merge readiness: `handoff_git` and `read_results_evidence`.

   Each pair is covered by the same record, and their answers differ in shape.
6. **I-080 has no GitHub argument.** `task_create` takes no issue or pull-request reference, so the
   leader must write the reference into `prompt` itself, as the cockpit's `composeGithubTask` does.
   The outcome is reachable, but the "same ref-prepending rule" is the client's job.

## Decision versions and operation attribution

The task version tracks a persisted, monotonic decision revision: status, archive/pin flags, title/title origin, auto-resume, task brief, queued messages, step identity/status, branch and workflow. Participant input advances it too. Transcript/tool/usage progress alone does not change it. This applies to every execution_control action and every other run-version guard; reversing a decision still invalidates an older token. On stale_version, re-read task_read and make a new decision with a new operationId; never blindly retry currentVersion.

Run tokens remain opaque `rev1` strings; the revision slot is decision-only and the digest is domain-separated from older transcript tokens. Legacy records initialize automatically. Re-read once after upgrade; no configuration or manual migration is needed.

Only an accepted effect may reserve a specific delayed transition: an accepted cancel reserves `cancelled`, consumed or discarded at the next status transition. Its acknowledgement remains echo-suppressed. Successful steering of an already-running task does not reserve completion; a waiting task’s answer consumes its immediate running transition, and later outcomes remain system-originated and pushed. Rejected operations lose echo ownership and their own pending intent without deleting a newer operation’s intent. Synchronous acknowledgements still see ownership registered before dispatch. Existing journal rows are immutable.

Participant `user-message` input also advances the decision revision; it is steering, not agent telemetry.
