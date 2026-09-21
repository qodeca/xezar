import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCodexModels } from './codex-model-catalog.ts';

const fixtures = fileURLToPath(new URL('__fixtures__/codex/', import.meta.url));

function fixture(name: string): unknown[] {
  return readFileSync(`${fixtures}${name}.ndjson`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function fakeChild(responses: unknown[] = []): {
  child: ChildProcessWithoutNullStreams;
  requests: Array<Record<string, unknown>>;
  emitExit(code: number): void;
} {
  const process = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const queued = [...responses];
  let input = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    input += chunk;
    let newline: number;
    while ((newline = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      requests.push(JSON.parse(line) as Record<string, unknown>);
      const response = queued.shift();
      if (response !== undefined) queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`));
    }
  });
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: () => true,
    pid: 123,
  });
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    requests,
    emitExit(code: number) {
      Object.assign(process, { exitCode: code });
      process.emit('exit', code);
      stdout.end();
    },
  };
}

describe('Codex model discovery', () => {
  it('validates a wire response and keeps the first visible, non-blank model in server order', async () => {
    const fake = fakeChild(fixture('model-list-success'));
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).resolves.toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier coding model' },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', description: 'Fast model' },
    ]);
    expect(fake.requests).toEqual([
      expect.objectContaining({ id: 1, method: 'initialize' }),
      { method: 'initialized', params: {} },
      { id: 2, method: 'model/list', params: { cursor: null, includeHidden: false } },
    ]);
  });

  it('follows every pagination cursor without reordering pages', async () => {
    const fake = fakeChild(fixture('model-list-pagination'));
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).resolves.toEqual([
      { id: 'first', label: 'First', description: 'First page' },
      { id: 'second', label: 'Second', description: 'Second page' },
    ]);
    expect(fake.requests.at(-1)).toEqual({
      id: 3,
      method: 'model/list',
      params: { cursor: 'page-2', includeHidden: false },
    });
  });

  it('rejects an old app-server without model/list', async () => {
    const fake = fakeChild([
      { id: 1, result: {} },
      { id: 2, error: { code: -32601, message: 'Method not found' } },
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).rejects.toThrow('Method not found');
  });

  it('rejects malformed model pages and malformed NDJSON', async () => {
    const invalidPage = fakeChild([{ id: 1, result: {} }, { id: 2, result: { data: [{ model: 42 }] } }]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => invalidPage.child })).rejects.toThrow('malformed model data');

    const invalidJson = fakeChild([{ id: 1, result: {} }]);
    invalidJson.child.stdin.on('data', () => queueMicrotask(() => (invalidJson.child.stdout as PassThrough).write('{broken\n')));
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => invalidJson.child })).rejects.toThrow('malformed NDJSON');
  });

  it('rejects cursor loops instead of returning an incomplete catalog', async () => {
    const fake = fakeChild([
      { id: 1, result: {} },
      { id: 2, result: { data: [], nextCursor: 'again' } },
      { id: 3, result: { data: [], nextCursor: 'again' } },
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).rejects.toThrow('cursor loop');
  });

  it('rejects oversized catalogs and excessive pagination', async () => {
    const tooMany = fakeChild([
      { id: 1, result: {} },
      {
        id: 2,
        result: {
          data: Array.from({ length: 501 }, (_, index) => ({ model: `model-${index}` })),
          nextCursor: null,
        },
      },
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => tooMany.child })).rejects.toThrow('size limit');

    const tooManyPages = fakeChild([
      { id: 1, result: {} },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: index + 2,
        result: { data: [], nextCursor: `page-${index + 2}` },
      })),
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => tooManyPages.child })).rejects.toThrow('page limit');
  });

  it('times out a non-responsive child', async () => {
    const fake = fakeChild();
    await expect(discoverCodexModels({ cwd: '/repo', timeoutMs: 10, spawn: () => fake.child })).rejects.toThrow('timed out');
  });

  it('rejects when the child exits while a request is pending', async () => {
    const fake = fakeChild();
    const discovery = discoverCodexModels({ cwd: '/repo', spawn: () => fake.child });
    queueMicrotask(() => fake.emitExit(7));
    await expect(discovery).rejects.toThrow('exited (7)');
  });

  describe('XEZ_DRY_RUN=1', () => {
    const original = process.env.XEZ_DRY_RUN;
    afterEach(() => {
      if (original === undefined) delete process.env.XEZ_DRY_RUN;
      else process.env.XEZ_DRY_RUN = original;
    });

    it('answers a fixed fixture list without ever spawning the real app-server (#579)', async () => {
      process.env.XEZ_DRY_RUN = '1';
      // A `spawn` that throws if called at all: before this fix, `discoverCodexModels` spawned
      // unconditionally, so this same assertion fails red against the pre-fix code (CI has no
      // `codex` binary and hits exactly this path every dry-run boot).
      const spawn = (): never => {
        throw new Error('discoverCodexModels must not spawn a real process under XEZ_DRY_RUN=1');
      };
      await expect(discoverCodexModels({ cwd: '/repo', spawn })).resolves.toEqual([
        { id: 'mock-codex-model', label: 'Mock Codex model', description: 'mock (XEZ_DRY_RUN=1)' },
      ]);
    });
  });
});

/**
 * #819 item 4 (T4.2): `vision` from Codex's own `inputModalities`, the field a real `model/list`
 * answer carries beside each model (read from a live app-server on 2026-09-21). Named break: a
 * `false` default for a model whose answer has no list — absent must stay absent.
 */
describe('Codex model discovery: vision only where inputModalities proves it (#819)', () => {
  const page = (data: unknown[]) => [
    { id: 1, result: { serverInfo: { name: 'codex-app-server' } } },
    { id: 2, result: { data, nextCursor: null } },
  ];

  it('reads image support from the list, and leaves a model without one unknown', async () => {
    const fake = fakeChild(
      page([
        { model: 'sees', inputModalities: ['text', 'image'] },
        { model: 'text-only', inputModalities: ['text'] },
        { model: 'no-list' },
        { model: 'garbled', inputModalities: 'image' },
      ]),
    );
    const models = await discoverCodexModels({ cwd: '/repo', spawn: () => fake.child });
    expect(models).toEqual([
      { id: 'sees', label: 'sees', description: '', vision: true },
      { id: 'text-only', label: 'text-only', description: '', vision: false },
      { id: 'no-list', label: 'no-list', description: '' },
      { id: 'garbled', label: 'garbled', description: '' },
    ]);
    expect('vision' in (models[2] as object)).toBe(false);
    // A value it cannot read never costs the other models: the page still parses whole.
    expect(models).toHaveLength(4);
  });
});
