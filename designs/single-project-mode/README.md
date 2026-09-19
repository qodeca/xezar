# Single-project mode – the cockpit surface

**Status:** Approved – design review PASS WITH FOLLOW-UPS on PR #604 (`design-approved`); NB-1
through NB-5 each carry a disposition in § Design review below. Partly implemented: the cockpit
slice merged as PR #611; PR #612 carries the four copy items #611 deferred, judged by a scoped
design review (PASS, `design-approved`, § Design review below). Both statuses become
**Implemented** once #612 merges. Authored 2026-09-17 by the `design`
workflow (`xezar-ux-design`, authoring mode) for the cockpit slice (PR4) of
[qodeca/xezar#600](https://github.com/qodeca/xezar/issues/600).

**Mockup:** [index.html](index.html) · [sidebar.html](sidebar.html) · [settings.html](settings.html) ·
[surfaces.html](surfaces.html) · [states.html](states.html) · [phone.html](phone.html).
Every page links `../../docs/design-system/cockpit.css` before its own `styles.css` and opens
straight from disk. `styles.css` holds feature rules only: no token is redeclared, no base class is
copied, no raw hex appears.

**Scope of this design:** items 1 to 7 of the slicing spec's section 4. Item 8 (an import dialog) is
deliberately **not drawn** – see §15, OD-4.

---

## 1. Summary

Single-project mode makes a xezar setup travel with the repository: started once with
`--single-project`, xezar keeps its settings, accounts and working files inside that folder and never
opens `~/.xezar`. The cockpit half of that has to do two things. It must answer, at a glance, "is
this xezar the one that lives in this repository?", because every settings pane means something
different depending on the answer. And it must stop offering the four affordances that only make
sense when xezar serves several projects.

The design is small on purpose: one neutral badge on the sidebar's brand block, one line per Settings
section naming the file it writes, one new content state (an agent account whose folder is not on
this machine), three removals, and one refusal page that explains itself instead of answering 404.
Nothing changes for anybody not in the mode.

## 2. Problem evidence

- **There is no cockpit header.** FR-9.2 asks for "a badge in the cockpit header"; the cockpit has
  none. The badge host is the sidebar brand row (`packages/web/src/components/app-shell.tsx:479-494`),
  which already carries a badge precedent – the development-build dot at `:772-782`
  (`data-slot="dev-badge"`, `docs/design-system/decisions.md` D-08).
- **Three affordances are gated on the wrong question.** `Add project` and the sidebar's project
  groups already read the capability (`app-shell.tsx:517`), but the sidebar switcher
  (`app-shell-container.tsx:107`), the composer's project pill (`routes/new-task.tsx:598`) and the
  palette's Projects group (`components/command-palette.tsx:200`) are gated on
  `registry.projects.length > 1`. "The registry happens to hold one row" and "this xezar cannot have
  a second project" are different facts with the same answer most of the time, which is exactly how
  one of them survives a refactor.
- **One word on the settings header becomes false.** `data-slot="settings-scope-chip"`
  (`routes/settings/settings-shell.tsx:181-190`) says "Global settings". In the mode those settings
  are committed to one repository.
- **Today hosted mode hides the accounts entirely.** `accounts-section.tsx:150-160` replaces the
  whole pane with one sentence when the listing is not editable. Once accounts are committed project
  state, the list itself is information a hosted reader legitimately needs.
- **A committed account can point at a folder nobody else has.** FR-6 requires the boot to survive
  it, Settings to name it and any task asking for it to be refused with the same message. The
  cockpit has no such row today; the closest is "folder not created yet; Connect will make it"
  (`accounts-section.tsx:501`), which describes a different situation.

## 3. Users and jobs

**Who.** Two readers, and the design serves both with the same pixels.

- **The person who set the mode up.** They ran `--single-project` in a repository, they are working
  in it daily, and their job on arrival is ordinary: start a task, read a thread, change a setting.
  They need one durable reminder of which xezar this is, because they also run a global cockpit on
  the same machine and the two look identical.
- **The person who cloned the repository.** Their job on arrival is to find out what this repository
  expects of their machine: which agent, which account, which limits. They did not choose any of it.
  What they most need is to be told when their machine cannot honour a committed expectation – the
  unavailable-account row – and where the settings they are reading actually live.

**Before and after.** Before: a terminal (`xez` with the flag, or a plain `xez` in the folder) and
its one boot line naming the mode and the state folder (FR-9.1). After: they start a task, or they
change a setting and their colleague gets it on the next pull. The cockpit sits between a
command-line fact and a git commit, and both are why the badge and the file notes matter.

## 4. Goals and non-goals

**Goals**

- Say which mode this cockpit is in, durably, on every screen including a phone.
- Say where each setting is written, so "will this travel?" is answerable without reading the docs.
- Show an account the repository asks for that this machine cannot provide, and refuse tasks on it
  with the same sentence.
- Remove every affordance that can only ever fail here – through absence, not through a disabled control.
- Change nothing on the default path: in global mode every surface stays byte-identical.

**Non-goals**

- No new per-project behaviour. The mode changes **where** settings live, not what any setting does.
- No cockpit way into or out of the mode. The folder decides (FR-1.2); the badge is a fact, not a control.
- No migration, conversion or sync UI in either direction.
- No import dialog (§15, OD-4).
- No change to the `XEZ_SINGLE_PROJECT=1` narrowing's behaviour, except the one named in OD-1.

## 5. Screens and first read

### 5.1 First read

Two facts must land before anything is clicked or scrolled:

1. **Which xezar this is** – the "Single project" badge on line two of the sidebar brand block, and
   in the phone top bar's status slot. It is in the default, collapsed view of every screen.
2. **Where a setting is written** – the file note under each Settings section description, visible
   without expanding anything.

Everything else in the feature is a subtraction and needs no first read at all.

### 5.2 The pages

| Page | What it shows | Spec item |
| --- | --- | --- |
| [sidebar.html](sidebar.html) | The global-mode sidebar and the mode's, side by side at 264 px; the badge's anatomy in four combinations including dev + mode; the long-name worst case; the "mode not known yet" case | 1, 2 |
| [phone.html](phone.html) | The mobile top bar at 375 px with the badge in `data-slot="mobile-status"`; the drawer's brand block; a settings pane at 375 px | 3 |
| [settings.html](settings.html) | A project section and a global section each naming their file; the scope chip's new wording; the section-to-file map; the unavailable-account row beside the task refusal | 4, 5 |
| [surfaces.html](surfaces.html) | The composer footer without the project pill and the palette without the Projects group, each beside today's version | 6 |
| [states.html](states.html) | Default, empty, filtered to nothing, loading, error, both refusals, stale/partial, already done, phone | 7 and `new-designs.md` §4 |

## 6. The distinction that matters most

**Read-only fact against changeable setting.** Everything else on the sidebar brand block and in a
Settings pane is either navigation or a control. The mode badge is neither: it reports where state
lives, and nothing in the cockpit can change it, because the folder decides. So it is not a button,
not a link, not a menu, and not in the tab order. It is a `Badge` – the cockpit's own component for
"a fact about this row" – with no hover state and no cursor change.

The same distinction governs the file note: it is text in the section's heading block, never a link
to the file and never a button that opens it. A control there would imply the cockpit can move the
setting somewhere else.

Colour does not carry either fact. The badge has no colour of its own (`outline`,
`text-muted-foreground`), because the two coloured badges in that neighbourhood already mean
specific things: violet is "a person is wanted" (`patterns.md` §2) and danger is the development
build. A third colour would teach two meanings for one place.

## 7. Component specs

| New or changed | Component reused | Spec |
| --- | --- | --- |
| Mode badge | `Badge variant="outline"` (`components/ui/badge.tsx`) | `data-slot="mode-badge"`. Text "Single project", a lucide `FolderIcon` at 11 px (`aria-hidden`), 10.5 px text, `text-muted-foreground`, `border-border`, transparent fill. One `sr-only` tail: "— xezar settings and state live in this folder, not in your home directory". Not interactive. |
| Brand block, line two | `data-slot="sidebar-brand"` (`app-shell.tsx:479-494`) becomes a column: line one is today's row untouched, line two holds the badge, indented to the wordmark (tile width + the row's own `gap-row`). Rendered only in the mode. |
| Phone top bar | `data-slot="mobile-status"` (`app-shell.tsx:819`) | The same badge, pushed right by the slot's own `ml-auto`. |
| Settings file note | new, local class `.file-note` in the mockup | A lucide `FileIcon` at 12 px, one sentence, the file name as `<code>` on `bg-muted`. Sits directly under the section description, inside the same heading block. Rendered only in the mode. Proposed as a small shared component (`SettingsFileNote`) because eight sections render it. |
| Settings scope chip | `data-slot="settings-scope-chip"` (`settings-shell.tsx:181-190`) | Same element, same position, same type ramp. Text becomes "Workspace settings" in the mode. |
| Account row, unavailable | `data-slot="account-row"` (`accounts-section.tsx:474`) plus `StatusDot tone="danger"` | Adds `data-slot="account-unavailable"` carrying the word "Unavailable" and the shared sentence. The row's border picks up a danger tint; the tint is reinforcement only. |
| Hosted-mode notice | the shell's status-row grammar, boxed | `role="status"`, neutral `bg-muted/50`, one sentence. Replaces today's whole-pane substitution. |
| Refused registry page | `CenteredState` + an `outline` "Back to settings" | Neutral tone with a lucide `FoldersIcon`. Not `tone="danger"` – nothing failed. |
| Removals | – | `Add project`, the project groups, the composer `ProjectPill` and the palette's `Projects` group are not rendered. No disabled variant of any of them exists. |

