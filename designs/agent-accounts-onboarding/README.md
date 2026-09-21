# Agent accounts onboarding – problems, the built-in login and the import state

**Status:** Draft – waiting for the first `design-review`. For #819 PR 9 (items 1–3, cockpit side),
label `release-0.18.0`. Base `main` `3e3f010a`.

Pages: [index.html](index.html) (overview) · [pane.html](pane.html) · [import.html](import.html) ·
[states.html](states.html) · [phone.html](phone.html). Every page links
`../../docs/design-system/cockpit.css` first and this folder's `styles.css` second; the light/dark
switch is in the bar (`?theme=light` pins it for a capture).

## 1. Summary

Settings → Agent accounts shows, on one screen: every account each of the four agents has, which one
tasks use ("In use"), the built-in login under that name, any saved choice that names an account the
list does not have (with its fix), and – in single-project mode – whether accounts were copied from
the person's personal xezar setup, with a person-only "Copy N accounts" action. Four agents are
stacked instead of tabbed so all four are read at once. Nothing here is shown in hosted mode except
the pane's existing refusal sentence.

## 2. Problem evidence

Observed in source at `3e3f010a` (`packages/web/src/routes/settings/accounts-section.tsx`, read-only):

- **One agent at a time.** The accounts sit in four `Tabs` (`accounts-section.tsx:180-204`); the
  first read after opening the pane is Claude Code's list only. The one cross-agent summary on the
  page is the Defaults card, whose picker shows one choice per agent
  (`DefaultAgentPicker`, `:396-415`). After an import, a person sees one list and a single choice
  per agent – the brief's "reads as the import failed".
- **No "used by tasks" marker.** No row says which account a task runs under; the reader must match
  the picker above against the rows below.
- **The built-in login is called "Default" and badged "discovered"** (`:514-518`; label synthesised
  as `Default` in `packages/xezar/src/workspace/agent-profiles.ts:81-95`, per spec §2.1). Neither
  word says "this is the login the agent has on its own, and xezar does not save it".
- **A dangling choice is invisible.** A saved default or selection that names a missing id is
  silently resolved to the built-in login at run time (spec §2.1, `agent-profiles.ts:137-138`);
  the pane shows nothing. This repository's own committed accounts file carried such a default
  (spec §2.1).
- **The import has no surface at all.** The outcome lives only in memory
  (`workspace/import-global.ts:76-80`, spec §1.1); there is no later path but the first-run
  terminal question.

Evidence label: the file/line citations above were read in this worktree; the engine citations are
quoted from the spec (`819-spec.md` r1, VERIFIED there) and not re-read here.

## 3. Users and jobs

A person who has just set up a project – usually single-project mode, the folder owns its state –
and opens Settings to check that their agents will run under the right logins before starting
tasks. They just ran the cockpit (or declined a terminal question they barely read); next they start
a task, or add or connect an account. A second reader is the same person weeks later, asking "why did
that task use my personal login?" – the problem line answers that.

Not a reader: an AI agent or project leader. It reads the same facts through MCP (`get_account`,
`discover_project`, spec PR 5) and can never trigger the import.

## 4. Goals and non-goals

Goals:

- G1 all four agents' full account lists readable at once, on a laptop and a phone;
- G2 exactly one "In use" per agent, and the built-in login named as built-in – in words;
- G3 every `unknown-account` problem shown, with what tasks do instead and a one-line fix;
- G4 the import state readable in each of its states, with a person-only action when there is
  something to copy;
- G5 no identity (an e-mail-shaped name) printed on a collapsed surface.

Non-goals (deliberately not built – a user might expect them and will not find them):

- no picking of which accounts to copy – the import is all-or-nothing and merge-only, the same code
  as the CLI; per-account choice would be a second import mechanism;
- no "undo import" – remove an account with the existing Remove, one at a time;
- no re-copy of workspace settings or UI state – the CLI does not do it either (spec §1.3, 1b);
- no import in the global layout, no import through MCP, no automatic import on page load;
- no search or filter over accounts – the realistic count (§ 9 below: up to about six per agent)
  does not justify one;
- no change to Connect, Check again, Show details, Rename, Remove, Add account or the Defaults card.

