# Air – the value tables

The reference tables of [`README.md`](README.md), split out so both files stay readable. The README keeps the narrative, the status and the decisions; every table here carries the README section number it belongs to, so a `§ 5 (d)`, `§ 5 (j)`, `§ 9.2` or `§ 9.3` reference – on a mockup page's `#values` table, in a PR body, in a review comment – still means what it always meant. **Nothing is renumbered.**

| Table | README section |
|---|---|
| Role variables: name · sheet · today (source) · proposed | § 5 (d) |
| Mockup-only departures | § 5 (j) |
| New defaults, surface by surface (PR 2) | § 9.2 |
| Pixels back on the scale (PR 3a rule, PR 3b conversions) | § 9.3 |

## § 5 (d) Role variables

Each drawn value that differs between the views is a role variable, declared in exactly one sheet (README § 5 (d) says which and why). These ~45 names exist only in this folder and never ship; the shipping spelling is the § 9.2 utility.

| Variable | Sheet | Today (source) | Proposed |
|---|---|---|---|
| `--gutter` | styles | u × 5 (`tasks-overview.tsx:211`, `inbox.tsx:93`); phone u × 3 | `--section`; phone u × 4 |
| `--body-top` | styles | `--gutter` – the body starts at the gutter | `--section`; phone u × 4 |
| `--btn-h`, `--btn-icon` | styles | 30px (`button.tsx:24, 26`), `.air-sm` buttons only | u × 8 |
| `--pill-h`, `--refchip-h` | styles | 26px (`picker-pill.tsx:22`), 22px (`reference-chip.tsx:148`) | u × 7, u × 6, floored at 24px in `shell.css` |
| `--status-pill-py` | styles | 3px (`pill.tsx:26`) | u × 1 (§ 9.3) |
| `--brand-gap` | styles | 9px (`app-shell.tsx:490`) | `--row` |
| `--cta-h` | styles | u × 9 (`button.tsx:23`, `app-shell.tsx:509`) | A u × 10 · B u × 9 (open point 7) |
| `--side-group-gap` | styles | 0 – a bucket heading's `pt-2.5` only (`task-quick-list.tsx:144`) | `--stack` |
| `--project-h`, `--nested-h` | styles | 34px, 30px (`project-groups.tsx:221, 260`; `:325`); phone u × 11 | u × 9, u × 8; phone u × 11 |
| `--project-gap` | styles | 7px (`project-groups.tsx:221, 260`) | u × 2 (nearest step – PR 3b decides) |
| `--quick-py` | styles | 7px (`task-quick-list.tsx:248, 425`) | u × 2 |
| `--th-h` | tasks | 38px (`tasks-overview.tsx:419`) | u × 10 |
| `--cell-px` | tasks | u × 2.5 (`tasks-overview.tsx:419, 514`) | u × 3 |
| `--tabs-pad` | tasks | 3px (`tasks-overview.tsx:158`) | u × 1 |
| `--footer-mt` | tasks | u × 3.5 (`tasks-overview.tsx:291`) | `--list` |
| `--mcard-pad`, `--mcard-gap` | tasks | u × 3 / u × 3.5 (`tasks-overview.tsx:904`), u × 2.5 (`:269`) | `--inset`, `--list` |
| `--table-gutter` | tasks | `--gutter` (`tasks-overview.tsx:211, 219`) | A `--gutter` · B u × 5 (open point 6) |
| `--run-head-x`, `--run-head-top` | thread | u × 6, u × 3 (`run-header.tsx:160`); phone u × 3, u × 2 | `--section`, `--group`; phone as today |
| `--title-gap` | thread | u × 2.5 (`run-header.tsx:222`); phone u × 1.5 | `--stack` |
| `--thread-x`, `--thread-y` | thread | u × 6, u × 5 (`task-thread.tsx:307`); phone u × 3 | `--section`; phone as today |
| `--turn-gap` | thread | u × 2.5 (`thread-scroller.tsx:410, 492`) | `--row` |
| `--speaker-gap` | thread | `--turn-gap` – no speaker boundary today | `--group`, on the outgoing speaker's last row (§ 9.2) |
| `--bubble-px` | thread | 15px (`thread-items.tsx:121, 167`) | u × 4 |
| `--tool-h`, `--tool-py` | thread | 28px, u × 0.5 (`thread-items.tsx:547`) | u × 8, u × 1 |
| `--trigger-h` | thread | 34px (`thread-items.tsx:615`) | u × 9 |
| `--nested-my` | thread | u × 2 (`thread-items.tsx:600`) | `--stack` |
| `--ask-pad`, `--ask-gap` | thread | u × 3.5 / u × 4, u × 4 (`ask-card.tsx:82, 87`) | `--inset`, `--list` |
| `--review-gap` | thread | u × 3 (`review-panel.tsx:39`) | `--stack` |
| `--dock-top`, `--dock-bottom` | thread | u × 1.5, u × 4 (`task-thread.tsx:409`); phone u × 1, u × 2 | `--stack`, `--list`; phone as today |
| `--composer-min-h` | thread | 54px (`composer.tsx:525`); phone u × 11 | u × 14 (PR 3b); phone as today |
| `--settings-nav-pad` | settings | u × 3 (`settings-shell.tsx:69`) | `--stack` |
| `--fields-gap` | settings | u × 7 (`agents-section.tsx:163`, `appearance.tsx:120`) | `--section` |
| `--field-gap` | settings | u × 2 (`settings-field.tsx:21`) | `--stack` |
| `--card-gap` | inbox | u × 2.5 (`inbox.tsx:128`) | `--list` |
| `--card-pad` | inbox | u × 4 (`inbox.tsx:227`) | `--inset` |
| `--card-head-gap` | inbox | u × 3 (`inbox.tsx:229`) | `--stack` |
| `--meta-mt` | inbox | u × 1.5 (`inbox.tsx:242`) | `--row` |
| `--dot-mt` | inbox | 5px (`inbox.tsx:234`) | u × 1.5 (nearest step – PR 3b decides) |

