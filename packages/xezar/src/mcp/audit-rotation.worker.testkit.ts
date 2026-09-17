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
 *   `{ dataDir, projectId, resourceId, barrier?, holdForPeer?, crashAfterRename? }`.
 *
 * `barrier` makes the race deterministic instead of lucky, in TWO steps. The writer announces itself
 * with `<barrier>/ready-<resourceId>` at the `beforeLock` point and waits there for `<barrier>/go`,
 * so the parent releases both writers only once both have arrived. That alone is not enough: a whole
 * write takes about a millisecond, so the second writer usually arrives to find the first one's
 * rotation already finished, and a rotation moved OUTSIDE the lock still looked correct in five runs
 * out of seven (#306 part 3 review, m1).
 *
 * So the writer also reports `<barrier>/decided-<resourceId>` the moment its size check decides to
 * rotate and BEFORE its first rename, and `holdForPeer` makes it wait there for its peer's report,
 * bounded by `HOLD_FOR_PEER_MS`. With the rotation under the lock, the peer is blocked before its own
 * decision, the report never comes, and this writer continues after the bound — correct, just slower.
 * With the decision or the renames moved outside the lock, the peer decides while this one is paused,
 * so two rotations always happen and the case is red wherever the break is placed. Both of the pair
 * hold, because whichever decides first must be the one that waits: pausing only one of them, or
 * pausing AFTER the renames, let the other decide on a live file that had already been moved.
 *
 * `crashAfterRename` kills the process under the lock right after live→`.1`, before the marker exists
 * — a real crash, not a simulated file layout; it takes precedence over the hold. The result is
 * printed as one JSON line: the persisted record (or `null`) and the warnings.
 */
interface WorkerSpec {
  dataDir: string;
  projectId: string;
  resourceId: string;
  barrier?: string;
  /** Hold at this writer's own rotate decision until this peer reports the same one, bounded. */
  holdForPeer?: string;
  crashAfterRename?: boolean;
}

/** Long enough that a peer running unlocked always finishes its own rotation inside it (~1 ms). */
const HOLD_FOR_PEER_MS = 500;

const spec = JSON.parse(process.argv[2] ?? '{}') as WorkerSpec;
const warnings: string[] = [];

async function waitFor(path: string): Promise<void> {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * The same wait, BLOCKING, because the rotate hooks fire inside a synchronous append. Blocking is
 * also the stronger proof: this writer's whole process is stopped inside the critical window, so
 * nothing of its own can make progress while the peer runs.
 */
function blockUntil(path: string, boundMs: number): void {
  const deadline = Date.now() + boundMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path) && Date.now() < deadline) Atomics.wait(idle, 0, 0, 5);
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
      ...(spec.barrier && !spec.crashAfterRename
        ? {
            beforeRotateRename: () => {
              writeFileSync(join(spec.barrier!, `decided-${spec.resourceId}`), '');
              if (spec.holdForPeer) blockUntil(join(spec.barrier!, `decided-${spec.holdForPeer}`), HOLD_FOR_PEER_MS);
            },
          }
        : {}),
    },
  },
);

const record = await trail
  .channel('cli')
  .record({ action: 'cli.run', actor: { command: 'run' } }, { outcome: 'applied', resource: { kind: 'run', id: spec.resourceId } });
process.stdout.write(`${JSON.stringify({ record, warnings })}\n`);
