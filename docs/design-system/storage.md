# Design storage and retirement

Start with [usage](usage.md), follow the [lifecycle](lifecycle.md) for ownership and status,
and retain the provenance required by [verification](verification.md).
[Recipes](recipes.md) is the planned P2 guide; it does not change storage ownership.

## Choose the owning location

| Material | Location | Ownership and naming |
| --- | --- | --- |
| Feature mockup and developer handoff | `designs/<feature>/index.html` and `designs/<feature>/README.md` | One descriptive, lowercase, hyphenated feature folder, following `quality-checks`, `decisions` and `design-system-air`. Start at index; additional pages name screens or states. Register the folder and status in [designs/README.md](../../designs/README.md). |
| Feature-only presentation | `designs/<feature>/styles.css`, with local scripts such as `theme.js` when needed | Shared stylesheet first; only feature-specific CSS locally. Static HTML opens from disk with no build or server. Mockup CSS is not imported into the application. |
| Reusable system examples | [specimens/](specimens/index.html) under `docs/design-system/specimens/` | Compare shared foundations, components, patterns and mobile examples. Keep a feature proposal in its feature folder until a system decision makes it shared grammar. |
| Safe, durable product captures | `docs/screenshots/<version>/` | Use the product version actually captured. Versioned screenshots are also owned by the product-docs work in [#448](https://github.com/qodeca/xezar/issues/448); coordinate changes rather than replacing its assets. A capture of unreleased work must say so, not pretend to show a released version. |
| Private scratch and task evidence | Ignored project `.local/`; durable Xezar evidence in the **primary checkout's** `.local/xezar-tasks/<runId>/` | Resolve with `.xezar/checks/lib/common.sh` (`resolve_task_paths`, `task_evidence_dir`). Task-worktree `.local` and engine temporary files may be reclaimed. Maintained docs must not depend on a local absolute path or private evidence file. |
| System decisions and known debt | [decisions.md](decisions.md) and [known-gaps.md](known-gaps.md) | System choices use D-nn; feature-local choices stay in the handoff. G-nn records inconsistent implementations and the rule for new work. A system decision is superseded by another decision, never deleted. |

This is the repository-root `designs/<feature>/` convention, not a `docs/designs/` directory.
The existing feature folders contain proposals and dated evidence; their presence is not proof
that their markup or historical values are today's approved system.

## Feature folder contract

Every HTML page links the shared sheet before the feature sheet:

```html
<link rel="stylesheet" href="../../docs/design-system/cockpit.css">
<link rel="stylesheet" href="styles.css">
```

Follow [new designs](new-designs.md) for state, appearance, mobile and accessibility requirements.
Local CSS must not redeclare tokens, copy base classes or introduce raw hex colours. Use shared
rhythm tokens; call out a genuinely new component as a proposal in the handoff.
The README covers summary, problem evidence, users, goals/non-goals, screens, component specs,
states, copy, developer notes, accessibility/responsiveness, AC, decisions, delivery plan, risks
and references. Its final `## Design review` is Pending until the author links the PR verdict
and dispositions. Keep its Status line and the index row consistent.

## Captures with provenance

A screenshot is evidence of one rendered configuration, not of every state or density.
Use an identifiable filename and record the full configuration in the handoff or PR evidence
table. For example, the following is a **naming example, not an existing or verified capture**:

```text
docs/screenshots/<version>/<feature>-<state>-<theme>-<width>x<height>-<density>-<short-sha>.png
```

Use real values for those fields; retain the full source SHA in the evidence table. Also record
capture date, route/page, whether it shows a static mockup or the running cockpit, accent,
reading width, method, expected/observed result and relevant review/implementation PR.
These fields follow the [verification evidence record](verification.md#evidence-record).
Keep published captures safe to commit and stable after the task worktree disappears. Private
captures stay in durable ignored evidence; publish a safe replacement or a sufficient written
result before making them a maintained reference. Screenshots do not replace keyboard or
geometry measurements.

A sample capture's journey:

1. **Draft:** the author captures a named feature's refusal state in dark theme at 375 × 812,
   Comfortable density; records accent, reading width and exact mockup SHA. It remains private
   evidence until checked for publication and promoted into the versioned screenshot location.
2. **Review:** the PR links the safe capture and metadata, saying which requirement it demonstrates.
   The reviewer records the judged SHA. One dark capture leaves the light/state/density matrix
   outstanding; it cannot earn approval by itself.
3. **Implementation:** capture the running cockpit at the implementation SHA. Label the earlier
   file as mockup evidence; do not overwrite it and silently change what the review link proves.
4. **Retirement:** keep referenced captures and handoff links with the retained feature folder.
   Add the replacement reference and superseded notice below. A proposed deletion first follows
   the sweep rule and reference search, not the passage of time alone.

## Retire without erasing the evidence

Implemented designs stay in place. Draft/In review designs untouched for 90 days become Archived;
Approved designs with no implementing PR within two releases revert to Draft; revived Archived
designs start again at Draft. [Lifecycle](lifecycle.md) names the actor and required evidence.
Retirement keeps **both the index row and the folder**.

When a document is retained only as historical evidence, place a dated **Superseded** banner
near its top, naming the replacement document or PR and the scope no longer current. This is
an annotation, not a sixth lifecycle status: keep the real Status line and index row aligned.
Preserve historical observations as dated observations; do not rewrite an old measured result
as though it described today's cockpit.

Deletion is a separate, justified change. Under the [#447 sweep rule](https://github.com/qodeca/xezar/issues/447),
announce the exact paths, reasons and references that would break on the issue **before deleting**.
Search repository and tests, including Markdown links and filenames; edit test-pinned prose
rather than removing it. Keep a referenced feature design under the retention convention.
This guide authorizes no deletion and adds no archival directory or cleanup job.

## Excluded material

Never commit secrets, credentials, `.env` contents, private data or personal agent configuration
in HTML, screenshots, handoffs or evidence. Use safe example data for publishable captures.
Keep generated build output in the project's build locations, not in a feature design or
screenshot folder. Root README is maintained source; its package copy is generated at build.
Private logs, reports and scratch scripts belong in ignored `.local/`, not beside these guides.
Check the root ignore rule before creating them; an ignore rule does not untrack an existing file.
