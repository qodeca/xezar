---
name: xezar-release-changelog
description: Write the release changelog entry from merged PRs, with no hand-written brief
---

# Write the release changelog entry from merged PRs

You are the `changelog` step of the `release` workflow (Worktree ON). Read docs/publishing.md and the top of CHANGELOG.md first. You derive the whole `# <version> (<date>)` section from the pull requests merged into `main` since the last release; nobody writes a brief for you. You edit exactly one file, CHANGELOG.md, and commit it. You do not push, publish, tag or touch package manifests — the last step does the pushing, and only the manually dispatched Release workflow publishes.

## The brief

`{{task}}` is one line of `key: value` pairs separated by commas or newlines. Accepted keys, nothing else:

| Key | Values | Meaning |
|---|---|---|
| `bump` | `patch`, `minor`, `major` | Required unless `version` is given. The target is `bump` applied to the version in `packages/xezar/package.json` on `origin/main`. |
| `version` | `X.Y.Z` | Optional explicit target. When both are given they must agree, otherwise write `BLOCKED` and stop. |
| `dry-run` | `true` | Optional. Ignored here (this step never pushes anyway); the publish step stops before dispatching. |

Record the resolved target, the tag you measured from and the brief itself in `release.json` in the evidence dir (`resolve_task_paths`, `task_evidence_dir`).

## 1. Find the boundary and the target

```sh
git fetch --quiet origin main --tags                         # a fresh worktree has no tags yet
git describe --tags --abbrev=0 --match 'v*' origin/main     # last release tag, e.g. v0.11.1
git log -1 --format=%cI "$(git describe --tags --abbrev=0 --match 'v*' origin/main)"   # its date
git show origin/main:packages/xezar/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version'
```

Sanity rules. The version in `packages/xezar/package.json` on `origin/main` may still be one behind npm when the previous `release/v<n>` bump PR has not merged (that happened on 0.11.1). Compare against `npm view @qodeca/xezar version` and the newest dated heading in CHANGELOG.md; when the manifest is behind, the target you write must be the next version after what npm serves, and you must say so in `release.json` so the publish step can refuse a duplicate bump. Never guess: when tag, manifest, npm and changelog cannot be reconciled into one target, write `BLOCKED` with the four values and stop.

## 2. Collect the PRs

```sh
gh pr list --state merged --base main --limit 200 \
  --search "merged:>=<tag commit date, YYYY-MM-DD>" \
  --json number,title,body,labels,mergedAt,mergeCommit,files
git log <tag>..origin/main --first-parent --format='%H %s'
```

Cross-check both lists: every first-parent commit on `main` since the tag is a squash of one PR (`(#N)` at the end of the subject), and every PR the search returns must have its merge commit in that range. A PR in one list and not the other is a finding to report, not a bullet to drop silently. Then exclude:

- `chore(release): v…` manifest bumps opened by the Release workflow;
- changelog-only PRs (`docs: record … in the changelog`, or a diff touching only CHANGELOG.md);
- any PR whose number already appears in a dated section of CHANGELOG.md (a lagging tag must not double-record).

If nothing remains, write `nothing to release since <tag>: <reason>` to `BLOCKED` in the evidence dir and stop. Readiness will refuse and the workflow ends before the gates.

## 3. Group and write

One bullet per PR, in the file's existing style: group emoji first, a bold lead sentence stating the user-visible change, one or two plain sentences of what and why from the PR body, wrapped at about 100 columns, and the number(s) at the end — `(#pr)`, or `(#issue, #pr)` when the PR closes an issue (`Closes/Fixes/Resolves #N` in the body, or `(#N)` in the title naming an issue). Never invent behaviour the PR does not describe; read the diff when the body is thin.

Label to group, in this order of precedence, and exactly the headings CHANGELOG.md already uses:

| Signal | Heading |
|---|---|
| `!` before the `:` in the title, or `BREAKING CHANGE:` in the body | `## 💥 Breaking` |
| a security fix — this repository has no `security` label, so read the title and body (and `priority-high`, which covers security hardening) | `## 🔒 Security` |
| label `bug` | `## 🐛 Fixes` |
| label `enhancement` | `## ✨ Features` |
| label `refactor` | `## 🔧 Changed` |
| label `documentation` | `## 📝 Specs & Documentation` |
| label `testing`, or no category label and the diff only touches `.github/`, `scripts/`, `.xezar/`, `.ai/`, CI config or test files | `## 🚀 CI/CD & Infrastructure` |
| none of the above | choose from the conventional-commit type (`fix:` → Fixes, `feat:` → Features, `docs:` → Docs, `refactor:` → Changed, `ci:`/`chore:`/`test:` → CI/CD) and say in the report that the PR carried no category label |

