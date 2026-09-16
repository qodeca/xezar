# Onboarding – first-setup entry and post-update offer

**Status: Approved.** Design review PASS WITH FOLLOW-UPS (§ 20); every finding has a disposition.
Static mockups only — the product code lands in the P2 implementation PR.
Covers **P2** of [qodeca/xezar#464](https://github.com/qodeca/xezar/issues/464).
Date: 2026-09-16. Author: the kit `design` workflow (`xezar-ux-design`, authoring mode).

Open in a browser from disk, starting at [`index.html`](index.html):
[`entry.html`](entry.html) (the setup entry) · [`offer.html`](offer.html) (the post-update offer) ·
[`states.html`](states.html) (every state) · [`phone.html`](phone.html) (375 px).
Owner questions with a recommendation each: [`open-questions.md`](open-questions.md).

---

## 1. Summary

Three surfaces, one action behind all of them.

1. **The setup entry — "Set up this project".** It lives in two places: a quiet second block under the
   first-task hero on Tasks (the primary placement), and a new project-scope settings section,
   **Settings → Project setup** (the durable home). Both start the same ordinary task from the launch
   definition xezar bundles. Independent tasks are untouched: nothing here makes a normal task need
   setup, a network call or any configuration.
2. **The post-update offer.** When the running engine version or the pinned template digest differs
   from `.local/xezar/onboarding-state.json`, one non-blocking row appears above the page with exactly
   two actions, **Re-check** and **Later**. It appears once per identity pair, never launches anything
   by itself, and never nags on a restart of the same pair.
3. **The status surface.** In Settings → Project setup: *last observed*, *last offered* and
   *last successfully checked*, each as its own row, with "unknown provenance" wording when there is no
   baseline and a visible dismissed state. A manual re-check is reachable here at all times.

What the design refuses to do is as important as what it does: no task runs at boot, no version is
recorded as a successful check, no missing baseline is invented, and no copy tells a user to adopt
xezar's own internal working files or development process.

## 2. Problem evidence

Read from the repository and from the #464 analysis comment (revision `bb271fc`, 2026-09-15):

- **Setup is invisible.** `xezar init` creates `fix-and-verify.yaml`, `project-conventions.md` and the
  runtime ignore protection, and nothing in the cockpit points at it. The verify step it writes is an
  echo placeholder, not a real gate (`packages/xezar/src/index.ts:739`). A person opening a fresh
  project sees "No tasks yet — describe a task to get started." and no hint that an agent could prepare
  the project first.
- **Nothing asks after an update.** `packages/xezar/src/.../update-check.ts` checks npm for a newer
  xezar and stops there. No surface asks whether the *project's own* setup still matches the xezar that
  is now running. The analysis found no whole-project re-check anywhere in the source.
- **Knowledge is scattered.** MCP registration, agent trust, sign-in and leader attachment are four
  separate manual steps across `README.md`, `AGENTS.md` and the MCP connection settings card. Nothing
  collects them into one answer for one project.
- **There is a real risk of a bad fix.** The naive shape of this feature — check the version at boot and
  run an analysis task — spends money, touches project files without consent and nags on every restart.
  The owner's decision Q3 rules it out; this design is built so the UI cannot drift back into it.

## 3. Users and jobs

| Reader | What they are doing when they arrive | Before | After |
| --- | --- | --- | --- |
| **A person opening xezar in a project for the first time** | They have just added a folder or cloned a repo and want to get an agent working on something. They are not looking for a settings page. | Added the project, or ran `npx @qodeca/xezar` in it | Either typed a task into the composer, or pressed **Set up this project** and answered two or three questions |
| **A returning person after xezar updated itself** | They came to check a task or start one. The update is not their errand. | Opened the cockpit, or reloaded after an update | Pressed **Later** and carried on, or pressed **Re-check** and read a preview |
| **A person who wants to know where they stand** | Something feels stale, or they are about to trust the project's setup, and they want the real answer. | Opened Settings | Read three identity lines and knew exactly what was checked and when |
| **A project leader (an MCP agent)** | Deciding whether to dispatch a setup or re-check task as part of a plan. Never uses the cockpit. | Called `discover_project` at session start | Read the onboarding block and either dispatched a task or dismissed the offer |

The primary job is **"get work started"**, not "configure xezar". Every ranking decision below follows
from that: setup is always the quieter action, and it is never on the path to a normal task.

## 4. Goals and non-goals

**Goals**

1. A person opening a project for the first time can discover that an agent will set the project up
   for them, without being told they must.
2. A person whose xezar changed is asked once, in a way that costs them one click to ignore.
3. Anyone can find out what was actually checked, when, and against which version — and can never be
   told a check happened that did not.
4. A project leader can do all of the above through the MCP, with no cockpit-only path.
5. Every one of these degrades: no record, a corrupt record, a read-only disk, no agent backend and
   hosted mode are all designed states, and none blocks boot or an ordinary task.

**Non-goals** — the full list, with the reason for each and what a person might expect instead, is in
§ 16. In short: no wizard, no progress surface, no automatic apply, no "never ask again", no
cross-project overview, no nav item, and no surface for trust, sign-in or leader attachment (owner
decision Q4 keeps those with the person; P3 covers verification).

## 5. Screens

### 5.1 First read

**On the fresh Tasks page**, before anything is expanded or clicked, a person must understand two
things in this order: *I can start a task right now*, and *there is also an optional setup*. The hero
keeps its shipped title and sentence; the setup block sits under a rule, in muted text, with an
`outline` button. The composer below is still the primary path and still focused.

**On the offer row**, before anything is clicked: *something about xezar changed, this is not an error,
and I have two choices*. The whole sentence is in the row — there is no "read more".

**In Settings → Project setup**, before anything is expanded: *what state this project is in* (one
sentence in the card heading) and *what I can do about it* (one button). The three identity rows below
answer "how do you know" for anyone who asks.

### 5.2 The pages

| Screen | Page | Reuses | New |
| --- | --- | --- | --- |
| Tasks, fresh project | [`entry.html`](entry.html) | `CenteredState tone="primary"` (`components/centered-state.tsx`), `Composer`, `AppShell` | `.setup-aside` — one rule, one sentence, one `outline` `Button` |
| Settings → Project setup | [`entry.html`](entry.html), [`states.html`](states.html) | `SettingsField`, the ad-hoc card spelling `rounded-lg border border-border bg-card shadow-xs` + `p-inset`, `Button`, `StatusDot` | `.setup-card` (card chassis), `.ident-list` (`<dl>` of three rows), `.setup-note` (a `card-2` hint inside the card) |
| The offer row | [`offer.html`](offer.html) | `ProviderBanner`'s row shape (`components/provider-banner.tsx`), `Button` variants `outline` and `ghost` | `.offer-row` — the same row with two trailing actions and a wrapping phone layout |
| Every state | [`states.html`](states.html) | `CenteredState tone="danger"` for the load error, the `loading-line` idiom, `role="alert"` for a refusal | — |
| Phone, 375 px | [`phone.html`](phone.html) | the shell's mobile top bar | — |

**Scanning many.** This design deliberately has no list. There is one project's state, one offer and
one action; there is nothing to sort, group, filter or search, and adding a search box to three rows
would be noise. The only list the feature touches is the task list, where a setup task appears as an
ordinary row with its own title, through the existing `TASK_COLUMNS`. If a future release ever shows
the per-project state across a workspace, that is a new surface and needs its own design.

## 6. The distinction that matters most

**Observed is not checked.** A version xezar happens to be running proves nothing about this project's
files. Only a check that actually finished can say a project was checked, and a partial, cancelled or
failed check must leave the record where it was.

This is the one difference a person must never miss here, because getting it wrong is how a feature
like this lies: it shows a green tick because a number matched, and a person trusts a project nothing
ever looked at.

How the design shows it, in this order:

1. **In words, in three separate labelled rows** — "Last observed", "Last offered",
   "Last successfully checked". They are never merged into one chip and never summarised as "up to
   date".
2. **In a sentence** under the rows when the state is unusual: "'Last successfully checked' moves only
   when this task finishes its check. A cancelled or failed check leaves it where it is."
3. **Only then in colour** — the card's `StatusDot` is `success` when a finished check covers the
   running identity, `pending` when the identity changed, and neutral otherwise. Remove the colour and
   every state still reads correctly.

The second distinction, one level down: **an offer is not a run.** The row says a version changed; it
never claims the project needs anything, and nothing starts or is paid for until a person presses
Re-check or a leader asks.

## 7. States

Every state has its own sentence. All are drawn in [`states.html`](states.html).

### 7.1 The setup entry

| State | When | Dot | Heading | Action |
| --- | --- | --- | --- | --- |
| **Never set up** | No record, or a record with no finished check | neutral | Not set up yet | `contrast` **Set up this project** |
| **Set up** | A finished check covers the running identity | `success` | Set up | `outline` **Re-check now** |
| **Changed identity** | A finished check exists for a different identity | `pending` | Changed since the last check | `contrast` **Re-check now** |
| **Dismissed** | Changed identity, and the offer was recorded | `pending` | Changed since the last check | `outline` **Re-check now** + a note that the notice will not return for this version |
| **Unknown provenance** | Record missing, empty or unreadable | neutral | Provenance unknown | `contrast` **Set up this project** + the "cannot tell your own edits" note |
| **Unavailable** | No agent backend detected | neutral | (state heading unchanged) | Disabled, with the reason as visible text wired by `aria-describedby` |
| **Hosted / remote mode** | `capabilities.localHandoff` is false | neutral | (state heading unchanged) | Enabled, plus one note naming the part that finishes on the owning machine (OQ-2) |
| **Re-check running** | A check task for this project is active | `violet pulse` | Re-checking | **Open the task** |
| **Loading** | The record has not answered yet | — | — | One muted line, "Loading project setup…". No skeleton and no false "Not set up yet" |
| **Load error** | The record could not be read | — | Could not load project setup | `CenteredState tone="danger"` `heading="h2"`, the server message verbatim as the subtitle, one **Retry** |
| **Start failed** | The task could not be created | — | — | One `role="alert"` line in the server's own words |

### 7.2 The offer row

| State | Rendered | Notes |
| --- | --- | --- |
| **Engine changed** | Row with both versions inline | Same shape up, down and for a development build |
| **Templates changed** | Row with both digests inline | Only when the engine version is unchanged |
| **Both changed** | Row with one sentence and a link to Settings | Four identities do not fit one line at 375 px |
| **Starting** | **Starting…**, both buttons disabled | The cockpit's pending-label rule |
| **Check running** | Replaced by a `violet pulse` line naming the task | Two clicks cannot start two checks |
| **Dismissed** | Not rendered at all | The record holds the offered pair |
| **No baseline** | Not rendered at all | Inventing a previous identity is the failure this design avoids |
| **Same identity** | Not rendered at all | Nothing changed |
| **Record unwritable** | Rendered once per session | The record is disposable; a read-only disk degrades, it never blocks boot |

### 7.3 Refusal

Hosted mode never produces a page-level refusal here, because the setup task itself is allowed. The
refusal is scoped to the one step that is genuinely local, and it is written as the cockpit writes
refusals — the consequence and who can act, never the phrase "not available in hosted mode":

> **One part finishes elsewhere.** Connecting an agent on your own computer is done from the machine
> that owns the checkout — this cockpit runs in hosted mode. Setup prepares that file here and leaves
> the last step to a person on that machine.

If the owner picks option B of OQ-2 instead, the entry is hidden and this note becomes the whole
content of the section, with no button — the "actions with no honest disable reason are hidden"
rule applied to the surface rather than the control.

## 8. Copy deck

Every string, per `docs/design-system/writing.md`: sentence case, `…` as one character, spaced em dash
` — ` between clauses, no Oxford comma, no contractions, `xezar` always lower case, no trailing period
on headings and buttons, full sentences elsewhere. `{engine}`, `{templates}` and `{when}` are
substitutions. A value that is not recorded prints `—`.

### 8.1 The setup entry

| Slot | String |
| --- | --- |
| Hero sentence (Tasks) | New to this project? An agent can look at it and prepare the files it needs — agent guidance, ignore rules and, if you want it, a delivery pipeline. It shows you every change before anything is written. |
| Hero button | Set up this project |
| Settings section title | Project setup |
| Settings field title | Guided setup |
| Settings field hint | An agent looks at this project and prepares the files it needs. You see every change before it is written. |
| Heading — never set up | Not set up yet |
| Body — never set up | No setup has been recorded for this project. You can still create ordinary tasks — setup is optional, and it is never required to start work. |
| Heading — set up | Set up |
| Body — set up | The last check finished against xezar {engine} and templates {templates}. A re-check compares this project's files against the pinned defaults and shows you the differences. |
| Heading — changed | Changed since the last check |
| Body — changed | The last check finished against xezar {engine}. xezar {engine} is running now. A re-check compares this project's files against the pinned defaults and shows you the differences. |
| Body — dismissed | The last check finished against xezar {engine}. xezar {engine} is running now. You chose Later, so the notice above the page will not come back for this version. |
| Heading — unknown provenance | Provenance unknown |
| Body — unknown provenance | A record of earlier checks exists for this project and cannot be read, so nothing here can say what was checked or when. A re-check can still read what is here and show you the pinned defaults, but it cannot tell your own edits from an older default, so it will not replace a file on its own. |
| Heading — re-check running | Re-checking |
| Body — re-check running | A task is comparing this project's files against the pinned defaults. It may ask you a question, and it writes nothing until you accept its preview. |
| Button — set up | Set up this project |
| Button — re-check | Re-check now |
| Button — pending | Starting… |
| Button — open the running task | Open the task |
| Disabled reason — no backend | Setup unavailable — no agent backend was found. Install Claude Code, Codex, OpenCode or pi, sign in, then open this page again. |

### 8.2 The identity rows

| Slot | String |
| --- | --- |
| Label 1 | Last observed |
| Label 2 | Last offered |
| Label 3 | Last successfully checked |
| Value | xezar {engine} · templates {templates} |
| Value suffix | — {when} |
| Absent value | — (with `sr-only` "not recorded") |

### 8.3 The notes inside the card

| Slot | String |
| --- | --- |
| Ordinary task | **Setup starts an ordinary task.** It appears in Tasks with every other task, you can read what it did, and you can cancel it. Nothing runs on its own when xezar starts. |
| Observed is not checked | **Observed is not checked.** "Last observed" is what is running now. Only a check that finished moves "Last successfully checked" — a partial or failed check leaves it where it was. |
| Re-check is always here | **A re-check is always here.** Choosing Later hides the notice for this version only. It never turns the check off. |
| Unknown provenance is not an error | **This is not an error.** The record is local scratch. Deleting it loses the history of checks and nothing else — xezar and your tasks work exactly as before. |
| Hosted mode | **One part finishes elsewhere.** Connecting an agent on your own computer is done from the machine that owns the checkout — this cockpit runs in hosted mode. Setup prepares that file here and leaves the last step to a person on that machine. |
| Running check | "Last successfully checked" moves only when this task finishes its check. A cancelled or failed check leaves it where it is. |

### 8.4 The offer row

| Variant | String |
| --- | --- |
| Engine changed | **xezar changed since this project was last checked** — {engine} now, {engine} then. A re-check compares this project's files against the pinned defaults and shows you the differences. |
| Templates changed | **The setup templates changed since this project was last checked** — {templates} now, {templates} then. A re-check compares this project's files against the pinned defaults and shows you the differences. |
| Both changed | **xezar and the setup templates changed since this project was last checked.** A re-check compares this project's files against the pinned defaults and shows you the differences. See the exact versions |
| Check running | **Re-checking this project** — open the task to answer its questions and accept its changes. |
| Button | Re-check |
| Button | Later |
| Button pending | Starting… |

The same sentence covers an upgrade, a downgrade and a development build. The words **update**,
**upgrade** and **newer** never appear, because a downgrade and a development build are changes to
inspect, not migration authority.

### 8.5 Toasts

| Trigger | String | Tone |
| --- | --- | --- |
| Re-check started | Re-check started — open the task to answer its questions | default |
| Task could not be created | *(the server's message, verbatim)* | danger |
| Dismissal could not be recorded | *(the server's message, verbatim)* | danger |

### 8.6 Release-hygiene rule applied (#466)

No string names xezar's own `.xezar/` working files, its SDLC, its workflows or its skills as something
a user adopts. The copy stays at the level of "the files it needs", and the concrete file list comes
from the task's own preview, where it is about the user's project. Where a file must be named in
running text, it is the project's own agent instructions file — not xezar's.

## 9. Developer notes

### 9.1 Files a developer will touch

| File | Change |
| --- | --- |
| `packages/web/src/routes/tasks-overview.tsx` | Add the `.setup-aside` block inside the first-task `CenteredState` (empty, not filtered-to-nothing). It renders only when the entry is applicable. |
| `packages/web/src/routes/settings/registry.tsx` | New `SETTINGS_SECTIONS` row, `scope: 'project'`, id `project-setup`, title "Project setup". |
| `packages/web/src/routes/settings/project-setup-section.tsx` *(new)* | The card, the three identity rows, the action, and every state of § 7.1. |
| `packages/web/src/components/provider-banner.tsx` (or a sibling) | The offer row. It is a second row in the same banner slot, `role="status"`, never the alert tone. Keep `ProviderBanner` as it is; do not overload it. |
| `packages/web/src/components/app-shell-container.tsx` | Wire the offer row into the shell's existing `banner` prop. |
| `packages/web/src/components/command-palette.tsx` | One Actions row, "Set up this project" (OQ-10). |
| `packages/contract/src/*.ts` | The response schema for the state read and the dismissal write — one zod definition per shape, types inferred. Never a hand-written interface, never a local copy in `server.ts`. |
| `packages/xezar/src/server/server.ts` | The routes, chained into a family builder, validated with `jsonZodValidator` / `paramZodValidator` as **middleware**, under `/api/v1` and mounted under both the boot alias and `/api/v1/p/:projectId/…`. Add the inventory rows to `BACKWARD_COMPATIBILITY.md` § 2. |
| `packages/xezar/src/mcp/tools/discovery.ts`, `project-config.ts` | The MCP half (§ 10). Regenerate `docs/features/mcp-server/mcp-api.md` with `npm test -- packages/xezar/src/mcp/mcp-api-doc.test.ts -u`, and add the `api-coverage.testkit.ts` records. |
| `packages/web/src/styles/index.css` | **No new token.** This design adds none. |
| `docs/design-system/*` | Only if a shared component is added. As designed, nothing shared changes, so the drift test needs no update. |

### 9.2 Data

The offer state is the contract's four-field record at `.local/xezar/onboarding-state.json`, read and
written through the project's data helpers:

```json
{
  "engineVersion": "0.15.0",
  "kitDigest": "2c20c60…",
  "lastOfferedAt": null,
  "lastCheckedAt": null
}
```

Rules the UI depends on, all from the contract note:

- Both identities are non-empty strings; both timestamps are UTC ISO-8601 or `null`, and both refer to
  **that observed pair**.
- On an identity change, both timestamps reset for the new pair. A previous successful check never
  carries over.
- `lastOfferedAt` is written **after** an offer is made — by Later, by Re-check, and by the MCP
  dismissal. `lastCheckedAt` is written **only** after a check that actually finished its promised
  scope.
- Absent, corrupt or read-only state must not block boot or any ordinary task. It degrades to "unknown
  provenance" and one warning, the way `~/.xezar/config.json` already degrades.
- Concurrent offers need serialised, identity-aware writes. A stale task result must not mark a newer
  identity checked. The UI must therefore treat its read as advisory and re-read after a write.

**The record is derived, never authored.** Deleting it loses the history of checks and nothing else.
No `XEZ_*` flag is proposed, and no configuration file is required — the whole feature is discovered
from the running engine, the pinned digest and the record, or it degrades to a smaller xezar.

### 9.3 Live updates

The state changes when a check task finishes, which is already a `run` event on the existing SSE
stream. Patch the query cache from that event and reconcile on reconnect and on `visibilitychange`.
**Do not add a `refetchInterval`**, and do not add a WebSocket topic: the demand lifetime here is "the
project is open", which the existing stream already covers.

### 9.4 What must not happen

- No task starts at boot, on project registration, or on any event other than a person's click or a
  leader's call.
- No write to the project's files outside a task's own worktree.
- No second page scroller, no `h-screen`, no raw colour, no `dark:` variant.
- No status word invented outside `lib/attention.ts` for the running check task — it is an ordinary run
  and uses the ordinary vocabulary.

## 10. MCP parity

Owner rule, 2026-09-16: every new cockpit capability must be reachable through the MCP for the leader.
Three of the four capabilities need a new action; one needs none.

| Cockpit capability | MCP carrier | New? | Shape |
| --- | --- | --- | --- |
| **Status** — read the three identities, the state and why setup is unavailable | `discover_project` | New response block, no new argument | The answer gains `onboarding: { state, available, unavailableReason?, provenance, observed: {engineVersion, kitDigest}, lastOffered: {engineVersion, kitDigest, at} \| null, lastChecked: {…} \| null, launch: { workflowId, modes: ["setup","recheck"] } }`. `discover_project` is already read-only, takes no arguments, and is the call a leader makes at session start and after a person changes settings — exactly when this matters. |
| **Offer** — know that an offer is pending | `discover_project` (pull) **and** `leader_events` (push) | New event kind | `state: "changed"` with `lastOffered` not matching `observed` is a pending offer. For an attached leader, a new event kind `onboarding_changed` carries both identity pairs. An event is a notice, not a run: it authorises nothing. |
| **Dismiss** — record the offer so it does not reappear | `project_config`, new action `dismiss_onboarding_offer` | New action | Arguments: `operationId` (required, 8–128 chars). No `expectedVersion`: it touches no task. It records `lastOfferedAt` for the **observed** pair only; if the identity moved since the leader read it, the answer is `status: "conflict"` and nothing is written. Repeating the same `operationId` returns the first answer and writes nothing twice. OQ-9 records why this tool and not `organise_work`. |
| **Start setup** — create the setup or re-check task | `task_create` | **None needed** | The setup task is an ordinary task. The leader names the bundled launch definition, which `project_config` already lists among the project's workflows, and which `discover_project.onboarding.launch.workflowId` names exactly so the leader never guesses. Mode is passed in the brief. |

Proposed inventory rows for `docs/features/mcp-server/mcp-ui-action-inventory.md` § G (project
settings), in that file's existing column order, all **covered**:

| ID | UI source and symbol | Availability | Inputs → outputs | Validation / quality rules | Effect scope | Required MCP equivalent (outcome) | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I-143 | `routes/settings/project-setup-section.tsx` state read ← `GET /api/v1/p/:projectId/onboarding` | whenever the section is open | none → state, provenance, three identity pairs, availability and its reason | none; a missing record reads as `provenance: "unknown"` and never errors | project | Read this project's setup state: which identity is running, which was offered, which a finished check actually covered, and whether setup can run here at all. Added 2026-09-16 (#464 P2) | covered |
| I-144 | `project-setup-section.tsx` "Set up this project" / "Re-check now" → `POST /api/v1/p/:projectId/runs` | an agent backend is available | mode (`setup` \| `recheck`) → the created task | refused with the server's own words when no backend is available; one check at a time per project | project | Create the setup or re-check task from the bundled launch definition. Added 2026-09-16 (#464 P2) | covered |
| I-145 | `provider-banner.tsx` offer row "Later" → `POST /api/v1/p/:projectId/onboarding/offered` | an offer is pending for the observed identity | observed identity → the recorded pair | refused as `conflict` when the observed identity moved since the read; idempotent per `operationId` | project | Record that the offer was made for this identity, so the same pair does not offer again. Added 2026-09-16 (#464 P2) | covered |
| I-146 | `provider-banner.tsx` offer row presence ← the same read as I-143 | a changed identity that has not been offered | none → whether an offer is pending, and what changed | never shown without a baseline | project | Learn that the running identity differs from the last checked one, as a pull and, for an attached leader, as a push. Added 2026-09-16 (#464 P2) | covered |

Two rules the implementing PR must not skip: a tool change without regenerating `mcp-api.md` and
`mcp-api.json` fails `npm test`, and the MCP scope holds an 80 % lines and 80 % branches floor
(`npm run test:coverage:mcp`) with each new test shown failing against a named break.

## 11. Accessibility

The bar this repository already holds, applied here:

- **Keyboard.** Re-check, Later, Set up this project, Re-check now, Retry and Open the task are real
  `<button>`s and `<a>`s. The offer row sits before any page CONTENT in DOM order — after the shell's
  own nav, which comes first on every page — so tabbing forward reaches it before anything on the
  page itself, exactly as `AC-16` states it. Nothing here is reachable only by hover or only by
  pointer.
- **Focus.** The shipped `:focus-visible` ring (`ring-[3px] ring-ring/50`) is untouched. Dismissing the
  row moves focus to the page heading, so a keyboard user is never left on a removed element; the same
  applies when Re-check navigates to the task.
- **Labels.** Every control has a visible label. No icon-only control is added. The card's `StatusDot`
  is `aria-hidden`, because the heading beside it already says the state in words.
- **Never colour alone.** The offer row has no status dot at all. Every entry state has its own
  heading and its own sentence. Remove all colour and the surfaces still read correctly.
- **Announcements.** The offer row is `role="status" aria-live="polite"`: it announces on arrival
  without stealing focus. A failed mutation is a `role="alert"` line, once, in the server's words. No
  count is announced, because there is no count.
- **Structure.** The identity rows are a `<dl>`, so each label is paired with its value. An absent value
  renders `—` with `sr-only` "not recorded", so a screen reader hears a word rather than a dash.
- **Disabled reasons.** The unavailable action keeps its reason as visible text, wired with
  `aria-describedby`, never as a `title` alone.
- **Themes.** Both work through tokens; no `dark:` variant, no raw hex, no `bg-white` or `text-black`.
  The `pending` dot uses the fill token; nowhere is amber used as text.
- **Motion.** The only motion is the existing `StatusDot pulse` on a running check. No new animation.
- **375 px.** Nothing scrolls sideways; see § 12. Touch targets are 44 px on phone.

**Verification status.** The mockups were opened from disk in a real browser in this run and checked in
both themes, at desktop width and at 375 px. That is a visual check of static pages, not a shipped-UI
QA: the product surfaces do not exist yet, so keyboard order, focus movement and screen-reader output
are **specified here and remain unverified** until the implementing PR runs the browser suite per
`docs/testing/agent-browser.md`. The acceptance criteria in § 13 are written so a tester can check
each one.

## 12. Responsive rules and what gets cut

| Width | Layout |
| --- | --- |
| ≥ 768 px | The offer row is one line: sentence, then the two actions right-aligned. The card puts its action beside the heading. The identity rows are label-left, value-right. |
| < 768 px | The desktop page header is hidden and the shell's mobile top bar names the page. The offer row wraps: sentence first, then both actions full width at 44 px. The card's action drops below the heading, full width. Each identity label goes above its value. |

What disappears first, in order, as the surface shrinks:

1. **The two identities inline in the offer row.** When both the engine and the templates changed, the
   row uses the short sentence and a link to Settings instead of four identifiers. The identities are
   detail; "something changed" is the message.
2. **The `.setup-note` block on the phone in the Tasks hero.** The hero's setup sentence shortens to one
   clause; the full explanation is in Settings, one tap away.
3. **The timestamp suffix on an identity row**, if it would force a third line.

What never disappears, at any width:

- The state heading and its sentence.
- Both offer actions, at 44 px.
- The "Last successfully checked" row, including its `—`.
- The reason an action is disabled.

## 13. Acceptance criteria

Each is checkable by a tester without reading the code.

| ID | Criterion |
| --- | --- |
| AC-01 | A project with no tasks and no record shows "No tasks yet", the composer, and one **Set up this project** button under a rule. Typing a task and sending it works with no setup, no network and no configuration. |
| AC-02 | **Set up this project** creates a task that appears in the task list like any other, can be opened, can be cancelled, and writes nothing to the project outside its own worktree until a person accepts a preview. |
| AC-03 | Starting xezar never creates a task, on any project, in any state of the record. |
| AC-04 | With the record naming a different engine version, opening the project shows exactly one non-blocking row with exactly two actions, **Re-check** and **Later**, and the page below is fully usable. |
| AC-05 | Pressing **Later**, then restarting xezar on the same version, shows no row. Settings still shows the change and a working **Re-check now**. |
| AC-06 | A downgrade and a development build produce the same sentence shape as an upgrade. The words "update", "upgrade" and "newer" appear nowhere on either surface. |
| AC-07 | Deleting `.local/xezar/onboarding-state.json` while xezar runs: the cockpit keeps working, no error page appears, Settings reads "Provenance unknown", and no offer row is shown. |
| AC-08 | Corrupting that file to invalid JSON produces the same result as AC-07, plus at most one warning. Boot never fails. |
| AC-09 | Making the file read-only: the offer row appears, **Later** removes it for the session, and a restart may show it once more. Nothing errors and no task starts. |
| AC-10 | With no agent backend installed, the setup action is disabled and its reason is on screen as text, readable by a screen reader through `aria-describedby`. |
| AC-11 | In hosted mode the entry behaves per OQ-2's accepted option, and the wording never contains the phrase "not available in hosted mode". |
| AC-12 | A check that is cancelled or fails leaves "Last successfully checked" exactly as it was. Only a finished check moves it. |
| AC-13 | Two rapid presses of **Re-check** create one task. The row is replaced by the running line. |
| AC-14 | At 375 px, on both surfaces, nothing scrolls sideways, both offer actions are at least 44 px tall, and every identity label is readable above its value. |
| AC-15 | Both themes: no element becomes invisible or unreadable, and no meaning is lost when colour is removed (check with a greyscale filter). |
| AC-16 | Tab from the top of the page reaches the offer row's two actions before any page content; each shows a visible focus ring. Pressing **Later** moves focus to the page heading. |
| AC-17 | `discover_project` returns the `onboarding` block with the same three identities the cockpit shows, for the same project, at the same moment. |
| AC-18 | `project_config` action `dismiss_onboarding_offer` removes the row for that identity; repeating it with the same `operationId` writes nothing twice; calling it after the identity moved answers `conflict` and writes nothing. |
| AC-19 | No string on either surface names xezar's own internal working files or development process as something the user should adopt (#466). |
| AC-20 | No new `XEZ_*` flag, no new required file, and no setting a user must author for any of the above to work. |

## 14. Worst case, measured

| Dimension | Number | Where it comes from |
| --- | --- | --- |
| Longest engine identity | 24 characters — `0.16.0-dev.20260916.abcd` | The development-channel shape the `channel` prop already distinguishes (`decisions.md` D-08). Assumption: no longer form ships. |
| Longest template digest as shown | 7 characters — `2c20c60` | The short form the repository uses for a merged revision (the `xez-onboard` merge is `2c20c60`). The full 40-character digest stays in the record and in the MCP answer, never on screen. |
| Longest offer sentence | 168 characters, both identities inline | Measured on the rendered variant a in `offer.html`. At 375 px it wraps to four lines and the row grows; the page below is pushed down, never covered. |
| Longest server error shown verbatim | Unbounded in principle | `CenteredState`'s subtitle wraps and its container scrolls with the page. Observed worst case in this repo's own error copy is a two-line `EACCES` path. Assumption: the existing verbatim-message doctrine already survives this everywhere else. |
| Longest list | 3 rows | The identity rows. There is no growable list in this design. |
| Slowest state | The re-check task itself — minutes | It is an ordinary task and shows in the ordinary task UI. The surfaces here only ever wait on one small file read, so their own loading state is a single muted line and is expected to be imperceptible. |
| Narrowest width | 375 px | Checked in a browser on `phone.html` and `states.html`. |
| Most projects | Unbounded | Mitigated by OQ-1: one row, for the active project only. |

## 15. Open decisions

Ten, each with a recommendation and the consequence of the alternative, in
[`open-questions.md`](open-questions.md): OQ-1 which project the row belongs to · OQ-2 hosted mode ·
OQ-3 the section name · OQ-4 an offer on a never-set-up project · OQ-5 the user-facing word for the
digest · OQ-6 "Later" against the dismiss-button convention · OQ-7 where a re-check gets the previous
bytes · OQ-8 browser notifications · OQ-9 the MCP carrier for the dismissal · OQ-10 the command
palette row.

**Departures from the design system**, each needing a reason in the review:

| Departure | Reason |
| --- | --- |
| A second row in the shell's banner slot, in the status tone, for something that is not a provider problem | The row shape is the cockpit's existing "something about your environment changed" surface. The alternative (a dialog or a toast) blocks or vanishes. The alert tone is deliberately **not** used, so the provider banner keeps its meaning. |
| A new project-scope settings section | `SETTINGS_SECTIONS` is the documented way to add one, and the status has to outlive the empty state. |
| "Later" instead of naming the kept outcome | The owner's decision Q3 names both actions. OQ-6. |
| A `<dl>` where the cockpit usually uses a settings field | Three label-value pairs are a description list. A settings field is for a control, and there is no control here. |
| `.setup-note` as a `card-2` block inside a card | That is the cockpit's own elevation rule (page → card → hint), spelled as a feature class rather than a new shared component. If a second feature needs it, promote it. |

**Nothing new is added to the design system by this design**: no token, no primitive, no shared
component, and therefore no `coverage.md` row and no drift-test update.

## 16. Deliberately not built

| Not built | Why, and what a person might expect instead |
| --- | --- |
| A wizard, a stepper or a multi-page setup flow | The setup *is* an agent task. Duplicating its questions in the cockpit would create a second place for them to drift out of step. The questions are asked in the task, through the existing question chips. |
| A "setup progress" surface (steps, percentage, checklist) | The task thread already shows what an agent is doing. A second view of the same run is a maintenance cost with no new answer. |
| Automatic apply on a re-check | The contract is explicit: accepting Re-check authorises inspection and preview only. |
| A "Never ask again" action | It would create a state the four-field record cannot honestly hold, and the record is disposable, so the state would be lost anyway. |
| A cross-project setup overview | Real counts do not justify it yet, and it is a different surface with a different job (see § 5). |
| Editing the identity rows | They are derived facts. There is nothing to type. |
| A dedicated nav item | Setup is a once-or-twice thing. The nav is for places a person returns to. |
| A dry-run toggle in the cockpit | Report-only is a property of the task's brief, and belongs in the task, not in a button here. |
| Any surface for trust, sign-in or leader attachment | Owner decision Q4: project files only in the first release. Those remain the person's own steps, and P3 covers verification once #450 has landed. |

## 17. Delivery plan

| Step | Content | Gate |
| --- | --- | --- |
| 1 | This design, reviewed | `design-approved` on this PR |
| 2 | Contract schemas plus the two routes (read, dismiss), with contract-parity and typed-body tests | `npm test` |
| 3 | The state reader and writer, with the absent, corrupt, read-only, same-identity, changed-identity, downgrade, dev, dismissed and concurrent cases as fixtures | `npm test`, `npm run test:unit` |
| 4 | The three cockpit surfaces and the palette row | `npm test`, the drift test, the designs lint |
| 5 | The MCP half: the `discover_project` block, the `project_config` action, the `leader_events` kind, the regenerated reference and the inventory rows | `npm test`, `npm run test:coverage:mcp` |
| 6 | The browser suite check of both themes at desktop and 375 px | `npm run test:e2e` |

Each of steps 2–5 is small enough to be one task and one PR. Step 3 carries the risk and should not be
merged with step 4.

## 18. Risks

| Risk | Consequence | Mitigation in this design |
| --- | --- | --- |
| **The offer becomes a nag** | People learn to ignore the banner row, including the provider alert that shares it | One appearance per identity pair, the record is written by both actions, and the row is a status tone rather than an alert |
| **"Observed" is mistaken for "checked"** | A person trusts a project nothing ever looked at | Three separate labelled rows, never a combined chip; the rule is repeated in a note; § 6 makes it the distinction the review must hold |
| **The record becomes required state** | Deleting local scratch breaks a project — against the zero-config rule | Every state degrades: missing, corrupt and read-only are all designed states, and none blocks boot or a task |
| **A boot-time run creeps back in** | Money spent and files touched without consent | AC-03 tests it directly, and the design gives the UI no path that starts a task without a click or a leader call |
| **Copy drifts into telling users to adopt xezar's own process** | Exactly what #466 forbids | § 8.6, plus AC-19 |
| **The cockpit and the MCP disagree** | The leader sees a different state from the person | Both read the same record through the same helper; AC-17 pins it |
| **The launch definition cannot be resolved offline** | Setup fails on a machine with no network, which is where it is most needed | A pinned fallback is bundled (owner decision Q2), and AC-01 requires the offline case to work |
| **A downgrade reads as a warning** | People treat a rollback as breakage | One sentence shape for every direction; AC-06 |

## 19. References

- [qodeca/xezar#464](https://github.com/qodeca/xezar/issues/464) — the umbrella issue, the analysis
  comment (revision `bb271fc`, 2026-09-15) and the owner decisions of 2026-09-16 (Q1–Q4 all A).
- `docs/features/onboarding/xez-onboard-contract.md` — the skill contract note (PR #475, branch
  `xez/a32492bd`, head `5bdc9c0`, approved). The source of the record shape, the offer rules and the
  "observed is not checked" rule.
- [qodeca/xezar#466](https://github.com/qodeca/xezar/issues/466) — release hygiene.
- [qodeca/xezar#450](https://github.com/qodeca/xezar/issues/450) — leader attach/status; P3 depends
  on it, this design does not.
- `qodeca/xezar-skills`, `xez-onboard`, merged as `2c20c60` — the public skill P2 pins.
- [`docs/design-system/README.md`](../../docs/design-system/README.md) and its
  [`new-designs.md`](../../docs/design-system/new-designs.md),
  [`patterns.md`](../../docs/design-system/patterns.md),
  [`components.md`](../../docs/design-system/components.md),
  [`foundations.md`](../../docs/design-system/foundations.md),
  [`writing.md`](../../docs/design-system/writing.md),
  [`known-gaps.md`](../../docs/design-system/known-gaps.md).
- [`designs/README.md`](../README.md) — the folder convention and the lifecycle.
- `docs/features/mcp-server/mcp-api.md` and `mcp-ui-action-inventory.md` — the MCP reference and the
  closed inventory the § 10 rows extend.
- `AGENTS.md` § Zero config, § The HTTP API; `SDLC.md` § The design gate;
  `BACKWARD_COMPATIBILITY.md` § 2.
- No prior art from other products is cited. None was researched for this design; any comparison a
  reviewer wants is `xezar-research` work.

## 20. Design review

**PASS WITH FOLLOW-UPS**, on [PR #489](https://github.com/qodeca/xezar/pull/489) — the
`## Design review` comment of the `design-review` workflow (reviewed commit `c72c23f`, base `b6d3954`).
No blocking findings; `design-approved` applied. Every recommendation of
[`open-questions.md`](open-questions.md) OQ-1…OQ-10 was found sound and is taken.

Disposition of the seven non-blocking findings, all carried by the P2 implementation PR:

| Finding | Disposition |
| --- | --- |
| **NB-1** — "kit" is user-facing in `entry.html` | **Fixed.** Four substitutions in `entry.html`, "kit" → "templates". The product copy never used it: `packages/web/src/lib/onboarding.ts` builds every identity label as "xezar {engine} · templates {digest}", and `onboarding.test.ts` fails on `/kit/i` in any shipped string. |
| **NB-2** — the changed-identity card has no templates-only wording | **Fixed.** `setupBody` now has the same three variants the offer row has (`changedClause`), and the templates-only case is a test. |
| **NB-3** — the local sheet overrides a shipped base class | **Fixed by not shipping it.** The mockup's `.centered-state .actions .btn` phone override has no counterpart in the product: the setup block sets its own `h-11` on its own button and touches no base class, so the departure disappeared rather than needing a known-gaps entry. |
| **NB-4** — new 12 px copy uses the token G-23 records as below AA | **Fixed.** The identity rows use `text-muted-foreground` for the label and the `— {when}` suffix, and the absent `—` inherits `text-foreground`; the sub-AA token is not used on this surface. |
| **NB-5** — § 11 overstates what DOM order gives | **Fixed.** § 11 now matches `AC-16` ("before any page content"), which was already the accurate statement. |
| **NB-6** — `launch.modes` understates the launch definition | **Fixed.** `discover_project.onboarding.launch.modes` carries all three modes (`setup`, `preview`, `recheck`); the cockpit deliberately surfaces two, and `lib/onboarding.ts`'s `CockpitSetupMode` is the narrower type that says so. |
| **NB-7** — the hero sentence assumes a software project | **Fixed.** `SETUP_HERO_SENTENCE` leads with the generic promise and names no software-shaped nouns; a test fails on `/ignore rules|pipeline/i`. |

One item of the design is **not** in the P2 implementation and is named here rather than left
implied: the `leader_events` push kind for a pending offer (§ 10, the second row of the MCP parity
table). The **pull** half is delivered in full — `discover_project.onboarding` carries the state,
the identities and the launch definition — so the owner's UI ↔ MCP parity rule is met: every
capability the cockpit has here is reachable through the MCP. The push is additive on top of that,
and it needs an emission point that does not exist yet (an identity change is a fact derived on
read, not an event anything fires), so inventing one belongs in its own change.

§ 11's verification note still stands: keyboard order, focus movement and screen-reader output are
covered by unit tests in the implementation PR and by the browser suite, not by this folder.
