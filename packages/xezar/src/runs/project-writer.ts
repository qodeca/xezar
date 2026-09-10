import { randomUUID } from 'node:crypto';
import { closeSync, openSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const owned = new Map<string, string>();

export class ProjectWriterError extends Error {
  constructor(readonly dataDir: string, detail: string) {
    super(`project data is already in use or its writer cannot be verified: ${dataDir} (${detail}). Use the existing cockpit.`);
    this.name = 'ProjectWriterError';
  }
}

/** One process owns a project's mutable state, independent of port and XEZ_HOME.
 * Publish a unique claim BEFORE scanning. Two simultaneous contenders may both refuse,
 * but cannot both see themselves alone. Dead claims have unique paths, so reclaiming one
 * cannot unlink a replacement owner's lock. Keep claims until process death: dispose() can
 * leave live sessions, and exit handlers may still flush. The next owner reaps dead PIDs.
 */
export function ownProjectData(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const canonical = realpathSync(dataDir);
  const prior = owned.get(canonical);
  if (prior) {
    // Deleting active runtime state is not a supported way to release ownership.
    let intact = false;
    try { intact = readFileSync(prior, 'utf8') === JSON.stringify({ pid: process.pid, host: hostname() }); } catch { /* fail closed */ }
    if (!intact) {
      throw new ProjectWriterError(canonical, 'the active claim changed');
    }
    return;
  }
  const directory = join(canonical, 'writer-claims');
  mkdirSync(directory, { recursive: true });
  const claim = join(directory, `${process.pid}-${randomUUID()}.json`);
  let published = false;
  try {
    const descriptor = openSync(claim, 'wx', 0o600);
    published = true; // Exclusive open established ownership even if the following write fails.
    try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, host: hostname() })); }
    finally { closeSync(descriptor); }
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (path === claim) continue;
      const match = /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.exec(name);
      const pid = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(pid)) throw new Error('invalid writer claim name');
      // A refused contender can remove its own claim between readdir and read.
      let raw: string;
      try { raw = readFileSync(path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      // A process can die during its initial write. Its unique PID-named empty/partial
      // claim is reclaimable once death is established, without requiring hand repair.
      let peer: unknown;
      try { peer = JSON.parse(raw); } catch { /* A live incomplete claim still refuses below. */ }
      if (peer && typeof peer === 'object' && 'host' in peer && peer.host !== hostname()) {
        throw new Error('foreign-host writer claim');
      }
      let dead = false;
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        dead = true;
      }
      if (dead) {
        try { unlinkSync(path); }
        catch (removed) { if ((removed as NodeJS.ErrnoException).code !== 'ENOENT') throw removed; }
        continue;
      }
      if (!peer || typeof peer !== 'object' || !('pid' in peer) || !('host' in peer)
        || !Number.isSafeInteger(peer.pid) || Number(peer.pid) <= 0
        || peer.host !== hostname() || peer.pid !== pid) {
        throw new Error('invalid or foreign-host writer claim');
      }
      throw new Error(`live writer PID ${peer.pid}`);
    }
    owned.set(canonical, claim);
  } catch (error) {
    if (published) {
      try { unlinkSync(claim); } catch { /* Never remove another owner's claim. */ }
    }
    throw new ProjectWriterError(canonical, error instanceof Error ? error.message : String(error));
  }
}
