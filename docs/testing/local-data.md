# Project files and local data

Maintained files belong in Git. Local execution records belong in `.local/` and must never
be included by an autosave, commit, package, or project-kit snapshot.

| Location | Classification and owner |
| --- | --- |
| `.xezar/` | Maintained project configuration, workflows, skills, checks and operator documentation; see [project layout](../project-layout.md). |
| `.ai/agentic.config.json`, `.ai/scripts/`, `.ai/skills/`, `.ai/trackers/` | Maintained agent tooling. Scripts remain here; their outputs do not. |
| `docs/specs/`, `docs/testing/agent-browser.md` | Maintained specifications and browser contract. New specifications are not ignored working drafts. |
| `.local/xezar/` | Engine run index, transcripts, attachments, handoffs, todos, UI state, automation state/logs/locks, temporary run directories and Git worktrees. |
| `.local/qa/` | Test environment descriptor, bootstrap lock, build fingerprint, logs, screenshots, isolated Xezar home and vendor configuration sandboxes. |
| `.local/test-tmp/` | Unique temporary fixtures used by Vitest, node:test and inherited child tools. Each test owns cleanup of its own fixture. A Git ceiling prevents fixtures without a repository from discovering the parent checkout. |
| `.local/runs/`, `.local/analysis/` | New agentic run records and working analyses selected by the maintained agentic config. |
| `.local/legacy-qa/`, `.local/legacy-agentic/`, `.local/legacy-xezar/` | Preserved legacy local records. These are archives, not disposable caches. Ignored custom legacy kit files are kept local rather than accidentally published as maintained files. |
| Primary checkout `.local/xezar-tasks/<runId>/` | Durable kit evidence, attempts and checkpoints, outside the task worktree that retention may remove. |
| Primary checkout `.local/xezar-tests/`, `.local/xezar-kit/` | Kit fixtures and bootstrap snapshot bookkeeping. |

The inventory covered all tracked project scripts and configuration, engine path producers,
Git/worktree retention, QA launch/stop scripts, every browser test artifact consumer,
unit/package-test temporary directories, and the existing `.ai` directory names. Historical
changelog/source-audit paths remain historical facts; they are not current write targets.

## Existing projects

Every project writes engine data to `.local/xezar` and keeps its maintained kit in `.xezar`.
Xezar does not read the pre-`.xezar` layout (`.ai/xezar`), so a repository that still holds
only that directory starts with default settings and an empty run history. Nothing there is
deleted, moved or rewritten; move the files by hand as described in
[project layout](../project-layout.md). Per-user `~/.xezar` settings are unaffected.

QA has a separate migration because it is repository development tooling:

```sh
sh .ai/scripts/test-env-down.sh
node .ai/scripts/migrate-local-state.mjs
sh .ai/scripts/test-env-up.sh
```

The stop script recognizes a legacy descriptor. The new launcher refuses a legacy descriptor
or bootstrap lock before starting another server. Migration refuses a live recorded process,
corrupt descriptor, or destination collision. It archives legacy QA separately; a fresh boot
cannot erase archived credentials or screenshots when it resets its disposable agent-home
sandbox. Old `.ai/runs`, `.ai/analysis`, `.ai/specs` and `.ai/tmp` directories are archived under
`.local/legacy-agentic` only after checking that no process has them open. Historical drafts
are preserved, not automatically declared maintained specifications.

## Cleanup and retained evidence

Use `test-env-down.sh` before cleaning test environment data. Cold QA boot deliberately
recreates the vendor config sandbox; keep anything worth preserving outside `.local/qa` first.
Tests continue to delete only their own unique temporary fixture. A failed test may leave
scratch under `.local/test-tmp`; inspect it after all test processes stop before removing it.
Do not delete all of `.local` as a generic cache cleanup: it includes actual task history,
local settings and durable evidence. Engine retention continues to operate on individual
registered task worktrees; it does not own primary-checkout kit evidence or legacy archives.

## Paths deliberately retained

`node_modules`, workspace `dist` directories, the shipped `packages/xezar/web/dist`, and
TypeScript build metadata remain dependency/build outputs at their existing tool/package
contract paths. Moving them would change module resolution or the published artifact, rather
than merely relocate local logs. npm's download cache, browser binaries, vendor credentials,
`~/.cache/xez` and the workspace registry in `~/.xezar` are external or per-user state, not
project output. Existing documented overrides remain available; broad environment overrides
must not relocate unrelated credentials. Production run scratch uses the engine data root; terminal launch scripts and temporary Git indexes use `.local/xezar/tmp` with their existing cleanup. Missing or read-only target directories retain an OS-temp fallback so opening a terminal or reading changes still works;
test-only TMPDIR/TMP/TEMP overrides do not change the host's normal tools or app configuration.

The shared test bootstrap is loaded by every Vitest project and by the node:test npm scripts.
Direct ad-hoc node:test commands should also load `scripts/test-local-state.mjs` if they need
the same scratch policy. No coverage or Playwright report producer is currently configured;
future reporters should write beneath `.local` rather than introduce a root report directory.
