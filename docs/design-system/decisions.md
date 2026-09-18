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

The next six records (D-02 to D-07; counts read on 2026-09-16) carry the decisions of the "air" design (`designs/design-system-air/`, issue #424) that bind the whole system. That folder numbers its own decisions; they are cited here as **Air D-n** so they are not read as ids of this file (step-0 design review, finding NB-7).

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
| **Status** | Accepted – applied in step 2 of #424 to the list pages; the Git, GitHub, Compare and Automations pages and the task Git tabs followed in design Batches 6 and 7 of #453 (#574, #585) after #424 was reopened on 2026-09-17 |
| **Context** | Page bodies use `p-3 … md:p-5` (12 / 20 px), and the page body starts at the gutter. The air design dropped a separate `page` step: a gutter is the same distance as a section break. The step-0 review ruled on the two open exceptions: the task-table wrapper and the page header. |
| **Decision** | From `md:` up, the page gutter is `section` (32 px) on both axes, and the page body starts `section` under the header. The task-table wrapper keeps `px-section` – no exemption (Air D-11, option A) – and the page header takes `md:px-section`, so the title lines up with the content. On phone the gutter is `p-4`. |
| **Consequences** | Step 2 (#437) changed `patterns.md` §3 and the list-page bodies and headers (Tasks, All tasks, Inbox, Skills, Workflows, Settings) and the task thread. It left eleven route files on `md:px-6` or `sm:p-6`; the owner reopened #424 for them on 2026-09-17 (#447 OD-1), and Batches 6 and 7 moved every one to the `section` gutter (read on 2026-09-18): `repo-git/repo-git.tsx:69`, `repo-branches.tsx:80`, `repo-changes.tsx:53,84`, `repo-commits.tsx:69`, `task-git/git-toolbar.tsx:56`, `task-changes.tsx:195`, `task-commits.tsx:96`, `task-files.tsx:66`, `compare-variants.tsx:155`, `automations/automations.tsx:244`, `skills-loading.tsx:9,13`, and the GitHub header `github/github.tsx:514`. **Follow-through, not yet done:** the loading line of twelve Settings sections still pads itself `p-4 … md:p-6` inside the page body (for example `routes/settings/agents-section.tsx:71`, `project-setup-section.tsx:34`; one per `*-section.tsx` that has a loading state) – a hand-picked 24 px where the rhythm would give `md:p-group`. No issue owns it yet. A page that wants a different gutter needs a new record. |
| **Source** | `designs/design-system-air/README.md` § 9.1, § 11 and § 13; the step-0 `## Design review` on PR #429 (open point 6 → Air D-11, finding NB-1). |

### D-04 One density lever scales rhythm and control size together

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted – in force from step 1 of #424 |
| **Context** | A second knob for "air" was possible, and the tighter densities could have pinned today's gaps. The owner's rule: "the layout should always look the same" (Air D-3), with one lever (Air D-7). |
| **Decision** | `data-density` changes only `--spacing`. The rhythm tokens are built on it, so every density scales the rhythm and the control sizes as one piece. Compact and Compact for real scale the new rhythm; no density reproduces the old look. Hand-set pixels are outside the lever and go (D-06). |
| **Consequences** | The tokens are `calc(var(--spacing) * n)`, never fixed px. Half-pixel values at compact and ultra are accepted (`foundations.md` §4.1). The release note of the step that loosens the default says plainly that no density reproduces the old look. The Roomy density (5 px per unit) uses the same lever; it shipped with step 4 of #424. |
| **Source** | `designs/design-system-air/README.md` § 7 and § 13 (Air D-3, Air D-7); the step-0 design review, which measured ×1.25 / ×0.75 on the thread and the settings list. |

### D-05 The looser rhythm ships as the default, with no flag

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted – in force from step 1 of #424 |
| **Context** | A visible spacing change could hide behind a setting or an `XEZ_*` flag. AGENTS.md § Zero config: never trade a working default for a knob. |
| **Decision** | The rhythm is the shipped default at every density (Air D-1, Air D-8). There is no flag, no environment variable and no toggle. The only choice a user gets is the density setting. |
| **Consequences** | Every UI step of #424 (1, 2, 3b, 4) changed the default path directly and passed the design and QA gates (`design-approved` + `qa-approved` on #432, #437, #438, #441); step 3a (#431) changed only the test gate and carried `skip-design` + `skip-qa`. `.env.example` does not change. |
| **Source** | `designs/design-system-air/README.md` § 13 (Air D-1, Air D-8). |

### D-06 A hand-typed spacing pixel fails `npm test`

| | |
| --- | --- |
| **Date** | 2026-09-14 (owner); recorded 2026-09-15 |
| **Status** | Accepted, applied in step 3a of #424 (#431); the allowlist reached its target on 2026-09-18 (#445 closed as met) |
| **Context** | 88 hand-set spacing pixels (47 spellings, 32 files on 2026-09-14) sit outside the density lever, which is why the tight densities look uneven. A prose rule would be argued in every review. |
| **Decision** | A design-guardian rule, `no-arbitrary-spacing` (`packages/web/src/design-guardian.test.ts:238`), fails `npm test` – the validation gate, not the build – for a new arbitrary pixel on padding, margin, gap, space, height, min-height or size (Air D-5). An allowlist keyed on file and spelling holds the occurrences that stay and only shrinks; its ceiling is its row count, 2 (`design-guardian.test.ts:143`). The two rows are the `min-h-[24px]` floors on the composer picker pill (`components/picker-pill.tsx:28`) and the reference chip (`components/reference-chip.tsx:161`): each is an absolute 24 px minimum height that the density lever cannot shrink, so the control never drops under the WCAG 2.2 SC 2.5.8 target size at Compact or Compact for real. |
| **Consequences** | A UI change that needs a hand-typed spacing pixel converts it to the scale instead of adding a row. History: #431 seeded 70 rows, #441 left 62, and the design-debt batches of #453 converted the rest; the owner closed #445 as met at the two justified rows on 2026-09-18 ("Yes, 2 justified rows is done"). A third row needs a new record here. |
| **Source** | `designs/design-system-air/README.md` § 9.3 and § 13 (Air D-5); the step-0 design review, finding NB-7. |

### D-07 The New-task button stays taller than the nav rows

| | |
| --- | --- |
| **Date** | 2026-09-15 (step-0 design review) |
| **Status** | Accepted, applied in step 3b of #424 |
| **Context** | Step 3b moves the sidebar nav rows from `md:h-[34px]` onto the scale at `md:h-9` (36 px). The New-task button is 36 px today; left alone it would match the rows and only its fill would set it apart. |
| **Decision** | The New-task button is `h-10` (40 px), one step taller than the nav rows (Air D-12, option A). |
| **Consequences** | One more recorded control-size change (+4 px). The Add project icon button beside it follows to `md:size-10`, so the two stay one height on desktop (40 / 50 / 35 / 30 px at Comfortable / Roomy / Compact / Compact for real; step 3b design review B-1). The phone drawer button stays under the 44 px touch target; that is older than this design and is tracked separately (review finding NB-4). |
| **Source** | The step-0 `## Design review` on PR #429 (open point 7 → Air D-12). |

### D-08 A red "D" badge marks the development build on the brand tile

| | |
| --- | --- |
| **Date** | 2026-09-15 (owner and leader, issue #442) |
| **Status** | Accepted by the owner and leader; the design review on the implementing PR confirms or reopens it |
| **Context** | A cockpit started from a source checkout and the released `xez` from npm looked the same, down to the version chip, because a checkout carries the released version number. #439 showed the confusion costs time. The server now reports `channel` (`dev` or `release`) on `GET /api/v1/health`, and the cockpit needs one quiet mark for `dev`. The logo renders in one place, `BrandTile` in `app-shell.tsx` (sidebar and mobile drawer). Red usually means broken in this system (`foundations.md` §1.4), a red fill on a chip needs a decision (`new-designs.md` §3), `text-black` is banned, and white on `--danger` is 3.8:1 (G-23). |
| **Decision** | On `channel === 'dev'` only, a round badge sits on the brand tile's top-right corner: `absolute -top-[15%] -right-[15%] grid size-[54%] place-items-center rounded-full bg-danger text-[9px] leading-none font-semibold text-danger-ink ring-2 ring-sidebar`, with a visible "D" (`aria-hidden`), `sr-only` text "Development build" and `title="Development build"`. **The fill is red because the owner asked for red**, knowing that red otherwise means broken: this is a documented exception for build identity, not a new status colour, and it does not decide D-01. The letter is `text-danger-ink`, a token added for this badge: `#0d0d0d` in both themes and under every accent, about 5.1:1 on `#ef4444` (computed from the hex values), never raw black. The first version used `text-primary-foreground`, which the violet accent repoints to white (3.8:1); the design review on the PR caught it (B-1). The badge is `size-[54%]` with `-top-[15%] -right-[15%]` offsets of the fixed 26 px tile (about 14 px and 4 px), so it keeps one size in every density instead of following the spacing lever (design review NB-1); no hand-typed spacing pixel and no new allowlist row. The review also raised that a lone "D" has no visible words for touch and keyboard users (NB-2) and that red can read as broken at first sight (NB-3); the owner considered both and keeps the lone red "D". The tile keeps `size-[26px]`, the badge overlays it, and the logo `<img>` keeps `alt=""`. `release`, `null` or an absent field (an older server) render the bare `<img>` exactly as before: no wrapper and no placeholder. |
| **Consequences** | The favicon, the phone top bar (it has no logo) and the MCP `health` tool stay unchanged (#439 follow-up). A second build-identity mark, or red for any other non-error marker, needs its own record. `cockpit.css` carries `.logo-wrap` and `.dev-badge` for mockups. A later resize of the badge or letter, or a change of fill or letter colour, supersedes this record. |
| **Source** | Issue #442 (owner request and business analysis comment); the implementing PR. |

### D-09 Compare's pick confirm keeps the ordinary `contrast` action

| | |
| --- | --- |
| **Date** | 2026-09-17 (the `## Design review` on PR #585, finding NB-4) |
| **Status** | Accepted – applied at #453 batch B7; retires G-43 |
| **Context** | "Pick variant A" (`routes/compare-variants.tsx`) cancels every other variant, archives it and removes its worktree and branch with no undo, while `AlertDialogAction` keeps its default `contrast` look. G-10's rule tints every irreversible confirm, and the Workflows and plan-review overwrites follow it since B7, so the one dialog that does not needed a verdict rather than a silent restyle. Rendered at the reviewed head: title "Pick variant A?", description "Variant A is kept with its changes. The other variant is cancelled if still open, archived, and their worktrees and branches removed. There is no undo.", cancel "Keep comparing", action on `contrast` (`rgb(235, 235, 235)`). |
| **Decision** | Keep the ordinary `contrast` action. In the reviewer's words: "The button is the affirmative choice the page exists to make — the loss is a consequence of keeping something, not the act itself — and the consequence is already carried by words, which is what README rule 10 asks for; the cancel already names the specific kept outcome. Tinting the one button a reader comes to this page to press would spend the danger colour on the happy path and weaken it where it means deletion." |
| **Consequences** | G-43 is retired rather than fixed, and `patterns.md` §7's danger-confirm rule reads with this exception: an irreversible confirm whose affirmative action is the page's own purpose may stay on `contrast` when its words carry the loss and its cancel names the kept outcome. The dialog keeps "There is no undo." and "Keep comparing", and it returns keyboard focus to its opener (this round's NB-3). A later change of the action's colour, its wording or its cancel supersedes this record. The owner may still prefer strict G-10 consistency; that would be a new record, not a reading of this one. |
| **Source** | The `## Design review` comment on PR #585 (#453 batch B7), finding NB-4. |

### D-10 The canonical page header keeps two deliberate exceptions

| | |
| --- | --- |
| **Date** | 2026-09-17 (#453 batch B8's final reconciliation) |
| **Status** | Accepted – G-01 retired by it |
| **Context** | G-01 recorded five page-header shapes. B6 and B7 migrated all of them except two, and retiring the row would have deleted the record of why those two stay: the task thread's `run-header.tsx` is `text-[15px]`, sticky only from `md`, and hosts an editable title with a rename control, a tab row and a meta row; `/new` centres an `h1 text-lg` as a hero over a composer that is the whole page. `PageHeader` hides below `md` by default, which neither surface can accept. |
| **Decision** | Both stay as they are, and they are not header variants: the run header is a **run** surface (a title you edit, tabs you switch, a state you read) that happens to sit at the top of the page, and `/new`'s hero belongs to the composer. Every other page renders `PageHeader`, and GitHub takes the Git page's shape for the same reason — its tabs live in the header. |
| **Consequences** | `patterns.md` §3 lists these two, and only these two, as the variations that exist; G-01 is retired rather than left open, so a third shape is a new gap and a new id (G-47 or later), not a reopening. Two open rows still touch the run header without changing this decision: G-26 (it shows scrolled content through it) and G-37 (its tab labels overlap), both filed as **#595**. |
| **Source** | #453 § B8 ("B8 owns final `known-gaps.md` reconciliation"); the B6 and B7 statuses on G-01. |

### D-11 The remaining primitive divergences wait for the next shadcn refresh

| | |
| --- | --- |
| **Date** | 2026-09-17 (#453 batch B8's final reconciliation) |
| **Status** | Accepted – G-07 retired by it |
| **Context** | G-07 listed ten places where the shadcn primitives disagree with each other: Select's check indicator is on the right and DropdownMenu's on the left; Sheet is `bg-background` where Dialog is `bg-card`; Tooltip's `sideOffset` is 0 against 4 elsewhere; Sheet's close button uses `data-[state=open]:bg-secondary` and a hard `size-4` icon where Dialog's uses `bg-accent` and the automatic size; Sheet exports no `Portal`/`Overlay`; the variant APIs are cva (`badge`, `button`, `tabs`), inline unions (`select`, `switch`, `dropdown-menu`) or booleans (`sheet`); Textarea's disabled state lacks Input's `pointer-events-none`; and `aria-invalid` styling is on four primitives only. The row's own rule was already "leave as is; they are documented in components.md". One item on that list was NOT cosmetic and has been fixed: `PopoverTitle` was typed `h2` and rendered a `div`, so a popover had no heading in the document outline — it renders the `h2` now. |
| **Decision** | The nine remaining divergences stay until the primitives are next refreshed from upstream, and they are documented rather than reconciled. Each is a difference between two library components that no cockpit surface reads as a rule, none loses information or blocks a reader, and aligning them by hand now would mean hand-editing nine vendored files that the next `shadcn` update overwrites — trading a documented inconsistency for an undocumented merge conflict. |
| **Consequences** | G-07 is retired, so a NEW divergence is a new gap with a new id rather than an addition to a row that reads as accepted. `components.md` stays the record of what each primitive actually does, and `design-system-drift.test.ts` keeps it honest. A divergence that starts costing a reader something — an accessibility defect like the `PopoverTitle` one, not a `sideOffset` of 0 — is a gap immediately and does not wait for the refresh. The refresh itself should re-read this record and close each item deliberately. |
| **Source** | #453 § B8; G-07's own rule, and the `PopoverTitle` fix that separated the one real defect from the nine cosmetic ones. |

### D-12 The image lightbox is a real Dialog, not a portalled div

| | |
| --- | --- |
| **Date** | 2026-09-17 (#453 batch B8, A06) |
| **Status** | Accepted – shipped in B8 |
| **Context** | `ZoomableImage` was an `<img onClick>` over a hand-rolled `role="dialog"` portal with a window-level Escape listener (#453 A06). A keyboard reader could not open it at all — an `img` is not focusable — and once open there was no focus move, no trap, no focus return and no close control. The cockpit already has a primitive that does all four correctly, but its `DialogContent` is a centred card and the lightbox is a full-bleed scrim, so adopting it meant overriding the content's own look rather than using it as intended. #453 also reserves adding or deleting catalogued component files to batch B1, so restyling `dialog.tsx` itself was not open to B8. |
| **Decision** | Use `Dialog`, `DialogTrigger` and `DialogContent` from `components/ui/dialog.tsx`, and push the content full-bleed with a `className` — no change to the primitive. The thumbnail becomes a real `DialogTrigger` button, which is what makes Enter and Space work and what Radix hands focus back to. The alternative considered and rejected was `role="button" tabIndex={0}` with a hand-written `onKeyDown` on the `img`: it would have answered the keyboard half while leaving the focus trap and the focus return hand-rolled, which is the part that keeps being got wrong. |
| **Consequences** | The documented `bg-black/80` scrim is now spelled `bg-black/60` on the content, because the primitive's own overlay contributes `bg-black/50` beneath it and the two composite to the same 80 % — `components.md` states that arithmetic, and neither number may move alone. The `no-raw-black-white` guardian exemption for this file still stands, for the same reason it always did. The lightbox inherits the primitive's `motion-safe:`-gated enter animation and its 44 px-floored close button, so both follow the system instead of this file. A future full-bleed surface that wants the same treatment should read this record before copying the class list: the override is deliberate, and `sm:max-w-none` is part of it (tailwind-merge keeps a modifier'd class when the override carries none). |
| **Source** | #453 A06 and AC-8; the B8 pull request. |
