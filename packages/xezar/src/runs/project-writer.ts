import { randomUUID } from 'node:crypto';
import { closeSync, openSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { localMachineId, machineRelation, type MachineRelation } from '../machine-identity.ts';

const owned = new Map<string, string>();

export class ProjectWriterError extends Error {
  constructor(readonly dataDir: string, detail: string) {
    super(`project data is already in use or its writer cannot be verified: ${dataDir} (${detail}). Use the existing cockpit.`);
    this.name = 'ProjectWriterError';
  }
}

/** The claim's exact bytes, for PUBLISHING only — the self-check (`claimIsOurs`) compares
 * fields, not bytes, because the `host` recorded here is display-only and this helper reads
 * `hostname()` live. `machine` is omitted (not written as null) when this host cannot identify
 * itself, so an unidentifiable host keeps writing the pre-#199 shape byte for byte. */
function claimBody(machine: string | null): string {
  return JSON.stringify({ pid: process.pid, host: hostname(), ...(machine === null ? {} : { machine }) });
}

/**
 * Is the claim this process published still the one on disk?
 *
 * It compares the two facts that identify a writer — the PID and the MACHINE — and never the
 * hostname, for the same reason the peer scan stopped trusting it: `claimBody` reads
 * `hostname()` live, so a byte-for-byte comparison against a freshly built body turns a machine
 * renaming itself into "the active claim changed". That is #199's lockout reproduced INSIDE one
 * process, and it is reachable long after boot — `automations/coordinator.ts` calls
 * `ownProjectData` lazily, so a laptop that changes network while `xez serve` is up hits it.
 * `localMachineId()` is memoized, so the hostname is the only field that could ever have moved.
 *
 * Fails closed on anything it cannot read or parse: an unreadable, truncated or rewritten claim
 * is not this process's claim. `unknown` (this host will not name itself, or the claim predates
 * the field) passes, exactly as the peer scan treats it — there is no evidence of a different
 * machine, and the file's path already carries this process's PID and a UUID only it generated.
 */
function claimIsOurs(path: string, machine: string | null): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const claim = parsed as { pid?: unknown; machine?: unknown };
  return claim.pid === process.pid && machineRelation(claim.machine, machine) !== 'different';
}

/** Long hostnames and corrupt claims must not turn an error message into a wall of text. */
function short(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 120));
}

/** Name the file, both hostnames and the PID, because the only repair is deleting one file and
 * "foreign-host writer claim" pointed at nothing (#199). Says WHY the machines were judged
 * different, so "a different machine" and "no identity to compare" never read the same. */
function foreignClaimDetail(path: string, recordedHost: unknown, pid: number, relation: MachineRelation): string {
  const evidence = relation === 'different'
    ? 'It also records a different machine identity.'
    : 'It records no machine identity to compare, so the hostname was the only evidence.';
  return `foreign-host writer claim: ${path} names host ${short(recordedHost)} (PID ${pid}); this host is ${short(hostname())}.`
    + ` ${evidence} If that machine is no longer using this directory, delete that claim file.`;
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
  const machine = localMachineId();
  const prior = owned.get(canonical);
  if (prior) {
    // Deleting active runtime state is not a supported way to release ownership.
    if (!claimIsOurs(prior, machine)) {
      throw new ProjectWriterError(canonical, 'the active claim changed');
    }
    return;
  }
  const body = claimBody(machine);
  const directory = join(canonical, 'writer-claims');
  mkdirSync(directory, { recursive: true });
  const claim = join(directory, `${process.pid}-${randomUUID()}.json`);
  let published = false;
  try {
    const descriptor = openSync(claim, 'wx', 0o600);
    published = true; // Exclusive open established ownership even if the following write fails.
    try { writeFileSync(descriptor, body); }
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
      // What the host check was load-bearing FOR: a PID number is only evidence on the machine
      // that wrote it, so a foreign claim must never be reaped by probing that PID here. A
      // hostname was standing in for the machine, and a laptop that changes networks changes its
      // name (#199), so a recorded identity that MATCHES this machine settles the question and
      // lets the hostname become display-only.
      //
      // Deliberately one-way. A mismatched or absent identity falls back to the hostname exactly
      // as before, so no claim this guard used to refuse becomes reapable: a restarted container
      // with a pinned hostname still recovers its own dead claim, and two hosts sharing storage
      // are no more reapable by PID than they were. Only "provably the same machine" is new.
      const relation = peer && typeof peer === 'object'
        ? machineRelation((peer as { machine?: unknown }).machine, machine)
        : 'unknown';
      const foreign = (recordedHost: unknown): boolean => relation !== 'same' && recordedHost !== hostname();
      if (peer && typeof peer === 'object' && 'host' in peer && foreign(peer.host)) {
        throw new Error(foreignClaimDetail(path, peer.host, pid, relation));
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
      // Same host rule as above, through the same helper: half the sites is half a fix, and a
      // live writer on this machine under its earlier name must report itself as the live writer
      // it is rather than as an invalid claim.
      if (!peer || typeof peer !== 'object' || !('pid' in peer) || !('host' in peer)
        || !Number.isSafeInteger(peer.pid) || Number(peer.pid) <= 0
        || foreign(peer.host) || peer.pid !== pid) {
        throw new Error(`invalid or foreign-host writer claim: ${path}`);
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
