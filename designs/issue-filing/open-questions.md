# Open questions — New issue in the GitHub tab

Six questions the design cannot settle on its own. Each has exactly two options, a recommendation
and what changes if the other option is taken. The design as drawn follows the recommendation in
every row, so answering "the recommendation" everywhere needs no rework.

None of these blocks the design review: a reviewer can judge the design as drawn and record a
different answer as a finding.

---

## OQ-1 — Should **New issue** appear when GitHub is unavailable?

When `gh` is missing, not logged in, or the repository has no GitHub remote, the tab replaces
itself with "GitHub is unavailable here". The skill still has a local-draft fallback: it writes an
ignored Markdown record under `.local/issues/` and reports `draft-only`.

| Option | What it means |
| --- | --- |
| **A — no control there (recommended)** | The tab's explainer stands unchanged. Filing a local draft is reached from the ordinary composer, like any other task. |
| B — offer it, labelled as a draft | A second button on the unavailable screen, saying the issue cannot be filed and only a local draft is possible. |

**Recommendation: A.** There is no destination to name, and the header that carries the control is
not rendered on that screen. A button called **New issue** that cannot produce an issue teaches
people to distrust the label — which is the one thing this design spends all its copy protecting.
The unavailable screen's job is to explain a missing capability, not to offer a consolation path.

*If B is chosen:* add a fifth state to `states.html`, a distinct label ("Draft an issue locally"),
and an AC asserting that no `gh` call is attempted.

---

## OQ-2 — Should the dialog offer a **Draft only** choice?

The skill reports four outcomes, one of which is `draft-only`.

| Option | What it means |
| --- | --- |
| **A — one path (recommended)** | The dialog always starts the same task. A person who wants a draft says so in the brief, and the skill honours it. |
| B — a Draft only toggle | A switch in the dialog that pins the task to `draft-only` before it starts. |

**Recommendation: A.** `draft-only` is an *outcome* the procedure reports, not a mode the caller
selects — it is also what a cancelled approval, an unavailable search and a blocked required fact
all resolve to. A toggle would suggest the other three are impossible when it is off, which is
false, and it adds a second authority channel beside the brief. One path keeps the brief the only
thing that carries intent.

*If B is chosen:* the toggle must also reach `task_create` (parity), and the copy must say that
draft-only is still what happens when the search fails.

---

## OQ-3 — Where does the draft strip live?

| Option | What it means |
| --- | --- |
| **A — the GitHub tab only (recommended)** | The strip is part of this surface and disappears with it. |
| B — the shell's banner row | Visible from every page, like the provider banner and the post-update offer. |

**Recommendation: A** for this PR. The task already appears in the task list, raises the sidebar
attention dot and can raise a notification — the cockpit's general "an agent needs you" channel is
not missing. The strip adds value only where the person's attention already is: the tracker they
were reading. Putting it in the shell would give issue filing a privilege no other task has, and
the banner row is a scarce surface shared with real environment problems.

*If B is chosen:* it must be coordinated with the onboarding design, which also proposes a row
there, and the two must have a stated order.

---

## OQ-4 — Should the empty-state entry pre-fill the brief with the search text?

A person who searched for "worktree lease" and found nothing presses **New issue**.

| Option | What it means |
| --- | --- |
| **A — pre-fill the first line, editable (recommended)** | The box opens containing the search words, with the caret after them. |
| B — always open empty | The search text is not carried over. |

**Recommendation: A.** The search words are the person's own, they are the best available first
sentence, and the cockpit already has this exact idiom — the hand-off box pre-fills the item
reference and is editable (#524). The same rule applies: what you see is what the agent gets. The
draft store must treat a pre-fill as *untouched*, so it is not persisted as a draft for a dialog
the person closed without typing.

*If B is chosen:* the empty-state copy should stop implying continuity ("An agent can draft one")
because nothing carries over.

---

## OQ-5 — Is the destination always the tab's repository?

| Option | What it means |
| --- | --- |
| **A — always this tab's repository (recommended)** | No picker. The destination is what the tab already discovered. |
| B — a repository picker in the dialog | The person may file into another repository. |

**Recommendation: A.** The tab is project-scoped and the repository is discovered, not configured.
A picker would need its own discovery, its own auth story per repository, and its own duplicate
search scope — and the skill's whole duplicate-first rule is scoped to *the resolved destination*.
Filing elsewhere is a task, and the composer already starts one.

*If B is chosen:* the destination row becomes a control, the duplicate-search claim in the dialog
copy must be requalified, and AC-5 grows a case per repository.

---

## OQ-6 — Do the engine pills belong in this dialog?

| Option | What it means |
| --- | --- |
| **A — keep them (recommended)** | `EnginePills` with accounts, exactly as the hand-off panel renders them. |
| B — drop them | The task silently inherits the project default backend and model. |

**Recommendation: A.** Every other way of starting a task from this tab offers the choice, and the
provider gate ("Connect an agent provider to run this item.") lives in that component — dropping
the pills would drop the one honest explanation for why the button cannot run. A person who does
not care simply ignores two chips.

*If B is chosen:* the provider-unavailable reason must be reproduced elsewhere in the dialog, or
the failure becomes a bare error after the press.
