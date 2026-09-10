# Project layout

The maintained project kit lives in **`.xezar/`** at the repository root, beside
`.ai/`, `.github/` and `.local/` (and `.claude/`, where a checkout has one). Configuration (`config.json`), workflows,
skills, checks, documentation and guidance belong here and can be committed.
Local execution data belongs in **`.local/xezar/`**. The separate per-user
`~/.xezar/` workspace registry, preferences and accounts do not move.

Each is exactly one directory. There is no discovery step, no per-file overlay
and no fallback location.

## Discovery and writes

`projectKitDir` is the shared directory resolver for configuration reads, model
policy, workflow discovery, skill discovery, initialization and API writes. It
returns `<repo>/.xezar` and creates nothing: an absent kit simply leaves every
default in place, and reads never move files.

`projectDataDir` is the equivalent for run state and returns `<repo>/.local/xezar`.
Writers call `ensureProjectDataIgnored`, which keeps a blanket `*` rule in
`.local/.gitignore`, so every present and future engine file is ignored without a
per-file list.

One exception exists, and it is a safety guard rather than a fallback: when xezar
is launched in the user's home directory, `<repo>/.xezar` **is** the global
workspace directory. Writing a project kit there would overwrite the user's
global settings, so the kit resolves to `<repo>/.local/xezar/kit` instead.

Discovery of shared `.ai/skills/`, `.agents/skills/` and native agent skill
directories is unchanged. Team skill repositories are third-party repositories
and their own layouts are still accepted as published.

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

Registered task worktrees must move through `git worktree move` so their Git
metadata stays valid. Anything else in the old directory is local scratch or a
credential: keep it out of Git rather than promoting it into `.xezar/`.

For the Xezar repository's own kit, all current guidance and check commands use
the new locations. Its task-local snapshot and lock live in `.local/xezar-kit/`,
outside the maintained kit. Source mappings in `.xezar/kit-manifest.json` retain
their original reference paths as provenance.

See [local data and testing](testing/local-data.md) for the complete runtime,
QA and test-artifact inventory.

## Verification

`project-kit-paths.test.ts` covers a new project, the home-directory guard, and a
pre-`.xezar` directory that must be ignored while its bytes stay untouched.
`project-kit-cli.test.ts` covers `xezar init`, and `server/project-kit-api.test.ts`
checks that settings and workflow writes use the same directory as reads and
preserve custom configuration keys. `tracked-files.test.ts` pins the ignore
policy. These local checks do not establish that a real model session, CI or
release has run.