Written once, as literals, because both views draw them unchanged: the table row `h-11` and its 16 px cell edges; the settings containers `p-4 md:p-6` and the refusal's `gap-4`; the Inbox card's inner `gap-2.5`; the project-group body indent `ml-[14px]` (`project-groups.tsx:300`; § 9.2 moves it to `ml-3.5`, the same 14 px at Comfortable); the mobile bar `h-11`; the dialog, diff and centered-state internals. The review chrome has one variable of its own: `--air-bar-h` in `styles.css`, the bar's measured height above 860 px and `0px` at 860 px and below and inside frames. Focus and anchors clear the bar through a scroll margin on the page's content (`chrome.css:107-110`), not a root `scroll-padding-top`: the padding also counted the sticky bar, sidebar and page head, so tabbing into them threw a scrolled page back to the top. Sticky chrome keeps no margin; on the task page `thread.css` widens the top margin under the run header and adds a bottom margin for the dock.

## § 5 (j) Mockup-only departures

Where a `cockpit.css` base class disagrees with the source, the mockup draws the source value in both views, through a local replica or a mirrored selector, and leaves `cockpit.css` as it is. `known-gaps.md` cannot change in step 0; PR 2 adds the rows it does not fix to the mockup-fidelity table (§ 14).

| Class | `cockpit.css` | Source | The mockup draws |
|---|---|---|---|
| `.btn-new-task` | `:591` `height: 34px` | the default size `h-9` = 36 (`button.tsx:23`, `app-shell.tsx:509`) | 36 today; 40 (A) or 36 (B) proposed |
| `.sidebar-head` | `:551` `gap: 8px` | `gap-[9px]` (`app-shell.tsx:490`) | 9 today; `--row` 8 proposed |
| `.quick li` | `:724` `height: 32px` | `py-[7px]`, height from content (`task-quick-list.tsx:248, 425`) | 7 / 8 padding |
| `.sidebar-foot` | `:768` one row, `padding: 10px`, `gap: 8px` | two rows, `flex-col gap-1.5 px-3.5 py-2.5` (`app-shell.tsx:627`) | the source |
| `.sidebar` in `.shell` | `:525-546` as tall as its content | one screen tall, `h-dvh overflow-hidden` (`app-shell.tsx:239`) | the source |
| `.mobile-bar` | `:2353` `height: 52px`, `padding: 0 14px` | `h-11 gap-2.5 px-3` (`app-shell.tsx:848`) | 44 |
| `.page-head` | `:798-804` `height: 56px`, `padding: 0 20px`, `gap: 12px` – three hand-set pixels | `h-14 px-5 gap-3` (`tasks-overview.tsx:156`; `patterns.md:43`) – the same 56 / 20 / 12, but on the scale | the source, respelled on `--u` in `shell.css`, so the density lever reaches all three |
| `.btn`, size `sm` | `:907-915` `gap: 6px`, `padding: 0 12px`, `font-weight: 500` | `gap-[7px]`, `px-2.5` = 10, `font-semibold` (`button.tsx:12, 24`) | the source, on every `.air-sm` button (`shell.css:214-216`) |
| `.settings-field` | `:2271` `padding: 18px 0` and a top border | a flat list: `gap-7` between (`agents-section.tsx:163`), `gap-2` inside (`settings-field.tsx:21`) | `.air-field` |
| `.settings-pills a` | `:2254` `height: 28px`, `padding: 0 10px` | `px-3 py-1.5 text-[13px]` (`settings-shell.tsx:138, 149`) | the source |
| `.segmented` | Appearance's control is `.radio-segment` (`:1300`), not `.segmented` | `inline-flex w-fit gap-0.5 … p-0.5` (`appearance.tsx:66`) | `.air-seg` on `.radio-segment` |
| `.tasks-table th`, `td` | `:1965-1976` `padding: 8px 12px` and `10px 12px` | th `h-[38px] px-2.5`, td `h-11 px-2.5 first:pl-4 last:pr-4` (`tasks-overview.tsx:419, 514`) | `.air-table` |
| `.task-head` | `:2043` `padding: 18px 24px 14px` | `px-3 pt-2 md:px-6 md:pt-3` (`run-header.tsx:160`) | `.air-run-head` |
| `.centered-state` | `:1592-1599` `gap: 16px`, `padding: 48px 24px`, both on one element | `px-6 py-12` on the outer element and `gap-4` on a `max-w-md` stack, both on the scale (`centered-state.tsx:51, 56`) | the source: the same 48 / 24 / 16 on two elements and on `--u` (`inbox.css:152`, mirrored by `.air-loading .centered-state` for the loading state) |
| `.diff header` | `:1782` `padding: 6px 12px` | `px-3 py-2` (`diff-view.tsx:324`) | 8 top and bottom |
| `.composer .foot` | `:1923` `padding: 4px 8px 8px` | `md:px-2 md:pt-1.5 md:pb-2` (`composer.tsx:547`) | the source |
| `.composer .send` | `:1936` `border-radius: 999px` | `icon-sm`, so `rounded-sm` (`button.tsx:26`; `composer.tsx:578, 583`) | the source |
| `.logo` | `:555-559` 24 × 24 | `size-[26px]` (`app-shell.tsx:836`) | 24 – not corrected, cosmetic |

