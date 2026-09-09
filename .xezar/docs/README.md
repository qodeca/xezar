# Xezar project dogfooding kit

This local installation is for developing Xezar with Xezar. It is not the proposed distributed kit, MCP server or built-in leader. Derived from the current reference .xezar source, adapted to this repository; no runtime/private API content is imported.

13 workflows and 14 skills cover triage, analysis, planning, implementation, bugfix, review, review response, testing, docs, dependencies, release preparation, integration and root synchronization. Use the matching workflow in the existing composer; choose an available backend/model. No foreign model pins. The first `kit` command snapshots this local installation into a new task worktree even before these assets are committed. Source code, unrelated edits, runtime and secrets are not copied. Existing conflicting task assets are refused, never overwritten. Resumed tasks keep their snapshot; changing the project kit affects subsequent tasks. A tracked future kit uses its existing content; see worktrees.md.

Canonical gates: npm ci (or verified-current dependency reuse), then the five commands in AGENTS/SDLC/.xezar/agentic.config.json, then isolated kit fixtures. UI/browser QA is separate; this installation does not execute it. A missing required prerequisite is not a pass. Release is manual dispatch only under existing authority.

Start with ui-operations.md, worktrees.md, recovery.md and dogfooding.md. Files under docs are operational guidance; primary .local/xezar-tasks holds private runtime evidence. Never commit runtime. Root AGENTS/SDLC/review/backward compatibility rules continue to govern. Start with `.xezar/CLAUDE.md` for the complete directory guide. Maintained files here are versionable directly; only the paths in `.gitignore` are local runtime.