The table is classification precedence (a `bug` PR that is also breaking goes under Breaking). Emit only the groups that have bullets, in the file's house order: `## Highlights`, `## 💥 Breaking`, `## 🔒 Security`, `## ✨ Features`, `## 🐛 Fixes`, `## 🔧 Changed`, `## 📝 Specs & Documentation`, `## 🚀 CI/CD & Infrastructure` — the order the 0.11.1 and 0.10.x sections use. Highlights is three to five lines of prose naming what a user gets from this release, written from the bullets — no marketing, no claims the PRs do not support.

## 4. Fold every `# Unreleased` section

Find every top-level `# Unreleased` heading in CHANGELOG.md (fix PRs add them, sometimes in the wrong place). Move each of their bullets, **verbatim**, into the matching group of the new section — re-grouped only when a bullet sits under a heading that contradicts its PR's label — and delete the `# Unreleased` heading and its now-empty groups. A bullet already present from the PR list is not duplicated: the Unreleased bullet wins and the generated one is dropped.

Place the new `# <version> (<YYYY-MM-DD>)` section directly above the newest existing top-level heading (dated release or the `# Renamed to Xezar` entry), followed by a `---` separator line, so the file stays newest-first. The date is today in the repository's timezone as `YYYY-MM-DD`. Match blank-line conventions of the sections around it.

## 5. Verify, then commit

```sh
bash .xezar/checks/changelog-check.sh --require-version <version>   # zero Unreleased, exactly one target heading
git diff --stat                                                      # CHANGELOG.md and nothing else
```

Then, for every PR number kept in step 2, `grep -c "#<n>)" CHANGELOG.md` inside the new section must be at least one. A missing number, a second changed file, or a red check is a defect to fix here, not something to hand to the gates. When it passes:

```sh
bash .xezar/checks/worktree-git.sh commit -m "docs: record <version> in the changelog"
```

Do not push. Write the kept PR list, the exclusions with reasons, the group decisions for unlabeled PRs and the commit SHA to `release.json` in the evidence dir; the publish step reads it. If the gates send the workflow back here (`onFail.retry`, at most two returns), fix the named failure only and re-verify; do not regenerate the section from scratch.

## Shared contract

Before reading kit files in a standalone skill run, if `.xezar/checks/bootstrap.sh` is absent, run `bash "$(git rev-parse --path-format=absolute --git-common-dir)/../.xezar/checks/bootstrap.sh"`. If unavailable or refused, stop with that specific blocker. Never fabricate commands or copy runtime. Workflow launches already perform this step.

Read `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md` and `.xezar/docs/README.md`. Root rules and the current authorized task govern. Workflows snapshot the local kit before work; do not create/adopt another task branch or change a peer's checkout. Use current task identity, not a remembered working directory. Read the task's current checkpoint and late steering before resume or handoff.

The leader owns the goal/plan and adjudication. Specialists own technical evidence and findings. Ask only for a genuinely missing decision outside existing authority, using `XEZ:ASK` with options and custom answer in an interactive terminal agent step. Silence is not authority. Record unresolved dependent work in the primary evidence directory's `BLOCKED` file so readiness cannot pass. Independent work may continue. Never waive mandatory quality/AC. Project operations within the authorized plan need no repeated permission; this is not permission to publish when the current assignment excludes it.

Writing-stage ownership: implement all code/tests/docs/release metadata, focused tests, self-review and focused commits before full gates. Run only `.xezar/checks/repo-gates.sh --fast` for final canonical evidence. Do not repeat the entire gate list in every agent step. Gate repair returns are at most two; quality-gates allows at most two repairs of the same failure. Preserve history when changing executors; no invented global retry allowance.

Derive durable evidence with `.xezar/checks/lib/common.sh` (`resolve_task_paths`, `task_evidence_dir`): primary `.local/xezar-tasks/<runId>/`, not the task's reclaimable `.local` or engine tmp. Keep checkpoints concise. Never copy secrets, credentials, `.env`, personal agent configuration or unrelated source content. Reports distinguish observed, fixture-tested, live-verified and unknown. Record relevant dogfooding observations using `.xezar/docs/dogfooding.md`.
