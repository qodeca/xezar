> **Internal engineering and decision record, not current product documentation.** Files here are dated requirements, decision spikes, evidence and audits; for how xezar behaves today, read the [root README](../../README.md).

# Feature records

| Record | What it records |
| --- | --- |
| [2026-09-19-configuration-parity.md](2026-09-19-configuration-parity.md) | Dated requirement: every configurable value in xezar editable through both the MCP (`project_config`) and the cockpit's Settings, taking effect without a restart wherever possible, with a derived default always present. Status: requirement, not yet built; the settings inventory is the first deliverable. |
| [mcp-server/](mcp-server/mcp-project-leader-requirements.md) | The MCP server for a project leader: requirements (D-01 to D-09 in § 10: D-01, D-02, D-04, D-05, D-06 and D-09 have records; D-03 is detailed in the [settings classification](mcp-server/mcp-settings-classification.md); D-07/D-08 are settled in § 10), the [2026-09-17 four-origin audit-trail specification](mcp-server/audit-trail-origins-2026-09-17.md), client evidence, the [whole-feature DoD](mcp-server/mcp-definition-of-done-record.md), [leader dogfooding findings](mcp-server/leader-dogfooding-2026-09-13.md), [pi extension](mcp-server/pi-leader-extension.md), wake decisions, [reviewer verdicts on the task record](mcp-server/mcp-reviewer-verdicts.md), [advisory stall and resume events](mcp-server/mcp-stall-events.md), and the generated [API reference](mcp-server/mcp-api.md). |
| [mcp-api-reference/](mcp-api-reference/mcp-api-reference-spec.md) | The specification for that API reference. |
| [builtin-project-leader/](builtin-project-leader/builtin-project-leader-requirements.md) | The built-in project leader: requirements and the process source audit. The superseded UI leader pilot was retired; Git history retains it. |
| [inbox-default-enabled/](inbox-default-enabled/inbox-default-enabled-requirements.md) | Business requirements for turning the follow-up Inbox on by default. |
| [tasks-view/](tasks-view/tasks-view-requirements.md) | Requirements for the Tasks view. |
| [decisions/](decisions/decisions-requirements.md) | The owner-only decision gate ("Decisions"): requirements F-1 to F-31, the grill-me interview record with decisions D-1 to D-20, and the five-reviewer verdict on the first design draft. |

The map of all of `docs/` is [docs/README.md](../README.md).
