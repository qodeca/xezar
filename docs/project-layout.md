# Project layout

The maintained project kit lives in **`.xezar/`** at the repository root, beside
`.github/` and `.local/` (and `.claude/`, where a checkout has one). Configuration (`config.json`), workflows,
skills, checks, documentation, guidance and the pipeline files (`pipeline/config.json`, `pipeline/trackers/`)
belong here and can be committed.
Local execution data belongs in **`.local/xezar/`**. The separate per-user
`~/.xezar/` workspace registry, preferences and accounts do not move (in
single-project mode they live in `<project>/.xezar` instead).

Each is exactly one directory. There is no discovery step, no per-file overlay
and no fallback location. An absent kit leaves every default in place.

One exception exists, and it is a safety guard rather than a fallback: when xezar
is launched in your home directory, `<repo>/.xezar` **is** the global workspace
directory. Writing a project kit there would overwrite your global settings, so
the kit goes to `<repo>/.local/xezar/kit` instead.

Shared skill folders (`.ai/skills/`, `.agents/skills/` and each agent's own skills
folder) are still discovered; see [Project kit](guide/15-project-kit.md#to-resolve-skills-with-the-same-name)
for the order. Team skill repositories keep their own published layouts.

## Repositories from before this layout

Xezar does not read the pre-`.xezar` layout (`.ai/xezar/`) — not as a kit, not as
a run store. A repository that still has only that directory starts with default
settings and an empty run history. Nothing there is deleted, moved or rewritten.

To carry an old project across, stop xezar and its task processes, then move the
files by hand:

| Old path | New path |
| --- | --- |
| `.ai/xezar/config.json` | `.xezar/config.json` |
| `.ai/xezar/workflows/`, `skills/`, `checks/`, `docs/`, guidance | `.xezar/` |
| `.ai/xezar/runs.json`, `runs/`, `todos.json`, `ui-state.json`, `launch-key`, `automation*` | `.local/xezar/` |
| `.ai/xezar/worktrees/<runId>` | `.local/xezar/worktrees/<runId>` |
| `.ai/agentic.config.json`, `.ai/trackers/<tracker>.md` (pipeline files) | `.xezar/pipeline/config.json`, `.xezar/pipeline/trackers/<tracker>.md` |

Registered task worktrees must move through `git worktree move` so their Git
metadata stays valid. Anything else in the old directory is local scratch or a
credential: keep it out of Git rather than promoting it into `.xezar/`.

## Appendix for contributors

This part describes how the engine resolves these folders and what tests pin them. You do not need it to use xezar.

### Discovery and writes

`projectKitDir` is the shared directory resolver for configuration reads, model
policy, workflow discovery, skill discovery, initialization and API writes. It
returns `<repo>/.xezar` and creates nothing: an absent kit simply leaves every
default in place, and reads never move files.

`projectDataDir` is the equivalent for run state and returns `<repo>/.local/xezar`.
Writers call `ensureProjectDataIgnored`, which keeps a blanket `*` rule in
`.local/.gitignore`, so every present and future engine file is ignored without a
per-file list.

That rule is about git only. It says nothing about other tools that read
`.local/xezar/`. At least one external consumer checks the files at the top level
of `.local/xezar/` against the names the engine writes today (`runs.json`,
`machine-state.json`, `audit.ndjson` and the rest), and fails a gate when an
unexpected name appears there. Those names are a shape to match, not a set to
enumerate. During ordinary operation, with no feature turned on, any of them may
also appear with a `.lock` suffix, a `.lock.takeover` suffix (the guard a lock release
takes), a `.tmp` or `.<pid>.<hex>.tmp` suffix (an atomic write in flight) or with a rotation number `.1`–`.4` (`audit.ndjson`), so a check against
exact names fails at random. By that consumer's own report,
a new subdirectory is safe and a new top-level file is a break. The allowed names
are published as data (`STATE_NAME_ENTRIES` in `local-xezar-top-level-names.ts`)
and printed by `xezar state-names --json`; `local-xezar-top-level-scan.test.ts`
fails when shipped code builds a name the list lacks. Put new engine state in a
subdirectory, list any new top-level name in the same change, and announce a new
top-level file in the changelog.

The home-directory guard above lives in `projectKitDir`. Single-project
mode resolves the workspace files through `state-layout.ts`.

### Verification

`project-kit-paths.test.ts` covers a new project, the home-directory guard, and a
pre-`.xezar` directory that must be ignored while its bytes stay untouched.
`project-kit-cli.test.ts` covers `xezar init`, and `server/project-kit-api.test.ts`
checks that settings and workflow writes use the same directory as reads and
preserve custom configuration keys. `tracked-files.test.ts` pins the ignore
policy. These local checks do not establish that a real model session, CI or
release has run.

See [local data and testing](testing/local-data.md) for the complete runtime,
QA and test-artifact inventory.

Describes xezar 0.30.0.
