# Design lifecycle

Use the [usage guide](usage.md) to scope the task and the [verification matrix](verification.md)
to plan evidence. [Storage](storage.md) owns the assets and their provenance;
[recipes](recipes.md) is the planned P2 composition guide. The authority for labels and merge
requirements is [SDLC — The design gate](../../SDLC.md#the-design-gate).
The folder statuses come from [designs/README.md](../../designs/README.md#lifecycle).
They are prose statuses, not GitHub labels or Xezar task states.

Feature-sized UI starts with a design. A fix-sized UI change gets design review on its PR
without a separate mockup. Read [known gaps](known-gaps.md) before copying a surface.
An author finishing a run is not design approval, QA, business acceptance or permission to merge.

## Actors, evidence and transitions

The [`design` workflow](../../.xezar/workflows/design.yaml) runs
[`xezar-ux-design`](../../.xezar/skills/xezar-ux-design.md) in authoring mode: static mockups,
all applicable states and a developer handoff, with no application code. The
[`design-review` workflow](../../.xezar/workflows/design-review.yaml) uses the same skill
read-only. The reviewer produces the verdict; the author writes the resulting status and
review link into **both** the feature README and the designs index. A review task never
edits either file, even though the index describes posting the verdict as the In review trigger.

| State / trigger | Actor | Required evidence | Transition and next action |
| --- | --- | --- | --- |
| New feature design | Author, through `design` or human work | Accepted task criteria; `designs/<feature>/index.html`, feature pages and README; open decisions; `## Design review` reads `Pending` | Set **Draft** in both status locations. Commit the complete mockup; handoff opens a draft PR with `needs-design`. |
| Review requested, then verdict posted | Requester starts `design-review`; reviewer inspects the identified PR head | One PR comment headed `## Design review`: SHA, reviewer role, themes, widths, verdict and numbered B-n / NB-n findings | Author links it and sets **In review** in both places. A request alone is not a verdict. |
| FAIL or missing required browser evidence | Reviewer reports failure / verification not run; author owns repair | Findings and missing checks; `design-approved` removed if applied in error; `merge-queue` removed on failure by an authorized actor | Remain **In review**. Return findings to the original author; re-review the repaired head. Disposing every finding does not turn FAIL into approval. |
| PASS or PASS WITH FOLLOW-UPS | Reviewer judges content; author records dispositions; authorized reviewer applies approval label | Identified reviewed SHA and comment; every finding exactly one of fixed in a SHA, filed as a `design-debt` issue, or accepted with a reason | Set **Approved** only with the passing verdict and dispositions. Keep `needs-design`, add `design-approved`. Evidence-only reviewers leave labels to an authorized actor. |
| Only part of an approved design ships | Implementing author | Merged PR and implemented AC/screens/states; explicit remaining scope and follow-up references in the handoff | Keep the whole design **Approved** while scope remains. Describe partial implementation in prose, not a new status or label. Re-review changes to the accepted design. |
| All intended scope ships | Implementing author / post-merge housekeeping, or next PR touching the index | Merged implementation PR(s), exact revision, affected-flow verification and any remaining debt | Reconcile both statuses to **Implemented (PR #n)** after merge. An implementation PR does not merge itself by changing this row; code review, QA and design gates still apply. |
| Draft or In review untouched for 90 days | Release prep or whoever notices, through an authoring change | Last activity date and archive reason | Set **Archived** in both locations; retain row, folder and evidence. |
| Approved with no implementing PR within two releases | Author or maintainer noticing the release boundary | Approval record and the two release references; changed cockpit assumptions | Revert both statuses to **Draft**. Revalidate against the current system before seeking a fresh verdict. |
| Archived work is picked up again | New or returning author, assigned by requester | Previous history plus current criteria, gaps and source revision | Return both statuses to **Draft**, refresh mockups and handoff, then request review. Old approval is historical evidence. |

Record accepted scope against an exact revision in the issue or PR; a mutable label alone
cannot say which content the owner accepted. Preserve historical reviews when content changes.
A design review is about the identified content; do not reuse it to certify later UI changes.

## Bounded repair and continuation

The design workflow's command sequence after the author's focused checks and commit is:

```sh
bash .xezar/checks/worktree-preflight.sh --readiness
bash .xezar/checks/repo-gates.sh --fast
bash .xezar/checks/worktree-preflight.sh --record-gate-evidence
```

Run the canonical gate in the foreground and wait for it. Handoff verifies the seal with
`bash .xezar/checks/worktree-preflight.sh --verify-gate-evidence` before pushing and drafting.
A failed gate returns to the design author at most **twice** (`onFail.retry: design`, `max: 2`).
Standalone quality-gates allows at most two repairs of the same failure. A reviewer does not
repair the tree or reset these counters. This is a gate-repair bound, not permission for a
fixed number of failed design verdicts to become a pass.

For a FAIL verdict, the requester/leader returns the findings to the original author.
A person uses **Continue**; the leader uses MCP `execution_control` with `action: "continue"`
and the feedback text, the author run id, a fresh `expectedVersion` from `task_read` and
a unique `operationId` (reuse it only for a retry of the same operation). See [recovery](../../.xezar/docs/recovery.md#continue-and-delivered-context)
and the [MCP command contract](../features/mcp-server/mcp-api.md#execution_control).
Continue does not replay the workflow: restore the author role, current head/base, review link,
remaining stages and consumed repair attempts. Finish repairs, validate and request a new
`design-review`. Stop for unresolved decisions or exhausted repairs; keep a draft PR and a
`BLOCKED` record in the durable task evidence directory. No `blocked` label is introduced.

## Tabletop walkthrough

These are command recipes, not executed review or browser evidence. Run tracker mutations only
with the assignment's authority and the [SDLC claim protocol](../../SDLC.md#the-claim-protocol).
Set `PR` to the actual PR number; `BODY` and `REVIEW` are absolute paths to prepared Markdown
in ignored working evidence, not new repository files. Verify the current head before each verdict:

```sh
gh pr view "$PR" --repo qodeca/xezar --json headRefOid,isDraft,labels,body
gh pr diff "$PR" --repo qodeca/xezar
```

| Scenario | Action and exact workflow / command | Expected exit and evidence |
| --- | --- | --- |
| Draft | Start `design` with the accepted brief. After commit, readiness, gates and seal, handoff runs `gh pr create --repo qodeca/xezar --base main --head "$BRANCH" --draft --title "$TITLE" --body-file "$BODY" --label needs-design`. | Draft PR, README review Pending, both statuses Draft; requester starts `design-review` for its number and head. |
| FAIL | Reviewer runs `gh pr comment "$PR" --repo qodeca/xezar --body-file "$REVIEW"` with a `## Design review` FAIL. Authorized actor removes present stale labels with `gh pr edit "$PR" --repo qodeca/xezar --remove-label design-approved --remove-label merge-queue`. | Author records In review and findings. Requester continues the author as above; no application implementation based on this FAIL. If a decision holds the work, `gh pr ready "$PR" --repo qodeca/xezar --undo` makes it draft and a comment explains the hold. |
| Approval | Reviewer posts PASS / PASS WITH FOLLOW-UPS through the same comment command. Author links it with all dispositions. Authorized reviewer runs `gh pr edit "$PR" --repo qodeca/xezar --add-label design-approved` and comments why. | Approved refers to reviewed content; `needs-design` remains. Any later rendered change gets review at its new head. Neither draft removal nor merge is implied. |
| Partial implementation | Author checks `gh pr view "$IMPLEMENTATION_PR" --repo qodeca/xezar --json state,mergedAt,mergeCommit,url`; updates implemented and remaining AC in the handoff. | A merged subset is recorded as partial, while status remains Approved. Remaining work returns to its assigned author; changed design assumptions return to review. No `partial` label. |
| Reviewer unavailable | Keep the PR draft pending capacity, or use only the self-verification exception below. | No reviewer/browser capacity is not PASS. With all exception evidence present, apply `design-approved` and `design-self-verified`; without it, approval remains missing. |
| Post-merge | Author verifies merge using the command above and exercises the implemented flow using [verification](verification.md); reconciles both status locations in the implementing PR's housekeeping or the next touching PR. | All intended scope delivered → Implemented (PR #n). Record results and follow-ups; complete a deferred post-merge design review through `design-review`. A merge record alone proves no browser result. |
| Expiry | Author/maintainer checks `git log -1 --format=%cI -- "designs/$FEATURE"` against recorded review/activity dates and release history. | Inactive Draft/In review at 90 days → Archived; Approved with no implementing PR in two releases → Draft. Record date/release evidence and reason in both status locations. These are prose edits, with no expiry label or automatic timer. |
| Revival | Requester starts `design` for the retained folder, naming the archived history and changed criteria. | Author sets Draft, refreshes evidence, then follows the Draft review path. No revival label and no inherited approval. |

Remove labels only when present; explain automated meta/pipeline label changes in a PR comment.
For review-only work without a PR, the reviewer returns the same verdict text in its final message;
the requester places it, and the author links it. The reviewer still does not edit the tree.

## Unavailable reviewer and explicit exceptions

[SDLC](../../SDLC.md#the-design-gate) permits author self-verification only when no design
reviewer has capacity in time: attach the same review comment **with screenshots of every
state in both themes and at 375 px**, file a `design-debt` issue for post-merge review and link
it in that comment. Only then apply both labels:

```sh
gh issue create --repo qodeca/xezar --title "$TITLE" --body-file "$BODY" --label design-debt
gh pr comment "$PR" --repo qodeca/xezar --body-file "$REVIEW"
gh pr edit "$PR" --repo qodeca/xezar --add-label design-approved --add-label design-self-verified
```

An unavailable browser prevents collecting that evidence; it is not an exception to verification.
A release definition of done does not count `design-self-verified` as a review. Use the
[verification matrix](verification.md), including 44 × 44 CSS px phone targets at every density
and the separate 24 px chip floor; do not replace measurements with class names.

`skip-design` needs a written reason and is never combined with `needs-design`. For a qualifying
unchanged-output case from SDLC (pure refactor, test/type-only change, writing-rule copy fix or
an existing G-nn rule applied), record that reason in the PR body before changing labels:

```sh
gh pr edit "$PR" --repo qodeca/xezar --body-file "$BODY"
gh pr edit "$PR" --repo qodeca/xezar --remove-label needs-design --add-label skip-design
```

It is not the fallback for a failed review, absent reviewer or absent browser. Markdown-only
reference documentation can state that non-UI scope explicitly. Publishing these guides does
not settle #453's remaining UI debt or certify production readiness.
