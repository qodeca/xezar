# Air – a design-system enhancement

| | |
|---|---|
| **Status** | Draft, revision 2 (2026-09-14 evening) – the four-reviewer verdict ([`review-2026-09-14.md`](review-2026-09-14.md)) and the owner's decisions D-1..D-10 applied. One decision still open ([§13](#13-open-decisions)). Nothing in `docs/design-system/` or `packages/web` changes until the mockup page for PR 2 is approved (D-4). |
| **Date** | 2026-09-14 |
| **Mockup** | Open [`index.html`](index.html) in a browser: seven surfaces, today beside proposed, same markup twice, with a density select (including the proposed Roomy) and the light/dark toggle. No build needed. |
| **Replaces** | Nothing. This design changes the system's spacing rules, not a feature surface. |
| **Comes from** | The owner, 2026-09-14: "the entire design system requires more air – more space between elements on the pages." |
| **Facts** | Every number below was read from the files it cites on 2026-09-14 and re-checked by the fact-check reviewer. Inferred statements are marked *inferred*. |

## 1. Summary

The cockpit is tight everywhere, and the design system has no word for "looser". Its one spacing lever – the density setting – can only make things tighter than shipped (`comfortable` → `compact` → `ultra`). The shipped look is the top of the range, and it packs blocks together: 10 px between thread rows, 8 px inside a settings field, 16 px inside a card, 10 px between cards, 20 px page gutters.

This design adds air in four moves, each its own PR:

1. **A rhythm scale.** Six semantic spacing tokens – `--spacing-row` 8, `-stack` 12, `-list` 16, `-inset` 20, `-group` 24, `-section` 32 – that name the space *between* things, built on Tailwind's `--spacing` so the density lever reaches them. Today every gap is a bare number (`gap-2.5`, `pb-2.5`, `p-4`) chosen per file.
2. **Looser defaults for the rhythm; controls keep their size.** Between blocks: thread rows 10 → 8 inside a turn and 24 at a speaker change; settings fields 8 → 12 inside and 28 → 32 between; card padding 16 → 20; cards 10 → 16 apart; page gutters 20 → 32; the page body starts 32 px under the header. Buttons, inputs, chips, nav rows and table rows keep their heights at the default density.
3. **Every hand-set pixel back on the scale.** 90 arbitrary-pixel spacing spellings (50 distinct, 29 files) sit outside the density lever today. They move to scale units or rhythm tokens, and a guardian rule that fails the build stops new ones.
4. **A "Roomy" density**, 5 px per unit (+25 %, the mirror of "Compact for real"), so the lever runs both ways. The shipped default stays Comfortable, which after move 2 is already roomier than today. Every density scales the whole page as one piece (D-3, D-7): the layout always looks the same, only larger or smaller.

Size: four PRs plus a full-page mockup before PR 2 (D-4). About three days of work plus two review rounds. One contract change (the density enum), one BC note, no run-record change, no `XEZ_*` variable.

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

The fact-check counted, in non-test `.ts/.tsx` under `packages/web/src`, with a left boundary and the prefixes `h|w|min-h|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-x|space-y|top|left|right|bottom|inset`: **90 occurrences, 50 distinct spellings, 29 files**. Top files: `routes/global-tasks.tsx` 14, `task-thread/thread-items.tsx` 8, `components/project-groups.tsx` 7, `components/app-shell.tsx` 7, `routes/new-task.tsx` 5, `components/task-quick-list.tsx` 5. Most frequent: `h-[30px]` ×7, `w-[336px]` ×6, `pl-[22px]` ×6, `p-[3px]` ×6, `gap-[7px]` ×5, `px-[5px]` ×4, `md:h-[34px]` ×3, `md:min-h-[54px]` ×3, `h-[26px]` ×3.

The ones that decide a control's size:

| Spelling | Where |
|---|---|
| `md:h-[34px]` nav row | `app-shell.tsx:572` |
| `md:h-[30px]` nested nav row | `project-groups.tsx:325` |
| `h-[38px]` table header | `tasks-overview.tsx:419` |
| `h-[30px]`, `size-[30px]` button | `components/ui/button.tsx:24`; asserted verbatim in `button.test.tsx:38-41` |
| `px-[15px]` user bubble | `thread-items.tsx:121` |
| `min-h-[28px]` tool row, `h-[34px]` group trigger | `thread-items.tsx:547, 615` |
| `h-[26px]` chip, `h-[22px]` reference chip | `components.md:271, 360` |
| `p-[3px]` segmented, `py-[3px]` pill, `py-[7px]` quick-list row | `components.md:288, 263`; `task-quick-list.tsx:248` |

Each is a place the density lever cannot reach. At `ultra` the page tightens around them and they stay put, which is why `ultra` looks uneven rather than uniformly tight – the mockup's density select shows it on the "today" column.

### 2.4 Line heights and small text

Assistant text `text-[15px] leading-[1.65]`, user bubble `13.5px leading-[1.55]`, markdown `line-height: 1.6` – fine (`thread-items.tsx:121, 240`; `index.css:499`). Thirteen type sizes from 10 to 24 px (`foundations.md:150-164`). Not a spacing problem, but small text reads tighter when the rhythm is tight; `known-gaps.md` G-23 records the contrast side.

### 2.5 Not recorded as a gap

`known-gaps.md` holds 23 entries (G-01..G-23); none is about spacing, density, gutters or rhythm. G-24 was used once and deleted (`design-guardian.test.ts:62` still cites it), so the next free id is **G-25**. Without an entry a reviewer has no rule to point at.

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

| File | What it is |
|---|---|
| [`index.html`](index.html) | The examples: seven pairs, today beside proposed, density select, theme toggle |
| [`styles.css`](styles.css) | The two value sets (`.ex.today` from the files, `.ex.air` from the tokens) and the example chrome; feature rules only, on top of `../../docs/design-system/cockpit.css`. One intentional exception to `designs/README.md` § "never redeclares a token": it declares the proposed `:root[data-density='roomy'] { --spacing: 0.3125rem }`, because that value is the proposal. |
| [`theme.js`](theme.js) | The mockup's light/dark and density switches |
| [`review-2026-09-14.md`](review-2026-09-14.md) | The four-reviewer record with every finding's disposition |

## 6. Screens

The mockup is one page of pairs. Each pair is the same markup twice; the tag line on each frame gives the numbers at the default density.

| Pair | Today | Proposed | Shows |
|---|---|---|---|
| 1 Settings fields | gap 8 · fields 28, flat · gutter 20 | stack 12 · fields section 32, flat · gutter 32 | title → control → hint, five fields |
| 2 Card list | cards 10 apart · 16 inside · button 30 | list 16 apart · inset 20 inside · button 32 | Inbox / hub / phone task cards |
| 3 Thread | every row 10 apart · tool row 28 · gutter 20 | row 8 inside a turn · group 24 at a speaker change · tool row 32 · gutter 32 | user bubble, assistant text, tool rows |
| 4 Page header and task head | header `h-14` · body at 20 · task head 18/24/14 | header `h-14` · body at 32 · task head 32/32/16 | the space under a header |
| 5 Sidebar | rows 34 (hand-set) · groups 6 apart | rows 36 (`h-9`) · groups stack 12 apart | nav, NEEDS YOU, WORKING |
| 6 Task table | rows 44 · cells 10 · header 38 (hand-set) | rows 44 · cells 12 · header 40 (`h-10`) | the one surface that does not grow |
| 7 Rhythm scale | – | six bars: 8 / 12 / 16 / 20 / 24 / 32 | the tokens |

Still missing from the page, to be added on the full-page mockup for PR 2 (D-4): a 375 px frame, the composer dock, a field with an inline error, a dialog, a diff view.

## 7. States