**One change to the shared stylesheet.** `docs/design-system/cockpit.css`'s `.sidebar-head .where`
had no truncation, so a long repo or branch name wrapped the brand row onto three lines – a
behaviour the cockpit does not have (`data-slot="repo-chip"` is `truncate`,
`app-shell.tsx:485-489`). Without it the worst-case figure on [sidebar.html](sidebar.html) would
have demonstrated the wrong thing. Added to the shared sheet with a source comment, per
`new-designs.md` §2, and recorded as a `(new)` row in `known-gaps.md` § Mockup fidelity. It is a
mockup-stylesheet fidelity fix; no cockpit code and no token changed, and
`design-system-drift.test.ts` passes.

## 8. States

| State | Where | What it says |
| --- | --- | --- |
| Default | every screen | Badge present; sections name their files; one connected account. |
| Empty – first use | Agent accounts | "This project carries no accounts of its own yet. The account found on this machine is used, and it is not committed — it describes this machine. Add an account to commit a login choice with the project." The discovered account is still listed: a bare "No accounts" beside a working login would be false. |
| Empty – first use | Tasks | The shipped hero plus one sentence: "This xezar keeps its settings and its working files in this folder, so everything a task needs travels with the repository." |
| Filtered to nothing | Command palette | The ordinary "No results." Typing another project's name gets no special message – inventing one would be guessing why a person typed a word. |
| Loading – the mode | Sidebar brand block, phone bar | **No badge, no placeholder, no reserved gap** until `/api/v1/health` answers. A badge that guessed and corrected itself would claim a fact it did not have. |
| Loading – a pane | Agent accounts | "Loading agent accounts…" on the cockpit's one muted line (`role="status"`). |
| Error – a pane | Agent accounts | `CenteredState tone="danger"`, "Could not load agent accounts", the server's message verbatim. |
| Error – the project's own file | Resources | "Could not read this project's settings — `.xezar/workspace.json` is not valid JSON. Nothing is saved until it can be read; fix or restore the file and reload." `role="alert"`. Never a silent fall back to defaults, never a silent write to the home directory. |
| Refusal – the mode's own | `/settings/global/projects` | "Projects are not managed here" + the explanation and "Back to settings" (OD-1). |
| Refusal – hosted mode | Agent accounts | Read-only list, every write hidden, one `role="status"` sentence: "Agent accounts are read-only here — they are changed from the machine that owns the checkout, and this cockpit runs in hosted mode." |
| Stale – probe pending | Account row | "Checking…" with a pulsing neutral dot. A row that said "Unavailable" before the probe answered would refuse tasks on a guess. |
| Partial – file absent | Agent accounts | "This project has no `.xezar/agent-accounts.json`. The account found on this machine is used, and any account you add here is saved to that file." |
| Already done | every screen | The default. A second run in an existing single-project root is not an event: no dialog, no toast, no announcement. |
| Phone, 375 px | [phone.html](phone.html) | Badge in the status slot; file note wraps; account actions stack to full width at 44 px. |

