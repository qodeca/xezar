> **Internal engineering and decision record, not current product documentation.** This is a dated requirement, not a description of how xezar behaves today; for current behaviour read the [root README](../../README.md).

# Configuration parity — every configurable value editable through the MCP and the cockpit (2026-09-19)

**Status: requirement, not yet built.** Owner: Marcin. Date: 2026-09-19. Campaign: 0.17.0.

## 1. The requirement

The owner's exact words (2026-09-19 10:0x, campaign chat, quoted from that campaign's `decisions.md`):

> "One thing. Any limits you will add to Xezar tool itself should be editable by MCP and the UI"

and, minutes later, widening it to everything:

> "This rule applies to everything what's configurable in Xezar. Ideally changes in configuration are applied without restarting Xezar where possible"

## 2. What it means

- **Both doors.** Every configurable value in xezar is reachable through the MCP (`project_config`) **and** through Settings in the cockpit. A value that only one door can reach does not satisfy this requirement.
- **No restart, wherever possible.** A change to a value takes effect without restarting xezar wherever that is possible. Where a restart is genuinely required, that fact must be known and stated rather than assumed — the requirement is a per-setting property to be measured, not a blanket promise.
- **Editable never means required.** A derived default always exists for every value, so the new setting is never something a user must author, migrate or repair. This is the zero-config rule of `AGENTS.md` § Zero config: xezar ships no config file the user must create and no setting they must set before it works.

**The leader's reading, marked as such:** "editable" means a stored value that supersedes the derived default — not a required setting — and the restart clause is a target to be inventoried and measured per setting, not a promise that every change is live today. The owner did not say which settings are currently missing a door; that is the inventory below.

## 3. Lineage and where it starts

- The UI ↔ MCP parity rule of 2026-09-16 (issue #439 lineage): an action that exists in the cockpit and is safe for a leader is reachable through the MCP, and vice versa. This requirement extends parity from **actions** to **configuration values**.
- [mcp-settings-classification.md](mcp-server/mcp-settings-classification.md) (D-03, 2026-09-10, status updated 2026-09-11) is the existing field-by-field classification of what the MCP may read, write, or is excluded from, with the enforcement primitives it cites. It is the MCP half of the starting inventory.
- [mcp-ui-action-inventory.md](mcp-server/mcp-ui-action-inventory.md) is the companion cockpit action inventory.
- The owner's first sentence was made about a limit the leader was about to add to the engine — the gate-admission lease of the 0.17.0 speed-and-quality proposal. The second sentence widened it to every configurable value in xezar, which is the requirement recorded here; the lease is one instance of it, not the whole scope.
- `AGENTS.md` § The HTTP API governs how a new setting is added: one zod definition in `packages/contract`, validated as route middleware, chained into a route family so the typed client can see it. A setting that cannot be reached through a route cannot be reached through either door.

## 4. The first deliverable: an inventory

Before anything is built, inventory today's settings **by door and restart-need**: for each configurable value, whether it is reachable through the MCP, through the cockpit, through both, or through neither, and whether a change takes effect live or only after a restart. The inventory is in progress; this record makes no claim that any specific setting is currently missing a door.

Inputs already available to that inventory:

- `mcp-settings-classification.md` — the MCP side, field by field, with the product decisions D-03-1 to D-03-5 and the enforcement primitives E-BIND, E-409-LOCAL, E-409-PROFILE, E-SCOPE-USER, E-SINGLE, E-CONTRACT and E-NARROW.
- `mcp-ui-action-inventory.md` — the cockpit action inventory the classification cites.
- The config write surfaces: `GET`/`PUT /api/v1/p/:projectId/config` and the `setConfigInputSchema` / `setWorkspaceConfigInputSchema` shapes in `packages/contract`, plus the agent-config and workspace routes the classification lists.
- `.xezar/docs/model-routing.md` § 5 already records one restart-shaped constraint in the opposite direction: changing a runner's default model from the cockpit writes the primary checkout's `.xezar/config.json` and breaks the kit snapshot, so the model is set per task or through a committed pin. It is an example of the kind of live-versus-restart fact the inventory must state.

## 5. What the inventory must answer

- Which values have no MCP path, which have no cockpit path, and which have neither.
- Which values are workspace-wide and therefore deliberately not writable from a project-bound leader (the classification's `safe-effective-read` and `excluded` rows) — parity is required for values, not a widening of the project-scope boundary that the classification settled. **Superseded in part, 2026-09-20 (#677 B1):** the owner's "every key" rule made the workspace SETTINGS writable from a project-bound leader, so this bullet now reads as "which values stay workspace-read-only". **Narrowed again, 2026-09-20 (#677 B2):** the two workspace folder paths followed under the same rule, so today that is the accounts and the provider switches. The sentence above is kept as the record of what this document asked for on 2026-09-19.
- Which changes are live and which need a restart, with the reason for each restart.
- Which values already have a derived default and which would need one before they could be made editable.

## 6. Sources and evidence

- Owner's exact words: `.local/xezar/campaigns/release-0.17.0/decisions.md`, entries of 2026-09-19 10:0x (both sentences, chat).
- The record is written from the committed kit and the campaign log only; nothing here is a claim about current runtime behaviour. **Unknown** until the inventory runs: the per-setting door and restart answers.
