# How the design system changes

The rest of this folder describes the cockpit as it is. This file describes how it moves: what earns a place in it, how a request is sorted, what a small change needs and what a large one needs, how a part is retired, and how the recorded gaps become work. The labels and the review evidence it names are defined in `SDLC.md` § The design gate; the two kit workflows are `design` (mockup plus draft PR) and `design-review` (a read-only verdict). Both run `.xezar/skills/xezar-ux-design.md`.

## 1. Criteria for a new token, component or pattern

Adapted from the GOV.UK Design System contribution criteria (https://design-system.service.gov.uk/community/contribution-criteria). A proposal answers all five, in the design README or in the PR description. An unanswered criterion is a reason to reject, not a formality.

| Criterion | The question | Where to check |
| --- | --- | --- |
| **Useful** | Is there evidence of the need in more than one place? One screen wanting it is a local rule in that screen. | The mockup's problem evidence, or two call sites in `packages/web/src`. |
| **Unique** | Does an existing token, component or pattern already do this? Check before proposing. | [components.md](components.md) and [patterns.md](patterns.md), then [foundations.md](foundations.md) for a token. |
| **Usable** | Does it show every state and work from the keyboard? | [new-designs.md](new-designs.md) §4 (states) and §7 (accessibility). |
| **Consistent** | Does it reuse the tokens and the grammar? No new colour outside [foundations.md](foundations.md); status lives in the dot; words carry the meaning. | [new-designs.md](new-designs.md) §3, README rules 1–4 and 10. |
| **Versatile** | Does it hold in both themes, under every appearance setting, and at 375 px? | [theming.md](theming.md), [new-designs.md](new-designs.md) §5–6, `specimens/mobile.html`. |

A part that passes all five gets its entry in `components.md` or `patterns.md`, its row in [coverage.md](coverage.md), and (for a token) its line in `foundations.md` and `cockpit.css`, in the same commit as the code. The drift test enforces the last two.

## 2. Triage buckets

Every design request is one of four things, after Brad Frost's design-system governance buckets (https://bradfrost.com/blog/post/design-system-governance-bugs-design-discrepancies-features-and-recipes/). Sort first; the bucket decides the labels and where the work lands.

| Bucket | What it is | Labels | Where it lands |
| --- | --- | --- | --- |
| **Bug** | A documented rule or component behaves wrongly: broken focus ring, a state that does not render, a token used where the docs say another. | `bug` + `design-debt` | Fixed on a PR. Design review on the diff. |
| **Visual discrepancy** | The code does one thing two ways, or a surface departs from the documented rule without a reason. | `design-debt` | Aligned to the rule on a PR, or recorded in [known-gaps.md](known-gaps.md) with paths, the chosen rule and why. Never fixed silently. |
| **Feature** | A new screen, surface, component or pattern. | `enhancement` + `needs-design` | The Design stage: a mockup in `designs/<feature>/` through the `design` workflow, reviewed by `design-review`, Approved before code. |
| **Recipe** | A composition of existing parts that solves a recurring job with nothing new. | `documentation` | A section in [patterns.md](patterns.md), with the components it composes named and a specimen if the look is not already shown. |

When a request straddles two buckets, split it: the discrepancy is fixed on its own PR and the feature waits for its design.

## 3. Fix by PR, bigger by design

After Atlassian's contribution model (https://atlassian.design/contribution): small changes go straight to a pull request, larger ones start with a design.

| Size | Definition | Needs before merge |
| --- | --- | --- |
| **Fix-sized** | A bug, a visual discrepancy, or a documented `G-nn` rule applied to the files it names. | A design review on the PR diff: a `## Design review` comment with a verdict of PASS or PASS WITH FOLLOW-UPS, and the `design-approved` label. |
| **Feature-sized** | A new screen, surface, component or pattern. | An Approved design first (`designs/<feature>/README.md` with its `## Design review` section filled and the row in `designs/README.md` at Approved), then the implementing PR carries `needs-design` and gets its own review on the diff. |

"UI in scope" is decided by the diff, not by the title: a non-test `.tsx` under `packages/web/src/routes/` or `packages/web/src/components/`, `packages/web/src/styles/index.css`, `docs/design-system/cockpit.css`, or anything under `designs/`. A PR that touches none of those needs no design review and may carry `skip-design`.

## 4. Deprecation

After Primer's component lifecycle (https://primer.github.io/contribute/component-lifecycle/). A part is retired in two steps, never one.

1. **Deprecate.** Its row in [coverage.md](coverage.md) takes the status `Deprecated since <version>, removed after <version>: use <replacement>`. The replacement is named, always; a deprecation with no replacement is a gap, not a deprecation. The entry in `components.md` or `patterns.md` gets the same line at the top. New call sites are refused in review.
2. **Remove.** At least one release after the deprecating one, the file is deleted and the row goes with it. Until then the row stays, so the drift test still sees the file it names.

A token is deprecated the same way, with its `foundations.md` row and its `cockpit.css` line kept until removal.

## 5. Decisions vs gaps

Two files record two different things:

- [known-gaps.md](known-gaps.md) records inconsistencies the code has today: two ways to do one thing, a comment that disagrees with the code, a mockup rule that departs from the cockpit. A gap closes by a code change, and its entry is deleted in that change (README § Maintenance, item 5).
- [decisions.md](decisions.md) records choices made in a review: which of two grammars a badge uses, whether a departure from a pattern stands. A decision closes by being superseded by a later `D-nn`; it is never deleted.

If a review finds the code inconsistent, that is a gap. If a review chooses between two consistent options, that is a decision. A decision that requires code to change also opens a gap or a `design-debt` issue; the decision record links it.

## 6. The debt loop

A `G-nn` entry is a record until one of three triggers turns it into a `design-debt` issue:

- a PR touches the files the entry names (the author applies the rule or files the issue, and says which in the PR);
- two design reviews cite the same entry;
- release prep reaches it.

Release prep triages the whole list once per release. Each entry ends in one of three states: **fixed** (entry deleted, `(G-nn)` references removed), **filed** (a `design-debt` issue linked from the entry), or **kept** with a date and one line on why it waits. An entry with no date and no issue after a release is a triage miss, and the next release prep starts there.
