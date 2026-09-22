## ✨ Features

- ✨ **Global settings → Agent accounts shows each Claude Code and Codex login's plan limits.** Every
  account row gains a limits half: whether the login can work now (and until when it cannot), one
  line per short, weekly and per-model window with a bar, the percentage and the reset time with its
  zone and offset, Codex credits, the plan, where the reading came from and how old it is, "Stale"
  past 15 minutes, and — under Show details — every fact the tool does not report, in words. A Plan
  limits block at the top of the pane says, per agent, how many logins can work, with Refresh all;
  each row has its own Refresh, unavailable during the 5-minute gap between checks with the next
  allowed time beside it. The cockpit shows exactly the answer the leader reads through the MCP and
  never acts on it: no login is switched and no task is held back. A hosted cockpit shows the
  limits too, with the names only. (#867)
- ✨ **A plan-limits chip on every page.** Above the sidebar footer on a desktop (`Claude Code 1/3 ·
  Codex 1/2`) and in the top bar on a phone (`2/5 can work`), one dot and count per agent that is
  installed and reports a plan; it opens a short list of the logins that are out or unknown and a
  link to the Plan limits block. With no such agent, no answer yet or a failed load there is no
  chip, and the sidebar is exactly as before. A local cockpit is kept current by one live
  subscription for the whole tab; a hosted one re-reads on the server's change hint, on reconnect,
  when the tab comes back and every 15 minutes while it is visible. (#867)