`.page-head` and `.centered-state` are the two rows where `cockpit.css` and the source agree on the number and disagree on the spelling: the sheet hand-sets pixels the density lever cannot reach, the source is on the scale. The mockup draws the source, so all four densities move those surfaces – which is the proposal itself (§ 1, move 3).

Also recorded while drawing:

- The sidebar is the multi-project one (`registry.projects.length > 1`, `app-shell-container.tsx:108` → `app-shell.tsx:531`). The flat nav rows (`md:h-[34px]` → `md:h-9`, `app-shell.tsx:572`) and the Active / Archived list tabs (`p-[3px]` → `p-1`, `task-quick-list.tsx:75`) render only with one project; `tasks.html` lists them and does not draw them.
- Settings → Agents has nine blocks: Providers and Default runner sit above the seven fields (`agents-section.tsx:165-172`).
- The per-project Tasks page has no phone group headings (`tasks-overview.tsx:269`); only the global tasks page does (`global-tasks.tsx:432`).
- The folded Branch column renders 30 px: its 42 px (`tasks-overview.tsx:231`) is a preference that Chrome shrinks once the table overflows.
- Mark unread, Pin and Archive (`run-header.tsx:276, 294, 300`) are not drawn: with all eight review actions the tab row overflows, 820 → 1,074 px.
- `rounded-2xl` emits no rule (`index.css:281` resets `--radius-*`), so the shipped user bubble rounds only its bottom-right corner (`thread-items.tsx:167`); both views draw it that way.

