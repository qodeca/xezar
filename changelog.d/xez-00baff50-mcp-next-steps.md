## 🐛 Fixes

- 🐛 **An MCP next step now works on the first call.** A refused `apply_skill_updates` or
  `open_in_app` shows the exact arguments of the call to make instead, with a placeholder for the
  fresh operation key, so a leader no longer spends one refused call learning the argument shape.
  `open_in_app` no longer points a hosted xezar at `local_handoff`, which cannot open anything
  there. (#838 items E and F)
- 🐛 **The Providers link opens the Providers card.** The address the MCP tools hand a leader for
  the person now ends in `#providers`, the anchor every cockpit link already uses. (#838 items E
  and F)
- 🐛 **"Not installed" says how to install.** `discover_project`, `xez providers connect` and the
  providers API name the install command (`npm i -g @anthropic-ai/claude-code`,
  `npm i -g @openai/codex`) or page (https://opencode.ai), read from the same table as the health
  checks, and say plainly when none is known (pi). (#838 items E and F)

## 🔧 Changed

- 🔧 **`discover_project`'s description names its `cockpit` field** and says it is absent in hosted
  mode. Every MCP reader of the cockpit address now goes through one accessor that re-checks hosted
  mode, so the four cannot disagree. (#838 items E and F)
