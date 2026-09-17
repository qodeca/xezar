# Verifying a UI change

Use this matrix before editing to set expected results and after building to record
what happened. Read it with the [usage guide](usage.md). Values stay in
[foundations](foundations.md), component entries and their owning source.

## Evidence record

For each applicable row, record the source revision, route, state, theme, accent,
density, viewport, reading width, method, expected result, observed result and
artefact link. Use passed, failed or not run; use N/A only with a reason. Keep
source inspection, fixture tests and live browser observations distinct. A green
source scan cannot prove target size, contrast, focus or absence of clipping.

Capture default, first-use empty, filtered empty, loading, error, refusal,
stale/partial and already-done states, or explain each inapplicable state. The
first six follow [new designs §4](new-designs.md#4-show-every-state) and
[patterns §6](patterns.md#6-empty-loading-and-error-states); the explicit split
and stale/partial/already-done checks carry the #453 P1 acceptance criteria.
Loading or missing data must not look like an empty success or a fabricated zero.

## Phone targets and chip floors

Owner decision for [#453](https://github.com/qodeca/xezar/issues/453#issuecomment-5686497380),
2026-09-15 21:06 CEST, Q2=A: require at least **44 × 44 CSS px** for phone interactive
targets at **every density** – Comfortable, Roomy, Compact and Compact for real.
Check the existing **24 px chip minimum height separately**, including caller
overrides. Passing that lower floor does not pass the phone target check.

This applies the phone rule in `docs/design-system/new-designs.md:65` across every density. It is an
acceptance policy, not a claim about current implementation. A class such as
`h-11` scales with density; its name is not proof of a 44 px target. Existing
smaller pins and controls remain debt, including the observation in
`docs/design-system/decisions.md:83` and `docs/design-system/behaviour.md:71`. Historical #424 measurements do not waive
this policy. Do not add arbitrary pixel utilities or grow the guardian allowlist
to make a target pass; an unresolved shared sizing change needs a design decision.

## Check matrix

Paths in the source column are repository-relative `file:line` citations. They
identify the rule or implementation to inspect, not a promise that it conforms.
Re-read the cited section at the candidate SHA when lines have moved.

| Check | Source of truth | Before editing | After building – method and evidence artefact |
| --- | --- | --- | --- |
| Geometry and pinned values | `docs/design-system/foundations.md:200`; `docs/design-system/decisions.md:31`; `packages/web/e2e/rhythm.e2e.ts:75`; `designs/design-system-air/handoff-values.md:12` | Identify affected gutter, field, card, thread and control rows. Link the owning value table and accepted decision; distinguish historical Today/Proposed columns from the current target. | Read computed padding, gaps and bounds in the rendered app. Record expected/actual values per density and viewport in a measurement table; retain browser test output. Do not paste a replacement token table into the design. |
| Task table and pin controls | `docs/design-system/patterns.md:55`; `docs/design-system/components.md:284`; `packages/web/src/components/pin-toggle.tsx:28`; `packages/web/src/routes/tasks-overview.tsx:867` | Inspect `packages/web/src/lib/task-columns.ts` and `packages/web/src/routes/tasks-overview.tsx`; list desktop rows, mobile cards and nested actions. | Measure pin bounds hidden, hovered, focused and pinned, with touch/no-hover too. Verify pinning does not open the row, words/pressed state stay correct and narrow rows retain reachable actions. Keep a pin result table, keyboard results and screenshots; apply the separate phone target row. |
| Chip floor | `docs/design-system/foundations.md:191`; `packages/web/src/components/picker-pill.tsx:20`; `docs/design-system/components.md:363` | List picker and reference-chip consumers and height overrides; inspect G-03 in `docs/design-system/known-gaps.md:29`. | Measure rendered minimum height at all four densities, including short or automatic-height callers. Keep measurements proving at least 24 px, plus applicable `packages/web/e2e/rhythm.e2e.ts` results. This checks the chip height floor, not general accessibility compliance. |
| Phone target policy | `docs/design-system/verification.md:22`; `docs/design-system/new-designs.md:65`; `docs/design-system/foundations.md:177` | Inventory every interactive target, including icon-only, chip, pin, menu and close controls at 375 px. Plan all four densities. | Measure the actual clickable width and height: both at least 44 CSS px. Check adjacent targets, clipping and reachability. Keep a target table with failures explicitly recorded and captures for each density; neither icon size nor spacing arithmetic is enough. |
| Responsive layout and keyboard clearance | `docs/design-system/behaviour.md:50`; `docs/design-system/foundations.md:352`; `docs/design-system/README.md:24` | Name layout transitions, scroll owners, safe areas and any docked composer. | At 375 px and desktop, verify no sideways document scroll, obscured actions or inaccessible content. Exercise the phone keyboard with the composer visible; inspect `dvh` usage. Keep before/after screenshots and a keyboard/scroll observation log. |
| Appearance | `docs/design-system/theming.md:7`; `docs/design-system/theming.md:67` | Plan light/dark, both accents, all densities and narrow/wide where applicable; include system-theme changes when touching theme behaviour. | Render the combinations and record wraps, overlap, legibility and width changes. For appearance changes, verify pre-paint and failed-save reconciliation too. Keep captures and test results naming the combinations actually checked; do not infer middle-density target sizes from the extremes. For target size, the owner’s Q2 policy overrides `docs/design-system/new-designs.md:59`, which says a page that holds at Roomy and ultra holds at the densities in between. |
| Keyboard and focus | `docs/design-system/behaviour.md:6`; `docs/design-system/components.md:319` | List Tab order, activation keys, Escape, shortcuts, focus return and hover-only actions; inspect G-06/G-21. | Exercise the flow without a pointer. Check visible focus, labels, dialog trapping/return and no-hover access; test IME/newlines if composer submission changes. Keep key-by-key results and focused screenshots or recordings. |
| Semantics and announcements | `docs/design-system/behaviour.md:34`; `docs/design-system/new-designs.md:68`; `docs/design-system/README.md:29` | Name controls, status words and announcing regions; separate read-only text from actions. | Inspect accessible names/roles and exercise status changes with assistive technology where affected. Verify polite updates, actionable errors and no colour-only meaning. Keep accessibility inspection and announcement results, with untested assistive technology marked not run. |
| Motion | `docs/design-system/behaviour.md:73`; `docs/design-system/foundations.md:281`; `docs/design-system/known-gaps.md:59` | Inventory animations/transitions and G-08 overlaps; choose the existing duration and reduced-motion behaviour. | Test normal and reduced motion; the state must remain understandable without movement. Keep recordings or computed-style observations and applicable tests. An unguarded existing animation is not permission to add one. |
| Colour tokens and contrast | `docs/design-system/foundations.md:8`; `docs/design-system/README.md:20`; `docs/design-system/known-gaps.md:163` | Select semantic tokens and check text/background pairs, both themes and accents. Keep amber text on `pending-strong`; observe the documented scrim exceptions. | Run the guardian and inspect actual rendered contrast. No raw colours, new `dark:` variants or design-token fallbacks. Keep scan output and contrast measurements; token use alone does not settle G-23. |
| Raw black and white | `docs/design-system/README.md:23`; `packages/web/src/design-guardian.test.ts:194` | Find `bg-white`, `text-white`, `bg-black` and `text-black`; select contrast tokens instead. Preserve only the documented `src/components/ui/` and `zoomable-image.tsx` scrim exceptions. | Run the guardian’s `no-raw-black-white` check and inspect the diff for new exceptions. Keep scan output and light/dark captures showing the selected tokens. |
| Native dialogs and destructive confirmation | `docs/design-system/README.md:25`; `packages/web/src/design-guardian.test.ts:204`; `docs/design-system/patterns.md:120` | Find native `window.confirm`, `alert` and `prompt` calls, including bare/globalThis forms; only the emitted bookmarklet program is exempt. Plan destructive confirmation with AlertDialog and a danger action. | Run the guardian’s `no-native-dialogs` check; exercise cancel and confirm, consequence copy, danger styling and focus return in the browser. Keep scan output, interaction results and dialog captures; the scan alone does not prove AlertDialog use or behaviour. |
| No arbitrary spacing pixels | `docs/design-system/decisions.md:64`; `packages/web/src/design-guardian.test.ts:237`; `packages/web/src/design-guardian-spacing-allowlist.json:1` | Inspect padding, margin, gap, space, height, min-height and size spellings. Existing allowlisted debt is not a reusable exception. | Run the guardian; convert new arbitrary spacing to the scale and do not grow the allowlist. Keep its output and the reviewed diff. D-06 is a spacing rule, not a ban on the typography values catalogued in foundations §3. |
| Spacing rhythm | `docs/design-system/foundations.md:200`; `docs/design-system/decisions.md:20`; `packages/web/e2e/rhythm.e2e.ts:87` | Use named rhythm between blocks and numeric scale inside controls. Select the owning surface rows, including page gutters and speaker changes. | Inspect classes and computed geometry across densities; run the applicable rhythm browser checks. Keep a measurement table and test log. The existing suite's selected surfaces/densities are evidence only for what it exercises. |
| States and truthful copy | `docs/design-system/new-designs.md:49`; `docs/design-system/patterns.md:98`; `docs/design-system/writing.md:8`; `docs/design-system/verification.md:15` | Complete the state inventory above, including failures and refusal recovery; choose page state, inline message or toast by scope. | Trigger each applicable state. Check words, next action, disabled reasons and absent values. Keep state screenshots, focused behaviour tests and reasoned N/A entries; distinguish a failed save from saved data. |
| Shared definitions | `docs/design-system/README.md:26`; `docs/design-system/patterns.md:70` | Locate attention, runner labels and task columns; identify which existing component renders the meaning. | Inspect imports and focused tests for `lib/attention.ts`, `lib/runner-label.ts` and `lib/task-columns.ts` under `packages/web/src`. Keep a reuse list and test results; do not add a local status map or loose task-table column. |
| Drift test | `packages/web/src/design-system-drift.test.ts:8`; `docs/design-system/README.md:49` | Check token documentation, shared-component boundaries and stylesheet ownership before changing a shared part. | Run `npm test -- packages/web/src/design-system-drift.test.ts`. Keep command, SHA and output. It checks token names in foundations/theming, component paths in coverage and stylesheet token parity; it does not render geometry or enforce commit timing. |
| Coverage rows | `docs/design-system/README.md:59`; `docs/design-system/coverage.md:5`; `packages/web/src/design-system-drift.test.ts:192` | Find every affected token, primitive, shared component and pattern row; note missing entries. | Update the owned entry/row with the code, remove stale paths and run drift. Keep the documentation diff and result. A documented row is inventory, not proof of visual or behavioural compliance. |
| Decisions, gaps and mockup fidelity | `docs/design-system/CONTRIBUTING.md:52`; `docs/design-system/CONTRIBUTING.md:61`; `docs/design-system/known-gaps.md:180`; `docs/design-system/new-designs.md:20` | Read affected G-nn and D-nn records and any superseding decision. Compare mockup base classes with the cockpit. | Fix touched debt or file the required design-debt issue; keep unresolved entries accurate. Close a gap only when its code is fixed; supersede decisions rather than delete them. Keep source-linked dispositions and specimen/app comparisons. Mockup styles must not copy tokens or base classes. |
| Design review screenshots | `SDLC.md:123`; `SDLC.md:132`; `docs/design-system/new-designs.md:49` | Identify the review target, state/appearance capture list and accepted design, if any. | Attach screenshots for the applicable states in both themes at 375 px and desktop to the `## Design review` evidence. Name SHA, route/state, theme, density and width for each capture. Include verdict and one disposition per finding under SDLC; a screenshot alone is not approval. |
| Required checks and handoff | `SDLC.md:112`; `SDLC.md:142`; `docs/design-system/CONTRIBUTING.md:32` | Assign focused tests, full gates, browser QA and design review to their owning stages. | Record passed/failed/not-run per command and revision; retain applicable browser QA and design review separately from source tests. Use the existing SDLC gates and exceptions with their evidence. A failed or missing required check stays pending. |

## Finish the record

Link the evidence from the PR and its design review. Keep temporary logs and
private working captures under the project's ignored `.local/`; durable feature
deliverables follow [designs/README.md](../../designs/README.md) and the repository's
working-file policy in [AGENTS.md](../../AGENTS.md). Maintained documentation must
not depend on a reclaimable worktree or private evidence path.

The owner chose instructions **and** closure of current debt for #453 (Q1=B,
2026-09-15). Debt fixes are later PRs. This matrix records what must be checked;
it neither waives existing failures nor claims the whole system already passes.