## § 9.2 New defaults, surface by surface (PR 2 – the cockpit)

| Surface | Today | Proposed | Delta |
|---|---|---|---|
| Thread row inside a turn | `pb-2.5` (10) | `pb-row` (8) | −2 |
| Thread row at a speaker change | `pb-2.5` (10) | 24 between the two speakers' rows: the outgoing speaker's last row takes `pb-group` instead of `pb-row` – `thread-groups.ts` already knows the boundary | +14 |
| Thread column gutters | `md:px-6 md:py-5` | `md:px-section md:py-section` (32) | +8 / +12 |
| Tool row | `min-h-[28px] py-0.5` | `min-h-8 py-1` (32) | +4; on scale – delivered by PR 3b (§ 9.3) |
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
| Table header | `h-[38px]` | `h-10` (40) | +2; on scale – delivered by PR 3b (§ 9.3) |
| Table footer strip | `mt-3.5` | `mt-list` (16) | +2 |
| Table wrapper on the task page | inside the gutter | keeps `px-section` – the table already scrolls sideways behind `overflow-x-auto` (D-11 = A, step-0 review) | 0 |
| Global tasks page | `gap-3 p-3 md:p-5` | same as the page body | +12 |
| Mobile task card | `px-3.5 py-3` | `p-inset` (20) | +6 / +8 |
| Sidebar nav rows | `md:h-[34px]`, container `py-1.5` | `md:h-9` (36), groups `gap-stack` | +2; on scale – `md:h-9` delivered by PR 3b (§ 9.3), the group gap here |
| Sidebar quick-list rows | `py-[7px]` (32) | `py-2` (34) | +2; on scale – delivered by PR 3b (§ 9.3) |
| Sidebar brand / footer rows | `gap-[9px]`, `gap-1.5` | `gap-row`, unchanged | −1 / 0 – `gap-row` delivered by PR 3b (§ 9.3), in this spelling |
| Project-group body | `mt-1 ml-[14px] pl-2` | `mt-1 ml-3.5 pl-2` | 0; on scale – delivered by PR 3b (§ 9.3) |
| Banner row | `min-h-9 px-4` | `min-h-10 px-section` | +4 / +16 |
| Review panel | `gap-3`; banner `px-3.5 py-2.5` | `gap-stack`; banner unchanged | 0 |
| Dialog / sheet / popover / menu / tooltip / toast / select / command | control-internal (`ui/*`) | unchanged | 0 |
| Diff and code views | `px-3 py-2`, `px-4 py-0.5`, `leading-[1.7]` | unchanged – code density is a feature | 0 |
| Inline empty states, command palette | `py-6`, `py-10`, `top-[10vh]` | unchanged | 0 |
| Centered state | `gap-4 px-6 py-12` | unchanged | 0 |
| Settings section containers | `p-4 md:p-6` (`agents-section.tsx:163`, `appearance.tsx:120`; `accounts-section.tsx:147` with `gap-4`) – the page-body row above cites `settings-shell.tsx:222`, the settings index page only | `p-list md:p-group` (16 / 24); the Agent accounts refusal keeps `gap-4` – inside one block (step-0 review NB-1) | 0 |
| Inbox card inside | `gap-2.5` (`inbox.tsx:227`) | unchanged – inside one block (step-0 review NB-1) | 0 |
| Page header x | `px-5` (20) (`tasks-overview.tsx:156`, `inbox.tsx:84`, `settings-shell.tsx:180`) | `md:px-section` (32) – the title lines up with the 32 px body gutter (step-0 review NB-1) | +12 |