The density select on the mockup's bar sets `data-density` on `<html>`, the way `AppearanceProvider` does in the cockpit (`components.md:226-229`).

| Density | `--spacing` | Today's column | Proposed column |
|---|---|---|---|
| Roomy (proposed) | `0.3125rem` (5 px) | scale units grow, hand-set pixels stay – uneven | +25 %, every value an integer (10 / 15 / 20 / 25 / 30 / 40) |
| Comfortable (default) | `0.25rem` (4 px) | the shipped look | 8 / 12 / 16 / 20 / 24 / 32 |
| Compact | `0.21875rem` (3.5 px) | uneven | 7 / 10.5 / 14 / 17.5 / 21 / 28 |
| Compact for real | `0.1875rem` (3 px) | uneven – nav rows, tool rows, table header and buttons stay put | 6 / 9 / 12 / 15 / 18 / 24 – still looser between blocks than today's default |

Compact and ultra give half-pixel values for some steps; that is already true of the numeric scale today and is recorded in foundations § 4.1, not hidden. Both themes render through `cockpit.css`; nothing in the sheet is theme-specific.

## 8. Copy deck

| Where | Text |
|---|---|
| Settings → Appearance, density options | Roomy · Comfortable · Compact · Compact for real |
| Settings → Appearance, density hint | Roomy and Compact change spacing across the cockpit – text stays the same size. |
| `foundations.md` § 4.1 title | Rhythm |
| `foundations.md` § 4.1 rule | Between blocks, a rhythm token. Inside a control, the numeric scale. Never a hand-typed pixel. |
| `known-gaps.md` G-25 title | No rhythm scale; between-block spacing is chosen per file |
| Design-system skill rule 17 | Between blocks, a rhythm token; no arbitrary spacing values. Owner `design-guardian.test.ts`. |
| Release note (0.16) | Spacing between blocks is looser at every density; a new Roomy density is available. Compact and Compact for real scale the new spacing, so they are a little looser than before. |

Rules applied: sentence case, en dashes, no contractions.

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
- One pilot surface (D-9, if confirmed): `settings-field.tsx:21` `gap-2` → `gap-stack`, and the eight section lists `gap-7` → `gap-section`.

### 9.2 New defaults, surface by surface (PR 2 – the cockpit)