## 5. Screens

One screen, Settings → Agent accounts (`/settings/global/agent-accounts`, "Workspace settings" in
single-project mode). Order, top to bottom – the reason is the first read: "did my accounts come
over, is anything wrong, then the lists".

1. **Heading and lead** (changed copy), the single-project file note (unchanged).
2. **Import block** (new; single-project mode only) – [import.html](import.html).
3. **Problem summary line** (new; only when `problems` is present and non-empty).
4. **Defaults card** (unchanged; the built-in row reads "Claude Code · Built-in login").
5. **Four agent groups, stacked** (changed; replaces the tabs). Each group:
   - a heading row: agent name (`h3`), facts "Installed · 2.1.4 · 3 accounts" or "Not installed ·
     no accounts", "1 choice to fix" with a pending dot when a problem exists, and "Add account" on
     the right for an agent that can carry accounts;
   - the problem block(s) for that agent, above the list;
   - the account list in today's frame; built-in login first, then added accounts in stored order;
   - OpenCode's existing single-account note under its list.
   Each account row: name ("Built-in login" when `builtIn`, or "Name hidden"), an outline "In use"
   badge on the one `selected` row, the folder, a sub-line for the built-in login ("Found on this
   machine — xezar does not save it.") or for a hidden name, the login state (unchanged), and the
   unchanged actions.

Answers to the brief's design questions:

| Question | Answer | Reason |
| --- | --- | --- |
| Four agents readable at once | Stacked groups with a one-line fact heading; no tabs | Tabs hid three lists, which is the "import failed" reading. A heading line per agent carries install, count and "to fix", so the four are scanned without opening anything. |
| `selected` and `builtIn` without colour | "In use" badge (words + check icon); the built-in row's name is "Built-in login" plus a sub-line | Words first; the icon only reinforces; no tint anywhere. A "Built-in" badge next to a name that says "Built-in login" would say it twice. |
| Where a problem appears | One pane-level line with jump links, and a fix block inside the agent group | The account named has no row; the agent may be screens away on a phone. |
| Import block per state | Card for the first offer; one line after an answer; no button at zero | See [import.html](import.html) and the copy deck. |
| A tool with no accounts | An inline line inside the list frame | A `CenteredState` tile per empty agent would push three agents down for no information. |
| An e-mail-shaped label | Never printed collapsed: "Name hidden" | Identity is opt-in behind Show details already. |

## 6. States

| State | Where | Shown |
| --- | --- | --- |
| Default | pane.html | as § 5 |
| First use, nothing added | pane.html (OpenCode) | built-in login only, "In use" on it |
| Empty agent (not installed) | pane.html (pi), states.html 3a | "No pi accounts yet" + install hint |
| Empty agent (installed, no row) | states.html 3b | "No Codex accounts yet" + Add account |
| Filtered to nothing | N/A | the pane has no filter (non-goal) |
| Loading the pane | states.html 4a | unchanged "Loading agent accounts…" |
| Loading an account's login | pane.html | unchanged "Checking…" with a pulsing neutral dot |
| Loading the import state | import.html 8 | only if fetched apart from the listing: "Checking for accounts to copy…" |
| Load error | states.html 4b | unchanged `CenteredState tone="danger"`, server message |
| Refusal (hosted) | states.html 4c | unchanged sentence; no import, fix or CLI line |
| Refusal of the copy (409) | import.html 7 | danger toast, the server's sentence |
| Import: unknown, >0 / unknown, 0 / declined, >0 / declined, 0 / done, 0 / done, >0 | import.html 1–4b | see copy deck |
| Copying / copied / copy failed | import.html 5–7 | "Copying…" disabled; toast; danger toast, block unchanged |
| Problem where=defaults / selection / hidden handle / two problems / fixed | states.html 1a–1e | see copy deck |
| Stale or partial | states.html 5 | absent `globalImport` → no block; absent `problems` → no line; stale count → idempotent copy |
| Already done | import.html 2, 4 | a line, no button |
| Global layout | states.html 6 | no import block or file note; "Default" marker; "new projects" wording |

## 7. Copy deck

Sentence case, curly quotes and apostrophes, ` — ` between clauses in UI text, `…` for pending, no
Oxford comma (writing.md §1). Every string is generic: agent names come from `RUNNER_LABEL`
(`lib/runner-label.ts`), `{n}` is a number, `{handle}` is the stored id.

**Pane lead** (replaces "One agent per tab: …"):
- single-project: "Every agent, whether it is installed, and the logins you have for it. “In use” marks the login tasks in this project run under. The built-in login is the one each agent finds on this machine by itself; tasks use it when no other account is chosen."
- global: "Every agent, whether it is installed, and the logins you have for it. “Default” marks the login a project runs under when it has not chosen one. The built-in login is the one each agent finds on this machine by itself; xezar uses it when no other account is chosen."

**Account rows:**
- built-in name: "Built-in login"; sub-line: "Found on this machine — xezar does not save it."
- marker: "In use" (single-project) / "Default" (global)
- hidden name: "Name hidden"; sub-line: "The name looks like an e-mail address, so it is not shown here. Show details to see it or rename it."
- Defaults picker row for the built-in login: "{Agent} · Built-in login"; for a hidden name: "{Agent} · Name hidden"
- Remove confirm title for a hidden name: "Remove this account?"; toast: "Account removed"

**Agent heading facts:** "Installed · {version} · {n} accounts" ("1 account"); "Installed · no accounts"; "Not installed · no accounts"; "Checking…" while health has not answered; problem count "{n} choice to fix" / "{n} choices to fix".

**Empty agent:**
- not installed: title "No {Agent} accounts yet"; body "{Agent} is not installed on this machine. Install it — {existing PROVIDER_INSTALL string} — and the login it finds appears here."
- installed: title "No {Agent} accounts yet"; body "xezar lists the login {Agent} finds on this machine and any account you add. Use Add account to add one."

**Problems** (`{handle}` in `<code>`; omitted when it looks like identity):
- summary: "{n} account choice names an account that is not in this list." / "{n} account choices name accounts that are not in this list." + " Tasks still run, with the built-in login. See {Agent}, {Agent}."
- where=defaults, single-project: "The project default for {Agent} names {handle}, which is not in this list. Tasks use the built-in login instead." Fix: "Fix: choose an account under Defaults for this project, or use the built-in login."
- where=defaults, global: "The default for new projects for {Agent} names {handle}, which is not in this list. Projects that have not chosen use the built-in login instead." Fix: "Fix: choose an account under Defaults for new projects, or use the built-in login."
- where=selection: "This project’s own choice for {Agent} names {handle}, which is not in this list. Tasks use the built-in login instead." Fix: "Fix: choose an account in this project’s Agents settings, or use the built-in login." ("Agents settings" links to the project's Agents section.)
- hidden handle: "… names an account that is not in this list. …"
- button: "Use the built-in login"; pending "Saving…"; toast "{Agent} now uses the built-in login"

**Import block** (single-project only):
- unknown, n>0 (card) – heading "Copy accounts from your personal setup"; body "{n} accounts in your personal xezar setup on this machine are not in this project yet. Copying adds their names and config folders to .xezar/agent-accounts.json, which is committed, so everyone who clones this project sees them. Sign-ins stay in their own folders and are never copied." (n=1: "1 account … is not in this project yet."); button "Copy {n} accounts" / "Copy 1 account"; CLI line "Or run xezar accounts import-global in a terminal in this folder."
- unknown or declined, n=0 (line): "There are no accounts in your personal xezar setup that this project does not already have."
- declined, n>0 (line + button): "You chose not to copy accounts from your personal xezar setup when this project was set up. {n} can still be copied into .xezar/agent-accounts.json." button "Copy {n} accounts"
- done, n=0 (line): "Accounts were copied from your personal xezar setup — this project has all of them."
- done, n>0 (line + button): "Accounts were copied from your personal xezar setup. {n} more were added there since and can be copied too." button "Copy {n} accounts"
- pending: "Copying…"; loading (only if separate): "Checking for accounts to copy…"
- toasts: "Copied {n} accounts", "Copied {n} accounts — {k} was already in this project" ("{k} were"), "Nothing new to copy — this project already has every account"; failure: the server's message, danger tone.

The file name in the copy is the file the single-project layout writes; if the engine names it
differently, the copy follows the engine (the file note already reads it from `registry.tsx`).

## 8. Developer notes

**Data** (decided in the brief; engine PRs 2, 3 and 5 are in flight – design against these, not today's API):

- per provider, every account with `builtIn: boolean` and exactly one `selected: true`;
- `problems: {kind: 'unknown-account', where: 'defaults' | 'selection', provider, handle}[]`,
  additive on `GET /api/v1/workspace/agent-profiles`; hosted mode serves `[]`;
- `globalImport: {state: 'done' | 'declined' | 'unknown', importable: number}`, project layout only;
  absent in the global layout. Where it rides (the listing, or its own read) is the engine's call;
  prefer the listing so the pane has one loading state.
- the import action: a person-only `POST /api/v1/workspace/agent-profiles/import-global`
  (spec §11 PR 9) – contract schema first in `packages/contract`, chained into its family builder,
  validated as middleware, 409 in hosted mode, answering added/kept counts. It must run the same code
  as `xezar accounts import-global`.

**The cockpit derives nothing it is sent.** `selected`, `builtIn` and `problems` come from the
server; the pane never recomputes which account is in use (the server's resolution order is the
run's). Absent fields render nothing (§ 6, partial).

**Files the implementing PR touches:** `packages/web/src/routes/settings/accounts-section.tsx`
(tabs → stacked groups, rows, problems, import block), `packages/web/src/components/default-agent-picker.tsx`
(built-in and hidden-name row labels), `packages/web/src/api/*` (the import mutation, invalidating
the accounts listing), `packages/contract/src/agent-profiles.ts` (only if this PR owns the import
route), their tests, and `docs/design-system/` (writing.md quotes; `components.md` Tabs "Where used"
drops to 0 files – see gap DG-1).

**Components and tokens reused** (by their design-system names): `Badge variant="outline"`
("In use"), `StatusDot tone="pending"` (problems, no pulse) and the existing login-state dots,
`Button` `outline`/`ghost` size `sm`, `CenteredState tone="danger"` (load error, unchanged),
`toast` default and danger, `DefaultAgentPicker`, `SettingsShell` pane spacing, the file note,
the "message then Fix:" block of writing.md §7 (`mcp-leader-control.tsx`), card spelling
`rounded-lg border border-border bg-card p-inset`. Tokens: `--muted`, `--muted-foreground`,
`--soft-foreground`, `--foreground`, `--card`, `--border`, `--pending`, `--success`, `--ring`,
rhythm `--spacing-row/stack/list/inset/group/section`, `--spacing-tap`. No new token.

**The implementing PR must NOT:**

- let an AI agent trigger the import: no MCP action, no leader event handler, no automatic import on
  page load or on boot, no default-yes – the only triggers are this button and the CLI command;
- render the import block, a fix button or the CLI hint in hosted mode (absent, not disabled);
- print an e-mail-shaped label or handle anywhere collapsed – row, picker, toast, confirm title,
  problem sentence – and must use the engine's `looksLikeIdentity` rule, not a second regex;
- add anything to `/api/v1/health` (the CORS-exempt route must not carry account handles or import
  state);
- compute `selected` or `problems` in the browser;
- show a count of zero on a button or treat an absent field as `unknown`;
- change Connect, Check again, Show details, Rename, Remove or Add account behaviour;
- use the danger tone for a problem (nothing is broken).

**Tests the implementing PR should carry** (suggested): one `In use` per agent from `selected`;
built-in label from `builtIn`; problem line and fix per `where`, and none when `problems` is absent;
each import state's text and the presence/absence of the button; no import block when
`editable === false` or `globalImport` is absent; a label `a@b.example` never in the DOM before Show
details; the browser suite at 375 px for no sideways scroll.

## 9. Accessibility

- **Keyboard and focus order:** heading → import button → (CLI text, not focusable) → problem
  jump links → Defaults radios → default-model selects → per agent: Add account → the problem's
  "Agents settings" link and "Use the built-in login" → each row's Connect, Check again, Show
  details. A jump link moves focus to the agent's heading (`tabIndex={-1}` on the `h3`), not only
  scroll. The visible ring is the cockpit's `focus-visible:ring-[3px] focus-visible:ring-ring/50`;
  pane.html draws it statically on "Copy 3 accounts".
- **Labels:** every control is a real `<button>` or `<a>` with visible text; the agent groups are
  `section`s labelled by their `h3`; the import block is a `section` labelled by its heading;
  "In use" is visible text inside the row, so a row reads "Built-in login, In use, ~/.claude,
  Connected". Dots are `aria-hidden` – the words beside them carry the meaning.
- **Announcements (polite, never assertive):** the problem summary is `role="status" aria-live="polite"
  aria-atomic="true"`, so a changed count is read and its first render is not; the import block owns
  an `sr-only` announcer of the same shape that reads the new state line after a copy; toasts are
  announced as today.
- **Not colour alone:** "In use", "Built-in login", "1 choice to fix", the login state word and
  every problem sentence are words; the pending dot and check icon only reinforce.
- **Themes:** light and dark through tokens only; checked in both (§ 12).
- **Motion:** nothing new animates.

## 10. Responsive

- At 375 px nothing scrolls sideways: measured `scrollWidth == clientWidth == 375` on pane, import
  and states pages, dark and light (§ 12). Paths wrap at any character.
- Below `md`: the page header and section nav go (mobile bar + settings pills, as today); every
  button is 44 × 44 px (`min-h-tap min-w-tap`); "Copy {n} accounts", "Use the built-in login" and
  "Add account" go full width; row actions share one line.
- **Cut first:** the agent version, then "Check again" (moves into Show details). **Never cut:**
  an account's name or "Name hidden", "In use", the login state, a problem sentence and its fix,
  the import sentence and button.
- **Worst case (assumptions stated):** six accounts per agent (24 rows; this repository commits four
  across all agents); a 60-character label; an 80-character folder path; two problems at once
  (one per `where`); the copy answering in under a second (a small local file read – not measured).
  Rendered height at 1280 px for the drawn default (nine rows): 2 056 px including the design bar.

## 11. Acceptance criteria

- DA-1 All four agents' accounts are visible without switching anything; each agent shows exactly
  one "In use" (single-project) or "Default" (global) marker, in words.
- DA-2 The built-in login reads "Built-in login" with "Found on this machine — xezar does not save it."
  in the row and in the Defaults picker; "Default" and "discovered" no longer name it.
- DA-3 A `where: 'defaults'` problem shows the summary line and the agent's fix block with the
  defaults copy; `where: 'selection'` shows the selection copy with a link to the project's Agents
  settings; "Use the built-in login" clears the choice and the problem disappears on refetch.
- DA-4 Each import state renders exactly the copy in § 7, with a button only when `importable > 0`;
  the button and the CLI command produce the same result.
- DA-5 In hosted mode the pane shows only its refusal sentence; the import block, fix buttons and
  CLI line are absent from the DOM; in the global layout the import block is absent.
- DA-6 An e-mail-shaped label or handle is not in the DOM before Show details is pressed.
- DA-7 At 375 px in light and dark no page scrolls sideways and every target is 44 × 44 px at every
  density; every action works from the keyboard with the visible ring; the summary count change is
  announced politely.
- DA-8 Nothing new is served on `/api/v1/health`, and no MCP action triggers the import.

## 12. Verification record (this mockup)

Tool: agent-browser 0.36.0 (headless Chrome), opening the pages from disk, head of this branch.
Captures are private working evidence in the task's evidence directory, not referenced by path here.

| Check | Width | Theme | Result |
| --- | --- | --- | --- |
| pane.html no sideways scroll | 1280, 375 | dark, light | passed (`scrollWidth == clientWidth`) |
| import.html no sideways scroll | 375 | dark, light | passed |
| states.html no sideways scroll | 375 | dark, light | passed |
| Keyboard focus ring | 1280 | dark | drawn statically (`.focus-demo`); live Tab order not run |
| 44 px targets at every density | 375 | – | not run (mockup CSS sets `min-height: var(--spacing-tap)`; measure in the app) |
| Contrast measurement | – | – | not run; only existing token pairs are used |
| Screen reader | – | – | not run |

## 13. Open decisions

- **OD-1 Stack the agents instead of tabs.** Departs from the documented reason in
  `accounts-section.tsx:61-66` ("Stacking every agent on one scroll made the answer to 'what's up
  with Codex' something you had to hunt for"). This design answers that with a one-line fact
  heading per agent and jump links. If review keeps the tabs, the fallback is tab labels carrying
  "· {n}" and a "to fix" word, which still hides three lists.
- **OD-2 "Use the built-in login" as a one-click fix** writes the committed accounts file in
  single-project mode. It is reversible and matches what tasks already do; review may prefer text only.
- **OD-3 The global-layout marker "Default".** `selected` in the global layout is the machine
  default, not what every project runs, so "In use" would be untrue there.
- **OD-4 Selection problems in the global layout** need a project name the decided shape does not
  carry. Until it does, the global pane shows the selection copy without a project and the fix
  points at "that project's Agents settings"; alternatively show only `defaults` problems there.
- **OD-5 "personal xezar setup"** is the plain-words name for the machine-wide xezar home; the CLI
  and docs say "global". Pick one term for both surfaces.
- **OD-6 No confirm dialog on "Copy {n} accounts".** The card states the cost before the click and
  the copy is merge-only; a confirm would repeat it. Review may want one because the file is committed.

## 14. Design-system gaps met (known-gaps style; not fixed here)

### DG-1 Tabs would have no remaining user

- **Differs**: `components.md` lists `Tabs` as used in one file, `settings/accounts-section.tsx`.
  This design removes that use.
- **Rule**: a primitive with no user is a dead primitive (G-20).
- **Fix**: the implementing PR updates the Tabs entry and `coverage.md`, or G-20 gains Tabs.

### DG-2 No named in-pane notice component

- **Differs**: the problem block reuses the "message then Fix:" spelling from writing.md §7
  (`mcp-leader-control.tsx`) because no shared notice component exists; `ProviderBanner` and
  `OnboardingOfferRow` are shell-row banners, not in-pane.
- **Rule**: reuse the writing.md §7 block.
- **Fix**: if a third pane needs it, extract a shared component and give it a `coverage.md` row.

### DG-3 An identity-shaped label has no documented treatment

- **Differs**: writing.md and patterns.md describe identity as opt-in behind Show details, but not
  what to print in place of a label that is itself identity-shaped.
- **Rule proposed here**: "Name hidden" with a sub-line; engine `looksLikeIdentity` decides.
- **Fix**: record it in writing.md once approved.

## 15. Delivery plan

PR 9 after PRs 2 and 3 land (import outcome storage, `problems`). If the import route is included,
PR 9 is `risk-high` and owns the contract and `server.ts` for its wave (spec §11). Design gate:
this folder, `needs-design` → `design-approved`; QA: browser, both themes, 375 px.

## 16. Risks

- The copy promises clones see the names; if the engine ever writes elsewhere, the sentence is wrong
  – the file name must come from the same source as the file note.
- Stacking lengthens the page (2 056 px at 1280 for nine rows); a person with many accounts scrolls
  more. Mitigated by the heading facts and jump links; revisit if real counts exceed six per agent.
- An e-mail-shaped label copied by the import still lands in the committed file; this design hides
  it on screen but cannot un-commit it. The import copy names the file so the person can check.
- The engine shapes are designed against, not observed; a later shape change reopens § 7–8.

## 17. References

- Spec: #819 business analysis r1 (`819-spec.md`, private task evidence of run `5dc7454f`), § 1, 2, 3, 11 "PR 9", 12 Q1–Q2.
- Issue: https://github.com/qodeca/xezar/issues/819 (read as data).
- Source read: `packages/web/src/routes/settings/accounts-section.tsx`, `packages/web/src/components/default-agent-picker.tsx`, `packages/web/src/routes/settings/agents-section.tsx` at `3e3f010a`.
- Design system: `docs/design-system/README.md`, `recipes.md` §3 and §5, `patterns.md` §4–8, `components.md`, `writing.md`, `new-designs.md`, `known-gaps.md` (G-20), `verification.md`.
- Prior art in this repository: `designs/single-project-mode/` (the file note, the unavailable account row). No external prior art was used.

## Design review

Pending.
