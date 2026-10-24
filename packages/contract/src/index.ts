/**
 * The xezar API contract. See `../README.md` — one zod definition per shape, its TypeScript type
 * inferred from it, shared by the server, the api-client and the cockpit.
 *
 * One owner-approved exception to "zod only": the v2 agent-event protocol (`ui-events.ts`) and its
 * pure display model (`tool-display.ts`). They are SSE frame payloads that no route validates, so
 * they stay plain TypeScript, but they live here once instead of as a hand-kept api-client mirror.
 */
export * from './events.ts';
export * from './api-errors.ts';
export * from './health.ts';
export * from './resume-command.ts';
export * from './mcp-ownership.ts';
export * from './task-verdict.ts';
export * from './run-progress.ts';
export * from './runs.ts';
export * from './repo.ts';
export * from './github.ts';
export * from './projects.ts';
export * from './workspace.ts';
export * from './workflows.ts';
export * from './skills.ts';
export * from './agent-config.ts';
export * from './agent-profiles.ts';
export * from './agent-quota.ts';
export * from './automations.ts';
export * from './onboarding.ts';
export * from './mcp-idempotency.ts';
export * from './mcp-versioning.ts';
export * from './mcp-journal.ts';
export * from './mcp-event-catalog.ts';
export * from './audit.ts';
export * from './mcp-audit.ts';
export * from './mcp-discovery.ts';
export * from './mcp-api-reference.ts';
export * from './mcp-leader.ts';
export * from './ui-events.ts';
export * from './tool-display.ts';