| Surface | Today | Proposed | Delta |
|---|---|---|---|
| Thread row inside a turn | `pb-2.5` (10) | `pb-row` (8) | −2 |
| Thread row at a speaker change | `pb-2.5` (10) | `pt-group` on the first row of the new speaker – `thread-groups.ts` already knows the boundary (24) | +14 |
| Thread column gutters | `md:px-6 md:py-5` | `md:px-section md:py-section` (32) | +8 / +12 |
| Tool row | `min-h-[28px] py-0.5` | `min-h-8 py-1` (32) | +4; on scale |
| Nested tool group | `my-2` | `my-stack` (12) | +4 |
| Ask card body | `gap-4` | `gap-list` | 0 |
| Ask card padding | `px-4 pt-3.5 pb-3.5` | `p-inset` (20) | +4 |
| Settings field inside | `gap-2` (8) | `gap-stack` (12) | +4 |
| Settings fields between (flat, D-6) | `gap-7` (28) | `gap-section` (32) | +4 |
| Settings sidebar | `gap-1 p-3`; rows `px-2.5 py-2` | `gap-1 p-stack`; rows unchanged | 0 / 0 |
| Card padding (inbox, hub, task card) | `p-4` (16) | `p-inset` (20) | +4 |
| Card list gap | `gap-2.5` (10) | `gap-list` (16) | +6 |
| Inbox card internals | head `gap-3`, meta `mt-1.5`, actions `gap-1.5` | head `gap-stack`; meta `mt-row`; actions unchanged | +0 / +2 |
| Page body gutters | `p-3 md:p-5` | `p-4 md:p-section` (16 / 32) | +4 / +12 |
| Under the page header | body starts at the gutter | `pt-section` (32) | +12 |
| Run header (task page) | `md:px-6 md:pt-3`; title `md:mt-2.5` | `md:px-section md:pt-group`; title `mt-stack` | +8 / +12 / +2 |
| Composer dock | `md:pt-1.5 md:pb-4` | `md:pt-stack md:pb-list` | +6 / 0 |
| Composer card internals | `md:min-h-[54px] md:px-4 md:pt-3` | unchanged (control-internal); `min-h-[54px]` → `min-h-14` (56) in PR 3b | – |
| Table rows | `h-11`, `px-2.5` | `h-11`, `px-3` | 0 height; +2 padding |
| Table header | `h-[38px]` | `h-10` (40) | +2; on scale |
| Table footer strip | `mt-3.5` | `mt-list` (16) | +2 |
| Table wrapper on the task page | inside the gutter | keeps `px-section` – the table already scrolls sideways behind `overflow-x-auto`; if a review shows the 13-column table losing a useful column, exempt the wrapper | 0 |
| Global tasks page | `gap-3 p-3 md:p-5` | same as the page body | +12 |
| Mobile task card | `px-3.5 py-3` | `p-inset` (20) | +6 / +8 |
| Sidebar nav rows | `md:h-[34px]`, container `py-1.5` | `md:h-9` (36), groups `gap-stack` | +2; on scale |
| Sidebar quick-list rows | `py-[7px]` (32) | `py-2` (34) | +2; on scale |
| Sidebar brand / footer rows | `gap-[9px]`, `gap-1.5` | `gap-row`, unchanged | −1 / 0 |
| Project-group body | `mt-1 ml-[14px] pl-2` | `mt-1 ml-3.5 pl-2` | 0; on scale |
| Banner row | `min-h-9 px-4` | `min-h-10 px-section` | +4 / +16 |
| Review panel | `gap-3`; banner `px-3.5 py-2.5` | `gap-stack`; banner unchanged | 0 |
| Dialog / sheet / popover / menu / tooltip / toast / select / command | control-internal (`ui/*`) | unchanged | 0 |
| Diff and code views | `px-3 py-2`, `px-4 py-0.5`, `leading-[1.7]` | unchanged – code density is a feature | 0 |
| Inline empty states, command palette | `py-6`, `py-10`, `top-[10vh]` | unchanged | 0 |
| Centered state | `gap-4 px-6 py-12` | unchanged | 0 |

Effect on a page: a settings page with five fields grows ~40 px; a thread of 30 rows with 10 speaker changes grows about 80 px between rows (−2 × 30 + 14 × 10) plus 20 px of gutter; the task table does not grow in height; the sidebar gains 2 px per row and 12 px between groups. All *inferred* from the deltas; PR 2 reports measured `document.scrollHeight` before and after (AC 4).

### 9.3 Pixels back on the scale (PR 3a rule, PR 3b conversions)

