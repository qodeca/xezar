import { runIdParamSchema } from '@qodeca/xezar-contract';
import type { ServiceDispatch } from '../service-adapter.ts';

/** A well-formed version no task has (#250): what a test sends when its case is not about versions. */
export const NO_VERSION = 'rev1:run:none:0:000000000000';

/**
 * The version a leader reads right before it changes a task (#250) — that task's own
 * `GET /runs/:id/version`, through the real app, exactly as `task_read` reads it.
 *
 * An id the route cannot name — a dot segment, another project's task, one that does not exist —
 * gets `NO_VERSION` without a lookup, and the tool's own refusal for that id is what the test then
 * sees. Pass the REAL app, never a spy: this is the test's read, not the tool's dispatch.
 */
export async function versionForTest(app: ServiceDispatch | undefined, projectId: string, runId: unknown): Promise<string> {
  if (!app || typeof runId !== 'string' || runId === '.' || runId === '..' || !runIdParamSchema.safeParse({ id: runId }).success) {
    return NO_VERSION;
  }
  const res = await app.request(`http://127.0.0.1/api/v1/p/${projectId}/runs/${runId}/version`, { headers: { host: '127.0.0.1' } });
  if (res.status !== 200) return NO_VERSION;
  return ((await res.json()) as { version: string }).version;
}
