# Local patches

Deliberate local changes to kit files. Format: `.xezar/docs/local-patches.md` § The register.

Retired ids, never used again: LP-2 (landed upstream at the 3.2.1 upgrade), LP-3 and LP-4 (their
last files, `.xezar/docs/leader-guide.md` and `.xezar/docs/recovery.md`, kept only two-branch
wording and moved to LP-5 on 2026-10-23).

## LP-1 – keep the project's own issue and pull request templates
- Files: .github/ISSUE_TEMPLATE/bug_report.yml, .github/ISSUE_TEMPLATE/config.yml, .github/ISSUE_TEMPLATE/feature_request.yml, .github/pull_request_template.md
- Reason: the templates name this product's backends, version commands, design folder and risk surfaces; the kit's generic copies would drop that detail
- Upstream: local only
- Since: 2026-10-05
- Confirmed: yes

## LP-5 – support the two-branch model (develop base, main for released work)
- Files: .xezar/checks/integration-preflight.sh, .xezar/checks/worktree-git.sh, .xezar/checks/worktree-preflight.sh, .xezar/checks/root-sync-preflight.sh, .xezar/skills/xezar-release-publish.md, .xezar/skills/xezar-release-changelog.md, .xezar/skills/xezar-integration.md, .xezar/skills/xezar-handoff-draft-pr.md, .xezar/skills/xezar-issue-triage.md, .xezar/workflows/release.yaml, .xezar/workflows/release-prep.yaml, .xezar/workflows/integration.yaml, .xezar/docs/leader-guide.md, .xezar/docs/recovery.md
- Reason: the owner moved this project to `develop` as the default and base branch, with `main` for released work only (2026-10-18). The kit assumes `main` is the base: the worktree guards did not refuse `develop`, the integration preflight refused every pull request into `main` and only squashes, and the release skills opened the changelog pull request into `main` and had no promotion or back-merge. This patch adds `integration-preflight.sh --release` (release-class head branches only, merge commit), refuses commits on the configured base, and writes the release skills for both models; under the trunk model every changed file behaves as before. xezar-release-publish.md also counts the four package manifests the Release workflow stamps (the kit text said three). recovery.md names the merge-commit exception for release-class PRs; leader-guide.md describes the two-branch model and points to `docs/publishing.md` for the release steps, and its setup section also names the CI checks branch protection requires, the platform labels intake sets, and that hotfixes are done by hand from `main`. Since 2026-10-23 xezar-release-changelog.md skips writing a bullet for a PR whose merge commit added a `changelog.d/` fragment (the fold already carries it), and xezar-integration.md spells out the merge order its citation of a removed leader-guide section used to name, with why it never runs `gh pr update-branch`. Since 2026-10-24 xezar-release-changelog.md also runs the release housekeeping checks of LP-6 as its step 4a, so they fire on the `release` path, and its commit may carry those text edits.
- Upstream: qodeca/xezar-skills#248
- Since: 2026-10-18
- Confirmed: yes

## LP-6 – release housekeeping: relabel BC Unreleased entries and expire designs by their own date
- Files: .xezar/skills/xezar-release-prep.md
- Reason: no release skill renamed `BACKWARD_COMPATIBILITY.md` § 9 entries headed `Unreleased` (0.31.0 shipped two), and the 90-day design expiry had no actor and measured `git log`, which repository-wide sweeps reset; the skill now holds both checks, and the expiry reads the date the design README records itself
- Upstream: local only
- Since: 2026-10-24
- Confirmed: no
