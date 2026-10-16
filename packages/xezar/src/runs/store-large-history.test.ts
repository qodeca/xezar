import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import type { RunStore as RunStoreType } from './store.ts';
import { closeStoreAndRemove } from './store.testkit.ts';

/**
 * #942: a run whose event log is past the runtime's string ceiling (about 512 MB). Writing such a
 * file in a test is not an option, so `readFileSync` is made to answer an event log the way Node
 * answers one that large – `ERR_STRING_TOO_LONG` – while the file on disk stays small. A reader
 * that does not build the whole file as one string never meets that error.
 */
const oversized = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (oversized.on && typeof path === 'string' && path.endsWith('.ndjson')) {
      throw Object.assign(new Error('Cannot create a string longer than 0x1fffffe8 characters'), {
        code: 'ERR_STRING_TOO_LONG',
      });
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { RunStore, forEachLineSync } = await import('./store.ts');

describe('a run event log too large to read as one string (#942)', () => {
  let dataDir: string;
  const opened: RunStoreType[] = [];
  const open = (): RunStoreType => {
    const store = RunStore.open(dataDir);
    opened.push(store);
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(join(tmpdir(), 'xez-942-store-'));
  });

  afterEach(() => {
    oversized.on = false;
    for (const store of opened.splice(0, opened.length - 1)) store.close();
    closeStoreAndRemove(opened.pop(), dataDir);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function seeded() {
    const store = open();
    const run = store.createRun({ title: 'long codex step', workflow: 'quick-task', task: 'generate assets', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'one' });
    store.appendEvent(run.id, { type: 'note', message: 'two' });
    store.appendEvent(run.id, { type: 'note', message: 'three' });
    store.flush();
    return { store, runId: run.id };
  }

  it('still returns every event', () => {
    const { store, runId } = seeded();
    oversized.on = true;
    expect(store.readEvents(runId).map((event) => event.message)).toEqual(['one', 'two', 'three']);
  });

  it('keeps numbering events after a restart instead of starting again at 1', () => {
    const { runId } = seeded();
    oversized.on = true;
    const reopened = open();
    expect(reopened.appendEvent(runId, { type: 'user-message', text: 'Continue.' }).seq).toBe(4);
  });

  it('keeps the no-file case: no events, and the first append is seq 1', () => {
    const store = open();
    const run = store.createRun({ title: 'fresh', workflow: 'quick-task', task: 't', steps: [] });
    expect(store.readEvents(run.id)).toEqual([]);
    expect(store.appendEvent(run.id, { type: 'note', message: 'first' }).seq).toBe(1);
  });
});

describe('forEachLineSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xez-942-lines-'));
  });
  afterEach(() => {
    rmSync(dir, TEST_DIR_RM_OPTIONS);
  });

  function lines(content: string | Buffer, max?: number): string[] {
    const path = join(dir, 'events.ndjson');
    writeFileSync(path, content);
    const out: string[] = [];
    forEachLineSync(path, (line) => out.push(line), max);
    return out;
  }

  it('splits like the old whole-file read: empty lines dropped, the unterminated tail kept', () => {
    expect(lines('{"a":1}\n\n{"b":2}\r\n{"c":3}')).toEqual(['{"a":1}', '{"b":2}\r', '{"c":3}']);
  });

  it('keeps a multi-byte character that straddles a read chunk', () => {
    const lead = 'x'.repeat(1024 * 1024 - 1);
    expect(lines(Buffer.from(`${lead}ż\n{"t":"ok"}\n`, 'utf8'))).toEqual([`${lead}ż`, '{"t":"ok"}']);
  });

  it('skips a line longer than the limit and keeps the lines around it', () => {
    expect(lines('{"a":1}\n' + 'y'.repeat(20) + '\n{"b":2}\n' + 'z'.repeat(20), 10)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('lets a missing file fail, for the caller to decide', () => {
    expect(() => forEachLineSync(join(dir, 'missing.ndjson'), () => undefined)).toThrow(/ENOENT/);
  });
});
