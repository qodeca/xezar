# Design decisions

A decision record is a choice made in a design review between options the design system allows, with the reason and what follows from it. It differs from a gap ([known-gaps.md](known-gaps.md)) in that nothing in the code is inconsistent: a gap closes by a code change, a decision closes only by a later decision that supersedes it. How the two relate is in [CONTRIBUTING.md](CONTRIBUTING.md) §5; a review that makes a decision records it here as the next `D-nn` and links it from its `## Design review` comment (README § Maintenance, item 7).

Format per entry: `### D-nn <title>`, then Date, Status, Context, Decision, Consequences, Source. A design folder's own open decisions are numbered separately in `designs/<feature>/README.md` § Open decisions; only records in this file carry the `D-nn` form, and a design decision that binds the system is recorded here and cited from the design's row.

### D-01 Colour of the nav badge for failed checks

| | |
| --- | --- |
| **Date** | 2026-09-13 |
| **Status** | Open – awaiting the owner |
| **Context** | `designs/quality-checks/README.md` § 14 Open decisions, D3, proposes a red (danger) badge for the sidebar count of failed checks, recommendation "Red", and names the design review as what it blocks. `new-designs.md` §3 says nav badges are violet, and that a badge in another colour is a decision the design review owns – naming this design as the one that proposes red and says so. |
| **Decision** | Pending. The options are the red (danger) badge the design recommends, or the existing violet "needs you" colour. |
| **Consequences** | Until decided, the mockup keeps the red badge and its README says so in Open decisions. The implementing PR must not ship either colour before this record closes. If violet wins, the design's D3 row and its `states.html` badge change; if red wins, `new-designs.md` §3 gains the exception and `patterns.md` §2 (sidebar navigation and badges) records the second badge colour. |
| **Source** | PR #384 review (the design-system docs), which surfaced the conflict between the design's D3 and `new-designs.md` §3. |
