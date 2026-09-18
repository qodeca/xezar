# Documentation map

The [root README](../README.md) introduces xezar. This directory holds the user guide and
project documentation. Use the table to find the part you need.

| Path | What it holds | For |
| --- | --- | --- |
| [guide/](guide/README.md) | The 17-part user guide: getting started, tasks, settings and references. | Users |
| [server-install/](server-install/README.md) | Host xezar on a server and reach it from another machine. | Users |
| [project-layout.md](project-layout.md) | The `.xezar/` directory, discovery precedence and the legacy migration command. | Users and contributors |
| [publishing.md](publishing.md) | How a release reaches npm through the manual Release workflow. | Maintainers |
| [releases/](releases/0.14.0-definition-of-done.md) | What "done" means for a release beyond its features, and how it was assessed for 0.14.0 — the only release with a recorded definition-of-done so far. | Maintainers and reviewers |
| [design-system/](design-system/README.md) | The cockpit's UX/UI design system: tokens, components, patterns, writing, HTML specimens and the shared mockup stylesheet. Every new design and UI change follows it. | Designers, contributors and coding agents |
| [testing/](testing/) | The browser suite ([agent-browser.md](testing/agent-browser.md)), where local data lives ([local-data.md](testing/local-data.md)), which suite covers which behaviour ([coverage-gaps.md](testing/coverage-gaps.md)), and the two-project registry/composition harness ([multi-project-harness.md](testing/multi-project-harness.md)). | Contributors |
| [lessons/](lessons/changing-working-mechanisms.md) | Worked examples behind the rules in [AGENTS.md](../AGENTS.md). | Contributors and coding agents |
| [screenshots/](screenshots/) | Images the root README shows. | — |
| [features/](features/README.md) | The internal engineering and decision record, one directory per feature. | Engineers and reviewers |

## `features/` is a record, not a manual

`docs/features/**` is **not current product documentation**. It holds requirements drafts, decision
spikes, evidence reports and audits, each dated and written for the engineers who built the feature.
A decision record says what was decided and when; the behaviour it describes may have changed since.
Read each file's status line before you rely on it. For how xezar behaves today, read the root README.

One exception: [features/mcp-server/mcp-api.md](features/mcp-server/mcp-api.md) is the reference for
the shipped MCP tools. Its tables are generated from the code and `npm test` checks them.

## Elsewhere

- Repository contracts at the root: [AGENTS.md](../AGENTS.md), [AGENT_PROTOCOL.md](../AGENT_PROTOCOL.md),
  [SDLC.md](../SDLC.md), [CODE_REVIEW.md](../CODE_REVIEW.md),
  [BACKWARD_COMPATIBILITY.md](../BACKWARD_COMPATIBILITY.md) and [CHANGELOG.md](../CHANGELOG.md).
- [.xezar/docs/](../.xezar/docs/README.md): the operating guides for developing xezar with xezar.
- [designs/](../designs/README.md): UI designs, one folder per feature – static mockups on the shared
  design-system stylesheet plus a handoff README. Its § Lifecycle carries the status of every design.
