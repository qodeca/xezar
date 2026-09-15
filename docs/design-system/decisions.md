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

The next five records carry the decisions of the "air" design (`designs/design-system-air/`, issue #424) that bind the whole system. That folder numbers its own decisions; they are cited here as **Air D-n** so they are not read as ids of this file (step-0 design review, finding NB-7).

### D-02 Six-step rhythm scale for the space between blocks

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted – tokens and the Settings pilot shipped in step 1 of #424 |
| **Context** | The cockpit had one spacing lever, `--spacing`, and no names for the distance between blocks: every gap was a bare number chosen per file (`known-gaps.md` G-25, deleted in step 2). A reviewer had no rule to cite. |
| **Decision** | Six named steps on the density unit: `--spacing-row` 2, `--spacing-stack` 3, `--spacing-list` 4, `--spacing-inset` 5, `--spacing-group` 6 and `--spacing-section` 8 units (8 / 12 / 16 / 20 / 24 / 32 px at Comfortable), declared as `calc(var(--spacing) * n)` in `@theme static`. Between blocks, a rhythm token; inside a control, the numeric scale. Names avoid `inline` / `block` (they would mint `.inset-inline` / `.inset-block`) and `card` (a colour token). Settings stay one flat list: `section` between fields, `stack` inside one (Air D-6). |
| **Consequences** | `foundations.md` §4.1 documents the scale; `lib/utils.ts` teaches tailwind-merge the six names. A seventh step needs a new record here. Step 2 of #424 moved the rest of the cockpit onto the scale and deleted G-25. |
| **Source** | `designs/design-system-air/README.md` § 9.1 and § 13 (Air D-6, Air D-9, the scale); issue #424 step 1. |

### D-03 Page gutters are `section` on both axes

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); 2026-09-15 (step-0 design review) |
| **Status** | Accepted – applied in step 2 of #424 |
| **Context** | Page bodies use `p-3 … md:p-5` (12 / 20 px), and the page body starts at the gutter. The air design dropped a separate `page` step: a gutter is the same distance as a section break. The step-0 review ruled on the two open exceptions: the task-table wrapper and the page header. |
| **Decision** | From `md:` up, the page gutter is `section` (32 px) on both axes, and the page body starts `section` under the header. The task-table wrapper keeps `px-section` – no exemption (Air D-11, option A) – and the page header takes `md:px-section`, so the title lines up with the content. On phone the gutter is `p-4`. |
| **Consequences** | Step 2 changed `patterns.md` §3 and every page body and header. A page that wants a different gutter needs a new record. |
| **Source** | `designs/design-system-air/README.md` § 9.1, § 11 and § 13; the step-0 `## Design review` on PR #429 (open point 6 → Air D-11, finding NB-1). |

### D-04 One density lever scales rhythm and control size together

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted – in force from step 1 of #424 |
| **Context** | A second knob for "air" was possible, and the tighter densities could have pinned today's gaps. The owner's rule: "the layout should always look the same" (Air D-3), with one lever (Air D-7). |
| **Decision** | `data-density` changes only `--spacing`. The rhythm tokens are built on it, so every density scales the rhythm and the control sizes as one piece. Compact and Compact for real scale the new rhythm; no density reproduces the old look. Hand-set pixels are outside the lever and go (D-06). |
| **Consequences** | The tokens are `calc(var(--spacing) * n)`, never fixed px. Half-pixel values at compact and ultra are accepted (`foundations.md` §4.1). The release note of the step that loosens the default says plainly that no density reproduces the old look. A proposed Roomy density (5 px per unit) uses the same lever; it ships with step 4 of #424. |
| **Source** | `designs/design-system-air/README.md` § 7 and § 13 (Air D-3, Air D-7); the step-0 design review, which measured ×1.25 / ×0.75 on the thread and the settings list. |

### D-05 The looser rhythm ships as the default, with no flag

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted – in force from step 1 of #424 |
| **Context** | A visible spacing change could hide behind a setting or an `XEZ_*` flag. AGENTS.md § Zero config: never trade a working default for a knob. |
| **Decision** | The rhythm is the shipped default at every density (Air D-1, Air D-8). There is no flag, no environment variable and no toggle. The only choice a user gets is the density setting. |
| **Consequences** | Every step of #424 changes the default path directly and carries `needs-design` + `needs-qa`. `.env.example` does not change. |
| **Source** | `designs/design-system-air/README.md` § 13 (Air D-1, Air D-8). |

### D-06 A hand-typed spacing pixel fails `npm test`

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted, applied in step 3a of #424 |
| **Context** | 88 hand-set spacing pixels (47 spellings, 32 files on 2026-09-14) sit outside the density lever, which is why the tight densities look uneven. A prose rule would be argued in every review. |
| **Decision** | A design-guardian rule, `no-arbitrary-spacing`, fails `npm test` – the validation gate, not the build – for a new arbitrary pixel on padding, margin, gap, space, height, min-height or size (Air D-5). An allowlist keyed on file and spelling holds today's occurrences and only shrinks; after step 3b its only rows are the two 24 px chip floors (WCAG 2.2 SC 2.5.8). |
| **Consequences** | Until step 3a merges, `foundations.md` §4 asks for scale units in prose. After it, a UI change that needs a hand-typed spacing pixel converts it to the scale instead of adding a row. |
| **Source** | `designs/design-system-air/README.md` § 9.3 and § 13 (Air D-5); the step-0 design review, finding NB-7. |

### D-07 The New-task button stays taller than the nav rows

| | |
| --- | --- |
| **Date** | 2026-09-15 (step-0 design review) |
| **Status** | Accepted, applied in step 3b of #424 |
| **Context** | Step 3b moves the sidebar nav rows from `md:h-[34px]` onto the scale at `md:h-9` (36 px). The New-task button is 36 px today; left alone it would match the rows and only its fill would set it apart. |
| **Decision** | The New-task button is `h-10` (40 px), one step taller than the nav rows (Air D-12, option A). |
| **Consequences** | One more recorded control-size change (+4 px). The phone drawer button stays under the 44 px touch target; that is older than this design and is tracked separately (review finding NB-4). |
| **Source** | The step-0 `## Design review` on PR #429 (open point 7 → Air D-12). |
