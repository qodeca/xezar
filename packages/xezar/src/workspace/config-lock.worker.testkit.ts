import { mergeWriteWorkspaceConfig } from './config.ts';

/**
 * One CROSS-PROCESS writer of `~/.xezar/config.json`, for the contention tests of #467.
 *
 * It exists as a real child process because the thing under test is a real cross-process
 * lock: two `await`s inside one vitest worker are serialized by the in-process queue and
 * would prove nothing about two `xez` commands started at the same moment.
 *
 * Usage: `tsx config-lock.worker.testkit.ts <projectId> <holdMs> [writer]`
 *
 * `holdMs` is spent SYNCHRONOUSLY inside the mutator — that is, between the read and the
 * write of the read-modify-write. It makes the lost-update window deterministic instead of
 * something a test has to hit by luck. `writer` picks which registry change this process
 * makes, so one test can pit a port-memory write against a `projects` edit.
 *
 * `XEZ_HOME` selects the sandbox; the caller always pins it.
 */
const [projectId = 'unnamed', holdText = '0', writer = 'add'] = process.argv.slice(2);
const holdMs = Number(holdText);

/** A synchronous pause. `Atomics.wait` blocks the thread, which is the point: it must sit
 *  between the load and the atomic rename, where an `await` would yield instead. */
function holdSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

await mergeWriteWorkspaceConfig((config) => {
  holdSync(holdMs);
  if (writer === 'remember') {
    const entry = config.projects.find((p) => p.id === projectId);
    if (entry) entry.lastListen = { port: 4321, host: '127.0.0.1', observedAt: 'fixed' };
    return;
  }
  config.projects.push({
    id: projectId,
    root: `/tmp/${projectId}`,
    name: projectId,
    addedAt: '',
    lastOpenedAt: '',
    source: 'local',
  });
});
