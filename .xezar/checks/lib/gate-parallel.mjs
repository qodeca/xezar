// Fixed application-gate dependency schedule. Workers never mutate attempt.json.
//
// THE INDEXES ARE POSITIONS IN `repo-gates.sh`'s canonical list, one-based. Nothing here knows
// which gates a project has: `repo-gates.sh` passes the application phase's entries, and the
// lanes come from `GATE_APPLICATION_LANES` beside the list (`3,6,7;4;5` — lanes split by `;`,
// a lane's gates by `,`, run in that order). Unset or empty means one lane in list order. The
// lanes must name every application gate exactly once, or the phase is refused: a gate that
// silently never ran is the one failure this file exists to prevent.
//
// On native Windows (Git Bash) a gate's processes are stopped by `windows-process.mjs`, which only
// this file loads and only there: Windows has no process group a signal reaches (#122).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [library, mode, rawEntries] = process.argv.slice(2);
const entries = JSON.parse(rawEntries);
const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
if (!['application', 'serial'].includes(mode) || !entries.length || byIndex.size !== entries.length ||
    entries.some(e => !Number.isInteger(e.index) || e.index < 1 || typeof e.name !== 'string' || !e.name || typeof e.command !== 'string' || !e.command)) {
  throw new Error('invalid gate phase');
}
const APPLICATION_LANES = (() => {
  if (mode !== 'application') return [];
  const raw = (process.env.GATE_APPLICATION_LANES ?? '').trim();
  if (!raw) return [entries.map((e) => e.index)];
  const lanes = raw.split(';').map((l) => l.split(',').map((n) => Number(n.trim())));
  const named = lanes.flat();
  if (named.some((n) => !Number.isInteger(n)) || named.length !== entries.length ||
      new Set(named).size !== named.length || named.some((n) => !byIndex.has(n))) {
    throw new Error(`invalid GATE_APPLICATION_LANES "${raw}": it must name each application gate (${[...byIndex.keys()].join(', ')}) exactly once`);
  }
  return lanes;
})();
const posix = process.platform !== 'win32';
const windows = posix ? null : await import('./windows-process.mjs');
const win = windows ? windows.prepare(process.env) : null;
if (win && !win.ok) {
  process.stderr.write(`gate scheduler: ${win.reason}\n`);
  process.exit(1);
}
const directory = join(process.env.GATE_ATTEMPT_DIR, 'workers');
mkdirSync(directory, { recursive: true });
const groups = new Set();
let stopped = false;
let infrastructureFailed = false;
const worker = '. "$1"; GATE_INDEX=$(($2-1)); GATE_WORKER_RESULT="$GATE_ATTEMPT_DIR/workers/$2.json"; gate_run "$3" bash -c "$4"';
// Windows: the worker first records its MSYS pid, the key to its processes after it has exited.
const windowsWorker = `printf '%s\\n' "$$" > "$GATE_ATTEMPT_DIR/workers/$2.msys-pid"; ${worker}`;
const STOP_SIGNALS = posix ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
const workers = new Map(); // Windows only: pid -> { child, index, spawnedAt, exitedAt, round }
const pending = [];

function signal(pid, kind) {
  if (!posix) return stopWindows(pid);
  try { process.kill(-pid, kind); }
  catch (error) { if (error.code !== 'ESRCH') infrastructureFailed = true; }
}
function interrupt() {
  stopped = true;
  for (const pid of groups) signal(pid, 'SIGTERM');
}
for (const name of STOP_SIGNALS) process.on(name, interrupt);