## 9. Copy deck

Sentence case, `…` as one character, ` — ` between clauses, no Oxford comma, `xezar` lower case, no
contractions (`writing.md`).

**The badge**

- Visible: `Single project`
- `sr-only` tail: `— xezar settings and state live in this folder, not in your home directory`
- `title`: `xezar settings and state live in this folder`

**The file note** (one pattern, eight sections)

- `Saved in this project — .xezar/config.json. It is committed, so a clone starts with these settings.`
- `Saved in this project — .xezar/workspace.json. It is committed, so a clone starts with these limits.`
- `Saved in this project — .xezar/agent-accounts.json. The logins themselves stay on this machine; only which accounts to use travels.`
- `Saved in this project — .xezar/workspace-ui.json.`
- Appearance: `Theme, accent and density are remembered in this browser; the project's default is saved in .xezar/config.json.`
- Skills: `Saved in this project — .xezar/config.json. The downloaded skills themselves live in .local/xezar and are not committed.`
- File absent: `This project has no .xezar/agent-accounts.json. The account found on this machine is used, and any account you add here is saved to that file.`
- MCP API: no line. Nothing there is written.

**The scope chip**

- Global mode: `Global settings` (unchanged)
- The mode: `Workspace settings`

**The unavailable account** — one string, two surfaces. The Settings row shows the sentence; the task
refusal shows it with the account name prefixed.

- Row: `Unavailable` + `— this account's folder does not exist on this machine: ~/.claude-work. Connect signs in and creates it, or pick another account for the task.`
- Task refusal (`role="alert"`): `Agent account “Work account” is unavailable — this account's folder does not exist on this machine: ~/.claude-work. Connect signs in and creates it, or pick another account for the task.`
- Over a hosted connection the remedy clause changes, because Connect is refused there:
  `…, or pick another account for the task.` becomes `Sign in on the machine that owns the checkout, or pick another account for the task.`

