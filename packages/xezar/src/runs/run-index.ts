import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { reconcileLoadedRun, runRecordSchema, type RunRecord } from './store.ts';

/**
 * The READ-ONLY half of `runs.json`, for the workspace-level run index (`GET
 * /workspace/runs-index`) — the one place that must read a project's runs WITHOUT owning it.
 *
 * `RunStore.open` cannot be used here and the reason is the whole point of this module. Opening a
 * store `mkdir`s `<dataDir>/runs/`, and the caller that opens one goes on to build a
 * `ProjectContext` — which prunes orphan worktrees and calls `manager.recover()`, resuming
 * interrupted runs. Building the workspace index must never do any of that: answering "which
 * tasks exist" would restart agents across every registered project, and typing into a search box
 * would spend tokens. Cold projects are precisely the ones the index exists to reach, so
 * `contexts.peek()` (which returns nothing for them) is not an answer either.
 *
 * What this does share with the store is the schema and `reconcileLoadedRun`, so a `running` row
 * left behind by a crashed process reads as interrupted here exactly as it would once the project
 * were opened for real. A second, subtly different parse of that field would show a task as
 * running in the palette and failed the moment you clicked it.
 */
export function readRunIndexFromDisk(dataDir: string): RunRecord[] {
  return readRunIndexReport(dataDir).runs;
}

/** What one read-only pass over `runs.json` found: every record that parsed, and how many did not. */
export interface RunIndexRead {
  runs: RunRecord[];
  /** Records present in the file that failed the schema. A file that is not a JSON array at all
   *  counts as zero dropped records and contributes nothing. */
  dropped: number;
}

/**
 * The same read as `readRunIndexFromDisk`, with the count of records it had to leave out. Per
 * record, like `RunStore.open`: one unreadable row (damaged, or written by a newer xezar) drops
 * that row alone, never the project's whole history from the index. Read-only: nothing is written,
 * not even the backup the store keeps.
 */
export function readRunIndexReport(dataDir: string): RunIndexRead {
  const indexPath = join(dataDir, 'runs.json');
  if (!existsSync(indexPath)) return { runs: [], dropped: 0 };
  try {
    const raw: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(raw)) return { runs: [], dropped: 0 };
    const runs: RunRecord[] = [];
    let dropped = 0;
    for (const row of raw) {
      const parsed = runRecordSchema.safeParse(row);
      if (!parsed.success) {
        dropped++;
        continue;
      }
      // `reconcileLoadedRun` mutates, which is safe here in a way it is not in the store: this
      // record was just parsed into a fresh object that nothing else holds a reference to.
      // Never `keepLive` — this reader has no RunManager, so there is nothing to recover into.
      runs.push(reconcileLoadedRun(parsed.data));
    }
    return { runs, dropped };
  } catch {
    // Corrupt or unreadable index. A project that cannot be read contributes nothing to the
    // index rather than failing the whole workspace's search — the same degrade-quietly rule
    // the rest of the registry follows.
    return { runs: [], dropped: 0 };
  }
}
