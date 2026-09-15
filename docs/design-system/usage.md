# Using the design system

Use this guide to turn a UI brief into a reading list, a reuse plan and evidence.
The [index](README.md) owns the core rules; [foundations](foundations.md) owns values.
Read the affected source alongside the docs. A documented gap is work to account for,
not a pattern to copy. This guide adds no tokens or component variants.

## Start with the task

Write down the reader, their job, the affected routes, the accepted outcome and the
states that could prevent it. Name the source revision and any accepted design.
For a fix, include the reproduction and expected behaviour. For a feature, include
its scope, data and action boundaries, then use the design-first route below.
Missing product decisions stay open; a plausible mockup is not acceptance.

Apply the existing rules to the brief:

- Help people scan concurrent work – reuse the task columns and attention labels
  instead of inventing local status words ([patterns](patterns.md) §§4–5).
- Make actions distinct from observations – label controls with verbs and keep
  status meaning in words ([writing](writing.md) §4, [index](README.md) rule 10).
- Explain why work cannot proceed – distinguish loading, absence, failure and
  refusal, then name the next action or who can act ([patterns](patterns.md) §6).

These are task questions derived from the reference rules, not new visual grammar.

## Read by task type

Start at the [index](README.md), then follow the matching row. Finish each route
with the [verification matrix](verification.md) before editing and after building.

