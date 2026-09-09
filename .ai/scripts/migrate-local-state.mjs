#!/usr/bin/env node
// Preserve legacy QA evidence separately from the disposable new test environment.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function entryExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function assertIdle(paths) {
  const roots = paths.map(path => realpathSync(path));
  let output;
  try { output = execFileSync('lsof', ['-nP', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { throw new Error('cannot verify legacy data is idle; install lsof before migration'); }
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (pid === process.pid || !line.startsWith('n')) continue;
    if (roots.some(root => line.slice(1) === root || line.slice(1).startsWith(root + '/'))) throw new Error('legacy data is in use; stop its processes before migration');
  }
}
function protectLocal(root) {
  const local = join(root, '.local');
  if (entryExists(local) && lstatSync(local).isSymbolicLink()) throw new Error('.local is a symlink; inspect it before migration');
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const ignore = join(local, '.gitignore');
  const content = entryExists(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!content.split('\n').includes('*')) writeFileSync(ignore, `${content}\n*\n`);
}

export function archiveLegacyQa(root) {
  const source = join(root, '.ai/qa');
  if (!entryExists(source)) return false;
  if (lstatSync(source).isSymbolicLink()) throw new Error('legacy QA is a symlink; inspect it before migration');
  if (readdirSync(source).every(name => name === '.gitkeep')) return false;
  const local = join(root, '.local');
  if (entryExists(local) && lstatSync(local).isSymbolicLink()) throw new Error('.local is a symlink; inspect it before migration');
  const target = join(local, 'legacy-qa');
  if (entryExists(target)) throw new Error('.local/legacy-qa already exists; resolve the two archives without overwriting either');
  const lock = join(source, 'test-env.lock');
  try { mkdirSync(lock); } catch { throw new Error('legacy QA bootstrap lock exists; wait for the old bootstrap or inspect its stale lock'); }
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, source: 'migrate-local-state' }));
    const descriptor = join(source, 'test-env.json');
    if (entryExists(descriptor)) {
      let data;
      try { data = JSON.parse(readFileSync(descriptor, 'utf8')); }
      catch { throw new Error('legacy QA descriptor is corrupt; inspect it before migration'); }
      if (data.app?.pid != null) {
        if (!Number.isSafeInteger(data.app.pid) || data.app.pid <= 0) throw new Error('legacy QA PID is invalid; inspect it before migration');
        let alive = true;
        try { process.kill(data.app.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('legacy QA process is alive; stop it with test-env-down.sh before migration');
      } else if (data.status === 'running') throw new Error('legacy QA claims to be running without a PID; inspect it before migration');
    }
    assertIdle([source]);
    protectLocal(root);
    // Same-filesystem rename: no partial copy, no overwriting files or deleting credentials.
    renameSync(source, target);
    rmSync(join(target, 'test-env.lock'), { recursive: true });
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function archiveLegacyAgentic(root) {
  const moves = ['runs', 'analysis', 'specs', 'tmp'].map(name => ({
    source: join(root, '.ai', name), target: join(root, '.local/legacy-agentic', name),
  })).filter(move => entryExists(move.source));
  if (!moves.length) return false;
  for (const move of moves) {
    if (lstatSync(move.source).isSymbolicLink()) throw new Error('legacy agentic directory is a symlink; inspect it before migration');
    if (entryExists(move.target)) throw new Error('legacy agentic archive already exists; no overwrite performed');
  }
  assertIdle(moves.map(move => move.source));
  protectLocal(root);
  mkdirSync(join(root, '.local/legacy-agentic'), { recursive: true, mode: 0o700 });
  for (const move of moves) renameSync(move.source, move.target);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(import.meta.dirname, '../..');
    const agenticChanged = archiveLegacyAgentic(root);
    const changed = archiveLegacyQa(root);
    if (agenticChanged) console.log('Preserved legacy agentic records in .local/legacy-agentic; maintained specifications now belong in docs/specs.');
    console.log(changed ? 'Preserved legacy QA in .local/legacy-qa. The next boot creates .local/qa.' : 'No legacy QA data to migrate.');
  } catch (error) { console.error(`[local-state] ${error.message}`); process.exitCode = 1; }
}
