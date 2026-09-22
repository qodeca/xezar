# Agent quota – plan limits in Settings → Agent accounts and a limits chip

Status: **Draft** – mockup for #867 step S4, waiting for the owner's look (D34) and then the first
`design-review`. Nothing here changes `packages/web`.

Start with [index.html](index.html). Pages: [the pane](accounts.html), [the chip](chip.html),
[every state](states.html), [phone](phone.html). Every page links
`../../docs/design-system/cockpit.css` first and this folder's `styles.css` (feature rules only),
opens from disk, and has a light / dark switch (`?theme=light` pins a theme for a capture).

## 1. Summary

For every Claude Code and Codex login, the cockpit shows how much of the short and weekly limits is
used, when each resets, and whether the login can work now – the same answer the leader reads
through the MCP (`project_config` → `read_quota`). Three pieces:

1. **A limits half in every account row** of Global settings → Agent accounts: a status sentence,
   one line per window (5-hour, weekly, weekly per model) with a bar, the percentage and the reset,
   extra credits, the plan, the age of the reading and a Refresh control. The row's existing Show
   details panel gains a “Plan limits in detail” half.
2. **A Plan limits block** at the top of that pane: one summary sentence per agent, Refresh all and
   the promise that xezar shows these facts and never acts on them.
3. **A limits chip** on every page: a band above the sidebar footer on a desktop
   (`● Claude Code 3/5  ● Codex 1/1`), the top bar's status slot on a phone (`● 4/6 can work`). It
   opens a Popover that names the logins that are out or unknown and links to the pane.

The cockpit only shows facts. It never switches a login, holds a task back or changes auto-resume
because of them (D2).

## 2. Problem evidence

- #867 § 2: xezar reads token counts but no account limits; a limit is learned only after a run
  fails, by matching error text (`parseUsageLimit`, `core/usage-limit.ts`). The leader spends a
  probe task per login to learn whether it has quota.
- #867 § 5 and the S0 proof comment on #867 (2026-09-22): the real facts are available at zero model
  tokens. Claude Code's `/usage` on the built-in login read “Current session: 92% used · resets Sep 22
  at 5:10pm”, “Current week (all models): 26% … Sep 28 at 7pm”, “Current week (Fable): 29%”. A
  named Claude Code login answered with **no** session or weekly lines at all. Codex
  `account/rateLimits/read` read `planType: pro`, one `primary` window of 10 080 minutes at 0 % with
  `resetsAt` 1790685902 (Tue Sep 29, 14:45 CEST), `secondary: null`, credits `hasCredits: false`,
  `balance: "0"`. The mockup uses exactly those numbers for its built-in logins, and the unknown row
  reproduces the named login that reported nothing.
- The cockpit today: Global settings → Agent accounts
  (`packages/web/src/routes/settings/accounts-section.tsx`) lists every login per agent, stacked, with
  Connected / Not connected and Check again; it says nothing about limits. The shell
  (`components/app-shell.tsx`) has no desktop top bar – only the sidebar and a phone top bar.

## 3. Users and their job

**Reader:** the person supervising a project leader – locally, or from a hosted cockpit – and anyone
choosing a login or model for a task by hand. **What they just did:** the leader reported a login out
of quota, a task failed on a limit, or they are about to start work on a named login. **The job:**
decide in seconds whether their logins can work now, which one comes back first, and which model
still has weekly room. **What they do next:** pick a login or model for a task in the composer, or
tell the leader – outside this surface. Nothing on this surface acts.

## 4. Goals and non-goals

