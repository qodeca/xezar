// Count-based worktree retention (#483). A busy cockpit leaves one full repo
// checkout per finished task under `.local/xezar/worktrees/<runId>`; nothing bounds
// the total, so disk saturates. This module decides *which* finished worktrees
// to reclaim (directory only — the `xez/<id8>` branch is kept, so the work stays
// recoverable) and the thin I/O enforcer that performs the reclaim. The selector
// is pure and unit-testable; the enforcer never throws (helper discipline).
import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createWorktree, removeWorktree } from '../git-worktree.ts';
import { ownRun, ownWorktree, ownershipScope, type OwnershipProject, type OwnershipScope } from '../mcp/resource-ownership.ts';
import type { RunRecord, RunStatus } from './store.ts';

/** The "finished" status set — mirrors `RunStore.archiveFinished`. A run at the
 *  `review` gate is deliberately excluded: it still needs its worktree to render
 *  the diff and open a draft PR, so reclaiming it would break the gate. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);

/** Recency key for retention ordering: when a run finished, falling back to when
 *  it was created (a finished run should always have `finishedAt`, but old
 *  records may not). Lexicographic compare is correct for ISO-8601 timestamps. */
function recencyKey(run: RunRecord): string {
  return run.finishedAt ?? run.createdAt;
}

/** A run is reclaimable when it is finished, still has a materialized worktree
 *  directory, and has not already been reclaimed. */
export function isReclaimable(run: RunRecord): boolean {
  return FINISHED.has(run.status) && !!run.worktreePath && !run.worktreeReclaimedAt;
}

/**
 * Given every run and the keep-count `keep`, return the ids of the finished
 * worktrees whose *directory* should be reclaimed: keep the `keep`
 * most-recently-finished reclaimable worktrees, reclaim the rest.
 *
 * `keep === 0` means "unlimited — never auto-reclaim" and returns `[]`.
 * Pure: no I/O, no mutation of the input.
 */
export function selectReclaimableWorktrees(runs: readonly RunRecord[], keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const reclaimable = runs
    .filter(isReclaimable)
    .sort((a, b) => (recencyKey(a) < recencyKey(b) ? 1 : recencyKey(a) > recencyKey(b) ? -1 : 0));
  return reclaimable.slice(keep).map((r) => r.id);
}

/** The slice of the runs store the enforcer needs. Kept structural so the
 *  enforcer stays easy to test and never imports the concrete store. */