| Today | Proposed | Note |
|---|---|---|
| `md:h-[34px]` nav row | `md:h-9` | 36 px; `.btn-new-task` above it is `h-9` too – take the CTA to `h-10` so the hierarchy holds (UI-7), or prove it on the screenshot |
| `md:h-[30px]` nested nav | `md:h-8` | 32 px |
| `h-[38px]` table header | `h-10` | 40 px |
| `h-[30px]`, `size-[30px]` button | `h-8`, `size-8` | 32 px – the one visible control-size change; `md` stays `h-9`; `button.test.tsx:38-41` updates with it |
| `px-[15px]` bubble | `px-4` | 16 px |
| `min-h-[28px]` tool row, `h-[34px]` group trigger | `min-h-8`, `h-9` | 32 / 36 px |
| `h-[26px]` chip, `h-[22px]` reference chip | `h-7`, `h-6` | 28 / 24 px at the default; 21 / 18 at ultra – under WCAG 2.2 SC 2.5.8 (24 px) at the tight densities, as the same chips already are today; recorded in `known-gaps.md`, not fixed here |
| `p-[3px]`, `py-[3px]`, `py-[7px]` | `p-1`, `py-1`, `py-2` | 4 / 4 / 8 px |
| `md:min-h-[54px]` composer | `md:min-h-14` | 56 px |
| `pl-[22px]`, `gap-[7px]`, `px-[5px]`, `gap-[9px]`, `ml-[14px]`, `mt-[5px]`, `pl-[15px]`, `pl-[26px]`, `px-[7px]` | nearest scale step | listed one by one in PR 3b's allowlist diff |
| `w-[336px]`, `w-[264px]`, `max-h-[…]`, `h-[3px]`, `h-[9px]` | out of scope | widths and hairlines are layout facts; the rule does not cover `w`, `max-*`, hairlines |
| `pb-[calc(90px+env(safe-area-inset-bottom))]` | one shared class `pb-dock` | a layout fact, not a density concern |
| `rounded-[18px]`, `rounded-[6px]` | unchanged | radius is a non-goal (§ 4) |

Guardian rule (new, `design-guardian.test.ts`, modelled on `unknown-color-token` at `:145-161`, which keys on `rel + match`):

- name `no-arbitrary-spacing`; pattern `(?<![\w-])(?:[a-z]+:)*(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|h|min-h|size)-\[\d+(?:\.\d+)?(?:px|rem|em)\]` – a left boundary so `max-w-[336px]` is not read as `w-[336px]`; `px|rem|em`; heights and `size` in, widths and `max-*` out.
- allowlist keyed on `file:spelling`, seeded in PR 3a with today's 90 occurrences, each row carrying a reason or "convert in 3b"; a fixture self-test proves `h-[34px]`, `size-[30px]` and `md:min-h-[54px]` each fail against an empty allowlist (the `git stash` red-then-green method AGENTS.md requires).
- It **fails** the suite (D-5). Owned by a test, never waived in prose.

### 9.4 The Roomy option (PR 4 – appearance)

