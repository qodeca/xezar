# Xezar recipes

These recipes describe xezar's own cockpit. Source paths are implementation examples
for this repository, not a file structure other projects should adopt. Start with
[usage](usage.md), then read the owning [patterns](patterns.md),
[components](components.md) and [writing rules](writing.md). Values remain in
[foundations](foundations.md); this page introduces no tokens or variants.

## Rules shared by every recipe

- Compose named rhythm between blocks (`row`, `stack`, `list`, `inset`, `group`,
  `section`); use the numeric spacing scale inside controls. Both follow `--spacing`.
  See [foundations §4](foundations.md#4-spacing-and-density).
- At 375 px, measure every interactive target at **44 × 44 CSS px or larger** at
  Comfortable, Roomy, Compact and Compact for real. Check width as well as height,
  nested actions, no-hover access and keyboard focus. The **24 px chip height floor
  is a separate check**. A density-scaled `h-11` or an existing small pin is not
  evidence of compliance. Follow [verification](verification.md#phone-targets-and-chip-floors).
- Use sentence case, `…`, concrete verbs for actions and full sentences for hints.
  Status words describe observations; colour reinforces them. Follow
  [writing](writing.md), including its surface-specific exceptions.
- Inventory default, first-use empty, filtered empty, loading, error, refusal,
  stale/partial and already-done states. The cases below are review requirements,
  not claims that every current surface implements them. Record N/A with a reason.
- Use the [verification matrix](verification.md#check-matrix) for geometry,
  both themes and accents, all densities, applicable reading widths, keyboard,
  announcements, motion and contrast. Source inspection and passing drift tests
  do not substitute for rendered measurements. Read [known gaps](known-gaps.md)
  before copying an implementation.

## 1. Task table, phone cards and pinned list

**Use when:** scanning, filtering or opening concurrent tasks, including the
sidebar's narrow quick list.

**Compose:** `TASK_COLUMNS`, `ToolNameCell`, `ModelNameCell`, `Pill`, `StatusDot`,
`ReferenceChip`, `DiffStatLabel`, `DirectionalUsage` and `PinToggle`. Keep backend
and model text in `runner-label.ts`; phone metadata uses those text helpers rather
than inserting desktop cell components. Use `bg-card`, `border-border`,
`hover:bg-muted`, foreground/muted text and `text-violet` for the pin/unread marks.
Phone cards use `p-inset` and `gap-list`; the table footer uses `mt-list`.
See [lists and tables](patterns.md#4-lists-cards-and-tables) and
[TaskQuickList](components.md#taskquicklist).

**Real implementations:** [tasks-overview.tsx](../../packages/web/src/routes/tasks-overview.tsx),
[task-columns.ts](../../packages/web/src/lib/task-columns.ts),
[task-agent.tsx](../../packages/web/src/components/task-agent.tsx) and
[task-quick-list.tsx](../../packages/web/src/components/task-quick-list.tsx).

- Desktop header, colgroup and rows consume the same column list. Preserve
  capability-hidden columns and fold controls with `aria-pressed`.
- Below `md`, the per-project table becomes cards with an always-visible pin.
  Nested links and buttons must act without opening the row.
- The quick list keeps the title flexible and lets secondary details drop as
  width shrinks. Dot, reference chip and pin are siblings of its link. Preserve
  pinned, hovered, focused and no-hover pin visibility.
- The cross-project table in
  [global-tasks.tsx](../../packages/web/src/routes/global-tasks.tsx) has its own
  columns and hides some at breakpoints; it does not share the phone-card layout
  (G-17). Do not infer parity from the shared agent cells.

**Density and targets:** apply the shared rule to fold toggles, filters, pins,
reference links and card actions at every density; measure hidden/revealed pin
bounds too. Row height alone does not establish the pin's target size.

**Copy and states:** follow [writing rules](writing.md#4-buttons-and-menu-items).
Use “Pin task” / “Unpin task”, “No tasks yet” versus “No matching tasks”, and `—`
for absent metrics instead of fabricated zeroes. Preserve the model helper's
`auto` distinction. Cover loading before the first answer, failed fetch or pin
mutation, empty archive, unread/read, queued/running/terminal rows, unavailable
reference data and an already-pinned task; explain any inapplicable refusal.

**Design review:** use the [table/pin, phone target and state rows](verification.md#check-matrix).
Check long titles/models, folded columns, narrow quick-list priorities, nested
clicks, keyboard access and touch visibility. G-03, G-17, G-21 and G-23 remain
relevant debt. Historical table and quick-list dimensions have the limits below.

## 2. Task thread and composer

**Use when:** reading live or retained agent work, replying, answering a question
or starting a task.

**Compose:** `SessionTranscript`, `RunHeader`, `AgentsDock`, `PlanDock`, `Composer`,
`PickerPill`, `RunnerPill`, `PromptTemplateMenu`, `StatusDot` and `ReferenceChip`.
The transcript separates rows within a turn (`pb-row`) from a speaker change
(`pb-group`). The reading column uses `--measure`; desktop column and dock align
on `md:px-section`, with `md:py-section` for the body and
`md:pt-stack md:pb-list` for the dock. The composer uses `bg-card`, `border-border`
and the `ring` focus treatment. See [Composer](components.md#composer) and
[foundations rhythm](foundations.md#41-rhythm).

**Real implementations:** [task-thread.tsx](../../packages/web/src/routes/task-thread/task-thread.tsx),
[session-transcript.tsx](../../packages/web/src/routes/task-thread/session-transcript.tsx),
[thread-scroller.tsx](../../packages/web/src/routes/task-thread/thread-scroller.tsx),
[new-task.tsx](../../packages/web/src/routes/new-task.tsx) and
[composer.tsx](../../packages/web/src/components/composer/composer.tsx).

- Keep history boundaries distinct from a live tail: older-page loading/failure
  must not look like a complete empty transcript. Preserve reading position while
  inspecting history and the explicit jump-to-latest action. Thread scroll rules
  live in [thread-scroll.ts](../../packages/web/src/routes/task-thread/thread-scroll.ts).
- The host owns the dock and keyboard inset; the shared composer owns text,
  attachments, autocomplete and submission. Keep the reply reachable above the
  phone keyboard, within the shell's scroll arrangement, using `dvh` rules.
- `/new` composes its own runner/model pills with its persisted draft and variants.
  [engine-pills.tsx](../../packages/web/src/components/engine-pills.tsx) instead owns
  the shared runner/model pair for Inbox and GitHub start surfaces. Reuse its
  resolution rules there; do not claim `/new` renders `EnginePills`.
- Follow [keyboard behaviour](behaviour.md#1-keyboard-and-focus): Enter sends,
  Shift+Enter inserts a newline, ⌘↵ / Ctrl+↵ sends; check autocomplete selection,
  Escape, IME composition and caret return. Preserve failed-send draft recovery.

**Density and targets:** measure send, attach, remove, dictation, picker, history
and jump controls under the shared 44 px rule. Check the separate chip floor and
caller overrides. Preserve turn hierarchy at every density and both reading widths.

**Copy and states:** follow [writing](writing.md): pending verbs such as “Sending…”,
a concrete disabled reason and actionable failures. Cover no events, queued work,
streaming, waiting for a reply, review, closed session, failed send with draft
restored, missing/failed older history, partial retained history, provider/model
loading or unavailable choices and an already-submitted action. Filtered empty
belongs to a picker when applicable, not a fictitious thread filter.

**Design review:** use the [responsive, keyboard, motion and state rows](verification.md#check-matrix).
Check speaker hierarchy in flat and virtual rendering, reading-position stability,
keyboard clearance, focus/caret recovery and attachment removal without hover.
G-03, G-08, G-09 and G-21 are existing debt, not reusable exceptions. Historical
thread/dock spacing is superseded as described below.

## 3. Settings sections

**Use when:** editing a project or workspace preference, or showing its read-only
summary within the existing settings navigation.

**Compose:** `SETTINGS_SECTIONS`, `SettingsField`, `Input`, `Textarea`, `Switch`,
`Button` and the existing native select/number controls where they ship. Do not
adopt the unused `Select` just because it exists (G-11/G-20). Use `gap-section`
between fields and `gap-stack` within a field; keep `bg-muted` active desktop
navigation and `bg-contrast text-contrast-foreground` active phone pills.
See [settings and forms](patterns.md#8-settings-and-forms).

**Real implementations:** [settings-shell.tsx](../../packages/web/src/routes/settings/settings-shell.tsx),
[registry.tsx](../../packages/web/src/routes/settings/registry.tsx),
[settings-field.tsx](../../packages/web/src/routes/settings/settings-field.tsx) and
[resources-section.tsx](../../packages/web/src/routes/settings/resources-section.tsx).

Preserve project/global scope in the registry. Keep a flat list of fields;
reuse `SettingsField` instead of another private wrapper (G-13). Selects and
switches save on change; text and numbers use a local draft and explicit Save.
Keep page failure in `CenteredState`, field validation beside its control and
mutation failure in a danger toast. Destructive removal uses `AlertDialog`.

**Density and targets:** apply the 44 px rule to phone section pills, switches,
inputs, saves and remove actions at all densities. Check horizontal navigation
reachability, labels and aligned desktop gutters, not just control heights.

**Copy and states:** follow [writing](writing.md): noun section titles, “Save” /
“Saving…”, full-sentence hints spelling out sentinels and “Could not load X” with
“Retry”. Cover saved/unchanged, dirty, saving, first-use empty summary, loading,
load/save error, refused edit with who can act, stale/partial summary and already
saved. Mark filtered empty N/A unless the section has a filter. Do not present a
refused save as persisted success.

**Design review:** use the [geometry, keyboard, copy and state rows](verification.md#check-matrix).
Check field hierarchy, label association, save semantics, refusal recovery and
contrast. G-11, G-13, G-15, G-22 and G-23 identify existing differences; the old
Air settings baseline is not the current rhythm.

## 4. Overlays and transient feedback

**Use when:** confirming an irreversible action, completing a bounded form,
opening navigation or a drill-down, finding a command or reporting a mutation.

**Compose and choose:** follow [overlays](patterns.md#7-dialogs-sheets-command-palette-toasts-and-notifications)
and the matching [primitive entries](components.md#1-primitives-srccomponentsui).

| Job | Composition and real implementation |
| --- | --- |
| Removal confirmation | `AlertDialog`, `AlertDialogCancel`, danger-tinted `AlertDialogAction`; [remove-project.tsx](../../packages/web/src/routes/settings/remove-project.tsx). Name the object and consequence. Use “There is no undo.” only when true. |
| Form | `Dialog`, title, description, form and footer buttons; [commit-dialog.tsx](../../packages/web/src/routes/task-git/commit-dialog.tsx). Cancel first in DOM, submit last; preserve ⌘↵ / Ctrl+↵. |
| Navigation or drill-down | `Sheet` left for the mobile drawer in [app-shell.tsx](../../packages/web/src/components/app-shell.tsx); right for [subagent-sheet.tsx](../../packages/web/src/routes/task-thread/subagent-sheet.tsx). |
| Find and act | `Command` within `CommandDialog`; [command-palette.tsx](../../packages/web/src/components/command-palette.tsx). Preserve ⌘K / Ctrl+K, search, selection and Escape. |
| Mutation feedback | `toast` and the shared `Toaster`; [toaster.tsx](../../packages/web/src/components/ui/toaster.tsx). Default or danger tone; no additional route-local toaster. |

Dialog uses `bg-card` and `shadow-modal`; Sheet uses `bg-background`. Toast uses
`bg-contrast text-contrast-foreground`, with danger tokens for failure. Preserve
these documented distinctions rather than normalizing them from a mockup.
Use the existing primitive spacing and numeric control scale.

**Density and targets:** the shared 44 px rule includes close, cancel, confirm,
menu results and any dismiss controls on phone, at every density. Check portal
bounds, scrolling, the phone footer order and keyboard focus return.

**Copy and states:** follow [writing rules](writing.md#4-buttons-and-menu-items):
explicit destructive verb, “Keep it” or the specific kept outcome; “Cancel” for a
form; pending verb with `…`; short toast fragments without a period, full sentences
with one. Cover closed/open, empty form or no search results, loading, submitting,
validation/mutation error, refusal, stale object and already-removed/committed
outcome. Do not repeat a destructive action on stale data. A toast has no first-use
empty state; record that N/A rather than inventing one.

**Design review:** use the [dialog, keyboard, phone target and motion rows](verification.md#check-matrix).
Check focus trapping/return, Escape, labelled close buttons, consequence copy,
danger styling, contrast and reduced motion. G-06, G-07, G-10 and G-16 remain debt.
Historical quality-checks overlays are proposals, not substitute primitives.

## 5. State and marker selection

**Use when:** conveying run activity, a reference's state, an attention count or
absence/failure without making an observation look like an action.

**Compose and choose:**

| Meaning | Existing composition and source |
| --- | --- |
| Run state | `deriveAttention` → neutral `Pill` with `StatusDot`, tone, pulse and lower-case label; [attention.ts](../../packages/web/src/lib/attention.ts), [pill.tsx](../../packages/web/src/components/pill.tsx). Do not map status colours locally. |
| PR or issue | `ReferenceChip` and reference vocabulary from [reference-status.ts](../../packages/web/src/lib/reference-status.ts); [reference-chip.tsx](../../packages/web/src/components/reference-chip.tsx). Preserve unknown, loading, unavailable, not-found and conflict distinctions. |
| Navigation attention | Violet count or update dot with words/accessibility text; [project-groups.tsx](../../packages/web/src/components/project-groups.tsx). Unknown and zero counts do not produce a badge. |
| Page empty/loading/error | `CenteredState`; [centered-state.tsx](../../packages/web/src/components/centered-state.tsx), used by [tasks-overview.tsx](../../packages/web/src/routes/tasks-overview.tsx). |
| Local load or validation | Muted inline loading text; sibling `text-danger` validation; [resources-section.tsx](../../packages/web/src/routes/settings/resources-section.tsx). Mutation errors use the shared danger toast. |

Use semantic `success`, `danger`, `violet`, `neutral` and `pending` roles through
their owners; reference tones additionally include `info` and `conflict`.
Amber text is `pending-strong`. Follow [status](patterns.md#5-status) and
[empty/loading/error](patterns.md#6-empty-loading-and-error-states).
Navigation badges are distinct from status chips. The red development-build mark
is the specific [D-08 exception](decisions.md#d-08-a-red-d-badge-marks-the-development-build-on-the-brand-tile), not
permission for another red attention badge; D-01's quality-checks badge choice
remains open in that record.

**Density and targets:** read-only markers are not buttons. Apply the shared 44 px
rule wherever a chip, reference, retry or state action is interactive, at every
density; verify reference-chip floors separately. Preserve `CenteredState` spacing
and readable hierarchy rather than copying a historical dashed empty box.

**Copy and states:** follow [writing rules](writing.md#5-empty-states): absence in a
fragment title, mechanism/next action in its subtitle, “Could not load X” for load
failure and the server's refusal sentence with who can act. Cover all eight shared
states: first-use and filtered emptiness differ; loading is not empty; stale or
partial data is labelled; already-done is not another invitation to mutate.
Keep words for pulsing/coloured markers and counts; never fabricate a zero from
missing data.

**Design review:** use the [semantics, contrast, motion and state rows](verification.md#check-matrix).
Check the attention derivation, accessible names/announcements, no colour-only
meaning, recovery actions and real text contrast. G-05, G-08, G-14 and G-23 remain
open implementation concerns. A documented token or marker is not a compliance
certificate.

## Limits of historical designs

[Design folders](../../designs/README.md) preserve rationale and proposals. They
are not shipped components, and their CSS must not be imported into the app.
For every recipe above, resolve geometry against current foundations and source,
then use [verification](verification.md) to measure the actual result.

- [design-system-air](../../designs/design-system-air/README.md), #424: its “Today”
  tables are the pre-rhythm baseline. The shipped rhythm in
  [foundations §4.1](foundations.md#41-rhythm) supersedes those old thread rows,
  thread/dock gutters, settings gaps, card spacing and table-cell values. Its
  [handoff values](../../designs/design-system-air/handoff-values.md) distinguish
  baseline and proposal; neither column alone proves current rendered geometry.
  Roomy now exists. Historical #424 target measurements do not waive the newer
  44 px requirement at every density.
- [quality-checks](../../designs/quality-checks/README.md) remains an In review
  proposal with a FAIL recorded in its handoff at this source revision. Its old
  thread body/header, quick-list heading and table spacing are superseded by #424's
  rhythm for new cockpit work. The exact remaining differences, including empty
  boxes, skeletons, toasts and the proposed red nav badge, are recorded in
  [mockup fidelity](known-gaps.md#mockup-fidelity-designsquality-checks-on-the-shared-stylesheet).
  Its state gallery can suggest cases; it does not approve that grammar.
- [decisions](../../designs/decisions/README.md) is a Draft for a new feature, not a
  shipped settings, thread or status recipe. Its feature requirements remain
  local to that proposal. Any older base layout must defer to the current #424
  rhythm; this does not mean #424 implemented or approved the Decisions feature.

Owner scope for [#453](https://github.com/qodeca/xezar/issues/453), 2026-09-15:
these instructions accompany later fixes for all current visual/accessibility
debt. Publishing the recipes does not close that debt or certify production readiness.