**Hosted mode**

- `Agent accounts are read-only here — they are changed from the machine that owns the checkout, and this cockpit runs in hosted mode.`

**The refused registry page**

- Title: `Projects are not managed here`
- Body: `This xezar runs in single-project mode: it serves this folder only, and adding, removing or switching projects is refused. To work on another repository, start xezar in that folder.`
- Action: `Back to settings`

**The empty states**

- Accounts: `This project carries no accounts of its own yet. The account found on this machine is used, and it is not committed — it describes this machine. Add an account to commit a login choice with the project.`
- Tasks hero, added sentence: `This xezar keeps its settings and its working files in this folder, so everything a task needs travels with the repository.`

**The broken-file error**

- `Could not read this project's settings — .xezar/workspace.json is not valid JSON. Nothing is saved until it can be read; fix or restore the file and reload.`

**The palette**

- Placeholder in the mode: `Search tasks and actions…` (today: `Search tasks, projects and actions…`)

## 10. Developer notes

### 10.1 Files a developer will touch

| File | Change |
| --- | --- |
| `packages/web/src/components/app-shell.tsx` | Brand block becomes two lines in the mode (`:479-494`); the badge component; the same badge into `data-slot="mobile-status"` (`:819`). `Add project` is already gated (`:517`). |
| `packages/web/src/components/app-shell-container.tsx` | `:107` and `:149` – the switcher and project groups read the new capability, not registry length. |
| `packages/web/src/components/project-groups.tsx` | Not rendered in the mode whatever the registry holds. |
| `packages/web/src/routes/new-task.tsx` | `:598` – the project pill reads the capability; `:909` `ProjectPill` itself is untouched. The composer's scope still comes from `/p/<id>/new`, never from the pill. |
| `packages/web/src/components/command-palette.tsx` | `:200`/`:486-487` – no Projects group in the mode; the search placeholder loses "projects". |
| `packages/web/src/routes/settings/settings-shell.tsx` | `:181-190` – the scope chip's text. |
| `packages/web/src/routes/settings/registry.tsx` | The per-section file note (a `fileNote` field on the section entry is the one-place shape this registry already uses for `scope`); the refused `projects` route. |
| `packages/web/src/routes/settings/accounts-section.tsx` | The unavailable row; the hosted-mode branch becomes read-only-list rather than whole-pane substitution. |
| `packages/web/src/routes/settings/project-general.tsx` | The file note on the project pane. |
| `docs/design-system/components.md`, `coverage.md`, `patterns.md`, `cockpit.css` | A row for the badge (and for `SettingsFileNote` if it lands as a shared component) in the same commit – `design-system-drift.test.ts` fails otherwise. |
| Tests | `app-shell.test.tsx`, `app-shell-container.test.tsx`, `settings.test.tsx`, `project-general.test.tsx`, `routes.test.tsx`, `new-task-project.test.tsx`, a new command-palette case, an accounts case for the unavailable row and one for the hosted read-only list. |

### 10.2 Data

- **One capability, read once.** The mode's own capability flag (additive and optional on the wire,
  per DC-2 and the spec's A2) is read where `singleProject` is read today and threaded down. No
  component re-derives it, and nothing infers it from the registry's length.
- **The badge renders only on a definite answer.** `undefined` (health not in yet) renders nothing.
- **The file note's content is server-supplied or table-driven, never string-built in a component.**
  Which key lives in which file is engineering's call (Q3), and the cockpit must not encode a second
  opinion about it. One table in `registry.tsx` beside `scope` is the shape that matches this repo's
  existing one-place rule.
- **The unavailable-account sentence has one owner.** Settings and the task refusal must render the
  same string; the spec's own SP-5.5 asks for a byte-for-byte test. Put it in one exported helper and
  have both sides call it.

### 10.3 What must not happen

- The composer must not lose its scope with its pill. The pill is a control; `/p/<id>/new` is the truth.
- The badge must not become a link to Settings. Nothing about the mode is changeable from here.
- A missing account must not fall back to another login anywhere, for any reason.
- The hosted-mode 409 on account and agent-config writes must not be weakened – listing is a read.
- Global mode must not gain the file note, the second brand line or any new conditional render.

## 11. Accessibility

- Every action on these surfaces works from the keyboard; the badge and the file note are text and
  are not in the tab order, because neither does anything.
- Focus is the existing `:focus-visible` ring. Nothing here adds a focusable element except the
  "Back to settings" button on the refusal page.
- Every control is labelled: the account row's `Connect` and `Show details` keep their text labels;
  the phone bar's menu button keeps `aria-label="Open menu"`.
- Meaning is never in colour alone: "Unavailable" is a word plus a sentence plus a dot; the badge has
  no colour of its own; the mockup's struck-through "removed" markers are design-doc only and every
  removal is also stated in words.
