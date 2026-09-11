# Documentation map

The user guide is the [root README](../README.md): install, run, configure. This directory holds
everything else. Use the table to find the part you need.

| Path | What it holds | For |
| --- | --- | --- |
| [server-install/](server-install/README.md) | Host xezar on a server and reach it from another machine. | Users |
| [project-layout.md](project-layout.md) | The `.xezar/` directory, discovery precedence and the legacy migration command. | Users and contributors |
| [publishing.md](publishing.md) | How a release reaches npm through the manual Release workflow. | Maintainers |
| [testing/](testing/) | The browser suite ([agent-browser.md](testing/agent-browser.md)), where local data lives ([local-data.md](testing/local-data.md)) and which suite covers which behaviour ([coverage-gaps.md](testing/coverage-gaps.md)). | Contributors |
| [lessons/](lessons/changing-working-mechanisms.md) | Worked examples behind the rules in [AGENTS.md](../AGENTS.md). | Contributors and coding agents |
| [prompts/](prompts/xezar-ui-leader-prompt.md) | The role prompt for the UI project-leader pilot. | Maintainers running that pilot |
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
