---
name: xezar-release-publish
description: Merge the changelog PR, dispatch the authorized Release run, verify npm, merge the bump PR
---

# Merge the changelog PR, dispatch the authorized Release run, verify npm, merge the bump PR

You are the LAST step of the `release` workflow, on purpose: only the last step is uncapped by default, and CI, the Release run, npm propagation and the bot's bump PR together take longer than the 30-minute default an earlier step falls through to. Since #22 an agent step can raise or drop that wall clock with its own `timeout` key, but no kit workflow sets one, so being last is still what buys the time — and it keeps `XEZ:ASK` live too. Every stop below is therefore a question with the evidence so far, never a silent exit. Read docs/publishing.md first. The brief `{{task}}` and `release.json` in the evidence dir (written by the `changelog` step: target version, tag, kept PRs, commit) are your inputs; the accepted brief keys are documented in `xezar-release-changelog.md`.

Hard rules, all of them, for the whole step:

- Never `npm publish` by hand, never push to `main`, never force-push, never edit a file, never make a new content commit. The only writers are `worktree-git.sh push`, `gh pr create`, `gh pr merge`, `gh workflow run` and the run-approval API call, each on the exact object named below.
- Every wait is bounded by the tool's own watch (`gh pr checks --watch`, `gh run watch`), and every failure or ambiguity stops with `XEZ:ASK`. Rerunning a red check is a choice the operator makes, not you.
- Record each substep's outcome (command, object, SHA or URL, result) by appending to `publish.md` in the evidence dir as you go, so a killed session leaves a readable trail and a resume can see what already happened. Re-read that file and the checkpoint first: an already-merged PR or an already-published version is reconciliation, not a repeat.
- Authority: the operator launched `release` with a bump. That is the authorization to dispatch the Release workflow once for that bump; it is not authorization for a different bump, a second dispatch or any manual recovery from docs/publishing.md's partial-failure table — those are `XEZ:ASK`.

## a. Verify the sealed evidence

```sh
bash .xezar/checks/worktree-preflight.sh --verify-gate-evidence
```

Red or missing evidence: stop with `XEZ:ASK` (return to gates / abort). The head you verified is the only head you may push.

## b. Changelog PR: open ready, wait for CI, squash-merge

```sh
bash .xezar/checks/worktree-git.sh push
gh pr list --head "$(git branch --show-current)" --state all --json number,state,url   # never open a duplicate
gh pr create --base main --title "docs: record <version> in the changelog" \
  --label documentation --label skip-qa --body "<the kept PR list from release.json, the tag boundary, and 'Part of the <version> release; the Release workflow is dispatched after this merges.'>"
gh pr checks <n> --watch --interval 30
gh pr merge <n> --squash --delete-branch --match-head-commit "$(git rev-parse HEAD)" \
  --subject "docs: record <version> in the changelog (#<n>)"
```

The PR is READY, not draft: `skip-qa` applies (docs-only) and the QA gate in SDLC.md does not. Do not attempt `gh pr review --approve` on your own PR — GitHub rejects self-approval on a single-account repository; say that in the report and proceed to the merge, which branch protection allows once the required check is green. If a check is red: `gh pr checks <n>` plus `gh run view <id> --log-failed` for the failing job, then `XEZ:ASK` with two options — rerun the failed job once (`gh run rerun <id> --failed`) when the only failure is the known flaky test from issue #28, or abort. Never merge over a red check. After the merge record the merge commit: `gh pr view <n> --json mergeCommit -q .mergeCommit.oid`.

## c. Confirm main and the version arithmetic

```sh
git fetch --quiet origin main --tags
git rev-parse origin/main                                   # must equal the merge commit from b.
git show origin/main:packages/xezar/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version'
npm view @qodeca/xezar versions --json
```

Compute the version the Release workflow WILL produce: `bump` applied to the manifest on `origin/main` (`existing` is never used here). It must equal the target in `release.json`, and it must not be in the npm `versions` list. The known trap: when the previous `release/v<n>` bump PR is still open, the manifest on `main` is one behind npm, so `bump: patch` would rebuild the version npm already serves and the run would fail at publish with E403 after a full build. In that case stop with `XEZ:ASK`: merge that older bump PR first (it is the operator's PR to authorize, then re-run from here), or abort. A head mismatch on `origin/main` (someone merged in between) is also `XEZ:ASK`, because the release would ship content nobody listed in the changelog.

## d. Dispatch the Release workflow, or stop on `dry-run: true`

If the brief carries `dry-run: true`, stop HERE. Report the exact command that would run, the computed version, the manifest and npm values, and end with `XEZ:DONE` — the changelog PR is merged and that is the whole dry run. Otherwise:

```sh
gh workflow run Release --ref main -f bump=<bump>
sleep 15; gh run list --workflow Release --limit 1 --json databaseId,status,headSha,createdAt,url
gh run watch <id> --exit-status
```

Confirm the run you watch was created after your dispatch and sits on the `origin/main` head from c. before you wait on it. Non-zero: `gh run view <id> --log-failed`, then `XEZ:ASK` with the failed step's log and the matching row of the partial-failure table in docs/publishing.md. Do not re-dispatch on your own — a second run against a version that did publish burns nothing, but one against a half-published version is the case that table exists for. If the `production` environment has a required reviewer, the run waits at `waiting`; say so and keep watching (the watch is bounded by the workflow's own 30-minute job timeout).