- The hosted notice and the loading lines are `role="status"`; the task refusal and the broken-file
  error are `role="alert"`. The badge announces nothing – it does not change.
- Light and dark both work through theme tokens; there is no `dark:` variant and no raw colour.
- At 375 px nothing scrolls sideways: the file note wraps, the account path breaks inside the word
  (`overflow-wrap: anywhere`), and the account actions stack to full width.
- Phone targets are at least 44 × 44 px at every density (`verification.md` § Phone targets).

## 12. Responsive rules and what gets cut

| Width | What happens |
| --- | --- |
| Desktop, 264 px sidebar | Brand row plus the badge line. The repo/branch chip truncates first, exactly as today. |
| Narrow sidebar (the user can drag it to 264 px minimum) | The badge never truncates – it has its own line. The repo chip absorbs the loss. |
| `< md` (phone and narrow panes) | The sidebar becomes a drawer; the badge appears in the top bar's status slot so the mode is legible without opening it. The desktop settings header – and its scope chip – hides, as it does today; the file note stays, because it is inside the pane. |
| 375 px | Account actions stack to full width; the file note and the unavailable sentence wrap. |

**What disappears first:** the repo/branch chip's tail, then the settings section description (already
`md:` only today), then the scope chip (already hidden below `md`). **What never disappears:** the mode
badge, the word "Unavailable" and its sentence, and the file note.

## 13. Acceptance criteria

One criterion per spec item, each falsifiable by looking at the built cockpit.

| id | Criterion | Falsifier |
| --- | --- | --- |
| DP-1 | In the mode the sidebar shows the flat nav, no `Add project` and no project groups, and the same sidebar in global mode is unchanged – in both themes | Any of the three renders in the mode, or a global-mode sidebar pixel moves |
| DP-2 | The mode badge renders on line two of the brand block with the words "Single project" and no colour of its own; on a development build both it and the dev badge are visible and neither overlaps or truncates | One badge hides the other, the badge carries a status colour, or a 27-character repo name pushes the badge out |
| DP-3 | At 375 px the mobile top bar shows the badge in `data-slot="mobile-status"`, and nothing scrolls sideways | No badge on the phone layout, or a horizontal scrollbar |
| DP-4 | Each Settings section names the file it writes, on a project section and on a global section, and the global scope chip reads "Workspace settings" | A section names no file or the wrong one, or the chip still says "Global settings" |
| DP-5 | A committed account whose folder is absent shows as "Unavailable" with the path named, in both themes, and a task asking for it is refused with the same sentence | The row is silent, the path is missing, the two strings differ, or a task runs on another login |
| DP-6 | The composer footer renders no project pill and the palette renders no Projects group in the mode, and the composer still submits to the scoped route | Either surface renders, or the task lands in another project |
| DP-7 | `/settings/global/projects` in the mode answers with the explanation and a way back, not a bare 404 | A "page not found" with no reason, or a dead end with no action |

Each criterion is also a unit test on the slot or the string; DP-2, DP-3 and DP-5 additionally need
a rendered check in both themes, because a unit test cannot see an overlap, a truncation or a
contrast.

## 14. Worst case, measured

| Thing | Number | Source |
| --- | --- | --- |
| Sidebar width | 264 px minimum (draggable to 420 px) | `patterns.md` §2 |
| Longest repo/branch chip drawn | `platform-internal-tooling / feature/single-project-mode` – 27 + 32 characters | [sidebar.html](sidebar.html) §2, last figure; assumption: longer names exist but truncate identically |
| Badge width at Comfortable | about 92 px including its icon, fixed – it never truncates because it owns its line | measured in the mockup |
| Longest file path in a note | `.xezar/agent-accounts.json` – 26 characters, plus a 96-character sentence | §9 |
| Longest account path drawn | `~/.claude-work`; a real one can be an absolute path of 60+ characters, which is why the row breaks inside the word | `accounts-section.tsx:489` uses `truncate` today with the full path in `title`; the mode's row wraps instead, because the path is the actionable part of the sentence |
| Accounts on one tab | 1 discovered + n committed; the mockup draws 2, and the list is a flat `<ul>` with no cap | `accounts-section.tsx` |
| Settings sections carrying a file note | 8 of 14 registered sections | §9, `registry.tsx` |
| Slowest state | the mode itself, bounded by `/api/v1/health`; the badge is absent until it answers, so there is no flash | §8 |
| Narrowest width checked | 375 px | [phone.html](phone.html) |

## 15. Open decisions