- `Density = 'roomy' | 'comfortable' | 'compact' | 'ultra'` (`lib/appearance.ts:26`), default unchanged; `normalizeDensity` (`:48-50`) learns the value.
- `:root[data-density='roomy'] { --spacing: 0.3125rem; }` = 5 px per unit (+25 %, the mirror of ultra's −25 %; every rhythm value stays an integer). One block in `index.css` beside `:253-261`, mirrored in `cockpit.css` beside `:182-187`, and the selector added to `THEME_SELECTORS` in `design-system-drift.test.ts:40-47` – otherwise check 0 fails the suite.
- **The contract.** `density` is a closed enum in `packages/contract/src/workspace.ts:144`, duplicated in `packages/xezar/src/server/server.ts:727`, and `PUT /api/v1/workspace/ui-state` validates through it (`server.ts:3002`). Without the enum change Roomy 400s on save. PR 4 adds the value to the contract, deletes the `server.ts` duplicate (AGENTS.md § The HTTP API), and runs `contract-parity*` and `typed-bodies`.
- **Pre-paint.** `packages/web/index.html:36-38` stamps `data-density` only for `compact`/`ultra`; Roomy would paint Comfortable and jump. Add the value there.
- **Old versions.** The read path returns the stored string untouched (`workspace/ui-state.ts:25-37`); an older cockpit falls back through `normalizeDensity`, an older server rejects the PUT with 400 and the cockpit toasts and refetches (`appearance-provider.tsx:73-75`). Server and cockpit ship together, so this only matters for mixed versions. BACKWARD_COMPATIBILITY.md gets one line under the UI-state surface.
- Settings → Appearance gains "Roomy" ahead of "Comfortable" (`appearance.tsx:36-40`); hint copy per § 8.

### 9.5 Documentation and tests that change

| File | Change |
|---|---|
| `docs/design-system/foundations.md` § 4 | new § 4.1 Rhythm: `--spacing` at the default, the six tokens (one `` `--spacing-<name>` `` line each – mandatory for the drift test), the rule, the half-pixel note, the Roomy row in the density table |
| `docs/design-system/components.md` | rows for every component whose spelling changes (§ 9.2, § 9.3) |
| `docs/design-system/patterns.md` § 3, § 4, § 5 | page-body, table and card spellings |
| `docs/design-system/cockpit.css` | `--spacing`, the six tokens, the `roomy` block, every mirrored class whose padding/gap changed, the `.density-demo` |
| `docs/design-system/specimens/foundations.html` § 4 | the Rhythm bars; the appearance bar gains Roomy |
| `docs/design-system/known-gaps.md` | **G-25** recorded in PR 1; **deleted** in PR 2 with a `design-debt` issue linked (the file's own rule, `:6-8`); a row for the chip targets at tight densities |
| `docs/design-system/new-designs.md` § 2, § 5 | "use the rhythm tokens for gaps between blocks in a mockup"; Roomy in the appearance checklist |
| `docs/design-system/theming.md` | Roomy in the density paragraph |
| `.claude/skills/design-system/SKILL.md` | rule 17 (§ 8) |
| `.xezar/skills/xezar-ux-design.md:36` | the review checklist names the four densities |
| `packages/web/src/design-guardian.test.ts` | the `no-arbitrary-spacing` rule, allowlist, fixture self-test |
| `packages/web/src/design-system-drift.test.ts` | `THEME_SELECTORS` gains `roomy` |
| `packages/web/src/lib/utils.ts` (+ test) | `tailwind-merge` `theme.spacing` extension |
| `packages/web/index.html` | pre-paint density stamp |
| `packages/contract/src/workspace.ts`, `packages/xezar/src/server/server.ts` | the enum; delete the duplicate |
| `packages/web/src/components/ui/button.test.tsx` | the `h-8` / `size-8` assertions |
| `packages/web/e2e/rhythm.e2e.ts` (new) | AC 3 |
| `BACKWARD_COMPATIBILITY.md` | the appearance value |
| `designs/quality-checks`, `designs/decisions` | adopt the tokens in their next revision; a `design-debt` issue keeps the lifecycle clock honest |

### 9.6 Rollout

| Step | Content | Gate | Measure |
|---|---|---|---|
| Mockup | A full-page before/after mockup in this folder (D-4): Tasks, a thread, Settings → Agents, Inbox, at 1280 and 375 px, both themes; plus the five missing frames from § 6 | `design-review` verdict | the verdict |
| PR 1 | `--spacing` + six tokens in `index.css` and `cockpit.css`, `tailwind-merge`, foundations § 4.1, specimens, G-25, and (D-9) the settings pilot | `needs-design` if the pilot ships, else `skip-design` with the reason; drift test | the specimen bars at 8/12/16/20/24/32 from disk (AC 2) |
| PR 2 | § 9.2 across `packages/web/src`; G-25 deleted | `needs-design` + `needs-qa`; before/after screenshots at 1280 and 375, both themes, comfortable and ultra; `npm run test:e2e` | measured page heights (AC 4); `rhythm.e2e.ts` (AC 3) |
| PR 3a | the guardian rule, allowlist seeded with the 90, fixture self-test | `skip-design` (no rendered change) | allowlist length pinned |
| PR 3b | § 9.3 conversions; `button.test.tsx`; the known-gaps chip row | `needs-design` + `needs-qa`; `npm run test:e2e` (the suite asserts real geometry: `task-thread.e2e.ts:452`, `quick-list.e2e.ts:271-276, 650-668`, `diff-scroll.e2e.ts:38, 254-287`) | allowlist ≤ 2 with reasons |
| PR 4 | Roomy: enum, `normalizeDensity`, pre-paint, `THEME_SELECTORS`, Settings option, BC note, release note | `needs-design`; contract parity | AC 8 |

Order: mockup → 1 → 2 → 3a → 3b → 4. 3b after 2 so PR 2's screenshots compare rhythm alone.

## 10. Accessibility

- Nothing changes for screen readers: the same elements, the same order, the same names.
- Touch targets stay `h-11` (44 px) on phone at Comfortable and grow at Roomy (55 px). At Compact and Compact for real they shrink as they do today (38.5 / 33 px) – the density lever is proportional by decision D-3; the cockpit's own foundations § 12 only promises 44 px at the default (*inferred*: `foundations.md:301` says `h-11` on phone, shrink at `md:`).
- Two chips (`h-7`, `h-6`) fall under WCAG 2.2 SC 2.5.8's 24 px at the tight densities; today's hand-set 26 / 22 px chips already do. Recorded in `known-gaps.md`.
- Type sizes and line heights are untouched, so the G-23 contrast gap is neither better nor worse. Focus rings, motion, colour: untouched.

## 11. Responsive

- Phone gutters stay `p-4` (16 px); `section` applies at `md:` (768 px) and up.
- Nothing scrolls sideways at 375 px: the rhythm adds vertical space only; the table keeps `.table-scroll`; `a11y-sweep.e2e.ts` (390 / 1440) and `ios-sweep.e2e.ts` stay green.
- Roomy on a phone: rows 55 px – opt-in.
- The mockup's pairs stack to one column under 900 px; each frame keeps its own gutter. A 375 px frame joins the full-page mockup (D-4).

## 12. Acceptance criteria

1. `index.css` and `cockpit.css` declare `--spacing` and the six `--spacing-*` tokens with byte-identical value strings; each is named in `foundations.md`; `npm test -- packages/web/src/design-system-drift.test.ts` is green.
2. `specimens/foundations.html` opened **from disk** shows the six rhythm bars at 8 / 12 / 16 / 20 / 24 / 32 px.
3. `packages/web/e2e/rhythm.e2e.ts` asserts through `getComputedStyle` at the default density: a thread row inside a turn 8, a speaker-change row 24, card padding 20, card-list gap 16, settings field gap 12, settings list gap 32, desktop page padding 32, page body top 32 – and 75 % of each at `data-density='ultra'`, 125 % at `roomy`.
4. PR 2 reports measured `document.scrollHeight` for Tasks, a 30-row thread, Settings → Agents and Inbox at 1280×900, before and after.
5. `no-arbitrary-spacing` exists with an allowlist of exactly N rows (N pinned in PR 3a); fixture lines `h-[34px]`, `size-[30px]` and `md:min-h-[54px]` each fail it against an empty allowlist, proved red-then-green; after PR 3b the allowlist is ≤ 2, each row with a written reason.
6. Touch targets ≥ 44 px on phone at Roomy and Comfortable, and no smaller than today at Compact and Compact for real.
7. Nothing scrolls sideways at 375 and 390 px; both themes pass the design-system review checklist.
8. Roomy round-trips: the contract enum accepts it; `normalizeDensity('roomy') === 'roomy'`; `index.html` stamps it before first paint on a cold load; an older cockpit falls back to Comfortable; BACKWARD_COMPATIBILITY.md carries the line.
9. G-25 is recorded in PR 1 and deleted in PR 2 with a `design-debt` issue linked; every UI-in-scope PR carries `needs-design` with a `## Design review` comment, or `skip-design` with the reason in the body.

## 13. Open decisions

Decided on 2026-09-14 (owner): **D-1** change the default · **D-2** table rows stay 44 · **D-3** compact/ultra scale the new rhythm ("the layout should always look the same") · **D-4** a full-page mockup before PR 2 · **D-5** the pixel rule fails the build · **D-6** settings stay flat, 28 → 32 · **D-7** one lever · **D-8** no flag · **D-10** two thread gaps · the scale 8/12/16/20/24/32 · Roomy stays and is 5 px per unit.

| # | Question | Options | Recommendation | Owner |
|---|---|---|---|---|
| D-9 | PR 1: ship the tokens with one pilot surface (the settings fields), or tokens alone? | pilot / alone | **Pilot** – the tokens then have a user and the review sees something real; `needs-design` on PR 1 | pending |

## 14. Risks

| Risk | Effect | Answer |
|---|---|---|
| More scroll | thread and settings pages grow 5–15 % | that is the point; tables do not grow; the density lever still offers tighter |
| Users on Compact / Compact for real see their pages loosen | 75 % of the new rhythm at ultra is still looser than today's default | said in the release note (§ 8); D-3 |
| Roomy fails to save | the enum in the contract and the server duplicate | PR 4 changes both; contract parity proves it |
| The browser suite asserts real geometry | `task-thread.e2e.ts:452` (44 px bar), `quick-list.e2e.ts` (7 px dot, 264 px layout), `diff-scroll.e2e.ts` (card heights) | run `npm run test:e2e` in PR 2 and 3b; screenshots are artifacts, not goldens – nothing to rebase |
| `cn()` merges stop resolving for the new utilities | `p-4 p-inset` both kept | `tailwind-merge` extension in PR 1, with a test |
| The mockup sheet drifts from the cockpit | `cockpit.css` mirrors ~40 classes by hand | the drift test covers tokens, not class paddings; PR 2 updates both in one commit; leftovers go in the known-gaps mockup-fidelity table |
| Sibling mockups go stale | `designs/quality-checks`, `designs/decisions` draw today's rhythm; the lifecycle clock reverts an unimplemented Approved design after two releases | a `design-debt` issue in PR 2 |
| The kit's review checklist names density values | `xezar-ux-design.md:36`, `new-designs.md:51-54` | updated in PR 4 |
| `calc()` tokens cost | none in kind – every Tailwind spacing utility is already `calc(var(--spacing) * n)` | accepted |
| "Air" becomes taste in every review | reviewers argue numbers | the tokens end it: a gap is a token or it is wrong |

## 15. References

- [`review-2026-09-14.md`](review-2026-09-14.md) – the four reviews and every disposition
- `docs/design-system/foundations.md` § 3, § 4, § 5, § 9, § 12; `theming.md`; `components.md`; `patterns.md`; `new-designs.md`; `known-gaps.md`
- `packages/web/src/styles/index.css` (`--spacing` `:248-261`, `@theme static` `:280-293`, thread markdown `:498-538`)
- `packages/web/src/lib/appearance.ts`, `lib/utils.ts`, `routes/settings/appearance.tsx`, `packages/web/index.html:36-38`
- `packages/contract/src/workspace.ts:144`, `packages/xezar/src/server/server.ts:727, 3002`, `packages/xezar/src/workspace/ui-state.ts:25-37`
- `packages/web/src/design-guardian.test.ts`, `design-system-drift.test.ts`, `components/ui/button.test.tsx`
- The cited routes and components: `tasks-overview.tsx`, `global-tasks.tsx`, `task-thread/*`, `settings/*`, `inbox.tsx`, `components/app-shell.tsx`, `project-groups.tsx`, `task-quick-list.tsx`, `provider-banner.tsx`, `centered-state.tsx`, `run-header.tsx`, `review-panel.tsx`
- Spacing precedents: Atlassian space tokens, Carbon spacing scale, Radix Themes spacing (all carry 24; none carries 28)
- Tailwind v4 theme variables: `--spacing-*` entries in `@theme` mint named spacing utilities (verified by compiling with 4.3.2)

## 16. Design review

Four reviews on 2026-09-14 (UX, UI, fact-check, plan): all PASS WITH CHANGES. Five blocking findings and eighteen should-fix items, consolidated with dispositions in [`review-2026-09-14.md`](review-2026-09-14.md); this revision applies every one the owner decided (D-1..D-10). The `design-review` kit verdict on the full-page mockup (D-4) is pending.