## e. Verify the publication

```sh
npm view @qodeca/xezar version                 # == <version>
npm view @qodeca/xezar dist-tags.latest        # == <version>
git ls-remote --tags origin "v<version>"       # one line
gh release view "v<version>" --json url,targetCommitish
```

All four or stop with `XEZ:ASK`; a green run with a missing tag is the "published, but no tag" row, and the operator decides.

## f. Approve and merge the bot's bump PR

```sh
gh pr list --head "release/v<version>" --state open --json number,url,headRefOid
gh run list --branch "release/v<version>" --json databaseId,status,conclusion,event
gh api -X POST "repos/qodeca/xezar/actions/runs/<id>/approve"     # the run is held at action_required (bot author)
gh pr checks <n> --watch --interval 30
gh pr merge <n> --squash --delete-branch --match-head-commit <headRefOid> \
  --subject "chore(release): v<version> (#<n>)"
```

Record the merge commit (`gh pr view <n> --json mergeCommit`). A red check here follows the same rule as b.: rerun once only for the known flaky test from #28, otherwise `XEZ:ASK`. The bump PR only touches three `package.json` files; if it carries anything else, stop and ask.

## g. Report

End with a table the operator can act on, then `XEZ:DONE`:

| Item | Value |
|---|---|
| Changelog PR | #n, merge SHA |
| Release run | URL, conclusion |
| npm | `@qodeca/xezar@<version>`, `latest` -> `<version>` |
| Tag / GitHub Release | `v<version>` SHA, release URL |
| Bump PR | #n, merge SHA |

And the two follow-ups the operator still owns, because this workflow never touches the primary checkout: run the `root-sync` workflow (Worktree OFF) with the bump merge commit as the fixed target, and `npm i -g @qodeca/xezar@<version>` on the machine that runs the cockpit. Say plainly which substeps were observed live and which were skipped (dry run, reconciliation).

## Shared contract

Before reading kit files in a standalone skill run, if `.xezar/checks/bootstrap.sh` is absent, run `bash "$(git rev-parse --path-format=absolute --git-common-dir)/../.xezar/checks/bootstrap.sh"`. If unavailable or refused, stop with that specific blocker. Never fabricate commands or copy runtime. Workflow launches already perform this step.

Read `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md` and `.xezar/docs/README.md`. Root rules and the current authorized task govern. Workflows snapshot the local kit before work; do not create/adopt another task branch or change a peer's checkout. Use current task identity, not a remembered working directory. Read the task's current checkpoint and late steering before resume or handoff.

The leader owns the goal/plan and adjudication. Specialists own technical evidence and findings. Ask only for a genuinely missing decision outside existing authority, using `XEZ:ASK` with options and custom answer in an interactive terminal agent step. Silence is not authority. Record unresolved dependent work in the primary evidence directory's `BLOCKED` file so readiness cannot pass. Independent work may continue. Never waive mandatory quality/AC. Project operations within the authorized plan need no repeated permission; this is not permission to publish when the current assignment excludes it.

Writing-stage ownership: implement all code/tests/docs/release metadata, focused tests, self-review and focused commits before full gates. Run only `.xezar/checks/repo-gates.sh --fast` for final canonical evidence. Do not repeat the entire gate list in every agent step. Gate repair returns are at most two; quality-gates allows at most two repairs of the same failure. Preserve history when changing executors; no invented global retry allowance.

Derive durable evidence with `.xezar/checks/lib/common.sh` (`resolve_task_paths`, `task_evidence_dir`): primary `.local/xezar-tasks/<runId>/`, not the task's reclaimable `.local` or engine tmp. Keep checkpoints concise. Never copy secrets, credentials, `.env`, personal agent configuration or unrelated source content. Reports distinguish observed, fixture-tested, live-verified and unknown. Record relevant dogfooding observations using `.xezar/docs/dogfooding.md`.