| id | Decision | Recommendation | Who decides |
| --- | --- | --- | --- |
| **OD-1** | `/settings/global/projects` in a narrowed xezar: a plain 404 (today) or an explanation of the mode? | **The explanation, for both narrowings.** The page exists in this build – the narrowing took it away – so "page not found" is a false sentence and it teaches a person to doubt their own bookmark or a link from the guides. A refusal names the consequence and who can act (`writing.md` §7). **Cost, stated plainly:** it changes the answer for `XEZ_SINGLE_PROJECT=1` too, and therefore one assertion in `packages/web/e2e/project-groups.e2e.ts:358-360`, which the slicing spec's proposed SP-4.4 asks to leave untouched. The alternative – explaining only in the new mode – keeps that assertion byte-for-byte and gives one URL two different answers, which is the kind of split BR-6 exists to prevent. | Owner or the leader, on the record |
| **OD-2** | Should the file note appear in **global** mode too, naming `~/.xezar/config.json`? | **No, for 0.16.0.** It answers a question only the mode raises, and adding it everywhere changes the default path for every existing user. Worth revisiting once the mode has been used. | Design review |
| **OD-3** | `Badge variant="outline"` is reused rather than a new `ModeBadge` component. `SettingsFileNote` **is** proposed as a new shared component, because eight sections render the same three-part line. | Accept the reuse; accept the one new shared component with its `components.md` and `coverage.md` rows in the same commit. | Design review |
| **OD-4** | The import ask is terminal-only, so no cockpit dialog is drawn (spec item 8). | Keep it terminal-only. A modal with its own empty, loading and error states for a question asked once, ever, is a second surface for no gain. **The design reviewer should not look for item 8.** | Owner (recorded in §16 as a working default) |
| **OD-5** | Hosted mode lists the accounts read-only, where today it hides them. | Accept. The accounts are committed project state, so which logins the work expects – and that one is missing – is exactly what a hosted reader needs. Every write stays refused and the 409 is untouched. | Design review, with the owner's Q5 answer in §16 |
| **OD-6** | The scope chip's new word is "Workspace settings". | Accept. "Global" is the one word on that header that becomes false in the mode. If a better word exists, this is the place to say so – the chip is one string in one file. | Design review |

## 16. Assumptions the owner has not yet confirmed

These are the leader's working answers to the slicing spec's open questions, taken so this design
could be authored. The owner confirms them separately; a different answer changes what is marked
here and nowhere else.

