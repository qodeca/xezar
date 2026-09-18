# Air – a design-system enhancement

| | |
|---|---|
| **Status** | Implemented (PRs #429, #432, #431, #437, #438, #441). #424 closed on 2026-09-15 and was reopened on 2026-09-17 (#447 OD-1) for the Git, GitHub, Compare and Automations pages and the task Git tabs, which design Batches 6 and 7 of #453 moved onto the `section` gutter (#574, #585). The allowlist target was met at two rows, the WCAG floors: #445 closed as met on 2026-09-18. D-1..D-12 closed; the step-0 verdict was PASS WITH FOLLOW-UPS ([comment](https://github.com/qodeca/xezar/pull/429#issuecomment-5678658435), § 16). Revision 3 applied the four-reviewer verdict ([`review-2026-09-14.md`](review-2026-09-14.md)). The mockup preserves the pre-#424 Today view beside the proposal. |
| **Date** | 2026-09-15 |
| **Mockup** | Open [`index.html`](index.html): a hub linking five 1:1 screen pages (flip Today \| Proposed in place), a stacked compare page, and three review aids (375 px pairs, states, appearance axes). No build, no server. |
| **Replaces** | Nothing. This design changes the system's spacing rules, not a feature surface. |
| **Comes from** | The owner, 2026-09-14: "the entire design system requires more air – more space between elements on the pages." |
| **Facts** | The proposal and its source line numbers are historical evidence from 2026-09-14, not a current-code inventory. Rollout outcomes below distinguish shipped work from targets. Allowlist counts read on 2026-09-16: 70 rows / 86 occurrences at #431 (`673c6ed`), 62 rows / 76 occurrences at this sweep; the remaining conversion was #445, closed as met on 2026-09-18 at 2 rows (the two `min-h-[24px]` WCAG floors). Inferred statements are marked *inferred*. |

## 1. Summary

The cockpit is tight everywhere, and the design system has no word for "looser". Its one spacing lever – the density setting – can only make things tighter than shipped (`comfortable` → `compact` → `ultra`). The shipped look is the top of the range, and it packs blocks together: 10 px between thread rows, 8 px inside a settings field, 16 px inside a card, 10 px between cards, 20 px page gutters.

This design adds air in four moves, delivered as five PRs after a mockup step (issue #424: steps 0 → 1 → 2 → 3a → 3b → 4):

1. **A rhythm scale.** Six semantic spacing tokens – `--spacing-row` 8, `-stack` 12, `-list` 16, `-inset` 20, `-group` 24, `-section` 32 – that name the space *between* things, built on Tailwind's `--spacing` so the density lever reaches them. Today every gap is a bare number (`gap-2.5`, `pb-2.5`, `p-4`) chosen per file.
2. **Looser defaults for the rhythm; controls keep their size.** Between blocks: thread rows 10 → 8 inside a turn and 24 at a speaker change; settings fields 8 → 12 inside and 28 → 32 between; card padding 16 → 20; cards 10 → 16 apart; page gutters 20 → 32; the page body starts 32 px under the header. Buttons, inputs, chips, nav rows and table rows keep their heights at the default density.
3. **Every hand-set pixel back on the scale.** 88 hand-set pixel occurrences (47 distinct spellings, 32 files) match the guardian rule's own pattern (§ 9.3) and sit outside the density lever today. They move to scale units or rhythm tokens, and a guardian rule that fails `npm test` – the validation gate – stops new ones.
4. **A "Roomy" density**, 5 px per unit (+25 %, the mirror of "Compact for real"), so the lever runs both ways. The shipped default stays Comfortable, which after move 2 is already roomier than today. Every density scales the whole page as one piece (D-3, D-7): the layout always looks the same, only larger or smaller.

Size: a mockup step (step 0, D-4) plus five PRs – 1, 2, 3a, 3b, 4 – under issue #424. About three days of work plus two review rounds. One contract change (the density enum moves into the contract and the server imports it), one BC note, no run-record change, no `XEZ_*` variable.

### What "air" means here

Air is the space **between** things, not the space **inside** a control. A 30 px button is the right height; two 30 px buttons 4 px apart are cramped. This design changes the *defaults* for the two separately – rhythm grows, control size does not – while both keep riding the one density lever, so a density change scales them together (D-7).

| | What it is | Today | Proposed |
|---|---|---|---|
| **Control size** | height and inner padding of a button, input, chip, nav row, table row | `h-9`, `h-[30px]`, `px-3.5`, `h-11` rows | unchanged at the default density (four hand-set values move 2–4 px onto the scale, § 9.3) |
| **Rhythm** | gap between rows, cards, fields, sections; page gutters; space under a header | bare numbers per file, mostly 8–16 px | six named tokens, 8–32 px |

## 2. Problem evidence

### 2.1 The lever only tightens

- `Density = 'comfortable' | 'compact' | 'ultra'`, default `comfortable` (`lib/appearance.ts:26, 34`).
- `comfortable` = no attribute = Tailwind's default `--spacing: 0.25rem`; `compact` = `0.21875rem`; `ultra` = `0.1875rem` (`index.css:253-261`, `foundations.md:180-184`). `--spacing` is never declared at the default (`index.css:248-252`); `cockpit.css` reads it as `var(--spacing, 0.25rem)` for that reason (`:481-483`).
- There is no `--space*`, `--gap*` or `--rhythm*` token anywhere.
- The Settings hint reads "Compact tightens spacing across the cockpit" (`routes/settings/appearance.tsx:133`). There is no way to loosen.

### 2.2 The shipped rhythm, surface by surface

| Surface | Between-block spacing today | Source |
|---|---|---|
| Thread (task page) | one row per block, every row `pb-2.5` = **10 px** – a speaker change and a tool→tool step are spaced the same; column `gap-2.5 md:gap-3.5`, `px-3 py-3 md:px-6 md:py-5` | `thread-scroller.tsx:410, 492`; `session-transcript.tsx:156-170`; `task-thread.tsx:307` |
| Tool rows in the thread | `min-h-[28px] py-0.5`; nested `my-2` | `thread-items.tsx:547, 600` |
| Settings field | `section … gap-2` = **8 px** between title, control and hint; no group level | `settings-field.tsx:20-27` |
| Settings fields, between | `gap-7` = **28 px** in every section – a flat list | `appearance.tsx:120`, `resources-section.tsx:239`, `agents-section.tsx:163`, `notifications-section.tsx:88`, `worktrees-section.tsx:90`, `mcp-connection-section.tsx:394`, `prompt-templates-section.tsx:126`, `project-general.tsx:83` |
| Card (inbox, hub, task card) | `p-4` = **16 px** inside; list `gap-2.5` = **10 px** between cards; card head `gap-3`, meta `mt-1.5` | `inbox.tsx:128, 227, 229, 242`; `settings-shell.tsx:243` |
| Ask card | `px-4 pt-3.5 pb-3.5`; header `mb-2.5`; body `gap-4` | `ask-card.tsx:82-87` |
| Page body | `p-3 … md:p-5` = **12 / 20 px** gutters; the body starts at the gutter | `patterns.md:51`; `settings-shell.tsx:222`; `global-tasks.tsx:396` |
| Page header | `h-14` (56 px), border | `patterns.md:43` |
| Run header (task page) | `px-3 pt-2 md:px-6 md:pt-3`; title `mt-1.5 md:mt-2.5` | `run-header.tsx:160, 222` |
| Composer dock | `px-3 pt-1 pb-2 md:px-6 md:pt-1.5 md:pb-4` | `task-thread.tsx:409` |
| Task table | rows `h-11` (44 px), cells `px-2.5`, header `h-[38px]`; 13 px text; footer strip `mt-3.5 … px-3.5 py-2.5` | `tasks-overview.tsx:291, 419, 514`; `patterns.md:60` |
| Mobile task card | `px-3.5 py-3` | `tasks-overview.tsx:904` |
| Sidebar | nav rows `md:h-[34px]` `gap-2.5`, container `px-2.5 py-1.5`; quick-list rows `py-[7px]` (32 px); brand row `gap-[9px] px-3.5 pt-3.5 pb-2.5` | `app-shell.tsx:490, 555, 572`; `task-quick-list.tsx:248, 425` |
| Banner row | `min-h-9 … px-4` | `provider-banner.tsx:43, 87` |
| Review panel | `gap-3`; banner `px-3.5 py-2.5` | `review-panel.tsx:39, 42` |
| Centered state | `gap-4 px-6 py-12` – the one roomy surface | `centered-state.tsx:51, 56` |
| Dialog | `gap-4 … p-6` – fine | `components.md:74` |

Pattern: inside a control the system is consistent and fine. Between blocks it is 8–10 px almost everywhere, chosen file by file; the only surfaces with real air are the centered state, the dialog and the settings list.

### 2.3 Hand-set pixels outside the lever

`foundations.md:186-187`: "Any px value you write by hand (`h-[34px]`, `px-[7px]`) is outside the density lever; prefer scale units."

Counted in non-test `.ts/.tsx` under `packages/web/src` with the guardian rule's own pattern (§ 9.3 – left boundary, prefixes `p*|m*|gap*|space-*|h|min-h|size`, `px|rem|em`): **88 occurrences, 47 distinct spellings, 32 files**. Top files: `components/app-shell.tsx` 10, `components/project-groups.tsx` 7, `routes/task-thread/plan-dock.tsx` 6, `routes/task-thread/agents-dock.tsx` 6, `components/task-quick-list.tsx` 6, `routes/tasks-overview.tsx` 5, `routes/task-thread/thread-items.tsx` 5. Most frequent: `size-[15px]` ×12, `pl-[22px]` ×6, `p-[3px]` ×6, `gap-[7px]` ×5, `px-[5px]` ×4, `h-[3px]` ×3, `md:h-[34px]` ×3, `h-[26px]` ×3. The earlier 90 / 50 / 29 came from a wider pattern that also matched `w-`, `max-h-` and `top/left/right/bottom/inset-` and omitted `size-`.

The ones that decide a control's size:

| Spelling | Where |
|---|---|
| `md:h-[34px]` nav row | `app-shell.tsx:572` |
| `md:h-[30px]` nested nav row | `project-groups.tsx:325` |
| `h-[38px]` table header | `tasks-overview.tsx:419` |
| `h-[30px]`, `size-[30px]` button | `components/ui/button.tsx:24`; asserted verbatim in `button.test.tsx:38-41` |
| `px-[15px]` user bubble | `thread-items.tsx:121` |
| `min-h-[28px]` tool row, `h-[34px]` group trigger | `thread-items.tsx:547, 615` |
| `h-[26px]` picker pill, `h-[22px]` reference chip | `picker-pill.tsx:22`, `prompt-template-menu.tsx:67`, `prompt-templates-section.tsx:345`; `reference-chip.tsx:148`; `components.md:271, 360` |
| `p-[3px]` segmented, `py-[3px]` pill, `py-[7px]` quick-list row | `components.md:288, 263`; `task-quick-list.tsx:248` |

Each is a place the density lever cannot reach. At `ultra` the page tightens around them and they stay put, which is why `ultra` looks uneven rather than uniformly tight – the mockup's density select shows it in the today view.

### 2.4 Line heights and small text

Assistant text `text-[15px] leading-[1.65]`, user bubble `13.5px leading-[1.55]`, markdown `line-height: 1.6` – fine (`thread-items.tsx:121, 240`; `index.css:499`). Thirteen type sizes from 10 to 24 px (`foundations.md:150-164`). Not a spacing problem, but small text reads tighter when the rhythm is tight; `known-gaps.md` G-23 records the contrast side.

### 2.5 Not recorded as a gap

On 2026-09-14, `known-gaps.md` held 23 entries (G-01..G-23); none is about spacing, density, gutters or rhythm. G-24 was used once and deleted (`design-guardian.test.ts:60` still cites it), so the next free id was **G-25**. G-25 was recorded in step 1 and deleted in step 2. This is the original problem statement, not the current gap inventory.

## 3. Users and jobs

| User | Job | What they need |
|---|---|---|
| **Owner** | "Read a thread, a settings page, the inbox without feeling boxed in" | more space between blocks; the same number of tasks on the table |
| **A user who chose Compact** | "Keep my dense view" | the tighter densities stay and scale the new rhythm proportionally (D-3) |
| **A developer adding a surface** | "Which gap do I use here?" | a named token per distance; a test that refuses a hand-typed pixel |
| **A design reviewer** | "Is this spacing right?" | a rule to cite instead of a taste to argue |

## 4. Goals and non-goals

**Goals (principles)**

1. Air lives between blocks, not inside controls. Controls keep their size; rhythm grows.
2. One scale, named steps. Six tokens name the distances the cockpit uses; a file never invents a seventh.
3. The lever reaches everything. No spacing value is a raw pixel, so every density scales the whole page as one piece – the layout always looks the same (owner, D-3).
4. Change the default, keep the choice. The shipped look gets roomier; the density setting keeps the tighter looks and gains a roomier one.
5. Type does not move. Font sizes and line heights stay, so it is clear which change helped.

**Non-goals**

- Font sizes, weights, line heights; radius, shadows, colours. The two radius spellings (`rounded-[18px]` tile, `rounded-[6px]` segment) stay as they are – a separate, later cleanup.
- The reading measure (820 / 1180 px).
- Taller table rows (D-2: 44 px stays).
- A second spacing knob (D-7: one lever).
- Pinning today's compact/ultra gaps (D-3: they scale).
- The missing shared `PageHeader` component (`patterns.md:43` – inlined per route). PR 2 touches those lines and may extract it; optional.

## 5. Files

Twenty-three files, flat in this folder (the designs lint reads it non-recursively). Every page links `../../docs/design-system/cockpit.css` as its first stylesheet; the local sheets hold feature rules only, with the exceptions listed after the table.

| File | What it is |
|---|---|
| [`index.html`](index.html) | The hub: how to review, the page and URL tables, where 375 px is true, the review check → page and URL table, open points 6 and 7 as four links, the questions for the verdict, what is not drawn, the rhythm bars |
| [`tasks.html`](tasks.html) | Screen page – Tasks: the multi-project sidebar, New task and Add project, the 13-column table (14 rows) in its wrapper, the footer strip; at 375 px the mobile bar, the task cards, the New-task FAB and the phone drawer (`?drawer=open`); open points 6 and 7, with the table widths measured at 1280 × 900 (`#op6`) |
| [`thread.html`](thread.html) | Screen page – the task page: run header, about 20 thread rows over five speaker changes, a tool group with a nested group, the ask card, the review panel, the composer dock; `?state=loading` and `?state=dialog` ("Delete this task?") |
| [`changes.html`](changes.html) | Screen page – the Changes tab under the same run header: toolbar, file tree and diff; the diff is unchanged |
| [`settings.html`](settings.html) | Screen page – Settings → Agents (project nav, nine blocks), → Appearance and → Agent accounts (global nav), switched by `?section=`; `?state=error` draws the Agents over-limit line |
| [`inbox.html`](inbox.html) | Screen page – the Inbox: five cards; `?state=empty` and `?state=error` |
| [`compare.html`](compare.html) | Review aid – one screen page twice at 1:1, Today above and Proposed below, at the same anchor (`?page=`, `section`, `state`, `at`) |
| [`phone.html`](phone.html) | Review aid – eight screens as 375 × 780 pairs, Today beside Proposed, each with up to three changed values |
| [`states.html`](states.html) | Review aid – the six-state map and five 375 px pairs (empty, loading, field error, page error, refusal), each linked at 1280 in both views and in `compare.html`. The field error is the Agents over-limit line (`agents-section.tsx:277-279`), the shipped counterpart of `.field-error` (`cockpit.css:1126`, also 11 px `--danger`), which no source file uses |
| [`appearance.html`](appearance.html) | Review aid – the proposed view at four densities (the thread at 1:1, the Settings list at 375 px), dark and light with lime and violet, and both reading widths in a 1600 px window at 70.75 % – the only scaled frames |
| [`styles.css`](styles.css) | Cross-screen values: `--u`, the root size, Roomy, the six rhythm values (proposed view only), the cross-screen role variables of both views, the phone and open-point-7 overrides, `--air-bar-h` |
| [`chrome.css`](chrome.css) | Review chrome, not part of a drawn screen: the bar, the Show and open-point radios with their focus ring, figures and captions, `.phone-375`, `.air-pair`, the wide and scaled frames, the compare layout, the values table, the rhythm bars. Declares one custom property, `--air-head-h` (`:137`): the clearance rule that reads it runs on every page and this is the only sheet all ten load, so declaring it in `shell.css` would leave an unresolvable `var()` – and a dropped declaration – on the aid pages. The reason is in the sheet header (`:5-7`); `styles.css` keeps its pair, `--air-bar-h` |
| [`shell.css`](shell.css) | The app-shell replica the five screen pages share: sidebar, drawer, mobile bar, page head, opt-in control sizes (`.air-sm`, `.air-touch`, Global settings at 28 px), the two chip floors, the dialog overlay. Declares no custom property |
| [`tasks.css`](tasks.css) | Tasks: its value block, then the table, wrapper, footer strip and phone cards |
| [`thread.css`](thread.css) | The task page: its value block, then the run header, thread column, rows, bubble, tool rows and groups, ask card, review panel, dock, dialog overlay and loading state; the Changes tab's toolbar, tree and diff |
| [`settings.css`](settings.css) | Settings: its value block, then the nav, the pills, the `.air-field` list, the `.air-seg` density control and the refusal |
| [`inbox.css`](inbox.css) | Inbox: its value block, then the list, the card and where the two states sit |
| [`theme.js`](theme.js) | View state for every page: one frozen axis table read URL → browser storage → default and stamped on `<html>` before first paint; frames get `.framed` and read the URL only; same-folder links are rebuilt from their authored `href`; builds the compare frames |
| [`bar.js`](bar.js) | Renders the review bar from `theme.js`'s axis table with DOM calls only: the page nav, Show, the axis selects, Section and State, the open-point radios, the "Compare at 1280" link, the status and note lines; reports two measured heights – the bar's, and the in-page sticky head's, through one `ResizeObserver` over `.air-screen .page-head, .air-screen .air-run-head` writing `--air-head-measured`. Focus clearance is measured, never estimated: the thread's was 0 at 375 px and is 117 px |
| [`icons.js`](icons.js) | The lucide sprite every page shares: 72 symbols from one constant template; no page keeps a local sprite |
| [`review-2026-09-14.md`](review-2026-09-14.md) | The four-reviewer record with every finding's disposition (revision 3; historical) |
| [`handoff-values.md`](handoff-values.md) | The four value tables this handoff keeps out of line: § 5 (d) role variables, § 5 (j) mockup-only departures, § 9.2 new defaults, § 9.3 pixel conversions. Same section numbers as here – nothing is renumbered |
| [`README.md`](README.md) | This handoff |

**One sidebar, five copies.** The five screen pages carry the same sidebar block verbatim between `<!-- sidebar:start -->` and `<!-- sidebar:end -->`; only the current item differs – `aria-current="page"` on a nav link, and `class="on"` on the task's quick-list row in `thread.html` and `changes.html`. Strip those two and the five blocks must be identical:

```sh
cd designs/design-system-air && for f in tasks thread changes settings inbox; do sed -n '/sidebar:start/,/sidebar:end/p' "$f.html" | sed 's/ aria-current="page"//g; s/ class="on"//' > "${TMPDIR:-/tmp}/sb-$f"; done; for f in thread changes settings inbox; do diff "${TMPDIR:-/tmp}/sb-tasks" "${TMPDIR:-/tmp}/sb-$f"; done  # no output = parity
```

A `s/ on//` strip is not enough: the quick-list row spells it `<li class="on">`, so the class has to be removed with its attribute.

**Local exceptions.** A design's local sheet holds feature rules only and never redeclares a token or copies a base class (`designs/README.md`, `new-designs.md` § 2). Where a mockup needs a look the cockpit has and `cockpit.css` lacks, `new-designs.md:30-31` adds the class to `cockpit.css` – but step 0 could not touch `docs/design-system/` before its verdict. Steps 1–4 have since added the tokens and Roomy block there. What the mockup did instead:

- **(a) Roomy.** Shipped in step 4: `cockpit.css` now declares `:root[data-density='roomy'] { --spacing: 0.3125rem }`, so the duplicate local block in `styles.css` is removed.
- **(b) The unit and the root size.** `--u: var(--spacing, 0.25rem)` is one Tailwind spacing unit. Step 0 needed local 16 px root / 14 px body overrides because the shared sheet combined both selectors. Step 1 split them (`cockpit.css` now sets `html` to 16 px and `body` to 14 px), so `styles.css` no longer carries those overrides.
- **(c) Rhythm values.** The six rhythm values (`--row` 8 · `--stack` 12 · `--list` 16 · `--inset` 20 · `--group` 24 · `--section` 32) are declared for the proposed view only, and on `.ex.air` for the hub's bars, under short local names; PR 1 (#432) named them `--spacing-<name>` in `index.css` and `cockpit.css`. The mockup keeps its short local names so the historical Today view does not change.
- **(d) Role variables.** Each drawn value that differs between the views is a role variable, declared in exactly one sheet: `styles.css` for cross-screen values, the first block of each screen sheet for its own. Today is raw px where the source hand-sets a value, so the density lever misses it as it does in the app, and `calc(var(--u) * n)` – written `u × n` in the table – where the source uses the scale. Proposed is a rhythm value or `u × n`.

  These ~45 role variable names – `--u`, `--gutter`, `--turn-gap`, `--cta-h` and the rest – exist only in this folder and never ship: they are how a page with no build step holds both views' values at once. The shipping spelling is the § 9.2 utility (`mt-list`, `p-inset`, `md:px-section`).

  The table – name · sheet · today (source) · proposed, and the values written once as literals – is in [`handoff-values.md`](handoff-values.md) § 5 (d).
- **(e) Frames and view switches.** `.phone-375` on the shared `.phone` (390 px wide, `cockpit.css:461`) makes a 377 × 782 box: a 375 × 780 viewport inside the 1 px border, because `cockpit.css:196-199` is border-box. `.only-today` / `.only-air` show markup that exists in one view only, such as the density options and hint; `.air-phone-only` / `.air-desktop-only` do the same for the two widths. The aid pages' frames carry `loading="lazy"`, which Chrome honours over http – `phone.html` holds 8 of its 16 frames until you scroll – and ignores completely on `file://`, where all 16 load at once (measured). Nothing is lost either way, since everything loads on scroll; a reviewer who double-clicks the page just pays for every frame up front. Not a bug.
- **(f) URL keys.** Every axis, state and section is a URL key, read by `theme.js` through one allowlist; an unknown value falls back to the default. A frame reads the URL only and never writes storage. A change on the bar goes to storage first and then to the address bar; a page opened from disk may refuse the second, and the bar says so.

  | Key | Values | Default | On `<html>` | Kept in storage | Pages |
  |---|---|---|---|---|---|
  | `theme` | dark, light | dark | `.light` | `air-mock-theme` | all |
  | `accent` | lime, violet | lime | `data-accent` | `air-mock-accent` | all |
  | `density` | roomy, comfortable, compact, ultra | comfortable | `data-density` (absent at comfortable) | `air-mock-density` | all |
  | `width` | narrow, wide | narrow | `data-width="wide"` | `air-mock-width` | all |
  | `v` | today, air | air | `data-view` | `air-mock-view` | screen pages |
  | `table`, `cta` | a, b | a | `data-table`, `data-cta` | no | tasks |
  | `drawer` | open | none | `data-drawer` (takes effect at 768 px and below) | no | tasks |
  | `state` | thread: loading, dialog · inbox: empty, error · settings: error | none | `data-state` | no | thread, inbox, settings |
  | `section` | agents, appearance, accounts | agents | `data-section` | no | settings |
  | `page`, `at`, `section`, `state` | page: tasks, thread, changes, settings, inbox · at: speaker-2, ask-card, dock (thread) · section, state: the target page's lists | tasks / none | – | no | compare |
- **(g) Local replicas.** Surfaces `cockpit.css` has no class for are drawn with local `air-` classes: the thread column, user bubble, assistant text, tool row and group, ask card, run header (`.air-run-head`), Inbox card layout, composer dock, drawer and settings field list (`.air-field`). Where `cockpit.css` has a `.base el` rule, an `air-` container mirrors its selector shape (`.air-quick li`, `.air-table th`, `.air-dock .composer textarea`, `.air-diffs .diff header`), so a today value is not lost to specificity. They stayed local because step 0 could not touch `docs/design-system/`; they preserve the pre-#424 Today view.
- **(h) Shell breakpoint.** The replica switched to the phone shell at 860 px, `cockpit.css`'s breakpoint when this mockup was drawn, until this folder's own sheets moved to the same 767.98 px edge as `cockpit.css` (docs wave PR 5, 2026-09-18, following #447 OD-3), so the replica now agrees with the app's `md` at 768 px; the review widths, 1280 and 375, sit clear of it either way. Between 768 and 896 px at comfortable density, though, `tasks.html`'s desktop header scrolls sideways rather than reflowing – a pre-existing gap, not something the breakpoint move introduced. See [`known-gaps.md` G-48](../../docs/design-system/known-gaps.md#g-48-the-tasks-desktop-header-does-not-fit-between-768-and-896-px-at-comfortable-density) and [#625](https://github.com/qodeca/xezar/issues/625).
- **(i) Captions.** Figure captions use `--muted-foreground`, not `.frame-label`, whose `--soft-foreground` is about 2.5:1 in light (`cockpit.css:378`).
- **(j) Mockup-only departures.** Where a `cockpit.css` base class disagrees with the source, the mockup draws the source value in both views, through a local replica or a mirrored selector, and leaves `cockpit.css` as it is. `known-gaps.md` could not change in step 0. Step 2 (#437) updated the Mockup fidelity table for the classes it restyled; the remaining § 5 (j) rows are not recorded there (open).

  The table – class · `cockpit.css` · source · what the mockup draws – and the notes recorded while drawing are in [`handoff-values.md`](handoff-values.md) § 5 (j).

## 6. Screens

The step-0 mockup (D-4) draws the cockpit's own screens at 1:1, twice: **Today** before #424, every value read from `packages/web/src` on 2026-09-14 and cited file:line at that revision in each page's values table, and **Proposed** – the end state after PR 4. Scope: eight surfaces – Tasks (table, sidebar, New-task button), a thread, the composer dock, a dialog, the diff (the Changes tab), Settings → Agents, Settings → Appearance and the Inbox – at 1280 and 375 px, in six states (§ 7), both themes, the violet accent, four densities and the wide width.

| Page | Surface | How the views compare |
|---|---|---|
| `tasks.html` | Tasks: sidebar, New task, the 13-column table, the footer strip; at 375 px the task cards and the phone drawer | flip; open points 6 and 7 (§ 13) |
| `thread.html` | the task page: run header, thread, ask card, review panel, composer dock; the delete dialog and the loading state | flip |
| `changes.html` | the Changes tab: the same run header over the toolbar, file tree and diff | flip |
| `settings.html` | Settings → Agents, → Appearance (Roomy · Comfortable · Compact · Compact for real, copy per § 8) and → Agent accounts (the refusal) | flip |
| `inbox.html` | the Inbox card list; the empty and page-error states | flip |
| `compare.html` | any of the five pages, Today above and Proposed below, both 1:1 at the same anchor | both at once |
| `phone.html` | eight screens as 375 px pairs | side by side |
| `states.html` | the six-state map and five 375 px pairs | side by side |
| `appearance.html` | the proposed view at four densities, dark and light with both accents, both reading widths | per axis |

**Comparison model.** At 1280 a screen page flips Today \| Proposed in place – a radio on the review bar, no reload, so the scroll position holds and a 2–4 px change shows as movement – and `compare.html` stacks both views of one page at 1:1. At 375 the aid pages show the two views side by side in 375 × 780 frames. AC 1 is met by the flip plus the stacked compare page (1:1, both at once). Each screen page ends with a values table: where, today (file:line), proposed (token = px at Comfortable).

The retired pair 1 drew the settings gutter as 20 → 32; the source was 24 (`md:p-6`, `agents-section.tsx:163`). The step-0 review (NB-1) assigned it `p-list md:p-group` – the "Settings section containers" row of `handoff-values.md` § 9.2, shipped in step 2.

## 7. States

The density select on the mockup's bar sets `data-density` on `<html>`, the way `AppearanceProvider` does in the cockpit (`components.md:226-229`).

| Density | `--spacing` | Today view | Proposed view |
|---|---|---|---|
| Roomy (proposed) | `0.3125rem` (5 px) | scale units grow, hand-set pixels stay – uneven | +25 %, every value an integer (10 / 15 / 20 / 25 / 30 / 40) |
| Comfortable (default) | `0.25rem` (4 px) | the shipped look | 8 / 12 / 16 / 20 / 24 / 32 |
| Compact | `0.21875rem` (3.5 px) | uneven | 7 / 10.5 / 14 / 17.5 / 21 / 28 |
| Compact for real | `0.1875rem` (3 px) | uneven – nav rows, tool rows, table header and buttons stay put | 6 / 9 / 12 / 15 / 18 / 24 – still looser between blocks than today's default |

Compact and ultra give half-pixel values for some steps; that is already true of the numeric scale today and is recorded in foundations § 4.1, not hidden. Both themes render through `cockpit.css`; nothing in the sheet is theme-specific.

The six states of `new-designs.md` § 4 appear once each, on their natural surface, at 1280 and 375 px. `states.html` holds the 375 px pairs and links each state at 1280 in both views and in `compare.html`.

| State | Surface | Page and URL | Copy, as shipped |
|---|---|---|---|
| Default | every screen | each screen page | – |
| Empty | Inbox | `inbox.html?state=empty` | "Inbox empty" / "Agents drop follow-up suggestions here when they finish a task." (`inbox.tsx:119-125`) |
| Loading | task page | `thread.html?state=loading` | "Loading task…" / "Fetching the run and its session transcript." (`thread-loading.tsx:17-18`) |
| Error, field | Settings → Agents, System prompt | `settings.html?section=agents&state=error` | "20,412 characters — the limit is 20,000." beside a disabled Save (`agents-section.tsx:269-279`) – the over-limit line, the shipped counterpart of `.field-error` (§ 5) |
| Error, page | Inbox | `inbox.html?state=error` | "Could not load the inbox" and the server's message, danger tone (`inbox.tsx:104-110`) |
| Refusal | Settings → Agent accounts, hosted mode | `settings.html?section=accounts` | "Agent accounts are managed from the machine that owns the checkout — this cockpit runs in hosted mode." (`accounts-section.tsx:149-153`) |
| Phone | every screen | `phone.html`; any screen page in a 375 px window | – |

Every state, section and appearance axis is a URL key; the keys are in § 5 (f).

## 8. Copy deck

| Where | Text |
|---|---|
| Settings → Appearance, density options | Roomy · Comfortable · Compact · Compact for real |
| Settings → Appearance, density hint | Roomy adds space between things and the Compact options take it away — text stays the same size. |
| `foundations.md` § 4.1 title | Rhythm |
| `foundations.md` § 4.1 rule | Between blocks, a rhythm token. Inside a control, the numeric scale. Never a hand-typed pixel. |
| `known-gaps.md` G-25 title | No rhythm scale; between-block spacing is chosen per file |
| Design-system skill rule 17 | Between blocks, a rhythm token; no arbitrary spacing values. Owner `design-guardian.test.ts`. |
| Release note (0.16) | Spacing between blocks is looser at every density, and a new Roomy density is available. No density reproduces the old look: Compact and Compact for real scale the new spacing, so they are looser than they were. |

Rules applied: sentence case, no contractions; en dashes in this document and a spaced em dash in the shipped UI strings – the docs use en dashes, the UI uses em dashes (`docs/design-system/writing.md` § 1).

## 9. Developer notes

### 9.1 Rhythm tokens (PR 1 – foundations)

Two things go into `index.css` `@theme static` (`:280-293`). First, `--spacing` itself at its default, because it is currently declared only in the compact/ultra blocks and a `calc()` on an undeclared variable collapses (review B-5). Then the six tokens. Tailwind 4.3.2 (`packages/web/package.json:32`) reads any `--spacing-<name>` in `@theme` as a named spacing utility – verified by compiling with the installed package: `.p-inset { padding: var(--spacing-inset) }`, `.gap-list`, `.px-section` are minted, the utilities reference the variable, and the `calc(var(--spacing) …)` form survives, so the density override on `:root[data-density]` re-resolves it at use time.

```css
--spacing: 0.25rem;                              /* 4px per unit – declared, so the tokens below resolve everywhere */

/* Rhythm: the distance BETWEEN things. Built on --spacing so density scales them.
   Controls keep their own heights; these name the gaps around and between blocks. */
--spacing-row:     calc(var(--spacing) * 2);   /*  8px – rows of one thing: icon+label, a turn's own rows, chips in a line */
--spacing-stack:   calc(var(--spacing) * 3);   /* 12px – lines inside one block: title → control → hint; sidebar groups */
--spacing-list:    calc(var(--spacing) * 4);   /* 16px – blocks in a list: cards, thread groups */
--spacing-inset:   calc(var(--spacing) * 5);   /* 20px – inside a card (not `card`: that is the colour token) */
--spacing-group:   calc(var(--spacing) * 6);   /* 24px – a speaker change in the thread; the run header's top; dialogs already use p-6 */
--spacing-section: calc(var(--spacing) * 8);   /* 32px – sections and settings fields; desktop page gutters; under a page header */
```

Names avoid Tailwind's logical-property roots: `inline` and `block` would have minted bare `.inset-inline` / `.inset-block` utilities (fact-check, compiled). `card` is the colour token. `page` is gone: gutters are `section`, symmetric on both axes.

Two more pieces belong to PR 1:

- `lib/utils.ts:10-17` – `cn()` is `extendTailwindMerge` extended only for `shadow-modal`; `twMerge('p-4 p-inset')` keeps both. Extend `theme.spacing` with the six names and add a `cn()` test.
- `cockpit.css :root` – mirror `--spacing: 0.25rem` and the six tokens with byte-identical value strings (drift check 3), and `foundations.md` gains a `` `--spacing-<name>` `` line per token (drift check 1, `design-system-drift.test.ts:181-189`). `specimens/foundations.html` § 4 gets a "Rhythm" row of six bars.
- The pilot surface (D-9, closed – PR 1 ships it): `settings-field.tsx:21` `gap-2` → `gap-stack`, and the eight section lists `gap-7` → `gap-section`.

### 9.2 New defaults, surface by surface (PR 2 – the cockpit)

The table – surface · today · proposed · delta – is in [`handoff-values.md`](handoff-values.md) § 9.2. Six of its rows are § 9.3 conversions of a hand-set pixel and are marked *delivered by PR 3b (§ 9.3)* there, so PR 2 leaves them alone: PR 3a seeded its allowlist from that step’s tree (70 rows, 86 occurrences in #431; counts read on 2026-09-16), and PR 2's screenshots compare the rhythm alone (§ 9.6).

**Not converted by #424: the two sticky offsets on the Changes tab.** The tree pane is `sticky top-40 … w-60 lg:w-72` (`task-changes.tsx:202`), so the mockup spells it on the density unit (`top: calc(var(--air-bar-h) + var(--u) * 40)`, `width: calc(var(--u) * 72)`). The diff file header is pinned by `[--diff-sticky-top:10rem]` (`:193`) – a real rem, so it keeps its 160 px. Measured in Chrome: at Comfortable both stick at 230 px under the review bar; at Roomy the pane sticks at 270 and the diff header at 230, a 40 px mismatch. The mockup is faithful here – the shipped product does the same, because `top-40` rides the lever and a rem does not; the old mockup hid it by hard-coding both. Still open after step 3b (`task-changes.tsx:193,202`, checked on 2026-09-16); a follow-up must choose between moving the diff header onto the scale and keeping the rem with the gap. It belongs with #445 or a separate issue (inferred).

Effect on a page: a settings page with five fields grows ~40 px; a thread of 30 rows with 10 speaker changes grows about 100 px between rows (−2 × 20 + 14 × 10: the 20 rows inside a turn lose 2 each, the 10 speaker-change rows gain 14 each) plus 24 px of gutter (the column's top and bottom padding each grow 20 → 32); the task table does not grow in height; the sidebar gains 2 px per row and 12 px between groups. All *inferred* from the deltas; PR 2 reports measured `document.scrollHeight` before and after (AC 4).

### 9.3 Pixels back on the scale (PR 3a rule, PR 3b conversions)

The conversion table – today · proposed · note – is in [`handoff-values.md`](handoff-values.md) § 9.3.

Guardian rule (new, `design-guardian.test.ts`, modelled on `unknown-color-token` (`:145-161`), the one rule with a `violates` hook – but that hook sees only the match, not the file):

- name `no-arbitrary-spacing`; pattern `(?<![\w-])(?:[a-z]+:)*(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|h|min-h|size)-\[\d+(?:\.\d+)?(?:px|rem|em)\]` – a left boundary so `max-w-[336px]` is not read as `w-[336px]`; `px|rem|em`; heights and `size` in, widths and `max-*` out.
- allowlist keyed on `file|spelling` in `packages/web/src/design-guardian-spacing-allowlist.json`, each row with a count and reason. PR 3a (#431) kept the `violates(match)` hook and added a per-occurrence map instead of widening the hook. Its seed was 70 rows / 86 occurrences (counts read on 2026-09-16 at `673c6ed`). Fixture self-tests pin rejection against an empty allowlist.
- It **fails `npm test`** – the validation gate, not the build (D-5). Owned by a test, never waived in prose.

### 9.4 The Roomy option (PR 4 – appearance)

- `Density = 'roomy' | 'comfortable' | 'compact' | 'ultra'` (`lib/appearance.ts:26`), default unchanged; `normalizeDensity` (`:48-50`) learns the value.
- `:root[data-density='roomy'] { --spacing: 0.3125rem; }` = 5 px per unit (+25 %, the mirror of ultra's −25 %; every rhythm value stays an integer). One block in `index.css` beside `:253-261`, mirrored in `cockpit.css` beside `:182-187`, and the selector added to `THEME_SELECTORS` in `design-system-drift.test.ts:40-47` – otherwise check 0 fails the suite.
- **The contract.** `density` is a closed enum in `packages/contract/src/workspace.ts:144` and duplicated in `packages/xezar/src/server/server.ts:727`. The duplicate is live: it validates the per-repo `PUT /api/v1/ui-state` (`server.ts:3138`), while `PUT /api/v1/workspace/ui-state` (`server.ts:3002`) validates through the contract schema, and contract parity asserts both unions match. Without the value in both, Roomy 400s on save. PR 4 exports the density schema from the contract, imports it in the server and deletes only the duplicated const (AGENTS.md § The HTTP API), then runs `contract-parity*` and `typed-bodies`.
- **Pre-paint.** `packages/web/index.html:36-38` stamps `data-density` only for `compact`/`ultra`; Roomy would paint Comfortable and jump. Add the value there.
- **Old versions.** The read path returns the stored string untouched (`workspace/ui-state.ts:25-37`); an older cockpit falls back through `normalizeDensity`, an older server rejects the PUT with 400 and the cockpit toasts and refetches (`appearance-provider.tsx:73-75`). Server and cockpit ship together, so this only matters for mixed versions. BACKWARD_COMPATIBILITY.md gets one line under the UI-state surface.
- Settings → Appearance gains "Roomy" ahead of "Comfortable" (`appearance.tsx:36-40`); hint copy per § 8.
- At 375 px the four density options (about 390 px, measured in the step-0 mockup) overflow the column (about 343 px): `Segmented` is `inline-flex w-fit` with no wrap (`appearance.tsx:66`). PR 4 wraps the row inside its border, so every option stays reachable at every density.

### 9.5 Documentation and tests that change

| File | Change |
|---|---|
| `docs/design-system/foundations.md` § 4 | new § 4.1 Rhythm: `--spacing` at the default, the six tokens (one `` `--spacing-<name>` `` line each – mandatory for the drift test), the rule, the half-pixel note, the Roomy row in the density table |
| `docs/design-system/components.md` | rows for every component whose spelling changes (§ 9.2, § 9.3) |
| `docs/design-system/patterns.md` § 3, § 4, § 5 | page-body, table and card spellings |
| `docs/design-system/cockpit.css` | `--spacing`, the six tokens, the `roomy` block, every mirrored class whose padding/gap changed, the `.density-demo` |
| `docs/design-system/specimens/foundations.html` § 4 | the Rhythm bars; the appearance bar gains Roomy |
| `docs/design-system/known-gaps.md` | **G-25** recorded in PR 1; **deleted** in PR 2 with a `design-debt` issue linked (the file's own rule, `:6-8`); no chip-target row is needed – PR 3b floors both chips at `min-h-[24px]` |
| `docs/design-system/new-designs.md` § 2, § 5 | "use the rhythm tokens for gaps between blocks in a mockup"; Roomy in the appearance checklist |
| `docs/design-system/theming.md` | Roomy in the density paragraph |
| `.claude/skills/design-system/SKILL.md` | rule 17 (§ 8) |
| `.xezar/skills/xezar-ux-design.md:36` | the review checklist names the four densities |
| `packages/web/src/design-guardian.test.ts` | the `no-arbitrary-spacing` rule, the per-occurrence allowlist map (the `violates(match)` hook stayed unchanged), the allowlist, the fixture self-test |
| `packages/web/src/design-system-drift.test.ts` | `THEME_SELECTORS` gains `roomy` |
| `packages/web/src/lib/utils.ts` (+ test) | `tailwind-merge` `theme.spacing` extension |
| `packages/web/index.html` | pre-paint density stamp |
| `packages/contract/src/workspace.ts`, `packages/xezar/src/server/server.ts` | the enum; export the density schema from the contract, import it in the server, delete only the duplicated const |
| `packages/web/src/components/ui/button.test.tsx` | the `h-8` / `size-8` assertions – not done in #424 (the small button is still `h-[30px]`); left to #445 |
| `packages/web/e2e/rhythm.e2e.ts` (new) | AC 3 |
| `BACKWARD_COMPATIBILITY.md` | the appearance value |
| `designs/quality-checks`, `designs/decisions` | adopt the tokens in their next revision – #435 |

### 9.6 Rollout

The gates and measurements below describe the rollout plan; the Merged column records delivery. #424 closed on 2026-09-15; the allowlist burn-down moved to #445.

| Step | Content | Gate | Measure | Merged |
|---|---|---|---|---|
| Step 0 – mockup | A full-page before/after mockup in this folder (D-4): Tasks (table, sidebar, New task, phone drawer), a thread with its dock, Changes, Settings → Agents, → Appearance (Roomy · Comfortable · Compact · Compact for real), → Agent accounts (refusal), Inbox and a dialog; at 1280 and 375 px; both themes, the violet accent, four densities and the wide width; the six states | the `design-review` verdict – it gates step 1 onward | the verdict | #429 (`c1919e8`) |
| PR 1 | `--spacing` + six tokens in `index.css` and `cockpit.css`, `tailwind-merge`, foundations § 4.1, specimens, G-25, and the Settings field-list pilot (D-9) | `needs-design` + `needs-qa` – the pilot ships; drift test | the specimen bars at 8/12/16/20/24/32 from disk (AC 2) | #432 (`d0c5def`) |
| PR 2 | § 9.2 across `packages/web/src`; G-25 deleted | `needs-design` + `needs-qa`; before/after screenshots at 1280 and 375, both themes, comfortable and ultra; `npm run test:e2e` | measured page heights (AC 4); `rhythm.e2e.ts` (AC 3) | #437 (`aa6416d`) |
| PR 3a | the guardian rule, per-occurrence map, allowlist seeded at 70 rows / 86 occurrences (counts read on 2026-09-16 at `673c6ed`), fixture self-test | `skip-design` (no rendered change) | allowlist seeded at 70 rows | #431 (`673c6ed`) |
| PR 3b | § 9.3 conversions; `button.test.tsx`; the known-gaps chip row | `needs-design` + `needs-qa`; `npm run test:e2e` (the suite asserts real geometry: `task-thread.e2e.ts:452`, `quick-list.e2e.ts:271-276, 650-668`, `diff-scroll.e2e.ts:38, 254-287`) | target: two chip-floor rows; #441 left 62 rows / 76 occurrences (counts read on 2026-09-16); burn-down in #445, met at the two floor rows on 2026-09-18 | #441 (`00ee895`) |
| PR 4 | Roomy: the density schema exported from the contract and imported by the server (duplicate deleted), `normalizeDensity`, pre-paint, `THEME_SELECTORS`, Settings option, BC note, release note | `needs-design`; contract parity | AC 8 | #438 (`8d29ea3`) |

Order (issue #424): step 0 → 1 → 2 → 3a → 3b → 4; the step-0 verdict gates step 1 onward. 3b after 2 so PR 2's screenshots compare rhythm alone.

## 10. Accessibility

- Nothing changes for screen readers: the same elements, the same order, the same names.
- Touch targets stay `h-11` (44 px) on phone at Comfortable and grow at Roomy (55 px). At Compact and Compact for real they shrink as they do today (38.5 / 33 px) – the density lever is proportional by decision D-3; the cockpit's own foundations § 12 only promises 44 px at the default (*inferred*: `foundations.md:301` says `h-11` on phone, shrink at `md:`).
- The two small interactive chips – the `h-[26px]` picker pill and the `h-[22px]` reference chip – are floored at an absolute `min-h-[24px]` in PR 3b, so they meet WCAG 2.2 SC 2.5.8's 24 px at every density; today's hand-set 26 / 22 px chips do not. The two permanent floor rows remain alongside the conversion debt tracked in #445.
- Type sizes and line heights are untouched, so the G-23 contrast gap is neither better nor worse. Focus rings, motion, colour: untouched.

## 11. Responsive

- Phone gutters grow from 12 to 16 px (`p-3` → `p-4`); `section` (32 px) applies at `md:` (768 px) and up.
- Nothing scrolls sideways at 375 px: the rhythm adds vertical space only; the table keeps `.table-scroll`; `a11y-sweep.e2e.ts` (390 / 1440) and `ios-sweep.e2e.ts` stay green.
- One container scrolls sideways on purpose: the run header's tab row, `overflow-x: auto` on `.air-tabs` – the treatment the shipped settings pill row already has (`cockpit.css:2248`). Measured: at a true 375 px viewport nothing overflows at any density; the row needs 339 px at Roomy, so below 327 px it scrolls inside itself rather than pushing the page. Intentional, not a defect, and step 2 keeps that rule when it converts the real component.
- Roomy on a phone: rows 55 px – opt-in.
- The mockup's screen pages render the true 375 px view in a 375 px window. The aid pages' 375 px frames shrink below their own width in a window narrower than about 425 px. The review bar is sticky from 769 px and static at 768 px and below. Focus and anchors clear it through a scroll margin on the page's content (`chrome.css`, `thread.css`), not a root `scroll-padding-top`.

## 12. Acceptance criteria

1. `index.css` and `cockpit.css` declare `--spacing` and the six `--spacing-*` tokens with byte-identical value strings; each is named in `foundations.md`; `npm test -- packages/web/src/design-system-drift.test.ts` is green.
2. `specimens/foundations.html` opened **from disk** shows the six rhythm bars at 8 / 12 / 16 / 20 / 24 / 32 px.
3. `packages/web/e2e/rhythm.e2e.ts` asserts through `getComputedStyle` at the default density: a thread row inside a turn 8, the gap between two speakers' rows 24, card padding 20, card-list gap 16, settings field gap 12, settings list gap 32, desktop page padding 32, page body top 32 – and 75 % of each at `data-density='ultra'`, 125 % at `roomy`.
4. PR 2 reports measured `document.scrollHeight` for Tasks, a 30-row thread, Settings → Agents and Inbox at 1280×900, before and after.
5. The original target was an allowlist containing only the two `min-h-[24px]` chip floors after PR 3b, with red/green fixture proofs for new arbitrary pixels. **Not met by #424:** #431 seeded 70 rows / 86 occurrences; after #441, 62 rows / 76 occurrences remain (counts read on 2026-09-16). #445 carried the burn-down and closed as met on 2026-09-18: the allowlist holds exactly the two floors (`components/picker-pill.tsx:28`, `components/reference-chip.tsx:161`).
6. Touch targets ≥ 44 px on phone at Roomy and Comfortable, no smaller than today at Compact and Compact for real, and no interactive target under 24 px at any density – the two chips carry `min-h-[24px]`.
7. Nothing scrolls sideways at 375 and 390 px; both themes pass the design-system review checklist.
8. Roomy round-trips: the contract enum accepts it and the server imports that schema with no second copy left in `server.ts`, `contract-parity*` and `typed-bodies` green; `normalizeDensity('roomy') === 'roomy'`; `index.html` stamps it before first paint on a cold load; an older cockpit falls back to Comfortable; BACKWARD_COMPATIBILITY.md carries the line.
9. G-25 is recorded in PR 1 and deleted in PR 2 with a `design-debt` issue linked; every UI-in-scope PR carries `needs-design` with a `## Design review` comment, or `skip-design` with the reason in the body.

## 13. Open decisions

Decided on 2026-09-14 (owner): **D-1** change the default · **D-2** table rows stay 44 · **D-3** compact/ultra scale the new rhythm ("the layout should always look the same") · **D-4** a full-page mockup as step 0, whose verdict gates step 1 onward · **D-5** the pixel rule fails `npm test`, the validation gate · **D-6** settings stay flat, 28 → 32 · **D-7** one lever · **D-8** no flag · **D-9** PR 1 ships the tokens, the docs and the Settings field lists as its pilot, labelled `needs-design` + `needs-qa` · **D-10** two thread gaps · the scale 8/12/16/20/24/32 · Roomy stays and is 5 px per unit. The "option in the configuration" the owner asked for is that Roomy density; the looser rhythm ships as the default, with no flag (D-8). D-1..D-10 stay closed.

Decided at the step-0 verdict (2026-09-15, [design review](https://github.com/qodeca/xezar/pull/429#issuecomment-5678658435)). Both options still switch live on `tasks.html`; A is the decision.

- **D-11 – Task-table wrapper: A, keeps `px-section`.** B gives back only 24 px (less than one column) and adds a gutter exception every future page would have to remember; with the header at `md:px-section` (NB-1) the title and the table edge line up at 32 px.
- **D-12 – New-task button: A, `h-10` (40 px).** With B the button is the same height as the `md:h-9` nav rows under it; A keeps it taller (40 vs 36), which is § 9.3 note UI-7. At phone width it stays under the 44 px drawer rows – a separate, older issue (NB-4, #430).

These numbers are this folder's items ("Air D-11", "Air D-12"), not `docs/design-system/decisions.md` ids; step 1 recorded the system-wide ones there as D-02..D-07 (NB-7).

Mockup-only departures are listed in § 5 (j) with reasons; they are not open decisions.

## 14. Risks

| Risk | Effect | Answer |
|---|---|---|
| More scroll | thread and settings pages grow 5–15 % | that is the point; tables do not grow; the density lever still offers tighter |
| Users on Compact / Compact for real see their pages loosen | 75 % of the new rhythm at ultra is still looser than today's default | the release note says plainly that no density reproduces the old look (§ 8); D-3 |
| Roomy fails to save | the enum in the contract and the server duplicate | PR 4 exports the schema from the contract and imports it in the server, deleting only the duplicated const; contract parity proves the two unions match |
| The browser suite asserts real geometry | `task-thread.e2e.ts:452` (44 px bar), `quick-list.e2e.ts` (7 px dot, 264 px layout), `diff-scroll.e2e.ts` (card heights) | run `npm run test:e2e` in PR 2 and 3b; screenshots are artifacts, not goldens – nothing to rebase |
| `cn()` merges stop resolving for the new utilities | `p-4 p-inset` both kept | `tailwind-merge` extension in PR 1, with a test |
| Small interactive chips drop under 24 px | the `h-[26px]` picker pill and the `h-[22px]` reference chip on the scale give 21 / 18 px at Compact for real | PR 3b floors both at an absolute `min-h-[24px]`; the two-floor target remains unmet; #445 carries the remaining conversion |
| The mockup sheet drifts from the cockpit | `cockpit.css` mirrors about 106 spacing-bearing classes by hand | the drift test covers tokens, not class paddings; PR 2 updates both in one commit; leftovers go in the known-gaps mockup-fidelity table |
| Sibling mockups go stale | `designs/quality-checks`, `designs/decisions` draw today's rhythm; the lifecycle clock reverts an unimplemented Approved design after two releases | #435 (filed in step 2) |
| The kit's review checklist names density values | `xezar-ux-design.md:36`, `new-designs.md:51-54` | updated in PR 4 |
| `calc()` tokens cost | none in kind – every Tailwind spacing utility is already `calc(var(--spacing) * n)` | accepted |
| "Air" becomes taste in every review | reviewers argue numbers | the tokens end it: a gap is a token or it is wrong |

## 15. References

- [`review-2026-09-14.md`](review-2026-09-14.md) – the four reviews and every disposition
- [qodeca/xezar#424](https://github.com/qodeca/xezar/issues/424) – the umbrella issue (`enhancement`, `epic`, `risk-high`): step 0 (full-page mockup) → 1 → 2 → 3a → 3b → 4
- `docs/design-system/foundations.md` § 3, § 4, § 5, § 9, § 12; `theming.md`; `components.md`; `patterns.md`; `new-designs.md`; `known-gaps.md`
- `packages/web/src/styles/index.css` (`--spacing` `:248-261`, `@theme static` `:280-293`, thread markdown `:498-538`)
- `packages/web/src/lib/appearance.ts`, `lib/utils.ts`, `routes/settings/appearance.tsx`, `packages/web/index.html:36-38`
- `packages/contract/src/workspace.ts:144`, `packages/xezar/src/server/server.ts:727, 3002`, `packages/xezar/src/workspace/ui-state.ts:25-37`
- `packages/web/src/design-guardian.test.ts`, `design-system-drift.test.ts`, `components/ui/button.test.tsx`
- The cited routes and components: `tasks-overview.tsx`, `global-tasks.tsx`, `task-thread/*`, `settings/*`, `inbox.tsx`, `components/app-shell.tsx`, `project-groups.tsx`, `task-quick-list.tsx`, `provider-banner.tsx`, `centered-state.tsx`, `run-header.tsx`, `review-panel.tsx`
- Spacing precedents: Atlassian space tokens, Carbon spacing scale, Radix Themes spacing (all carry 24; none carries 28)
- Tailwind v4 theme variables: `--spacing-*` entries in `@theme` mint named spacing utilities (verified by compiling with 4.3.2)

## 16. Design review

Four reviews on 2026-09-14 (UX, UI, fact-check, plan): all PASS WITH CHANGES. Five blocking findings and eighteen should-fix items, consolidated with dispositions in [`review-2026-09-14.md`](review-2026-09-14.md); every decision the owner took (D-1..D-10) is applied and stays closed. The step-0 mockup set (revision 4) has its `design-review` verdict below (D-4); steps 1–4 followed (§ 9.6).

### Step 0 – the full-page mockup

| Field | Value |
|---|---|
| Comment | [`## Design review` on PR #429](https://github.com/qodeca/xezar/pull/429#issuecomment-5678658435) |
| Reviewed commit | `4d3e0001dbce177f1b11e1e2edebee35ae1faebe` |
| Reviewer role | Xezar `design-review` task, claude – independent, did not write the mockup |
| Themes and widths checked | dark and light; lime and violet accent; 1280 × 900, 375 × 780, 1600 px wide; all four densities |
| Verdict | **PASS WITH FOLLOW-UPS** – no blocking findings; `design-approved` applied |
| Open points | 6 → D-11 = A, 7 → D-12 = A (§ 13) |

| # | Finding | Disposition |
|---|---|---|
| NB-1 | Page header stays at `px-5` (20) while the body moves to 32, so the title is 12 px out of line | **Fixed in this PR:** the proposed header is `md:px-section` (`shell.css`, spelled on `--u`); the four § 9.2 rows in `handoff-values.md` updated (settings containers `p-list md:p-group`, Inbox card and refusal gaps stay inside one block) |
| NB-2 | § 9.3 does not list the step rail's `md:min-h-[30px]` (`step-rail.tsx:164`) | **Fixed in this PR:** § 9.3 row `md:min-h-[30px]` → `md:min-h-8` added to `handoff-values.md`; the drawing stays, PR 3a re-counts from the tree |
| NB-3 | `cockpit.css` base classes (sidebar head, New-task row, `.btn` gap, pill, composer, `kbd`, nav badge) stay fixed at every density in both views | **Accepted:** the comparison stays fair; § 5 (j) and § 14 already send `cockpit.css` fidelity rows to PR 2's known-gaps mockup-fidelity table, which lists these classes by name |
| NB-4 | Phone drawer New-task button is 36 px today, 40 px with D-12 – under 44 px | **Filed** as `design-debt` [#430](https://github.com/qodeca/xezar/issues/430); older than Air, out of scope |
| NB-5 | Compare frames at 1280 × 900 show only ~60–70 px of thread | **Accepted:** the in-place Today / Proposed flip is the main comparison, and the compare page says the frames are short |
| NB-6 | Settings values table says `p-stack` = 12 is "the same at every density" | **Fixed in this PR:** now "12 at Comfortable – it scales with density: 9 / 10.5 / 12 / 15" (`settings.html`) |
| NB-7 | Air D-3, D-5, D-7, D-11 and D-12 set system-wide rules but are not in `docs/design-system/decisions.md` | **Accepted for step 0; done in step 1:** recorded as `decisions.md` D-02..D-07, citing the folder's items as "Air D-n" |
