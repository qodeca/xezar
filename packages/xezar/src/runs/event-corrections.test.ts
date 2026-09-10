import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireHistoryView } from './event-corrections.ts';
import { deriveRunContextEvents, readEventsAfterLiveCursor, readRunHistoryPage, validateLegacyHistoryResume, validateLiveCursor } from './event-history.ts';
import { RunStore } from './store.ts';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), createReadStream: vi.fn(actual.createReadStream) };
});
const directories: string[] = [];
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'xez-correction-test-'));
  directories.push(path);
  return path;
}
const line = (seq: number, message: string) => JSON.stringify({ seq, ts: '2026-09-10T14:31:30Z', type: 'note', stepId: 'continue-1', message }) + '\n';
function correct(path: string, excludedIndexes: number[]): void {
  const raw = readFileSync(path);
  const records = raw.toString('utf8').split('\n').slice(0, -1).map((record) => Buffer.from(record + '\n'));
  let offset = 0;
  const exclusions = records.flatMap((record, index) => {
    const value = { offset, length: record.length, sha256: hash(record) };
    offset += record.length;
    return excludedIndexes.includes(index) ? [value] : [];
  });
  writeFileSync(`${path}.corrections.json`, JSON.stringify({ version: 1, incident: 'test-185', prefixBytes: raw.length, prefixSha256: hash(raw), exclusions }));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('leaves the no-sidecar path untouched, including missing ordinary histories', () => {
  const path = join(directory(), 'absent.ndjson');
  const view = acquireHistoryView(path);
  expect(view.path).toBe(path);
  expect(view.generation).toBeUndefined();
  view.release();
  expect(existsSync(path)).toBe(false);
});

it('filters exact UTF-8 byte ranges before dedup and retains identical genuine later records', async () => {
  const path = join(directory(), 'run.ndjson');
  const mock = line(2, 'mock żółć');
  const genuine = line(2, 'genuine Łódź');
  const original = line(1, 'real') + mock + genuine;
  writeFileSync(path, original);
  correct(path, [1]);
  const first = acquireHistoryView(path);
  expect(readFileSync(first.path, 'utf8')).toBe(line(1, 'real') + genuine);
  const page = await readRunHistoryPage(path);
  expect(page.events.map((event) => event.message)).toEqual(['real', 'genuine Łódź']);
  expect(page.asOfSeq).toBe(2);
  expect((await deriveRunContextEvents(path)).asOfSeq).toBe(2);
  appendFileSync(path, mock); // Same bytes and same step, but outside the quarantined prefix.
  const second = acquireHistoryView(path);
  expect(second.path).not.toBe(first.path);
  expect(readFileSync(first.path, 'utf8')).toBe(line(1, 'real') + genuine);
  expect(readFileSync(second.path, 'utf8')).toBe(line(1, 'real') + genuine + mock);
  expect((await readEventsAfterLiveCursor(path, page.liveCursor)).events.map((event) => event.message)).toEqual(['mock żółć']);
  first.release();
  expect(existsSync(first.path)).toBe(false);
  first.release();
  second.release();
  expect(readFileSync(path, 'utf8')).toBe(original + mock);
});

it('does not consume a partial appended record into the live cursor', async () => {
  const path = join(directory(), 'run.ndjson');
  writeFileSync(path, line(1, 'real') + line(90, 'mock'));
  correct(path, [1]);
  const suffix = line(91, 'genuine later');
  appendFileSync(path, suffix.slice(0, -1));
  const page = await readRunHistoryPage(path);
  expect(page.asOfSeq).toBe(1);
  appendFileSync(path, '\n');
  expect((await readEventsAfterLiveCursor(path, page.liveCursor)).events.map((event) => event.seq)).toEqual([91]);
});

it('rejects pre-correction page/live and sequence-only resumes; fresh replay remains available', async () => {
  const path = join(directory(), 'run.ndjson');
  writeFileSync(path, Array.from({ length: 110 }, (_, index) => line(index + 1, String(index))).join(''));
  const old = await readRunHistoryPage(path);
  correct(path, [109]);
  await expect(readRunHistoryPage(path, old.olderCursor)).rejects.toMatchObject({ status: 409 });
  await expect(readEventsAfterLiveCursor(path, old.liveCursor)).rejects.toMatchObject({ status: 409 });
  await expect(validateLiveCursor(path, old.liveCursor)).rejects.toMatchObject({ status: 409 });
  expect(() => validateLegacyHistoryResume(path, 110)).toThrow('history was corrected');
  expect(() => validateLegacyHistoryResume(path, 0)).not.toThrow();
  const fresh = await readRunHistoryPage(path);
  await expect(validateLiveCursor(path, fresh.liveCursor)).resolves.toBeUndefined();
  expect((await readRunHistoryPage(path, fresh.olderCursor)).asOfSeq).toBe(109);
});

it('allocates above raw quarantined max while all store display reads exclude the mock', () => {
  const root = directory();
  const store = RunStore.open(root);
  const run = store.createRun({ title: 'test', task: 'test', workflow: 'quick-task', steps: [] });
  store.flush();
  const path = join(root, 'runs', `${run.id}.ndjson`);
  const original = line(1, 'real') + line(900, 'mock') + line(2, 'real afterward');
  writeFileSync(path, original);
  correct(path, [1]);
  const reopened = RunStore.open(root);
  expect(reopened.readEvents(run.id).map((event) => event.seq)).toEqual([1, 2]);
  reopened.appendEvent(run.id, { type: 'note', message: 'new genuine' });
  reopened.flush();
  expect(reopened.readEvents(run.id).map((event) => event.seq)).toEqual([1, 2, 901]);
  expect(readFileSync(path, 'utf8').startsWith(original)).toBe(true);
});

it.each(['prefix', 'boundary', 'digest', 'overlap', 'schema'])('refuses an invalid %s manifest without hiding the error as empty history', async (fault) => {
  const path = join(directory(), 'run.ndjson');
  writeFileSync(path, line(1, 'real') + line(2, 'mock'));
  correct(path, [1]);
  const sidecar = `${path}.corrections.json`;
  const manifest = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (fault === 'prefix') manifest.prefixSha256 = '0'.repeat(64);
  if (fault === 'boundary') manifest.exclusions[0].offset += 1;
  if (fault === 'digest') manifest.exclusions[0].sha256 = '0'.repeat(64);
  if (fault === 'overlap') manifest.exclusions.push(manifest.exclusions[0]);
  if (fault === 'schema') manifest.version = 2;
  writeFileSync(sidecar, JSON.stringify(manifest));
  await expect(readRunHistoryPage(path)).rejects.toThrow('history correction cannot be verified');
  await expect(deriveRunContextEvents(path)).rejects.toThrow('history correction cannot be verified');
});

it.each(['changed', 'removed', 'truncated', 'replaced'])('refuses %s recovery inputs after activation', (fault) => {
  const path = join(directory(), 'run.ndjson');
  const raw = line(1, 'real') + line(2, 'mock');
  writeFileSync(path, raw);
  correct(path, [1]);
  acquireHistoryView(path).release();
  if (fault === 'changed') appendFileSync(`${path}.corrections.json`, ' ');
  if (fault === 'removed') rmSync(`${path}.corrections.json`);
  if (fault === 'truncated') writeFileSync(path, '');
  if (fault === 'replaced') { rmSync(path); writeFileSync(path, raw); }
  expect(() => acquireHistoryView(path)).toThrow('history correction cannot be verified');
});

it('does not expose a partial cache write or damage an already leased snapshot', () => {
  const path = join(directory(), 'run.ndjson');
  writeFileSync(path, line(1, 'real') + line(2, 'mock'));
  correct(path, [1]);
  const first = acquireHistoryView(path);
  appendFileSync(path, line(3, 'later'));
  const cacheBefore = readdirSync(dirname(first.path)).sort();
  let partialDescriptor: number | undefined;
  vi.mocked(writeFileSync).mockImplementationOnce((descriptor) => {
    if (typeof descriptor !== 'number') throw new Error('expected owned file descriptor');
    partialDescriptor = descriptor;
    writeSync(descriptor, 'partial cache');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  expect(() => acquireHistoryView(path)).toThrow('disk full');
  expect(partialDescriptor).toBeTypeOf('number');
  expect(readdirSync(dirname(first.path)).sort()).toEqual(cacheBefore);
  expect(readFileSync(first.path, 'utf8')).toBe(line(1, 'real'));
  const retry = acquireHistoryView(path);
  expect(readFileSync(retry.path, 'utf8')).toBe(line(1, 'real') + line(3, 'later'));
  first.release(); retry.release();
});


it('keeps a real asynchronous context reader on its old snapshot during publication of an append', async () => {
  const path = join(directory(), 'run.ndjson');
  writeFileSync(path, line(1, 'real') + line(900, 'mock'));
  correct(path, [1]);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let oldPath: string | undefined;
  vi.mocked(createReadStream).mockImplementationOnce((source, options) => {
    oldPath = String(source);
    appendFileSync(path, line(901, 'later'));
    const newer = acquireHistoryView(path);
    expect(newer.path).not.toBe(oldPath);
    newer.release();
    expect(existsSync(oldPath)).toBe(true);
    return actual.createReadStream(source, options);
  });
  expect((await deriveRunContextEvents(path)).asOfSeq).toBe(1);
  expect(oldPath).toBeTypeOf('string');
  expect(existsSync(String(oldPath))).toBe(false);
  expect((await deriveRunContextEvents(path)).asOfSeq).toBe(901);
});
