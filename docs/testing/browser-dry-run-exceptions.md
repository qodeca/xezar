# Browser dry-run exceptions

This register records the guide flows that a browser fixture running with `XEZ_DRY_RUN=1` cannot honestly cross. Each guide part has one row; cited tests were resolved on this tree on 2026-09-20.

| Guide part | Flow outside the dry-run browser boundary | Classification | Evidence |
| --- | --- | --- | --- |
| 01 | Install, upgrade, reset, and launch the packaged CLI | covered by a named lower-level test | `packages/xezar/test/e2e/package-cli.test.ts`; `packages/xezar/src/pack-check.test.ts` |
| 02 | Agent execution and review transitions; opening a draft pull request on a remote forge | stubbed at the app's seam; covered by a named lower-level test | Dry-run agent and forge seams; `packages/xezar/src/server/forge/draft-pr-autosave.test.ts`; `packages/xezar/src/server/cockpit-ownership.test.ts` |
| 03 | Worktree creation/failure, repository-root lease, and non-Git in-place execution | covered by a named lower-level test | `packages/xezar/src/workflows/run-isolation.test.ts` |
| 04 | Real provider execution and account login | stubbed at the app's seam; covered by a named lower-level test; manual with a dated record | Agent seam; `packages/xezar/src/core/backend-detect.test.ts`; `packages/xezar/src/core/usage-limit.test.ts`; `docs/testing/browser-manual-checks.md` |
| 05 | Agent and check-step execution in a workflow | stubbed at the app's seam | Dry-run agent seam |
| 06 | Skills-catalog and update network calls | stubbed at the app's seam | Skills-catalog seam |
| 07 | Real GitHub authorisation, remote issue/PR mutation, and bookmarklet execution on github.com | stubbed at the app's seam; manual with a dated record | Forge seam; `docs/testing/browser-manual-checks.md` |
| 08 | Browser/OS notification permission and delivery | manual with a dated record | `docs/testing/browser-manual-checks.md` |
| 09 | Clone checkout while adding a project | stubbed at the app's seam | Git/clone seam |
| 10 | No dry-run boundary: settings navigation and command-palette interaction remain browser-testable | covered by a named lower-level test | `packages/web/e2e/command-palette.e2e.ts` |
| 11 | Corrupt/read-only/concurrent configuration and stored/environment precedence | covered by a named lower-level test | `packages/xezar/src/workspace/config.test.ts`; `packages/xezar/src/workspace/config-lock.test.ts`; `packages/xezar/src/workspace/migrations.test.ts` |
| 12 | CLI commands and terminal contracts | covered by a named lower-level test | `packages/xezar/test/e2e/package-cli.test.ts`; `packages/xezar/src/mcp/cli.test.ts`; `packages/xezar/src/init-kit.test.ts` |
| 13 | Actual client connection, push delivery, and acknowledgement | stubbed at the app's seam; manual with a dated record | MCP-client seam; `docs/testing/browser-manual-checks.md` |
| 14 | Host/origin guards and a hosted-installation lifecycle | covered by a named lower-level test; manual with a dated record | `packages/xezar/src/server/host-guard.test.ts`; `packages/xezar/src/server/origin-guard.test.ts`; `docs/testing/browser-manual-checks.md` |
| 15 | Kit initialisation and an `xez-onboard` run using a real team-skills fetch | covered by a named lower-level test; manual with a dated record | `packages/xezar/src/init-kit.test.ts`; `packages/xezar/src/project-kit-cli.test.ts`; `docs/testing/browser-manual-checks.md` |
| 16 | Deterministic process-level error responses: worktree failures, port fallback, missing `gh`, and usage-limit resume | stubbed at the app's seam; covered by a named lower-level test | Error seams; `packages/xezar/src/workflows/run-isolation.test.ts`; `packages/xezar/test/e2e/package-cli.test.ts`; `packages/xezar/src/onboarding/issue-filing.test.ts`; `packages/xezar/src/core/usage-limit.test.ts` |
| 17 | Audit trail NDJSON and audit UI; there is no cockpit page | covered by a named lower-level test | `packages/xezar/src/mcp/audit-answer-refusals.test.ts`; `packages/xezar/src/mcp/audit-four-doors.test.ts`; `packages/xezar/src/mcp/audit-inventory.test.ts`; `packages/xezar/src/mcp/audit-not-found.test.ts`; `packages/xezar/src/mcp/audit-origin-wiring.test.ts`; `packages/xezar/src/mcp/audit-redaction-seam.test.ts`; `packages/xezar/src/mcp/audit-redaction.test.ts`; `packages/xezar/src/mcp/audit-rotation.failures.test.ts`; `packages/xezar/src/mcp/audit-rotation.test.ts`; `packages/xezar/src/mcp/audit-trail.legacy.test.ts`; `packages/xezar/src/mcp/audit-trail.test.ts`; `packages/xezar/src/mcp/audit-upgrade.test.ts`; `packages/xezar/src/audit-warnings.test.ts`; `packages/xezar/src/server/audit-ui.test.ts` |

The audit-trail row names the 13 current audit lower-level tests (12 under `mcp/` plus `audit-warnings.test.ts`) and the audit UI test. No browser test is possible because guide 17 has no cockpit page.