| Question | Working answer used here | What changes if the owner answers otherwise |
| --- | --- | --- |
| **Q4** – is the import ask a terminal prompt or a cockpit dialog? | **(a) terminal-only.** Item 8 is not drawn. | A dialog is a new surface with its own six states; this design grows by roughly half and PR5 becomes UI in scope. Nothing already drawn changes. |
| **Q5** – hosted mode plus project-local accounts? | **(a) keep the 409.** Accounts are readable over a hosted connection and not writable; [states.html](states.html) §6 draws it. | If writes were allowed, the hosted notice and the hidden actions in that state disappear. The rest of the design is unaffected. |
| **Q2** – the GUI preferences file name? | **(b) `workspace-ui.json`.** Settings names that file in §9 and in the section map. | One string in the Notifications file note. |
| **Q3** – do the machine-shaped keys go to `workspace.json` or `config.json`? | `workspace.json` (the spec's own recommendation), used in the Resources file note. | One string per affected section. The design fixes the sentence pattern, not the mapping; §10.2 requires the mapping to be table-driven for exactly this reason. |
| **Q1** – corrupt or unwritable project state: fail loudly or degrade? | Not assumed. The pane-level error in [states.html](states.html) §5 is correct either way: it says the file is broken and that nothing is being saved. | If the boot refuses instead, that is a terminal surface, not this one. |

## 17. Deliberately not built

- **No import dialog** (OD-4). A person who might expect one after reading FR-4.1 will not find it;
  the ask is in the terminal, once.
- **No way into or out of the mode from the cockpit.** No toggle, no "switch to global", no
  "make this a single-project root" button. The folder decides, and a control that pretended
  otherwise would have to lie about what it does.
- **No project switcher that lists one project.** Not greyed out, not with a tooltip – absent.
- **No migration or import UI for the global registry.** An explicit issue non-goal.
- **No badge in the page header of every page.** The sidebar and the phone bar are enough, and the
  page header belongs to the page.
- **No diff, sync indicator or "your colleague changed this" state.** There is no sync in either
  direction; a UI hinting at one would be inventing a feature.
- **No per-field file names.** Section grain only (§7).

## 18. Delivery plan

1. This mockup and handoff, as a draft PR with `design` and `needs-design` (this change). It also
   carries the one shared-stylesheet fidelity fix of §7 and its `known-gaps.md` row, and the row in
   `designs/README.md`. No cockpit code.
2. `design-review` posts the `## Design review` verdict; every finding gets a disposition here in §20
   and the status rows move per `designs/README.md` § Lifecycle.
3. PR4 of the slicing spec implements it, blocked on `design-approved`, with the unit tests of §13,
   the `design-system-drift.test.ts` rows of §10.1 and its own browser QA.
4. OD-1's cost lands with PR4 or not at all: the `project-groups.e2e.ts` assertion is part of the
   same change as the refusal page.

## 19. Risks

| Risk | Consequence | What keeps it small |
| --- | --- | --- |
| The composer loses its scope with its pill | Tasks post to the wrong project, silently | §10.3 names it; a unit test asserts the submit target while the pill is absent |
| Two spellings of the capability | A surface stays visible for one narrowing and hides for the other | One capability read, threaded down (§10.2); the spec's own SP-4.2 covers the four surfaces |
| The two unavailable-account strings drift | A person reads the Settings row and the task refusal as two different problems | One exported helper, one byte-for-byte test (§10.2) |
| OD-1 changes a browser assertion | A proposed criterion (SP-4.4) has to be amended | Stated in the open decision, not discovered during implementation |
| The badge is mistaken for a control | A person clicks it expecting to leave the mode | Not focusable, no hover state, no cursor change (§6) |
| The file note becomes stale | A pane names a file that no longer holds that key | Table-driven from one place beside `scope` (§10.2) |

## 20. References

- Issue: [qodeca/xezar#600](https://github.com/qodeca/xezar/issues/600) – FR-6, FR-9.2, FR-9.3, FR-10.3, AC-6, AC-9, AC-10.
- Slicing spec, section 4 (items 1–8), section 3 › PR4, section 1.8 business rules – the read-only
  business analysis in run `66cac4b5`'s task evidence. Private evidence: quoted here, never a
  dependency of this document.
- Design system: [README](../../docs/design-system/README.md), [new-designs](../../docs/design-system/new-designs.md)
  §§1–9, [patterns](../../docs/design-system/patterns.md) §§2, 6, 7, 8,
  [components](../../docs/design-system/components.md) (Badge, StatusDot, CenteredState),
  [writing](../../docs/design-system/writing.md) §§1, 7, 10,
  [verification](../../docs/design-system/verification.md),
  [storage](../../docs/design-system/storage.md), [lifecycle](../../docs/design-system/lifecycle.md),
  [known-gaps](../../docs/design-system/known-gaps.md) (G-23 contrast, the sidebar version-chip
  truncation at Roomy – neither is re-introduced here).
- Cockpit sources cited in §2 and §10.1, read at `8905e496`.

## 21. Verification record

Author's own checks. Rendered observations are of the **static mockup**, not of the cockpit, and are
kept separate from what a source test proved. Method: `agent-browser` 0.36.0 (Chrome for Testing
153.0.8010.47) per `docs/testing/agent-browser.md`, pages opened from disk as `file://`, session
`spm-f61a85a8`, mockup at the commit this PR opens with, on macOS 15 arm64, Comfortable density,
default accent.

| Check | Method | Result |
| --- | --- | --- |
| Both themes, every page | Opened all six pages at 1440 × 1000 in dark and again in light through the `theme.js` toggle; full-page captures of each | **Passed.** Read in both; no unreadable pair found by eye, no token-less colour |
| No sideways scroll, desktop | `document.documentElement.scrollWidth` against `clientWidth` on every page at 1440 px | **Passed** – 1440 / 1440 on all six |
| No sideways scroll, 375 px | The same measurement on every page at 375 × 812, both themes for `phone.html` | **Passed** – 375 / 375 on all six, in both themes |
| Sidebar width, the comparison's own claim | Measured both `.sidebar-only` boxes | **Passed** – 264 px and 264 px, the shell's real first column |
| Repo-chip truncation in the worst case | Compared `scrollWidth` with `clientWidth` on all eight brand blocks | **Passed** – exactly one truncates: the 27-character repo on the 32-character branch. Required the shared-sheet fix in §7 |
| Phone target sizes, this design's own controls | Measured `Connect` and `Show details` on the stacked account row at 375 px | **Passed** – 135 × 44 px each |
| Phone target sizes, the shared sheet's chrome | Same measurement on the mockup's menu button and settings pills | **Observed below the floor: 34 × 34 px and 28 px high.** These are `cockpit.css` base classes, not this feature's controls – the cockpit uses `min-h-tap` below `md` and the mockup sheet does not model it. Recorded as an observation, not a design requirement; it is the same limitation every existing mockup has |
| Rendered target sizes at Roomy, Compact and Compact-for-real | – | **Not run.** The mockup follows the 44 px rule in CSS; measuring all four densities belongs to PR4's own verification in the running cockpit (`verification.md` § Phone targets) |
| Accessibility audit | `agent-browser a11y` (axe-core) on all six pages, both themes | **Passed for the design; two doc-page artefacts remain.** No contrast, name, role or colour-only violation on any page. Every page reports `region` (content outside a landmark) and `settings.html` additionally `landmark-one-main`: both are artefacts of a design-doc page that shows app fragments outside a `<main>`, and wrapping them in one would nest a `<main>` inside the shell demos' own. Fixed during authoring: the duplicate-banner and duplicate-landmark findings, by making each pane heading a `<div class="pane-head">` (which is also what the cockpit renders) and by labelling the two demo navs distinctly |
| Console and page errors | `agent-browser errors` after the desktop pass | **Passed** – none |
| Token and base-class discipline | Read `styles.css` against `new-designs.md` §2 | **Passed** – no token redeclared, no base class copied, no raw hex; one deliberate shared-sheet addition, §7 |
| Repository tests | `npm test -- packages/web/src/designs-handoff.test.ts packages/web/src/design-system-drift.test.ts` | **Passed** – 34 tests |
| Keyboard walk | – | **Not applicable to a static mockup.** §11 states what the build must hold; PR4 owns the keyboard evidence |
| Captures | 12 full-page PNGs (six pages × two themes at 1440 px, plus `phone.html` × two themes at 375 px) | Kept as **private task evidence** in the primary checkout's `.local/xezar/tasks/<runId>/design-captures/`, not committed. This document depends on none of them; the pages themselves are the reviewable artefact, and the `design-review` run captures its own per `verification.md` § Design review screenshots |

**Known limitation of the mockup, not of the design.** Chrome blocks `file://` iframes by default,
so the phone preview frames on `index.html`, `sidebar.html` and `states.html` render empty when the
pages are opened straight from disk. Each frame now carries a line saying so and linking
`phone.html` directly. The 375 px checks above were made on `phone.html` itself at a 375 px
viewport, not through a frame.

## Design review

**Verdict: PASS WITH FOLLOW-UPS**, posted on PR #604:
[comment](https://github.com/qodeca/xezar/pull/604#issuecomment-5721745323).

| Finding | Disposition |
| --- | --- |
| NB-1 – `.mode-badge`, `.file-note` and `.refusal-line` lose to a more specific shared `cockpit.css` rule | Accepted with reason: the prose spec (§6, §7, `index.html`'s decision table) already pins the shipped value (`text-muted-foreground`) unambiguously; PR4 implements from that spec text, not from this mockup's CSS, so the specificity bug does not propagate |
| NB-2 – `settings.html:144` and the PR body cite the wrong `states.html` section number for the refusal | Accepted with reason: the `#refused-projects` anchor itself is correct and lands on the right content; only the printed number is stale, which is cosmetic and does not affect PR4 |
| NB-3 – the copy deck (§9) and the rendered strings use straight apostrophes where `writing.md` §1 requires curly | Tracked for PR4 (cockpit slice): the character is settled here as curly, per `writing.md` §1; PR4 ships the curly form in its own copy, and the mockup's straight quotes are corrected whenever the pages are next touched |
| NB-4 – §14 does not record the phone top bar's own worst case (a 67-character title against the fixed 101 px badge) | Accepted with reason: the reviewer's own measurement (title truncates, badge holds 101 px, no overlap, `scrollWidth` 375) is recorded here so it is not rediscovered; §14 itself is unchanged in this docs-only round |
| NB-5 – `index.html`, `sidebar.html` and `states.html` embed a `phone.html` iframe that renders empty from `file://` | Accepted with reason: already recorded honestly in §21 as a known mockup limitation with a working link in each frame; replacing or dropping the iframe is a mockup content change, out of scope for this docs-only round |

### Scoped design review – PR #612, the four deferred copy items

**Verdict: PASS**, posted on PR #612 (`design-approved`):
[comment](https://github.com/qodeca/xezar/pull/612#issuecomment-5724843480).
Scope: only the four #611 review items folded into PR #612 (the accounts card title and
description, the unavailable account row, the Resources pane without "Configure per-project limits",
and the Tasks empty-state sentence). PR #612's own feature, the first-run import, is asked in the
terminal only, so `skip-design` covers it.

| Finding | Disposition |
| --- | --- |
| NB-1 – the unavailable row's danger border tint (§7) is not shipped, and the departure was not recorded | Recorded as the fifth accepted deviation in `docs/design-system/known-gaps.md` G-47: the tint was reinforcement only, and the word, the sentence and the danger dot already carry the state. The row's path now renders in the mono face, as `settings.html` draws it (the code review's m3) |
| NB-2 – `DefaultAgentPicker` (`components/default-agent-picker.tsx:46`) describes the account the global way inside the renamed card, and still offers the unavailable account | Deferred to the docs/copy wave, beside #604's NB-3 remainders: the string is identical in both modes, so nothing regressed, and it does not contradict the row |
| Note – the straight apostrophe in "this account's folder" | Unchanged: the recorded open gap in `known-gaps.md` § copy conventions ("Apostrophes"); the string is byte-identical to the copy deck and pinned across two surfaces |
| Note – under `XEZ_DRY_RUN=1` the credential probe answers `connected` for an absent folder, so `Connect` was hidden | An environment property of the dry-run fixture, not of this design; reported as unknown by the reviewer |