// A worker's close does not prove its descendants exited. Its owned POSIX group
// gets a bounded cleanup, even when a grandchild ignores TERM or the worker exited first.
async function reap(pid) {
  if (!posix) return reapWindows(pid);
  try { process.kill(-pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return;
    infrastructureFailed = true;
  }
  signal(pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  signal(pid, 'SIGKILL');
}

// --- Windows ---------------------------------------------------------------------------------------
// A console program has no graceful stage there: SIGTERM and SIGKILL both mean "stop now". The
// worker is killed through Node's own handle, then its processes by identity (windows-process.mjs).
function windowsRoot(w, stoppedAt) {
  let msysPid = null;
  try { msysPid = Number(readFileSync(join(directory, `${w.index}.msys-pid`), 'utf8').trim()) || null; } catch { msysPid = null; }
  return { winpid: w.child.pid, msysPid, spawnedAt: w.spawnedAt, stoppedAt };
}
function windowsRound(w, root, killRoot) {
  return windows.stopTree(root, win, { killRoot }).then((result) => {
    if (!result.ok) {
      infrastructureFailed = true;
      process.stderr.write(`gate scheduler: could not stop every process gate ${w.index} started (${result.reason})\n`);
    }
    return result;
  });
}
function stopWindows(pid) {
  const w = workers.get(pid);
  if (!w || w.round || w.exitedAt !== null) return; // an exited worker is reaped instead
  w.child.kill();
  w.round = windowsRound(w, windowsRoot(w, Date.now()), true).finally(() => { w.round = null; });
  pending.push(w.round);
}
// After a worker exited by itself: stop what is left of it, dated by the moment its exit was seen.
// A round that killed something gets one more, for a process started while it ran.
async function reapWindows(pid) {
  const w = workers.get(pid);
  if (!w) return;
  if (w.round) await w.round;
  for (let round = 0; round < 2; round += 1) {
    const result = await windowsRound(w, windowsRoot(w, w.exitedAt ?? Date.now()), false);
    if (!result.ok || !result.killed) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function run(entry) {
  if (stopped) return;
  try {
    const child = posix
      ? spawn('bash', ['-c', worker, 'gate-worker', library,
        String(entry.index), entry.name, entry.command], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: process.env,
      })
      // Git's own usr\bin\bash.exe, so the worker's pid is bash's; not detached, so it keeps the
      // console. The command line is quoted for the MSYS runtime (windows-process.mjs, msysQuote).
      : spawn(win.bash, ['-c', windowsWorker, 'gate-worker', library,
        String(entry.index), entry.name, entry.command].map(windows.msysQuote), {
        stdio: ['ignore', 'ignore', 'ignore'], env: win.env,
        windowsHide: true, windowsVerbatimArguments: true, argv0: windows.msysQuote(win.bash),
      });
    const pid = child.pid;
    if (pid) groups.add(pid);
    if (pid && !posix) {
      const w = { child, index: entry.index, spawnedAt: Date.now(), exitedAt: null, round: null };
      workers.set(pid, w);
      child.once('exit', () => { w.exitedAt = Date.now(); });
    }
    // Command output goes to durable gate logs. No pipe can be held by a descendant.
    await new Promise((resolve) => {
      let killTimer;
      const escalate = () => {
        if (!pid) return;
        signal(pid, 'SIGTERM');
        killTimer ??= setTimeout(() => signal(pid, 'SIGKILL'), 2000);
      };
      for (const name of STOP_SIGNALS) process.on(name, escalate);
      child.on('error', () => { infrastructureFailed = true; });
      child.on('close', (code, sig) => {
        try {
          writeFileSync(join(directory, `${entry.index}.exit.json`), JSON.stringify({code, signal: sig}), {flag: 'wx', mode: 0o600});
          const result = JSON.parse(readFileSync(join(directory, `${entry.index}.json`), 'utf8'));
          const expected = result.status === 'not-run' ? 1 : result.exitCode;
          if (sig || code === null || code !== expected) infrastructureFailed = true;
        } catch { infrastructureFailed = true; }
        if (killTimer) clearTimeout(killTimer);
        for (const name of STOP_SIGNALS) process.off(name, escalate);
        resolve();
      });
      if (stopped) escalate();
    });
    if (pid) { await reap(pid); groups.delete(pid); }
    workers.delete(pid);
  } catch (error) {
    infrastructureFailed = true;
    process.stderr.write(`gate scheduler: ${error.message}\n`);
  }
}
async function lane(indices) {
  for (const index of indices) {
    if (stopped) break;
    await run(byIndex.get(index)); // ordinary failure never skips a successor
  }
}
// Windows: a stop is also asked for through `workers/stop` (repo-gates.sh writes it: a TERM from
// Git Bash never reaches this process's handler). It runs exactly the listeners a TERM runs.
const stopPoll = posix ? null : setInterval(() => {
  if (!stopped && existsSync(join(directory, 'stop'))) process.emit('SIGTERM');
}, 250);
stopPoll?.unref();
await Promise.all((mode === 'application' ? APPLICATION_LANES : [entries.map(e => e.index)]).map(lane));
if (stopPoll) clearInterval(stopPoll);
await Promise.all(pending);
process.exitCode = stopped ? 130 : infrastructureFailed ? 1 : 0;