| Task | Reading route | What to record before work |
| --- | --- | --- |
| Fix an existing UI | [Components](components.md) → [patterns](patterns.md) → [foundations](foundations.md) → [behaviour](behaviour.md) → [writing](writing.md) → [known gaps](known-gaps.md) → [decisions](decisions.md) | Reproduction, reused part, affected gap ids, expected before/after result. A fix gets review on the diff under [contribution rules](CONTRIBUTING.md#3-fix-by-pr-bigger-by-design). |
| Add a screen, surface or shared part | [Contribution criteria](CONTRIBUTING.md) → [new designs](new-designs.md) → [patterns](patterns.md) → [components](components.md) → [writing](writing.md) → [decisions](decisions.md) → [known gaps](known-gaps.md) | An approved design before implementation; reused parts, proposed departures, all states and source files in its handoff. Read foundations and behaviour for the chosen parts. |
| Change theme, accent, density or width | [Theming](theming.md) → [foundations](foundations.md) → [decisions](decisions.md) → [behaviour](behaviour.md) | Affected appearance combinations and persistence behaviour. Inspect `packages/web/index.html`, `packages/web/src/lib/theme.ts` and `packages/web/src/lib/appearance.ts` together. |
| Review a design or UI diff | [Known gaps](known-gaps.md) → [patterns](patterns.md) → [components](components.md) → [behaviour](behaviour.md) → [decisions](decisions.md) | Reviewed revision, applicable rules, measurements, screenshots and findings for the [design gate](../../SDLC.md#the-design-gate). |

A mockup lives under `designs/<feature>/` and links [cockpit.css](cockpit.css).
Follow [new designs](new-designs.md) for its local stylesheet, states and handoff.
Use [specimens](specimens/index.html) to compare shared parts. Historical design
value tables show their dated baseline and proposal; confirm current rules and
source before treating a proposed value as shipped.

## Worked example – fix a copied chip

**Brief:** align the prompt-template trigger with the shared composer chip while
preserving template insertion and focus. This is a source-backed walkthrough,
not a delivered fix or a claim that the control passes browser checks.

**Inputs:** a reproduction at each density, labelled and icon-only trigger states,
empty and populated template lists, the disabled case and the caller's sizing
classes. Start at `packages/web/src/components/prompt-template-menu.tsx:55` and
`packages/web/src/components/picker-pill.tsx:20`; inspect the insertion caller in
`packages/web/src/components/composer/composer.tsx`.

**Pages read:** components §§ PickerPill and PromptTemplateMenu; patterns §7;
foundations §4; behaviour §1; writing §4; decisions D-04 and D-06; known gaps G-03.
Then complete the chip, phone target and keyboard rows in the verification matrix.

**Reuse plan:** import `chipClass` from `picker-pill.tsx` for the trigger instead
of copying its classes. Keep the existing Popover and Command composition in
`prompt-template-menu.tsx`. Preserve its accessible label and the deliberate
`onCloseAutoFocus` handling that lets the composer restore the caret. Check both
trigger forms and caller overrides; sharing a class alone proves no rendered size.

**Decisions and gaps:** D-04 keeps density on one lever; D-06 forbids adding an
arbitrary spacing exception. G-03 names this copied chip and another copy in
`packages/web/src/routes/settings/prompt-templates-section.tsx`. A one-site fix
must leave the remaining gap accurate. The 24 px chip floor does not satisfy the
44 px phone target policy: measure both dimensions of the interactive target at
every density and resolve any shortfall within the accepted fix scope. A needed
shared sizing rule requires a recorded decision, not a silent new allowlist row.

**Evidence to produce:** before/after target measurements and screenshots at
375 px and desktop in both themes, for all four densities; keyboard opening,
selection, Escape and caret return results; disabled and empty-list observations;
focused regression results and guardian/drift output. This trigger is absent for
an empty template list in the inspected source. Record loading, fetch error and
refusal at the owning caller if applicable. If the fix changes no data operation,
mark mutation refusal and already-done states N/A with that reason; do not invent
a successful insertion result from missing data.

## Worked example – add a settings surface

**Brief:** design a new settings pane with a saved text value and a read-only
summary. This is a composition exercise, not an approved product feature. The
field's meaning, storage scope, validation rules and refusal conditions must come
from the task's accepted criteria before implementation.

**Inputs:** those criteria, the existing settings route and registry, saved and
unsaved values, empty and partial summary data, a slow load, a failed load, a
failed save and a refusal response. Start at
`packages/web/src/routes/settings/settings-shell.tsx` and
`packages/web/src/routes/settings/registry.tsx`. Inspect
`packages/web/src/routes/settings/resources-section.tsx` for explicit saving and
`packages/web/src/routes/settings/settings-field.tsx` for the field structure.

**Pages read:** CONTRIBUTING §§1–3; new-designs §§1–8; patterns §§3, 6–8;
components §§ Input, Button and CenteredState; foundations §4.1; theming;
behaviour §§1–4; writing §§1–4; decisions D-02–D-06; known gaps G-05, G-13 and G-23.
Use the verification matrix to plan the design's state and appearance captures.

**Reuse plan:** keep the settings shell and registry; compose `SettingsField`,
`Input` and `Button` from `packages/web/src/components/ui/`. Use the existing
`CenteredState` for a page-level state and the toaster for a mutation failure.
Follow the flat settings list pattern: named rhythm between fields, numeric
spacing inside controls. Text changes keep a local draft and explicit Save;
read-only summary text is not styled as an action. Use a Dialog only if the
accepted interaction calls for a form overlay; destructive confirmation uses
AlertDialog, following patterns §7.

**Decisions and gaps:** D-02 selects rhythm, D-03 aligns gutters and D-04/D-05
preserve the density lever and default. D-06 rules out a local pixel patch.
Check for later superseding records before building. G-13 warns against another
private field wrapper; G-05 warns against another hand-built page state; G-23
requires checking the actual contrast of small text. No new badge grammar is
needed. If the feature later adds a navigation badge, inspect open D-01; D-08's
development badge exception does not decide it.

**Evidence to produce:** an approved design and its source-file handoff, then
implementation screenshots, measured geometry and keyboard/announcement results
for the implemented revision. Include focused tests for validation, draft/save
behaviour and failed or refused saving. Record coverage rows, any decision or gap
changes and full gate results at their owning stages.

Walk the state inventory explicitly: default saved value; first-use empty summary;
filtered empty N/A if there is no filter; loading before data answers; load and
save errors; refusal with who can act; stale/partial summary labelled as such;
already-saved value with Save unavailable until a change. The exact copy and
recovery action remain dependent on the accepted feature criteria. No example
here supplies missing backend behaviour or certifies an unbuilt screen.

## Hand off evidence

Keep one result per applicable [verification](verification.md) row, with a reason
for N/A. Link screenshots and findings from the design review at the reviewed
SHA. Update the owned reference pages in the UI change using the
[index maintenance list](README.md#maintenance); decisions and gaps follow
[CONTRIBUTING §5](CONTRIBUTING.md#5-decisions-vs-gaps).

Owner scope for [#453](https://github.com/qodeca/xezar/issues/453), 2026-09-15:
these instructions accompany later fixes for all current visual/accessibility
debt. Publishing the guides does not close that debt or certify production readiness.
