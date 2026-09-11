import type { EventCatalog } from './event-catalog.ts';

/**
 * The per-project lookup the cockpit's write routes use to report an E-05 change (#252). A
 * configuration, workflow or agent-config write has no in-process signal the catalog could listen
 * to, so its route reports it — and a route knows only its project, while a catalog lives inside
 * the MCP composition (`startMcpService`). This map joins the two, keyed by registry project id.
 *
 * Degrades silently by construction: a project with no catalog (its MCP composition never started,
 * or could not open a journal) reports nothing, and a report that throws is swallowed. A write
 * route never fails, never slows and never changes its answer because of the leader's feed.
 *
 * Type-only import on purpose: `server.ts` imports this module statically, and the MCP module
 * otherwise stays a lazy import so a broken MCP part can never stop the cockpit booting (N-07).
 */

/** The writer-reported half of the catalog — exactly the three E-05 hooks. */
export type ProjectChangeReporter = Pick<EventCatalog, 'configChanged' | 'workflowChanged' | 'agentConfigChanged'>;

const reporters = new Map<string, ProjectChangeReporter>();

/**
 * Make `reporter` the project's catalog until the returned release runs. The release removes only
 * this registration, so a late release from an older composition never evicts a newer one.
 */
export function registerProjectCatalog(projectId: string, reporter: ProjectChangeReporter): () => void {
  reporters.set(projectId, reporter);
  return () => {
    if (reporters.get(projectId) === reporter) reporters.delete(projectId);
  };
}

/** Report one change to the project's catalog, if it has one. Never throws. */
export function reportProjectChange(projectId: string, report: (reporter: ProjectChangeReporter) => unknown): void {
  const reporter = reporters.get(projectId);
  if (!reporter) return;
  try {
    report(reporter);
  } catch {
    // The catalog guards its own writes; this only keeps a future reporter bug off the route.
  }
}