**One change, one owner.** Six rows above are § 9.3 conversions of a hand-set pixel, and each says *delivered by PR 3b (§ 9.3)*: the tool row, the table header, the nav-row height, the quick-list row, the brand gap and the project-group indent. PR 2 does not touch them, which is what the rollout (§ 9.6) already assumes on both sides – PR 3a seeds its allowlist with all 88 occurrences, and PR 2's before/after screenshots compare the rhythm alone.

## § 9.3 Pixels back on the scale (PR 3a rule, PR 3b conversions)

| Today | Proposed | Note |
|---|---|---|
| `md:h-[34px]` nav row | `md:h-9` | 36 px; `.btn-new-task` above it is `h-9` too – take the CTA to `h-10` so the hierarchy holds (UI-7), or prove it on the screenshot |
| `md:h-[30px]` nested nav | `md:h-8` | 32 px |
| `h-[38px]` table header | `h-10` | 40 px |
| `h-[30px]`, `size-[30px]` button | `h-8`, `size-8` | 32 px – the one visible control-size change; `md` stays `h-9`; `button.test.tsx:38-41` updates with it |
| `px-[15px]` bubble | `px-4` | 16 px |
| `min-h-[28px]` tool row, `h-[34px]` group trigger | `min-h-8`, `h-9` | 32 / 36 px |
| `h-[26px]` picker pill, `h-[22px]` reference chip | `h-7 min-h-[24px]`, `h-6 min-h-[24px]` | 28 / 24 px at the default; without a floor they fall to 21 / 18 px at Compact for real, under WCAG 2.2 SC 2.5.8's 24 px. The absolute `min-h-[24px]` holds them at 24 at every density; these two floors are the only allowlist rows PR 3b leaves behind |
| `p-[3px]`, `py-[3px]`, `py-[7px]` | `p-1`, `py-1`, `py-2` | 4 / 4 / 8 px |
| `md:min-h-[54px]` composer | `md:min-h-14` | 56 px |
| `md:min-h-[30px]` step rail (`step-rail.tsx:164`) | `md:min-h-8` | 32 px; the mockup still draws 30 (`thread.css:139`) – PR 3a re-counts from the tree (step-0 review NB-2) |
| `pl-[22px]`, `gap-[7px]`, `px-[5px]`, `gap-[9px]`, `ml-[14px]`, `mt-[5px]`, `pl-[15px]`, `pl-[26px]`, `px-[7px]` | nearest scale step | listed one by one in PR 3b's allowlist diff; `gap-[9px]` takes § 9.2's `gap-row` and `ml-[14px]` § 9.2's `ml-3.5` |
| `w-[336px]`, `w-[264px]`, `max-h-[…]` | out of scope | widths and max-heights are layout facts; the rule does not cover `w` or `max-*` |
| `size-[15px]` ×12, `size-[17px]` ×2 icon glyphs; `h-[3px]` ×3, `md:h-[3px]`, `h-[9px]` hairlines | PR 3b converts (`size-4`; `h-0.5` / `h-1` / `h-2`) or narrows the pattern to drop `size` and heights under 4 px – the implementer's call, recorded in the PR | 19 of the 88 matches are glyph sizes and hairlines, not spacing; AC 5's "exactly two rows" holds either way |
| `pb-[calc(90px+env(safe-area-inset-bottom))]` | one shared class `pb-dock` | a layout fact, not a density concern |
| `rounded-[18px]`, `rounded-[6px]` | unchanged | radius is a non-goal (§ 4) |
