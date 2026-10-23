> **Internal engineering and decision record, not current product documentation.** Files here are dated requirements, decision spikes, evidence and audits; for how xezar behaves today, read the [root README](../../README.md).

# Feature records

> **History – removed in 0.30.0.** The pi and OpenCode backends named on this page were removed in 0.30.0 ([#1041](https://github.com/qodeca/xezar/issues/1041)). Those mentions record the product as it was, not current behaviour.

| Record | Status | What it records |
| --- | --- | --- |
| [2026-09-19-configuration-parity.md](2026-09-19-configuration-parity.md) | Shipped, with deferrals | Dated requirement: every configurable value in xezar editable through both the MCP (`project_config`) and the cockpit's Settings, taking effect without a restart wherever possible, with a derived default always present. Status: built by the #677 programme (closed 2026-09-21); the record keeps the original requirement and lists what was deferred. |
| [mcp-server/](mcp-server/mcp-project-leader-requirements.md) | Shipped | The MCP server for a project leader: requirements (D-01 to D-09 in § 10: D-01, D-02, D-04, D-05, D-06 and D-09 have records; D-03 is detailed in the [settings classification](mcp-server/mcp-settings-classification.md); D-07/D-08 are settled in § 10), the [2026-09-17 four-origin audit-trail specification](mcp-server/audit-trail-origins-2026-09-17.md), client evidence, the [whole-feature DoD](mcp-server/mcp-definition-of-done-record.md), leader dogfooding findings (`leader-dogfooding-2026-09-13.md`, removed), the records of the removed pi and OpenCode backends – the [pi extension](https://github.com/qodeca/xezar/blob/v0.30.0/docs/features/mcp-server/pi-leader-extension.md) and their adapter evidence and wake records, deleted after 0.30.0 removed those backends and readable at the `v0.30.0` tag (Qwen Code is the third supported client now), wake decisions, [reviewer verdicts on the task record](mcp-server/mcp-reviewer-verdicts.md), [advisory stall and resume events](mcp-server/mcp-stall-events.md), and the generated [API reference](mcp-server/mcp-api.md). Some records inside are superseded spikes; each says so in its own banner. |
| [mcp-api-reference/](mcp-api-reference/mcp-api-reference-spec.md) | Partly | The specification for that API reference. |
| [builtin-project-leader/](builtin-project-leader/builtin-project-leader-requirements.md) | Not implemented | The built-in project leader: requirements and the process source audit. The superseded UI leader pilot was retired; Git history retains it. |
| [inbox-default-enabled/](inbox-default-enabled/inbox-default-enabled-requirements.md) | Not implemented | Business requirements for turning the follow-up Inbox on by default. |
| [tasks-view/](tasks-view/tasks-view-requirements.md) | Not implemented | Requirements for the Tasks view. |
| [issue-filing/](issue-filing/xez-issue-create-contract.md) | Shipped | The consumer-boundary contract for the `xez-issue-create` skill (#468, #473). |
| [onboarding/](onboarding/xez-onboard-contract.md) | Shipped (inferred) | The `xez-onboard` skill contract for the first-setup entry and post-update re-check (#464, P2 and P3). |
| [decisions/](decisions/decisions-requirements.md) | Not implemented | The owner-only decision gate ("Decisions"): requirements F-1 to F-31, the grill-me interview record with decisions D-1 to D-20, and the five-reviewer verdict on the first design draft. |

The Status column is copied from each record's own status line as of 2026-10-23: **Shipped**, **Partly** (some of it shipped), **Not implemented**, or **Superseded** (replaced by a later record). The onboarding contract has no status line of its own, so its status is inferred from the shipped code in `packages/xezar/src/onboarding/`. Read the record itself before relying on the column.

Research notes that fed these records live in [docs/research/](../research/README.md).

The map of all of `docs/` is [docs/README.md](../README.md).
