# Designs

UI designs for xezar, one folder per feature: `designs/<feature-name>/`.

Every design folder contains:

- **Static HTML mockups** on the shared design-system stylesheet plus a feature-specific `styles.css`. They must open straight from disk, with no build and no server. Start with `index.html`.
  - A placeholder link, such as a sidebar item, points at the design's own page when one exists. `href="#"` is only for items with no page in the design.
- **A `README.md` handoff document** for developers and the rest of the team. It covers:
  - summary, problem evidence, users and goals / non-goals
  - screens, component specs and every state
  - copy deck
  - developer notes (data, routes, files, tests)
  - accessibility and responsive rules
  - acceptance criteria
  - open decisions, delivery plan, risks and references

Mockups follow the design system in [`docs/design-system/`](../docs/design-system/README.md) – read it first. Every page links the shared stylesheet `docs/design-system/cockpit.css` by relative path (`../../docs/design-system/cockpit.css`), which carries the cockpit's tokens for both themes and the base component classes; the design's own `styles.css` holds only feature-specific rules and never redeclares a token or a base class. The rules are in [`docs/design-system/new-designs.md`](../docs/design-system/new-designs.md). Mockups are references, not shipped code: never import their CSS into the app.

## Lifecycle

A design folder moves through five statuses: **Draft → In review → Approved → Implemented (PR #n) → Archived**. The labels and the review evidence are defined in `SDLC.md` § The design gate; the kit workflows are `design` (writes the mockup and opens the draft PR) and `design-review` (posts the verdict).

| Status | Set when | By whom |
| --- | --- | --- |
| **Draft** | The folder exists and its README has open decisions or no review yet. | The `design` workflow, or the author. |
| **In review** | The `design-review` run or a human reviewer posts the `## Design review` comment on the PR. | Whoever posts the comment. |
| **Approved** | The README's own `## Design review` section links that comment and every finding has a disposition: fixed, filed as a `design-debt` issue, or accepted with a reason. No finding may be left blank. | The PR that fills the section. |
| **Implemented (PR #n)** | The PR that ships the surface is merged; the row names it. Post-merge housekeeping, not a gate. | The implementing PR, or the next PR that touches this file. |
| **Archived** | A Draft or In review design untouched for 90 days. The row stays and the folder stays; the README's Status line says Archived and why. | Release prep, or whoever notices. |

Two reversals: an Approved design with no implementing PR within two releases reverts to Draft, because the cockpit moved on and the review no longer describes it; an Archived design that is picked up again re-enters at Draft.

The row below and the design README's own Status line must agree; the PR that changes one changes both. Every design README ends with a `## Design review` section that reads "Pending" until the review lands (`docs/design-system/new-designs.md` §8).

| Design | Status |
|---|---|
| [quality-checks](quality-checks/README.md) | In review – first `design-review` verdict FAIL (README §18); waiting for owner decisions and the fixes |
| [decisions](decisions/README.md) | Draft, revision 2 – the owner-only decision gate ("Decisions" menu item, case cards, MCP blocking, scope check); the five-reviewer verdict and the owner interview applied; waiting for the first `design-review` |
| [cli-terminal](cli-terminal/README.md) | Draft – terminal output (live activity, settings, ports) and one cockpit per project, for #467; text mockups plus the “Other projects” switcher; waiting for the first `design-review` |
| [issue-filing](issue-filing/README.md) | Draft – the “New issue” affordance in the GitHub tab: a task draft with the `xezar-issue-create` skill, its states and the MCP parity path (PR 5 of qodeca/xezar#468); six owner questions in `issue-filing/open-questions.md`; waiting for the first `design-review` |
| [onboarding](onboarding/README.md) | Approved – the first-setup entry, the post-update Re-check / Later offer and the setup status surface (P2 of qodeca/xezar#464). Design review PASS WITH FOLLOW-UPS on #489 (`design-approved`), and a second PASS WITH FOLLOW-UPS on the implementing PR #497; NB-1…NB-7 and the #497 findings each carry a disposition in `onboarding/README.md` § 20, and the implementation lands in the P2 PR |
| [single-project-mode](single-project-mode/README.md) | Approved – the cockpit surface of single-project mode (the mode badge, Settings naming its file, the unavailable account, the three removals and the refused registry page) for PR4 of qodeca/xezar#600. Design review PASS WITH FOLLOW-UPS on PR #604 (`design-approved`); NB-1 through NB-5 each carry a disposition in `single-project-mode/README.md` § Design review. Six open decisions in `single-project-mode/README.md` §15 and the owner's unconfirmed answers in §16 remain open |
| [design-system-air](design-system-air/README.md) | Implemented (PRs #429, #432, #431, #437, #438, #441) – rhythm tokens, looser between-block defaults and Roomy density; #424 closed; remaining allowlist conversion: #445; phone drawer target: #430 |