export interface RetentionStore {
  listRuns(): RunRecord[];
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/** The slice of the store the re-materializer needs. */
export interface RematerializeStore {
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/**
 * If retention (#483) reclaimed this run's worktree — branch kept, directory
 * gone, `worktreeReclaimedAt` stamped — re-materialize the directory (via the
 * idempotent `createWorktree`, which reattaches the surviving `xez/<id8>`
 * branch) and CLEAR the stamp. Called on the resume/continue path so a resumed
 * run regains its isolated tree and becomes eligible for retention again;
 * without it the run would keep a directory on disk while staying invisible to
 * the enforcer forever (a leak). Returns true when it re-materialized.
 * Best-effort: never throws; the continuation caller refuses lost isolation before spawning.
 */
export async function rematerializeReclaimedWorktree(
  repoRoot: string,
  store: RematerializeStore,
  runId: string,
): Promise<boolean> {
  const run = store.getRun(runId);
  if (!run?.worktreePath || !run.worktreeReclaimedAt || existsSync(run.worktreePath)) return false;
  try {
    await createWorktree(repoRoot, runId, run.baseBranch ?? 'HEAD');
    store.updateRun(runId, { worktreeReclaimedAt: undefined });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce the retention budget: reclaim the *directory* of every over-limit
 * finished worktree (branch kept via `removeWorktree` without the branch arg),
 * stamping `worktreeReclaimedAt` on each run actually reclaimed. Returns the
 * reclaimed run ids (for logging/SSE).
 *
 * Never throws (helper discipline). `removeWorktree` is best-effort and does not
 * report failure, so a run is stamped only once its directory is confirmed gone
 * — a locked/permission failure leaves the stamp unset so the next pass retries.
 * Idempotent under races: `removeWorktree` is `--force` + `prune` and a repeated
 * stamp is harmless. A caller with a lifecycle passes `shouldStop` and the sweep abandons the
 * rest of the pass the moment that caller is done with the repository, returning the ids it had
 * already reclaimed.
 */
export interface ReclaimOptions {
  /** Timestamp source for the stamp — injectable for deterministic tests. */
  now?: () => string;
  /** Directory reclaimer — defaults to the real `removeWorktree` (branch kept).
   *  Injectable so tests can exercise the "removal failed" branch without brittle
   *  filesystem-permission tricks. */
  remove?: (repoRoot: string, worktreePath: string) => Promise<void>;
  /**
   * Asked before EVERY iteration: has the caller stopped owning this repository?
   *
   * A sweep is a loop of `git worktree remove` spawns with a `store.updateRun` stamp after each
   * one, so a caller that checks "am I still alive" once before calling this stops the sweep
   * before its FIRST removal and never again — and a five-worktree pass that straddles a
   * `RunManager.dispose()` goes on writing into a data root its owner has finished with (#200).
   *
   * Absent means "never stop", which is what every one-shot caller (boot, the reclaim route)
   * wants: they have no lifecycle to lose mid-sweep.
   */
  shouldStop?: () => boolean;
}

/** Reclaim looks up no automation, so that half of the ownership scope refuses everything. */
const NO_AUTOMATIONS = { get: () => undefined, latestReceipts: () => new Map() } as unknown as OwnershipProject['automationStore'];

/**
 * The reclaimable runs whose worktree is provably this project's own (#288). A record's
 * `worktreePath` is data — a copied or hand-edited `.local/xezar` can name another project's
 * worktree — and reclaim deletes that directory. So a candidate must name this project's
 * `<root>/.local/xezar/worktrees/<id>` (`ownRun`), and a directory that exists there must be a
 * real one reached through no symlink (`ownWorktree`). A directory that is already gone reaches
 * nothing and stays a candidate, so its stamp is still written. Anything else is left out BEFORE
 * selection: it neither counts against `keep` nor is touched. Per record rather than `ownSweep`'s
 * whole-sweep refusal, because this also runs unattended at boot and at every task's end, where
 * refusing the whole sweep would silently switch retention (#483) off for the project.
 */
async function ownedReclaimable(repoRoot: string, runs: readonly RunRecord[]): Promise<RunRecord[]> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const scope = ownershipScope({
    root: repoRoot,
    store: { getRun: (id) => byId.get(id), listRuns: () => [...runs] },
    automationStore: NO_AUTOMATIONS,
  });
  const owned: RunRecord[] = [];
  for (const run of runs) {
    if (isReclaimable(run) && (await ownRunAndWorktree(scope, run.id))) owned.push(run);
  }
  return owned;
}

/**
 * A run of this project whose recorded worktree, if it names one, is provably this project's own
 * (`ownRun` + `ownWorktree`) or already gone — the rule above, per run. The cockpit's run routes
 * that delete, commit, push or run git in that worktree ask the same question through this one
 * function (#316), so reclaim and those routes cannot come to disagree about what is ours.
 * `null` when the run is unknown here or reaches anywhere else.
 */
export async function ownRunAndWorktree(scope: OwnershipScope, runId: string): Promise<RunRecord | null> {
  const run = ownRun(scope, runId);
  if (!run.ok) return null;
  const path = run.value.worktreePath;
  if (path === undefined || (await ownWorktree(scope, runId)).ok || (await isAbsent(path))) return run.value;
  return null;
}

/** Nothing at `path`, not even a dangling link. Any other answer is not "absent" (fail closed). */
async function isAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function reclaimWorktrees(
  repoRoot: string,
  store: RetentionStore,
  keep: number,
  opts: ReclaimOptions = {},
): Promise<string[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const remove = opts.remove ?? ((root, path) => removeWorktree(root, path)); // branch kept
  const shouldStop = opts.shouldStop ?? (() => false);
  const runs = store.listRuns();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const reclaimed: string[] = [];
  for (const id of selectReclaimableWorktrees(await ownedReclaimable(repoRoot, runs), keep)) {
    // Per iteration, not once before the loop: each pass costs a git spawn and a record write,
    // and the caller's ownership can end between any two of them. Returning what was already
    // reclaimed is honest — those directories really are gone.
    if (shouldStop()) break;
    const run = byId.get(id);
    if (!run?.worktreePath) continue;
    try {
      await remove(repoRoot, run.worktreePath);
      if (existsSync(run.worktreePath)) continue; // reclaim failed; retry next pass
      store.updateRun(id, { worktreeReclaimedAt: now() });
      reclaimed.push(id);
    } catch {
      // best-effort: never let retention crash a terminal transition or startup.
    }
  }
  return reclaimed;
}