Goals (from #867 D3): no probe tasks, no lost runs, plan the week, pick the model – each by reading,
not by trying.

**Deliberately not built** (a user might expect these and will not find them):

- No “switch to this login”, no warning dialog before a task starts, no auto-pick (D2).
- No pace, forecast, history chart or “you will run out at …” (D4). Codex's own token totals appear
  in details as Codex reports them; xezar computes no totals (D21).
- No OpenCode, pi or DeepSeek balance (D10). Their groups stay exactly as today, and the Plan limits
  block says in one sentence that they do not report plan limits.
- No limits for API-key logins, and no organisation rate limits or billing – they read “Limits not
  reported”.
- No guess that two logins share a window (D19): every row stands alone.
- No per-row history of checks, no notification when a login comes back, no search or filter (the
  longest real list is a handful of logins per agent).

## 5. Screens

### 5.1 The first read

Before anything is expanded, a person must see, per login: **can it work now** (a word), **when it
comes back** if it cannot (in the same sentence), **each window's percentage and reset**, and **how
old the reading is**. That is the collapsed row. Details (source, next check time, what is not
reported, Codex token totals) wait behind Show details.

### 5.2 Scanning many

Order is today's: agents stacked (Claude Code, Codex, then OpenCode and pi unchanged), and within an
agent the built-in login first, then named accounts as `listAgentProfiles` returns them (FR-1). The
order does **not** change with status – a row that jumps when its quota changes is harder to find,
and the summary block already lists the ones that are out. Each row shows at a glance: status
sentence, one line per window, credits, plan and age. A person scanning for “which one can I use”
reads the status words down the left edge; the bars line up in one column so a near-full window
stands out without reading every number.

### 5.3 The distinction that matters most

**Can work now against cannot.** It is said in words first – “Can work”, “Out until 17:10 CEST
(+02:00) — the 5-hour limit is used up”, “Limits unknown — …”, “Limits not reported — …” – in bold
at the start of the limits half. The `StatusDot` reinforces it: success (can work), pending (can work
but near a limit or paying from extra credits), danger (out), no colour (unknown or not reported).
The bar turns amber from 80 % and red at 100 %, always beside the number. The second distinction is
**fresh against stale**: every reading carries its age, and past 15 minutes an outline badge reads
“Stale” beside it.

### 5.4 Settings → Agent accounts ([accounts.html](accounts.html))

Route: `/settings/global/accounts` (Global settings → Agent accounts; “Workspace settings” in
single-project mode). #867 names it “Settings → Agents”; the accounts live in this pane
(`accounts-section.tsx`), not in the project-scoped Agents section, so that is where the rows go.

Order of the pane, top to bottom: title and lead (unchanged) → **Plan limits block (new)** → problem
summary and Defaults for new projects (unchanged) → the agent groups, each row gaining its limits
half.

**Plan limits block** (`data-slot="agent-quota-summary"`, `id="limits"` so the chip can link to it):
a card (`rounded-lg border border-border bg-card p-inset`) with the heading “Plan limits”, a Refresh
all button, one line per applicable agent with its `StatusDot` and the server's summary sentence
(`summaries[].text`), plus a jump link to the first login that is out; then two fine-print sentences
(what this is and that it never acts; the refresh pace). The summary list is a polite live region.

**Limits half of a row** (`data-slot="account-limits"`, `role="group"`, labelled “Plan limits of
{name}, {agent}”): under the existing name/path/Connected and actions, full width, after a dashed
hairline:

1. Status sentence (`limit-status`): dot, **bold status**, muted reason.
2. Window list (`win-list`), one line per window: label · bar · “58% used” · “resets …”. A window
   whose reading is older than the row's adds “· as of 38m ago”.
3. A note when a tool reported no short window (“Codex reported no short window for this login.”).
4. Credits line: Claude Code “Extra credits: off.” / “on — 12.40 of 50.00 USD used this month (25%).”
   / “on, in use now — …”; Codex “Credits: none — balance 0.” / “unlimited.”; then “Member limit:
   …”, “Spend limit: reached.” and “Limit-reset credits: 2 available.” when present.
5. Warnings from `warnings[]`, each a pending dot and one sentence.
6. Meta line: optional “Stale” badge, “Plan: max · checked 6m ago”, and the **Refresh** button on
   the same line – the line it changes.

**Show details** (existing panel) gains “Plan limits in detail”: where the numbers came from and the
tool version, login kind, full credits facts, spend limit, member limit, limit-reset credits,
Codex's reported tokens (total, busiest day, by day), next check allowed, and “Not reported by
Claude Code / Codex: …” listing every `notReported` field in words.

### 5.5 The chip ([chip.html](chip.html))

**Where.** The cockpit has no desktop top bar, so the chip is a band of its own
(`data-slot="agent-quota-band"`) directly above the sidebar footer's controls row – the same “own
band” approach as “Other projects” (patterns.md §2). The footer row stays one unwrapped row (#702);
its elastic item stays the version chip. On a phone the chip sits in the top bar's
`data-slot="mobile-status"` slot (patterns.md §9), where the page title truncates first.

**What.** Desktop: one segment per applicable agent – `StatusDot` + product name + `canWork/total`
in mono (`Claude Code 3/5`). Phone: one combined count with the worst tone, `4/6 can work`. The dot
per agent: success when every login can work, pending when some cannot, danger when none can, none
while nothing is known. Stale adds the word “stale”.

**Press.** It is a button (`aria-haspopup="dialog"`, `aria-expanded`) opening a `Popover` titled
“Logins that can work now”: each agent's summary sentence, under it the logins that are out (with
reset), unknown or near a limit; a foot with the age range of the readings, the never-acts sentence
(and, in hosted mode, how the page stays current) and an “Open agent accounts” button linking to
`#limits`. Escape closes it and returns focus to the chip. The chip never starts a check.

**When absent.** No agent installed with a subscription login (D38), no answer yet, or the first
load failed: no band, and the footer is exactly today's. A “0/0” or “—” chip would claim something
nobody measured.

## 6. States

Every state has its own sentence. [states.html](states.html) shows each one; the chip's states are
on [chip.html](chip.html).

| State | Where | What the person sees |
| --- | --- | --- |
| Fresh, can work | row | “Can work”, windows, credits, “checked 6m ago”, Refresh |
| Near a limit | row | pending dot, “Can work — near a limit: the 5-hour window is 92% used.”, amber bar |
| Using extra credits | row | pending dot, “Can work — using extra credits: …”, credits line “on, in use now” |
| Out – 5-hour / weekly | row, chip, block | danger dot, “Out until 17:10 CEST (+02:00) — the 5-hour limit is used up.”, red bar |
| Out – workspace credits (Codex) | row | “Out until … — the workspace owner’s credits are used up.” + “This limit belongs to the workspace, not to this login.” |
| Out – from a failed task | row | “— a task under this login stopped on the usage limit 3m ago.”, meta “from a failed task 3m ago” |
| A reset passed (already done) | row | the spent window is removed, “Can work — the 5-hour window reset at 17:10.”, “Its new number arrives with the next check.” |
| First check, no numbers | row, chip | “Checking the limits…”, no dot, no bar; chip “Checking limits…” |
| Checking (stale row) | row | numbers kept, “Stale” badge, age, “Checking…” in place of Refresh |
| Stale, gap holds the check | row | numbers kept, “Stale”, warning “The last check did not answer within 20 seconds.”, next check time |
| Refresh in the 5-minute gap | row | Refresh unavailable (focusable), “next check allowed at 16:51 CEST (+02:00)” on the same line |
| Refreshing | row | “Refreshing…” on the button, numbers kept |
| Unknown – no limit lines | row | “Limits unknown — Claude Code reported no limits for this login.” + “Tasks can still start under this login.” |
| Unknown – timeout / format / old version / not installed | row | one reason sentence each; no Refresh for old version and not installed |
| Fallback – /usage text | row | numbers + warning “Read from the /usage text, because the usage request failed. That text is not a fixed format.” |
| Fallback – live data only | row | numbers + warning “Per-model weekly limits are not shown: they come only from a check, and the last check failed.” |
| API-key login | row | “Limits not reported — API-key logins do not report plan limits.”, no windows, no Refresh |
| Loading | block, chip | “Loading plan limits…” with a card-sized reserve; rows show no limits half; no chip |
| Load error | block, chip | “Could not load plan limits” + the server's words + Retry; no chip |
| Refresh all running / all in gap | block | “Refreshing…” + “Checking 6 logins, 2 at a time.” / unavailable + “Every login was checked in the last 5 minutes. The next check is allowed at …” |
| Refresh toasts | toast | success, raced into the gap, partial, request error (writing.md §13) |
| Hosted mode | block, rows, chip | account management refused (today's sentence) + “Their plan limits are below.”; rows show name and limits only; the fetch-not-push sentence |
| Empty – no login known | block, chip | “No plan limits to show” + install-and-sign-in sentence + why the sidebar shows no summary; no chip |
| API-key logins only | block, chip | “Claude Code: 1 login, which uses an API key and reports no plan limits.”; no chip |
| Filtered to nothing | – | N/A: no filter or search |
| Refusal (hosted 409) | – | N/A for limits: every limits action is allowed in hosted mode (D9) |

## 7. Copy deck

UI copy follows [writing.md](../../docs/design-system/writing.md): sentence case, `…`, spaced em
dash ` — ` in the UI, no Oxford comma, `xezar` lower case, product names from `runner-label.ts`.

**Plan limits block**

- Heading: “Plan limits”. Button: “Refresh all” / pending “Refreshing…”.
- Summary line: the server's `summaries[].text` with the product name from `runner-label.ts`:
  “Claude Code: 3 of 5 logins can work.”, “Codex: 1 of 1 login can work.”, “Claude Code: 0 of 5 logins
  can work; first free at 17:10 CEST (+02:00).” When one login is out, it adds “{name} is out until
  {time}.” with {name} as a jump link.
- Fine print: “How much of each login’s short and weekly limits is used, as Claude Code and Codex
  report it, with the age of every reading. xezar only shows these facts — it never switches logins,
  holds a task back or changes auto-resume because of them. Times are in the server’s zone, {IANA
  zone}. OpenCode and pi do not report plan limits.”
- Pace: “Refresh all checks every login last checked 5 or more minutes ago, 2 at a time; the rest
  wait their turn.” Running: “Checking {n} logins, 2 at a time.” All in gap: “Every login was checked
  in the last 5 minutes. The next check is allowed at {time}.”
- Hosted: “This cockpit is not on the machine that runs the agents, so it reads the limits again when
  the server reports a change, and every 15 minutes while this tab is open.” The pane lead adds
  “Their plan limits are below.” after today's refusal sentence.
- Loading: “Loading plan limits…”. Error: title “Could not load plan limits”, body the server's
  message verbatim, button “Retry”.
- Empty: “No plan limits to show” / “No Claude Code or Codex login is known on this machine. Install
  either one and sign in, and its short and weekly limits appear here. Until then the sidebar shows no
  limits summary.” API keys only: “{Agent}: {n} login(s), which use(s) an API key and report(s) no plan
  limits.” / “The sidebar shows no limits summary: none of these logins has a plan with limits.”

**Status sentences** (bold part, then muted reason)

| `status` / `statusReason` | Sentence |
| --- | --- |
| ok | **Can work** |
| ok, stale | **Can work** — as of {age} ago. |
| warning / near-limit | **Can work** — near a limit: the {window} is {n}% used. |
| warning / using-extra-credits | **Can work** — using extra credits: the {window} is used up, so requests are paid from extra credits. |
| limited / usage-limit | **Out until {time}** — the {5-hour / weekly} limit is used up. |
| limited / credits-depleted | **Out until {time}** — the extra credits are used up. |
| limited / spend-limit | **Out until {time}** — the spend limit is reached. |
| limited / workspace-usage-limit | **Out until {time}** — the workspace’s usage limit is reached. + “This limit belongs to the workspace, not to this login.” |
| limited / workspace-credits-depleted | **Out until {time}** — the workspace owner’s credits are used up. + the same note |
| limited, `source: error` | **Out until {time}** — a task under this login stopped on the usage limit {age} ago. |
| limited, no `limitedUntil` | **Out** — {reason}. The reset time was not reported. |
| unknown / not-reported (no lines) | **Limits unknown** — {Agent} reported no limits for this login. + “Its answer had no session or weekly lines, so xezar cannot say how much is left. Tasks can still start under this login.” |
| unknown / check-failed | **Limits unknown** — the last check did not answer within 20 seconds. |
| unknown / format-changed | **Limits unknown** — {Agent} {version} changed how it reports usage, so xezar cannot read it. |
| unknown / version-too-old | **Limits unknown** — update {Agent} to at least {minimum} to report limits. + “{Agent} {version} is installed.” |
| unknown / not-installed | **Limits unknown** — {Agent} is not installed on this machine. |
| unknown, `loginKind: apiKey` | **Limits not reported** — API-key logins do not report plan limits. |
| refreshing, no reading yet | **Checking the limits…** |

**Windows.** Labels: `short` with 300 minutes “5-hour window”; other `short` “Short window
({h} hours)” or “Short window”; `weekly` “Weekly, all models” for Claude Code and “Weekly” for Codex;
`weekly` with `model` “Weekly, {model}”; `short` with `model` “5-hour window, {model}”; `other` the
tool's `label`. Value: “{n}% used” (integer as reported). Reset: “resets {HH:mm} {zone} ({offset})”
today, “resets {Mon d}, {HH:mm} {zone} ({offset})” on another day; no reset reported: “reset time not
reported”. Older window: “· as of {age} ago”. Missing short window: “{Agent} reported no short window
for this login.”

**Meta and Refresh.** “Plan: {plan}” (the tool's own word, verbatim; “—” when null) · the age:
`source: check` “checked {age} ago”, `check-text` “checked {age} ago” + the fallback warning,
`live` “seen {age} ago in a running task”, `error` “from a failed task {age} ago”; a failed check
with no reading “tried {age} ago”; never checked “Not checked yet”. Stale: badge “Stale” + “— the
numbers may have moved since.” Gap: “· next check allowed at {time}”. Button “Refresh” / pending
“Refreshing…” / background check “Checking…”; accessible name “Refresh limits of {name}, {Agent}”.

**Credits.** Claude Code: “Extra credits: off.” / “on — {used} of {limit} {currency} used this month
({n}%).” / “on, in use now — …”. Codex: “Credits: unlimited.” / “Credits: {balance} available.” /
“Credits: none — balance {balance}.” Member limit: “Member limit: {used} of {limit} used ({n}%) ·
resets {time}.” Spend limit: “Spend limit: reached.” / “{n}% used · resets {time}.”
Limit-reset credits: “Limit-reset credits: {n} available.”

**Warnings.** “Read from the /usage text, because the usage request failed. That text is not a fixed
format.”; “Per-model weekly limits are not shown: they come only from a check, and the last check
failed.”; “The last check did not answer within 20 seconds.” Other `warnings[]` strings from the
server are shown verbatim.

**Not reported** (details): “Not reported by {Agent}: {list}” with field names in words – credit
balance, unlimited credits, whether credits are available, extra credits on or off, monthly credit
limit, credits used, whether extra credits are in use now, whether you can buy credits, member limit,
limit-reset credits, token totals, spend limit, plan. An API-key login: “every plan limit, extra
credits, spend limit and plan — this login uses an API key”.

**Chip and Popover.** Desktop chip text: “{Agent} {canWork}/{total}” per agent; accessible name
“Logins that can work now: Claude Code 3 of 5, Codex 1 of 1. Show details” (“Hide details” while open;
“— stale, every reading is over 15 minutes old” when stale). Phone chip: “{sum}/{total} can work”;
accessible name “4 of 6 logins can work now. Show details”. Checking: “Checking limits…” (desktop),
“Checking…” (phone). Popover title “Logins that can work now”; sub-lines “{name} — out until {time}”,
“{name} — limits unknown”, “{name} — near a limit”; foot “Readings from {youngest} to {oldest} old.
xezar shows these limits and never acts on them.”; stale foot “Stale — the newest reading is {age}
old. New checks started when this tab opened.”; button “Open agent accounts”.

**Toasts.** “Refreshed the limits of {name}” · “Not checked — {name} was checked {age} ago. The next
check is allowed at {time}.” · partial, danger: “Checked {k} of {n} logins — {name}: {reason}” ·
request failure, danger: the server's message verbatim.

## 8. Developer notes

**Data.** One query over `GET /api/v1/workspace/agent-quota` (contract
`agentQuotaResponseSchema`, #867 § 8), read by both the pane and the chip. Render the answer's
fields and values exactly (D1, D37): the cockpit computes no status, no count, no staleness and no
“can work” – `status`, `statusReason`, `summaries[]`, `stale`, `refreshing`, `nextCheckAt`,
`limitedUntil` come from the server. The cockpit only formats: ages via `shortAge`
(`lib/format.ts`), times from the ISO string's own offset with the zone abbreviation of
`serverTimeZone` (D32), token totals via `compactTokens`.

**Live.** Local mode: subscribe once to the `agent-quota` WS topic in `GlobalEventsProvider`, like
`useHealthSubscription`, and return the unsubscribe; readers use a pure cache read. Hosted mode: no
WebSocket; refetch on the SSE `agent-quota` hint, on reconnect, on visibility and every 15 minutes
while visible (FR-11). Ages tick with `useNow(30_000)`.

**Refresh.** `POST /api/v1/workspace/agent-quota/refresh` with `{ provider, accountId }` per row, `{}`
for Refresh all. Disabled (`aria-disabled`, still focusable) while `now < nextCheckAt` or
`refreshing`; the reason text is the `aria-describedby` target. The answer replaces the cache; the
toast reports what came back (a row whose `observedAt` did not move = “Not checked — …”).

**Files.**

| File | Change |
| --- | --- |
| `packages/web/src/routes/settings/accounts-section.tsx` | Plan limits block; limits half per Claude Code / Codex row; details half; hosted branch renders names + limits under the refusal sentence |
| new `packages/web/src/routes/settings/account-limits.tsx` | `AccountLimits`, `LimitWindow`, `LimitsSummary`, the copy maps of § 7 |
| `packages/web/src/components/app-shell.tsx` | `agentQuota` slot: the band above `sidebar-footer`, and the chip in `mobile-status` |
| new `packages/web/src/components/agent-quota-chip.tsx` | chip + Popover |
| `packages/web/src/api/queries.ts`, `api/global-events.tsx` | query, root subscription, hosted refetch |
| `docs/design-system/components.md`, `coverage.md`, `patterns.md` §2/§9, `writing.md` | the two new shared components, the band, the copy (drift test) |

**Components reused, by their design-system names:** `StatusDot` (every status and chip dot),
`Badge variant="outline"` (“Default”, “Stale”), `Button variant="ghost" size="sm"` (Refresh, Check
again, Show details), `Button` outline (Refresh all, Retry, Open agent accounts), `Popover` (the
chip's expanded state), `toast` / `Toaster`, the chip look of `PickerPill` / `.chip`, the patterns.md
§6 inline loading line with its `min-h-*` reserve, the writing.md §7 load-error doctrine, the §8
settings pane spelling. **New:** the usage bar (OD-4) and the limits band (OD-1).

**Tokens used.** `--card`, `--border`, `--muted`, `--foreground`, `--muted-foreground`,
`--soft-foreground` (paths only, as today), `--success`, `--pending`, `--danger` (dots and bar fill
only – never as text), `--ring`, `--radius`, `--radius-lg`, `--radius-sm`, `--spacing` and the rhythm
tokens `--spacing-row`, `--spacing-stack`, `--spacing-list`, `--spacing-inset`,
`--spacing-group`, `--spacing-section`, `--spacing-tap`. No new token.

**Tests to write** (S5): every row state of § 6 from a fixture answer; the “cockpit = MCP answer”
test (AC-37); chip visibility (D38), counts and words; Refresh disabled inside the gap and its
reason; the root subscription subscribes once and unsubscribes; hosted refetch on the hint; the
e2e phone-target and no-sideways-scroll checks at 375 px for the pane and the top bar.

## 9. Accessibility

- Every action is a real `<button>` or link and works from the keyboard: Refresh, Refresh all, Show
  details, the chip (Enter / Space opens the Popover, focus moves into it, Escape closes it and
  returns focus to the chip – walked in the mockup), the jump link to an out login.
- Focus is the existing `:focus-visible` ring (drawn statically on the first Refresh in
  accounts.html).
- Every control is labelled: Refresh carries “Refresh limits of {name}, {Agent}”; the chip carries a
  full sentence with every count; each limits half is a `role="group"` named after its login.
- Meaning never rides on colour: every dot and bar has the sentence or the number beside it; the
  bars are `aria-hidden`.
- Changed counts are announced politely: the Plan limits summary list is `role="status"
  aria-live="polite" aria-atomic="true"`, and the chip's count change is announced through the same
  region when the pane is not open (one polite root announcer, as the nav badges do). First render is
  not announced.
- Refresh inside the 5-minute gap is `aria-disabled` (still focusable) with the reason as
  `aria-describedby` text on screen – no tooltip-only reason.
- Light and dark through theme tokens only; checked in both (captures below). Amber and red appear
  only as dot and bar fills, never as text (G-23, rule 3).
- Reduced motion: the checking spinner turns only under `prefers-reduced-motion: no-preference`;
  the word “Checking…” carries the state without it.

## 10. Responsive rules

- **375 px:** nothing scrolls sideways (measured: `scrollWidth` 375 on all five pages, both
  themes). Each window becomes three lines – label and percent, full-width bar, reset. Refresh and
  Refresh all go full width. The desktop sidebar band is gone with the sidebar; the chip moves to the
  top bar as “4/6 can work”, a 44 px target.
- **What is cut first:** the bar's fixed column (it goes full width), then “Check again” (into Show
  details, as today), then the per-agent names in the chip (the Popover still names them).
- **Never cut:** the status sentence with its reset time, every window's percentage and reset, the
  word “Stale” with the age, the reason Refresh is unavailable, “Not reported”.
- **Wraps, never truncates:** login names, reset strings and model names wrap; only the phone page
  title truncates.
- **Desktop sidebar (264 px):** the band chip is one line at Comfortable, Compact and Compact for
  real (measured 24–25 px tall) and at Roomy (27 px); the stale variant wraps “stale” onto a second
  line (43–46 px). The chevron was dropped so the counts, not the chevron, own the width.

## 11. Worst case, measured

| Case | Number | Source |
| --- | --- | --- |
| Logins per agent | 5 Claude Code logins drawn; assume up to 10 per agent | the routing doc names 4 named Claude logins + the built-in one; a stated assumption beyond |
| Windows per Claude Code login | up to 6 (5-hour, weekly all, Opus, Sonnet, Fable, OAuth apps) | #867 FR-3 mapping |
| Longest reset string | “resets Sep 28, 19:00 CEST (+02:00)”, 34 characters | this mockup |
| Longest status sentence | “Out until Oct 1, 02:00 CEST (+02:00) — the workspace owner’s credits are used up.”, 81 characters | states.html |
| Login name | 40 characters assumed; wraps anywhere | assumption |
| Slowest state | one check up to 20 s; 6 logins at 2 at a time up to about 60 s after start; a leader read waits at most 20 s | #867 FR-7 |
| Oldest number normally shown | 15 min before “Stale”, more while nobody looks | D16, D26 |
| Narrowest | 375 px: no sideways scroll on any page | agent-browser, see § 16 |

## 12. Acceptance criteria

Checkable by a tester against the implementation (S5):

- **AQ-1** Each Claude Code and Codex account row shows the status sentence of § 7 for its
  `status`/`statusReason`, one window line per `windows[]` item with “{n}% used” and its reset, the
  credits line, “Plan: {plan}” and the age with its source words.
- **AQ-2** A row with `stale: true` shows the “Stale” badge and its age; a window whose `observedAt`
  differs from the row's shows “as of {age} ago”.
- **AQ-3** No row shows a percentage, a bar or a reset time that is not in the answer; a login with no
  windows shows none and says why.
- **AQ-4** Refresh is `aria-disabled` and the line says “next check allowed at {time}” while `now <
  nextCheckAt`; it shows “Refreshing…” / “Checking…” while `refreshing`; it is absent for
  `version-too-old`, `not-installed` and API-key logins.
- **AQ-5** Show details lists every `notReported` field as “Not reported by {Agent}: …” in words.
- **AQ-6** The Plan limits block shows one line per applicable agent with `summaries[].text` (product
  name from `runner-label.ts`), Refresh all, and the never-acts sentence.
- **AQ-7** The chip appears only when at least one agent is installed with a subscription login
  (D38); shows `{canWork}/{total}` per agent on a desktop and the combined count on a phone; each
  count has words, not only a dot; it opens the Popover and links to `#limits`.
- **AQ-8** Hosted mode: the pane shows today's refusal sentence plus names and limits, no path, no
  e-mail, no Connected line; Refresh works; no WebSocket is opened.
- **AQ-9** Loading, load error, empty and API-keys-only read exactly as § 7; none shows a chip.
- **AQ-10** At 375 px in both themes nothing scrolls sideways and every target is at least 44 × 44 px
  at all four densities; the band chip keeps the 24 px chip floor on a desktop.
- **AQ-11** All keyboard paths of § 9 work; count changes are announced once, politely.

## 13. Open decisions

Every departure from #867's wording or from the design system, with the recommendation.

- **OD-1 – Chip location on a desktop.** #867 FR-11 says “top-bar chip” (`app-shell.tsx`); the
  cockpit has no desktop top bar. Recommended: its own band above the sidebar footer (this mockup).
  Alternatives: inside the one-row footer (would wrap or starve the version chip, #702), or a new
  desktop top bar (a new shell row on every page, a much larger change). This band is a new pattern
  for patterns.md §2.
- **OD-2 – One dot per agent, not one dot for the chip.** FR-11 says “coloured by the worst status”.
  A single worst dot would paint Codex's fine state red because of Claude Code; one dot per segment
  keeps each agent honest. The phone chip does use the single worst tone, because it shows one
  combined count.
- **OD-3 – The chip opens a Popover rather than navigating.** FR-11 / AC-36 say the chip “opens
  Settings → Agents”. The Popover answers “which one is out and until when” without leaving the page,
  and its button opens the pane. If the owner wants a plain link, drop the Popover and link to
  `#limits`.
- **OD-4 – The usage bar is a new component.** It extends the step rail's `h-0.5 bg-muted` progress
  bar to 6 px, neutral fill, `pending` from 80 % and `danger` at 100 %. The 80 % threshold mirrors
  FR-5's `near-limit`. Needs a components.md entry and a coverage row.
- **OD-5 – Times in the server's zone.** D32 requires server-local times with zone and offset;
  writing.md §12 formats dates in the reader's locale. Kept D32, with the zone name and offset on
  every value so a hosted reader elsewhere is never misled. Repeating “CEST (+02:00)” on every line is
  verbose; an alternative is to state the zone once in the block and keep the offset per value only
  when it differs (a DST change).
- **OD-6 – “Not reported by Claude Code”.** #867 writes “Claude”; rule 8 of the design system makes
  the product name “Claude Code”.
- **OD-7 – Pane name.** #867 says “Settings → Agents”; the rows live in Global settings → Agent
  accounts (`accounts-section.tsx`, the file #867 names). No change to the project “Agents” section.
- **OD-8 – No queued state.** The answer has `refreshing` but no “waiting for a check slot”; a queued
  row therefore reads “Checking…” like a running one, and Refresh all states the pace once. Adding a
  `queued` field would need the frozen fixture (D33) to change.
- **OD-9 – Codex daily token buckets in details.** They are Codex's own numbers (D21 keeps them in the
  answer) but read like history (D4). Shown as plain text in details only; the owner may prefer to
  omit them from the cockpit.
- **OD-10 – The /usage text source.** The S0 proof read Claude Code only through `/usage`. If S3 ships
  `/usage` as the primary path, every Claude Code row would carry the fallback warning; the warning
  should then appear only when the tool's text parser itself fell back, and `source` words become
  “checked {age} ago”.
- **OD-11 – `compactTokens` has no billions unit.** 2 741 187 799 reads “2741.1M”. A `B` unit would
  read better; out of scope for this design.
- **OD-12 – The band's hosted-mode sentence lives in the Popover foot only.** The chip itself looks
  identical in both modes.

## 14. Delivery plan

S5 (PR 4 of #867), after S1 (contract) and this design's approval: pane limits half and block →
chip and band → live wiring (root subscription, hosted refetch) → design-system docs (components,
coverage, patterns, writing) in the same PR → `needs-design` → `design-review` on the running
cockpit → `design-approved`; QA includes “screen = MCP”.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| The row grows tall (up to 6 windows × 10 logins) | windows are one line each on a desktop; details stay collapsed; the summary block and chip answer the first question without scrolling |
| Two “check” buttons on one row (Check again for sign-in, Refresh for limits) are confused | Refresh sits on the limits' own meta line, not among the row actions; labels name what they refresh |
| A reader trusts an old number | age on every row, “as of” per window, “Stale” past 15 minutes, never a fabricated 0 % |
| The chip reads as an alert or an action | neutral chip look, words with every dot, “never acts” in the Popover |
| The tools change their formats | “Limits unknown — … changed how it reports usage” instead of a wrong number |

## 16. References

- Issue #867 (spec, decisions D1–D38, FR-11, AC-34–AC-37) and its S0 proof comment, read 2026-09-22.
- `docs/design-system/` README, usage, recipes §§3–5, patterns §§2, 4–10, components, writing,
  new-designs, verification, lifecycle, storage, known gaps (G-23), read at `main` `6a8ff114`.
- Prior art in this repository: `designs/agent-accounts-onboarding/` (the stacked pane this builds on),
  `components/tools-menu.tsx` (the footer's status dropdown), `routes/settings/skills-section.tsx`
  (“Check is stale” / “Not checked yet” wording).
- Browser evidence (agent-browser 0.36.0, static mockup from disk, source revision of this branch,
  2026-09-22): all five pages at 1440 × 900 and 375 × 900 in dark and light – no sideways scroll
  (`scrollWidth` equals the viewport at 375); the chip's Popover opened with Enter, focus moved into
  it, Escape closed it and returned focus to the chip; band chip heights measured at all four
  densities (§ 10). Captures are private task evidence, not committed. Not run: screen-reader
  announcements, 44 px measurement of every phone target at every density (left to the
  implementation, where `min-h-tap` applies), accent `violet`.

## Design review

Pending.
