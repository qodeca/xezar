# Lessons: changing a mechanism that already works

The worked examples behind the seven rules in [AGENTS.md](../../AGENTS.md) § Changing a
mechanism that already works. The rules live there because a session needs them; the
narratives live here because a session only needs them when a rule is disputed.

Every incident below predates the rename; its number is a pre-rename issue number, kept as a
label.

## Why this class of change is the riskiest

Replacing working behavior fails in a characteristic way: the new mechanism is correct,
the tests are green, the spec is thorough — and the DEFAULT path quietly lost a guarantee
nobody wrote down. Pre-rename issues 810 and 811 both shipped a
well-specified improvement that left the zero-config user worse off than before.

## Name what the old mechanism was load-bearing FOR

`IDLE_TIMEOUT_MS` read as session hygiene, and pre-rename issue 661 removed it from the
monitoring branch for a good reason: it was closing live sessions mid-CI and recording
them as `done`.

It was also the only liveness bound on `XEZ:MONITORING`, and the only reason a parked
monitor eventually stopped holding a `maxParallel` slot. Neither dependency was named in
the spec, so neither was replaced, and `monitoring` became a state with no exit.

A name-keyed stored list survives a repo rename and silently empties the default catalog.
The Manage-skills panel stores a curated `importedSkills` list of skill NAMES in
`~/.xezar/ui-state.json`, and the catalog gate keeps a default-repo skill only when its name
is in that list. Flipping the default team skills repository from one that names its skills
`om-*` to one that names them `xez-*` left every curated install with zero team skills and
no error – the old list was load-bearing for "which of the default skills show", not for
"which repository they come from". The fix maps `om-<x>` to `xez-<x>` when the list is READ
(never written back), and the regression test is the one that failed first: a stored
`['om-fix']` against a catalog offering `xez-fix` must keep `xez-fix`.

## Enumerate the transitions out of every state

A parked run has exactly three wake sources: a user message (`deliverMessage`), the
autonomous nudge (turn-end only), and the monitoring wake timer. Xezar has no
process-exit callback, no CI webhook and no sub-agent-completion event, so a state whose
only on-by-default exit is "a human types something" is a dead end, however well it
renders.

## Find every construction site of a shared in-memory object

`ActiveRun` is built in `execute` AND in `runContinuation`. Pre-rename issue 811
populated `state.skills` in the first only, so registry `/skill` expansion worked on new
tasks and silently failed on every Continue and every restart recovery.

The same shape recurs in the two near-identical turn-end handlers in `workflows/run.ts`
(streaming and non-streaming): a lifecycle change applied to one of them ships half a fix.

## A fail-open helper needs a populated-input guarantee

`expandRegistrySlashSkill` returning its input unchanged on no-match is right on its own —
a backend's own slash commands must survive. Against an empty registry that same branch
turns "xezar never loaded the list" into a confident user-facing "Unknown skill".

## A replacement that ships OFF is not a replacement

A spec's "Resolved assumptions" table answering a COST question with "opt-in, default
null" is not an answer to whether the zero-config path still works. Cost-safe and
functional are separate reviews.

## Read the run-history evidence before theorizing

`git log -S` and `git merge-base --is-ancestor <commit> <tag>` settle "was this in the
release the user is on", and a user's "it worked in 0.9.1" is a testable claim, not an
opinion. Pre-rename issue 810 was confirmed in one command before a line of code was
read.
