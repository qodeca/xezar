import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  version: z.literal(1),
  incident: z.string().min(1),
  prefixBytes: z.number().int().positive(),
  prefixSha256: hashSchema,
  exclusions: z.array(z.object({
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive(),
    sha256: hashSchema,
  }).strict()).min(1),
}).strict();

export class EventCorrectionError extends Error {
  constructor(message: string) {
    super(`history correction cannot be verified: ${message}`);
    this.name = 'EventCorrectionError';
  }
}

interface Snapshot { path: string; readers: number; retired: boolean }
interface CachedView {
  generation: string;
  inode: number;
  device: number;
  size: number;
  mtime: number;
  snapshot: Snapshot;
}
const views = new Map<string, CachedView>();
let cacheDirectory: string | undefined;
function directory(): string {
  if (!cacheDirectory) {
    cacheDirectory = mkdtempSync(join(tmpdir(), 'xez-history-view-'));
    const ownedDirectory = cacheDirectory;
    process.once('exit', () => {
      try { rmSync(ownedDirectory, { recursive: true, force: true }); } catch { /* Generated cache only. */ }
    });
  }
  return cacheDirectory;
}
function retire(snapshot: Snapshot): void {
  snapshot.retired = true;
  if (snapshot.readers === 0) {
    try { rmSync(snapshot.path, { force: true }); } catch { /* Exit cleanup retries. */ }
  }
}

/** An immutable display snapshot; raw NDJSON and its sequence allocator remain untouched.
 * Corrections are operator-reviewed recovery evidence installed only during a drained restart.
 * No sidecar means the ordinary raw path, with no transcript scan or generated file.
 */
export function acquireHistoryView(rawPath: string): { path: string; generation?: string; release: () => void } {
  const previous = views.get(rawPath);
  let manifestText: string;
  try { manifestText = readFileSync(`${rawPath}.corrections.json`, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !previous) return { path: rawPath, release: () => {} };
    throw new EventCorrectionError(error instanceof Error ? error.message : String(error));
  }
  try {
    const generation = digest(manifestText);
    if (previous && previous.generation !== generation) throw new Error('sidecar changed; stop writers and restart');
    const source = statSync(rawPath);
    if (previous && (source.ino !== previous.inode || source.dev !== previous.device || source.size < previous.size)) {
      throw new Error('raw source was replaced or truncated');
    }
    let current = previous;
    if (!current || source.size !== current.size || source.mtimeMs !== current.mtime) {
      const manifest = manifestSchema.parse(JSON.parse(manifestText));
      // Capture one byte range. Later appends belong to the next immutable snapshot.
      const raw = readFileSync(rawPath).subarray(0, source.size);
      if (raw.length !== source.size || manifest.prefixBytes > raw.length) throw new Error('incomplete raw prefix');
      const prefix = raw.subarray(0, manifest.prefixBytes);
      if (prefix.at(-1) !== 0x0a || digest(prefix) !== manifest.prefixSha256) throw new Error('raw prefix digest or boundary mismatch');
      const chunks: Buffer[] = [];
      let after = 0;
      for (const exclusion of manifest.exclusions) {
        const end = exclusion.offset + exclusion.length;
        if (exclusion.offset < after || end > prefix.length || !Number.isSafeInteger(end)
          || (exclusion.offset > 0 && raw[exclusion.offset - 1] !== 0x0a)
          || raw[end - 1] !== 0x0a) throw new Error('invalid exclusion boundaries');
        const line = raw.subarray(exclusion.offset, end);
        if (line.subarray(0, -1).includes(0x0a) || digest(line) !== exclusion.sha256) throw new Error('excluded record digest mismatch');
        chunks.push(raw.subarray(after, exclusion.offset));
        after = end;
      }
      // Never turn an unfinished appended line into a consumed live cursor.
      const completeEnd = raw.lastIndexOf(0x0a) + 1;
      chunks.push(raw.subarray(after, completeEnd));
      const path = join(directory(), `${randomUUID()}.jsonl`);
      let owned = false;
      try {
        const descriptor = openSync(path, 'wx', 0o600);
        owned = true;
        try { writeFileSync(descriptor, Buffer.concat(chunks)); }
        finally { closeSync(descriptor); }
      }
      catch (error) {
        try { if (owned) rmSync(path, { force: true }); } catch { /* Generated partial cache, never exposed. */ }
        throw error;
      }
      current = { generation, inode: source.ino, device: source.dev, size: source.size, mtime: source.mtimeMs,
        snapshot: { path, readers: 0, retired: false } };
      views.set(rawPath, current);
      if (previous) retire(previous.snapshot);
    }
    const snapshot = current.snapshot;
    snapshot.readers += 1;
    let released = false;
    return { path: snapshot.path, generation, release: () => {
      if (released) return;
      released = true;
      snapshot.readers -= 1;
      if (snapshot.retired) retire(snapshot);
    } };
  } catch (error) {
    throw new EventCorrectionError(error instanceof Error ? error.message : String(error));
  }
}
