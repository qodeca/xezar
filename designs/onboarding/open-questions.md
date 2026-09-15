# Onboarding design – open questions for the owner

Ten questions this design could not settle from the request, the code or the accepted decisions on
[#464](https://github.com/qodeca/xezar/issues/464). Each has a recommendation, and the mockup is
built on that recommendation, so a "yes" costs nothing and a "no" is a named, bounded change.

Date: 2026-09-16. Author: the `design` workflow (`xezar-ux-design`, authoring mode).
Context read: the analysis and owner-decisions comments on #464, the contract note
`docs/features/onboarding/xez-onboard-contract.md` (PR #475, head `5bdc9c0`), the design system, and
the release-hygiene rule of [#466](https://github.com/qodeca/xezar/issues/466).

---

## OQ-1 · Which project does the offer row belong to?

The record is per project. The banner row is part of the shell, and the shell is inside a project
scope (`/p/:projectId/`), but a person with five registered projects could in principle be shown five
changes at once.

| Option | Consequence |
| --- | --- |
| **A. The active project only** (recommended) | One row at most, always about the project on screen. A second project's change waits until you open it. Simple, honest, no queue. |
| B. One row for every changed project | A person who opens xezar after an update meets five rows. That is the nag the owner's decision Q3 was written to avoid. |

**Recommendation: A.** The whole design assumes it.

---

## OQ-2 · In hosted mode, does the setup entry stay available?

The setup task itself is an ordinary task and runs fine in hosted mode. Two parts of its outcome do
not: registering the xezar connection in an agent's own config file on a person's computer, and
attaching that agent as the project leader. Those are local-machine steps and the cockpit already
refuses them with a 409.

| Option | Consequence |
| --- | --- |
| **A. Keep the entry, add one line naming the part that finishes elsewhere** (recommended) | A hosted user gets the useful part: project guidance, ignore rules and the optional delivery pipeline. The one step they cannot finish here is stated before they start, not discovered at the end. |
| B. Hide the entry in hosted mode | Nothing misleading, but a hosted user loses a working capability for the sake of a step most of them never wanted. |

**Recommendation: A.** State 2c on `states.html` shows the wording.

---

## OQ-3 · What is the settings section called?

| Option | Consequence |
| --- | --- |
| **A. "Project setup"** (recommended) | Matches the sentence-case noun-phrase rule for settings sections, and says which thing is being set up. Distinct from the existing "Agent config". |
| B. "Setup" | Shorter, but in a project-scope settings pane every section is about the project, so "Setup" reads as "set up xezar", which is not what it does. |

**Recommendation: A.**

---

## OQ-4 · Does the offer row ever appear for a project that has never been set up?

| Option | Consequence |
| --- | --- |
| **A. No — the never-set-up entry is the only offer** (recommended) | A brand-new project shows one quiet action on its empty state and nothing else. A banner row on top of that would be a nag before anything has happened. |
| B. Yes, once | More discoverable, at the cost of greeting every new project with a notice. |

**Recommendation: A.** The contract already says first use offers setup without inventing an
upgrade baseline; this keeps the surfaces matching that.

---

## OQ-5 · What is the pinned kit digest called in user-facing copy?

The contract calls it `kitDigest`. The release-hygiene rule of #466 says the copy must never present
xezar's own internal working files as something a user adopts, and "kit" is exactly that word.

| Option | Consequence |
| --- | --- |
| **A. "setup templates"** (recommended) | Describes what the digest actually pins from the user's side, and carries none of xezar's internal vocabulary. The field name stays `kitDigest`. |
| B. "kit" | One word, but it teaches a user a xezar-internal term and points at the thing #466 says not to point at. |

**Recommendation: A.** Every string in the copy deck uses it.

---

## OQ-6 · "Later" departs from the cockpit's dismiss-button convention

`docs/design-system/writing.md` §4 says a dismiss button names the kept outcome ("Keep it",
"Keep the file"). "Later" names a time instead.

| Option | Consequence |
| --- | --- |
| **A. Keep "Later"** (recommended) | It is the word the owner's decision Q3 names, it is short, and "Later" is honest: the offer really does come back through Settings at any time. Recorded here as a documented departure so a reviewer does not read it as an accident. |
| B. "Not now" | Closer to the convention's spirit, still not the kept outcome, and no longer the owner's word. |

**Recommendation: A**, with this entry as the reason a review needs.

---

## OQ-7 · Where does a re-check get the previous bytes from?

The contract leaves this open: "Re-check baseline provenance is an open P2 decision; the candidate is
to resolve previous bytes from the pinned `kitDigest` revision."

| Option | Consequence |
| --- | --- |
| **A. Resolve them from the pinned `kitDigest` revision, and when that cannot be resolved, run report-only and say so** (recommended) | A real three-way comparison when the revision is reachable, and an honest, clearly-labelled two-way reading when it is not. Never a silent overwrite. |
| B. Keep a copy of the applied bytes in the project | A guaranteed baseline, but it adds project state a user must not have to keep, migrate or repair — against the zero-config rule. |

**Recommendation: A.** State 2a covers the UI half: "cannot tell your own edits from an older
default, so it will not replace a file on its own."

---

## OQ-8 · Does the change deserve a browser notification?

| Option | Consequence |
| --- | --- |
| **A. No** (recommended) | Notifications fire for `needs you`, `needs review` and `failed` — a person is being waited on. A version change waits for nobody. |
| B. Yes | Reaches a person who has the tab hidden, at the cost of making an optional offer feel urgent. |

**Recommendation: A.**

---

## OQ-9 · Which MCP tool carries the dismissal?

| Option | Consequence |
| --- | --- |
| **A. `project_config`, new action `dismiss_onboarding_offer`** (recommended) | That tool already reads and changes this project's own configuration, and the dismissal is project state, not a task. No new tool, no new inventory family. |
| B. `organise_work` | That tool is explicitly about this project's tasks. A project-level dismissal would be the first action there that touches no task. |

**Recommendation: A.** The proposed inventory rows are in the README's MCP parity section.

---

## OQ-10 · Does the setup entry belong in the command palette?

| Option | Consequence |
| --- | --- |
| **A. Yes, one row in the Actions group** (recommended) | ⌘K is how a returning person reaches anything, and this is the entry that is hardest to find once the empty state is gone. Same availability rules: hidden when no backend is available, so the palette never offers a dead action. |
| B. No | One fewer surface to keep in step, and a person who forgot where the section lives has to hunt through Settings. |

**Recommendation: A.** It is a row added to the existing palette Actions group, not a new surface,
so it is in scope for the implementing PR but is not drawn in this mockup.
