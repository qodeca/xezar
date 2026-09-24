# Guidance for `packages/xezar/src/agent-config/`

These rules are the full task-routing guidance moved from the repository root. Root `AGENTS.md` retains the routing index and canonical cross-repository rules.

## Agent config files (Settings → Agent config; grouped by agent, MCP as a per-agent subsection — spec 2026-07-17-agent-config-by-agent, descriptor table in `packages/web/src/routes/settings/agent-descriptors.ts`)

Read and edit the coding agents' OWN config files (Claude/Codex/OpenCode settings, MCP, memory), raw and per-scope (spec pre-rename issue 404). `catalog.ts` is the ONLY place vendor knowledge about config FILES lives — paths + verbatim precedence strings; keep it accurate and dated. Its sibling `src/core/agent-profiles.ts` owns the other half: the env var that relocates each agent's whole home (spec `2026-07-29-agent-profiles`). Never re-serialize a file xezar opened (byte-exact round-trip). Files are addressed by catalog id, never a path. **Writing is a local-machine capability: every `PUT /api/v1/agent-config/:id` 409s when `capabilities().localHandoff` is false — this closes a hooks-based RCE path, do not weaken it.** The gitignored personal layer is seeded into run worktrees (`seed.ts`, guarded by `git check-ignore`).
