# Task operation and stage ownership

Select the role workflow and actual available backend/model. Worktree ON for ordinary writing; integration/root-sync modes are separate. Read-only tasks may initialize evidence without dependencies. Bootstrap runs first; then development workflows run preflight → setup → author → readiness → gates → seal → handoff. Nine writing workflows allow at most two returns to their author step after failed gates. Standalone quality-gates allows two repairs of the same failure. Reassignment retains failure history, not a hidden counter reset.

The terminal agent step must remain last so XEZ:ASK can present options. An unresolved required decision in an earlier stage needs a BLOCKED record, and readiness must stop before gates; plain text is insufficient. Because an author step can also end with no work and no BLOCKED record, readiness and both evidence modes refuse a branch with no commits over its base (`branch.has-own-commits`, #312); plain preflight and the read-only roles do not run that check. Ask only outside existing authority, never for routine authorized operations. Do not interpret silence as consent.

Complete all source/tests/docs/release metadata and focused commits in development. Handoff verifies unchanged evidence and writes no new content/commit. Missing content returns to the author stage. Publish only within actual assignment authority; draft is not completion. Follow SDLC QA/labels, current CI and actual hosting policy.

Checkpoint: goal/DoD, stable AC and accepted content, plan/tasks/dependencies, decisions/questions, current head/base, evidence/remaining stages, blockers and next action. Handoff: task/phase/outcome, judged/current revision, passed/failed/not-run, PR/CI identity, unmet AC and actionable follow-ups. Decision: accountable delegated authority, question/answer, exact content path/revision/digest or immutable criteria snapshot and conditions. Current checkpoint and late steering must be consumed before resume/final handoff.

## Browser command delivery

Reuse one working task tab and close obsolete tabs you created. Before Start or Send, read back project, full task identity, workflow, backend/model, Worktree, autonomy, exact draft and enabled control. A disabled composer is a capability/state question: preserve its draft and restore the supported path before submission. Submit once, then reconcile fresh thread/history; a click or a draft is not delivery.

Use a short command identity in the brief and the existing task checkpoint. It correlates observations; it is not a server idempotency key. Track each state independently:

| State | Evidence required |
|---|---|
| Attempted | Exact command/draft, target, identity and submission time |
| Server persisted or queued | Supported acknowledgement or matching persisted user-message; record which one |
| Runner received | Exposed runner acknowledgement; transcript persistence or queue acknowledgement alone is not runner receipt; otherwise unknown |
| Acted upon | Agent response or artifact explicitly addressing the command |
| Unresolved | Last confirmed state, missing evidence, investigation deadline and next trigger |

A transcript message can be persisted before runner send fails. A startup queue acknowledgement can refer to an in-memory buffer lost on restart. Therefore neither proves runner receipt. For timeouts before/after acceptance, persistence followed by refusal, or deferred acceptance followed by restart, inspect the same command identity and preserve unknowns. Do not blindly retry, launch a replacement owner or equate an accepted message with completed code. Checkpoint unresolved delivery, stop automatic retries, and investigate within a stated finite window; when it expires report the narrow blocker and the supported manual continuation. Never infer absence from one failed or incomplete read.

## Readiness and ownership ledger

Use the existing durable task evidence directory and one coherent checkpoint, not another database. Each row names AC, candidate head/base, implementation artifact, execution status, independent review/QA, current CI, merge commit, primary sync and effective deployment evidence. Unknown, failed, interrupted and not-run remain distinct. A closed issue with unmet AC, a done author with missing review/red CI, or merged code absent from the live artifact remains unready in that dimension. Record archive membership separately from execution; link to archived work that resumes.

A takeover starts with confirmed owner state, checkpoint, branch/worktree and backend session identity. A parked view is not a dead owner. Preserve raw history, correction manifests, consumed workflow returns and same-failure repairs across task IDs/backends. Recover missing history before deciding another repair budget. One primary writer and the actual engine lease remain required where applicable; never manufacture a lease record. Use current authorization when the owner explicitly assigned direct primary-checkout work.

## Bounded pilot

Choose five eligible ordinary work items before observing results: docs, reproduced fix, test strengthening, feature slice and continuation/review response, using OpenCode and pi where suitable. Each assignment records requested/effective backend/model or unknown, tool fitness, local/paid routing reason and fallback authority. Begin with one controlled local inference assignment when shared capacity is unknown. Account for other visible consumers; do not claim exclusive cluster capacity.

Record cohort identity, eligibility/matching reasons, calendar observation cutoff and post-merge follow-up window before outcomes. Keep failed, replaced, abandoned and unresolved items plus every attempt and attributable leader/reviewer/fallback cost. Unknown subscription consumption is unknown. Report individual small-sample timings, acceptance counts, latency, interventions and quality follow-up still pending; extend only to investigate a named failure mode. Compare paid consumption and accepted-result latency only with defensibly matched history. Investigate a >20% median latency regression; never promote a route with lost work, falsely certified completion or waived quality. Use adapted → fixture-tested → real-task verified → recommended with explicit evidence boundaries.
