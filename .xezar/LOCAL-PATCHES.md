# Local patches

Deliberate local changes to kit files. Format: the kit's `upgrade/CONTRACT.md` §2.

## LP-1 – keep the project's own issue and pull request templates
- Files: .github/ISSUE_TEMPLATE/bug_report.yml, .github/ISSUE_TEMPLATE/config.yml, .github/ISSUE_TEMPLATE/feature_request.yml, .github/pull_request_template.md
- Reason: the templates name this product's backends, version commands, design folder and risk surfaces; the kit's generic copies would drop that detail
- Upstream: local only
- Since: 2026-10-05
- Confirmed: yes

## LP-2 – keep the gate worker's MSYS=noglob out of the gate command
- Files: .xezar/checks/lib/gate-parallel.mjs, .xezar/checks/lib/windows-process.mjs
- Reason: on Windows the worker passed MSYS=noglob to every gate command, so Git's sh split quoted paths with a space and npm test failed in every local gate run (#1078)
- Upstream: qodeca/xezar-skills#216
- Since: 2026-10-17
- Confirmed: yes

## LP-3 – route this project's DeepSeek lanes through Qwen Code
- Files: .xezar/checks/route.mjs, .xezar/routing.schema.json, .xezar/docs/routing.md, .xezar/docs/leader-guide.md
- Reason: the engine runs claude, codex and qwen only (#1046), and qwen holds a reading step read-only (#1044); the kit still names the two backends removed in 0.30.0. Since 2026-10-18 leader-guide.md also describes this project's two-branch model (`develop` base, `main` for released work) and its release runbook – see LP-5; it names the nine CI checks branch protection requires and the `release` workflow's `changelog` step as the place fragments are folded
- Upstream: local only
- Since: 2026-10-16
- Confirmed: yes

## LP-4 – drop the two backends removed in 0.30.0 from the kit text
- Files: .xezar/checks/gh-write.sh, .xezar/checks/verdict-write.sh, .xezar/checks/local-tree.sh, .xezar/docs/parallel-tasks.md, .xezar/docs/ui-operations.md, .xezar/docs/recovery.md
- Reason: the engine runs claude, codex and qwen only since 0.30.0 (#1041), and these kit files still described the two removed backends as current. Since 2026-10-18 recovery.md also names the merge-commit exception for release-class PRs under the two-branch model (LP-5); that line is local wording, so dropping this patch at an upgrade needs qodeca/xezar-skills#248 as well. Each changed line is the upstream wording, verbatim: kit 3.2.0 for ui-operations.md, parallel-tasks.md, gh-write.sh and verdict-write.sh, and the fix for qodeca/xezar-skills#231 for recovery.md and local-tree.sh. An upgrade that brings those lines finds them already here, so this patch can be dropped then.
- Upstream: qodeca/xezar-skills#231
- Since: 2026-10-18
- Confirmed: yes

## LP-5 – support the two-branch model (develop base, main for released work)
- Files: .xezar/checks/integration-preflight.sh, .xezar/checks/worktree-git.sh, .xezar/checks/worktree-preflight.sh, .xezar/checks/root-sync-preflight.sh, .xezar/skills/xezar-release-publish.md, .xezar/skills/xezar-release-changelog.md, .xezar/skills/xezar-integration.md, .xezar/skills/xezar-handoff-draft-pr.md, .xezar/skills/xezar-issue-triage.md, .xezar/workflows/release.yaml, .xezar/workflows/release-prep.yaml, .xezar/workflows/integration.yaml
- Reason: the owner moved this project to `develop` as the default and base branch, with `main` for released work only (2026-10-18). The kit assumes `main` is the base: the worktree guards did not refuse `develop`, the integration preflight refused every pull request into `main` and only squashes, and the release skills opened the changelog pull request into `main` and had no promotion or back-merge. This patch adds `integration-preflight.sh --release` (release-class head branches only, merge commit), refuses commits on the configured base, and writes the release skills for both models; under the trunk model every changed file behaves as before. xezar-release-publish.md also counts the four package manifests the Release workflow stamps (the kit text said three).
- Upstream: qodeca/xezar-skills#248
- Since: 2026-10-18
- Confirmed: yes
