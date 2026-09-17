import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditTrail } from './audit-trail.ts';

/**
 * One CROSS-PROCESS writer of a project's audit trail, for `audit-rotation.test.ts` (#306 part 3,
 * spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 7 and § 11).
 *
 * It is a real child process because the thing under test is a real cross-process lock: two
 * writers inside one vitest worker are serialized by the in-process queue and prove nothing about
 * two xezar processes appending at the same moment.
 *
 * Usage: `tsx audit-rotation.worker.testkit.ts '<json>'` with
 *   `{ dataDir, projectId, resourceId, barrier?, crashAfterRename? }`.
 *
 * `barrier` makes the race deterministic instead of lucky: the writer announces itself with
 * `<barrier>/ready-<resourceId>` at the `beforeLock` point and waits there for `<barrier>/go`, so
 * the parent releases both writers only once both have arrived. `crashAfterRename` kills the process
 * under the lock right after live→`.1`, before the marker exists — a real crash, not a simulated file
 * layout. The result is printed as one JSON line: the persisted record (or `null`) and the warnings.
 */
interface WorkerSpec {
  dataDir: string;
  projectId: string;
  resourceId: string;
  barrier?: string;
  crashAfterRename?: boolean;
}

const spec = JSON.parse(process.argv[2] ?? '{}') as WorkerSpec;
const warnings: string[] = [];

async function waitFor(path: string): Promise<void> {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 5));
}

const trail = new AuditTrail(
  { projectId: spec.projectId, dataDir: spec.dataDir },
  {
    warn: (message) => warnings.push(message),
    hooks: {
      ...(spec.barrier
        ? {
            beforeLock: async () => {
              writeFileSync(join(spec.barrier!, `ready-${spec.resourceId}`), '');
              await waitFor(join(spec.barrier!, 'go'));
            },
          }
        : {}),
      ...(spec.crashAfterRename ? { afterRotateRename: () => process.exit(86) } : {}),
    },
  },
);

const record = await trail
  .channel('cli')
  .record({ action: 'cli.run', actor: { command: 'run' } }, { outcome: 'applied', resource: { kind: 'run', id: spec.resourceId } });
process.stdout.write(`${JSON.stringify({ record, warnings })}\n`);
