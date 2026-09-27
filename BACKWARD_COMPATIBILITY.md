# Backward compatibility

The surfaces people and programs outside this repository already depend on. A change that
breaks one of them is a breaking change, whatever the tests say, and it needs either a
compatible path or a deprecation (§8). Where this page is silent about a surface, treat it as
protected and ask the owner; do not decide it in a review.

## 1. The CLI

The `xezar` and `xez` commands: their subcommands (`serve`, `run`, `init`, `mcp` and the rest),
flags, help text, output shapes and exit codes. A script that calls the CLI today keeps working.

## 2. The HTTP API

Everything under `/api/v1` (project-scoped under `/api/v1/p/:projectId/`), as the zod schemas in
`packages/contract` describe it. A route, a field or a status code clients read is not removed or
retyped; a new field is additive.

## 3. The MCP tool surface

The tools `xezar mcp` serves to a project leader, their names, arguments and result shapes, as
`docs/features/mcp-server/mcp-api.md` documents them. A leader built against today's tools keeps
working against the next release, and the bridge refuses a mismatched protocol version rather than
guessing.

## 4. Workflow and skill files

The YAML workflow format under `.xezar/workflows/` and the Markdown skill format under
`.xezar/skills/`. A file that loads today loads tomorrow with the same meaning. An absent `timeout`
keeps its old meaning: an earlier agent step falls through to the runner's default wall clock and
the last interactive step is uncapped.

## 5. Configuration and state files

`.xezar/config.json`, the per-user `~/.xezar/` files, and the runtime state under
`.local/xezar/` (plain JSON, NDJSON and Markdown). The old shape keeps being read for as long as
anyone can still have it on disk; a migration is tolerant and never requires the user to repair a
file by hand.

## 6. Environment variables

The `XEZ_*` variables and their defaults, as `.env.example` documents them. Renaming one, removing
one, or changing what its default does is a breaking change and updates `.env.example` in the same
change.

## 7. The npm package

`@qodeca/xezar`: its name, its `xezar` and `xez` bins, the supported Node range (20 and later), and
that the built cockpit ships inside it. Nothing publishes automatically (`docs/publishing.md`).

## 8. Deprecation

A surface above is removed only after a deprecation that names the replacement and the release it
goes in, recorded under `docs/deprecations/` with an upgrade note keyed by the symptom a user will
see. How long the notice runs is the owner's decision for each case.
