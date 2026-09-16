/**
 * AC-08 (cursor and region), AC-09 (no ANSI off a terminal, quiet, the level matrix) and
 * AC-12 (redraw budget, listener and timer release, a closed output).
 *
 * Named breaks proven here: `ansi-in-pipe`, `quiet-hides-failure`, `unbounded-redraw`,
 * `broken-pipe-kills-runs`, `listener-leak`, `cursor-left-hidden`.
 *
 * The stream and the clock are both fakes. That is not a shortcut around a PTY — it is what
 * makes the budget assertion exact: a thousand updates can be pushed through one simulated
 * second and the writes counted, with no sleeping and no flakiness. What a fake stream cannot
 * prove is how a real terminal renders the bytes, and that is what the design review's own
 * captures are for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, TerminalRenderer, REDRAW_INTERVAL_MS, type RendererClock, type RenderStream } from './renderer.ts';
import { UTF8_GLYPHS } from './format.ts';

import type { TerminalEvent } from './event-names.ts';
import type { TaskRow } from './activity.ts';

const ESC = '\u001b';

/** A stream that records what it was handed, and can pretend to be a terminal. */
class FakeStream implements RenderStream {
  chunks: string[] = [];
  isTTY: boolean;
  columns: number;
  destroyed = false;
  writableEnded = false;
  throwOnWrite: Error | undefined;
  readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  constructor(options: { isTTY?: boolean; columns?: number } = {}) {
    this.isTTY = options.isTTY ?? true;
    this.columns = options.columns ?? 80;
  }

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.chunks.push(chunk);
    return true;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(listener);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as () => void)();
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  get text(): string {
    return this.chunks.join('');
  }
}

/** A clock that only moves when a test says so, and fires due timers in order. */
class FakeClock implements RendererClock {
  private current = 1_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].fn();
    }
    this.current = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

function makeRenderer(
  options: {
    stream?: FakeStream;
    clock?: FakeClock;
    mode?: 'rich' | 'lines' | 'plain';
    level?: 'debug' | 'info' | 'warn' | 'error';
    colorEnabled?: boolean;
    columns?: number;
  } = {},
) {
  const stream = options.stream ?? new FakeStream();
  const clock = options.clock ?? new FakeClock();
  const renderer = new TerminalRenderer({
    stream,
    clock,
    mode: options.mode ?? 'rich',
    columns: options.columns ?? stream.columns,
    colorEnabled: options.colorEnabled ?? false,
    level: options.level ?? 'info',
    projectId: 'beta',
    url: 'http://localhost:4322',
    glyphs: UTF8_GLYPHS,
  });
  return { renderer, stream, clock };
}

function info(message: string, event: TerminalEvent = 'task.started') {
  return entry({ level: 'info', subject: 'a12bc345', message, event, fields: [['run', 'a12bc345']] });
}

function row(over: Partial<TaskRow> & Pick<TaskRow, 'id' | 'state'>): TaskRow {
  return { startedAtMs: 0, title: 'A task', step: 'implement', agent: 'Claude Code', ...over };
}

describe('the level filter', () => {
  it('drops everything under the threshold before a line is even built', () => {
    const { renderer } = makeRenderer({ level: 'warn' });
    expect(renderer.log(info('started'))).toBe(false);
    expect(renderer.log(entry({ level: 'warn', subject: 'http', message: '409', event: 'http.refused' }))).toBe(true);
  });

  it('quiet — a warn ceiling — still shows every warning and every error', () => {
    // `quiet-hides-failure`: the one thing quiet may never do.
    const { renderer, stream, clock } = makeRenderer({ level: 'warn' });
    renderer.log(info('started'));
    renderer.log(entry({ level: 'error', subject: 'a12bc345', message: 'failed — agent stopped', event: 'task.failed' }));
    renderer.log(entry({ level: 'warn', subject: 'b98de765', message: 'needs you', event: 'question.asked' }));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.text).toContain('failed — agent stopped');
    expect(stream.text).toContain('needs you');
    expect(stream.text).not.toContain('started');
  });

  it('debug adds the routine lines and nothing is lost at the wider levels', () => {
    const { renderer, stream, clock } = makeRenderer({ level: 'debug' });
    renderer.log(entry({ level: 'debug', subject: 'registry', message: 'remembered port 4322', event: 'registry.port' }));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.text).toContain('remembered port 4322');
  });
});

describe('plain output — AC-09', () => {
  it('carries no escape byte at all, even when colour was asked for', () => {
    const stream = new FakeStream({ isTTY: false });
    const { renderer } = makeRenderer({ stream, mode: 'plain', colorEnabled: true });
    renderer.log(info('started — implement · Codex'));
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    renderer.stop();
    expect(stream.text).not.toMatch(/[\u001b\u009b]/);
  });

  it('is one event per line, in logfmt, with the project on every line', () => {
    const stream = new FakeStream({ isTTY: false });
    const { renderer } = makeRenderer({ stream, mode: 'plain' });
    renderer.log(
      entry({
        level: 'error',
        subject: 'a12bc345',
        message: 'check unit-tests failed',
        event: 'gate.failed',
        fields: [
          ['run', 'a12bc345'],
          ['step', 'unit-tests'],
          ['exit', 1],
        ],
      }),
    );
    const lines = stream.text.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=error project=beta event=gate\.failed run=a12bc345 step=unit-tests exit=1$/,
    );
  });

  it('prefers the entry owner over the renderer boot project', () => {
    const stream = new FakeStream({ isTTY: false });
    const { renderer } = makeRenderer({ stream, mode: 'plain' });
    renderer.log(
      entry({
        level: 'error',
        projectId: 'later',
        subject: 'a12bc345',
        message: 'failed',
        event: 'task.failed',
      }),
    );
    expect(stream.text).toContain('project=later');
    expect(stream.text).not.toContain('project=beta');
  });

  it('sanitizes the entry owner before it reaches plain output', () => {
    const stream = new FakeStream({ isTTY: false });
    const { renderer } = makeRenderer({ stream, mode: 'plain' });
    const projectId = ['later', String.fromCharCode(27), '[2J', '\nforged'].join('');
    renderer.log(entry({ level: 'error', projectId, subject: 'a12bc345', message: 'failed', event: 'task.failed' }));
    expect(stream.text).not.toMatch(/[\u001b\u009b]/);
    expect(stream.text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('draws no live region — there is nothing to redraw in a file', () => {
    const stream = new FakeStream({ isTTY: false });
    const { renderer } = makeRenderer({ stream, mode: 'plain' });
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    renderer.log(info('started'));
    expect(renderer.hasRegion).toBe(false);
    expect(stream.text).not.toContain('active tasks');
  });
});

describe('lines output in a file', () => {
  it('writes human lines with no cursor movement and no region', () => {
    const stream = new FakeStream({ isTTY: false });
    const { renderer } = makeRenderer({ stream, mode: 'lines' });
    renderer.log(info('started — implement · Codex'));
    expect(renderer.hasRegion).toBe(false);
    expect(stream.text).toContain('started — implement · Codex');
    expect(stream.text).not.toContain(`${ESC}[`);
  });
});

describe('the live region — AC-08', () => {
  it('hides the cursor on the first draw and shows it again on stop', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.log(info('started'));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.text).toContain(`${ESC}[?25l`);
    renderer.stop();
    expect(stream.text.endsWith(`${ESC}[?25h`)).toBe(true);
  });

  it('erases exactly its own lines and never touches scrollback', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.setRow(row({ id: 'a12bc345', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    const firstRegionLines = (stream.chunks.join('').match(/\n/g) ?? []).length;
    stream.chunks = [];
    renderer.setRow(row({ id: 'b98de765', state: 'queued' }));
    clock.advance(REDRAW_INTERVAL_MS);
    // The cursor moves up by the number of lines the PREVIOUS region occupied, then clears to
    // the end of the screen. Never a full clear (`ESC[2J`), never the alternate screen.
    expect(stream.text).toMatch(new RegExp(`\\${ESC}\\[${firstRegionLines}A\\${ESC}\\[0J`));
    expect(stream.text).not.toContain(`${ESC}[2J`);
    expect(stream.text).not.toContain(`${ESC}[?1049h`);
  });

  it('puts a durable line above the region, never inside it', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.setRow(row({ id: 'a12bc345', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    stream.chunks = [];
    renderer.log(info('done — 2m 09s'));
    clock.advance(REDRAW_INTERVAL_MS);
    const written = stream.text;
    expect(written.indexOf('done — 2m 09s')).toBeLessThan(written.indexOf('active tasks'));
  });

  it('is one write per redraw, so a terminal never shows a half-erased table', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    renderer.log(info('started'));
    stream.chunks = [];
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.chunks).toHaveLength(1);
  });

  it('shows the empty state rather than nothing', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.log(info('started'));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.text).toContain('No active tasks');
  });
});

describe('the redraw budget — AC-12', () => {
  it('holds at four redraws a second under a thousand updates a second', () => {
    // `unbounded-redraw`: the named break. Ten simulated seconds, 1000 row updates each.
    const { renderer, stream, clock } = makeRenderer();
    for (let second = 0; second < 10; second++) {
      for (let i = 0; i < 1000; i++) {
        renderer.setRow(row({ id: `id${i % 7}`, state: i % 2 === 0 ? 'running' : 'queued' }));
        clock.advance(1);
      }
    }
    clock.advance(REDRAW_INTERVAL_MS);
    // 10 seconds x 4 = 40, plus the trailing flush.
    expect(stream.chunks.length).toBeLessThanOrEqual(41);
    expect(stream.chunks.length).toBeGreaterThan(1);
  });

  it('keeps every error line through that burst', () => {
    const { renderer, stream, clock } = makeRenderer();
    for (let i = 0; i < 500; i++) {
      renderer.log(info(`routine ${i}`));
      clock.advance(1);
    }
    renderer.log(entry({ level: 'error', subject: 'a1', message: 'the one failure', event: 'task.failed' }));
    clock.advance(REDRAW_INTERVAL_MS * 2);
    expect(stream.text).toContain('the one failure');
  });

  it('draws nothing when nothing changed', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    stream.chunks = [];
    // The same row again: identical state, so there is nothing to show.
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.chunks).toHaveLength(0);
  });
});

describe('burst folding', () => {
  it('folds info above twenty a second into one count line', () => {
    const { renderer, stream, clock } = makeRenderer();
    for (let i = 0; i < 100; i++) renderer.log(info(`line ${i}`));
    clock.advance(1000);
    clock.advance(REDRAW_INTERVAL_MS);
    expect(stream.text).toContain('80 more info lines in the last second were folded');
    expect(stream.text).toContain('line 19');
    expect(stream.text).not.toContain('line 99');
  });

  it('never folds a warning or an error, at any rate', () => {
    const { renderer, stream, clock } = makeRenderer();
    for (let i = 0; i < 100; i++) {
      renderer.log(entry({ level: 'error', subject: 'a1', message: `failure ${i}`, event: 'task.failed' }));
    }
    clock.advance(REDRAW_INTERVAL_MS);
    for (let i = 0; i < 100; i++) expect(stream.text, `failure ${i}`).toContain(`failure ${i}`);
  });

  it('prints the count line even when the burst is the last thing that happens', () => {
    const { renderer, stream, clock } = makeRenderer();
    for (let i = 0; i < 40; i++) renderer.log(info(`line ${i}`));
    clock.advance(1000 + REDRAW_INTERVAL_MS);
    expect(stream.text).toContain('20 more info lines in the last second were folded');
  });
});

describe('a closed output — AC-12', () => {
  it('stops drawing and never throws when the stream throws EPIPE', () => {
    // `broken-pipe-kills-runs`: the service and its tasks must be untouched.
    const { renderer, stream, clock } = makeRenderer();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    stream.throwOnWrite = epipe;
    expect(() => {
      renderer.log(info('started'));
      clock.advance(REDRAW_INTERVAL_MS);
    }).not.toThrow();
    expect(renderer.isStopped).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('stops drawing when the stream reports itself destroyed', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.log(info('started'));
    clock.advance(REDRAW_INTERVAL_MS);
    stream.destroyed = true;
    renderer.log(info('again'));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(renderer.isStopped).toBe(true);
  });

  it('detaches on the stream’s own error event', () => {
    const { renderer, stream } = makeRenderer();
    renderer.attachProcess();
    stream.emit('error');
    expect(renderer.isStopped).toBe(true);
    expect(stream.listenerCount).toBe(0);
  });
});

describe('listener and timer release — AC-12', () => {
  it('releases every stream and process listener it added', () => {
    // `listener-leak`: a suite builds dozens of these, and a leaked SIGINT-era listener is how
    // a shutdown later runs a handler belonging to a renderer that stopped an hour ago.
    const before = process.listenerCount('exit');
    const { renderer, stream } = makeRenderer();
    renderer.attachProcess();
    expect(stream.listenerCount).toBe(2);
    expect(process.listenerCount('exit')).toBe(before + 1);
    renderer.stop();
    expect(stream.listenerCount).toBe(0);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('releases every timer', () => {
    const { renderer, clock } = makeRenderer();
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    expect(clock.pending).toBeGreaterThan(0);
    renderer.stop();
    expect(clock.pending).toBe(0);
  });

  it('is safe to stop twice — a second Ctrl-C does exactly that', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.attachProcess();
    renderer.log(info('started'));
    clock.advance(REDRAW_INTERVAL_MS);
    renderer.stop();
    const after = stream.text;
    expect(() => renderer.stop()).not.toThrow();
    expect(stream.text).toBe(after);
  });

  it('repeated create-and-stop leaves the listener counts where they started', () => {
    const before = process.listenerCount('exit');
    for (let i = 0; i < 20; i++) {
      const { renderer } = makeRenderer();
      renderer.attachProcess();
      renderer.log(info('started'));
      renderer.stop();
    }
    expect(process.listenerCount('exit')).toBe(before);
  });
});

describe('resize', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('is debounced, then redraws at the new width', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.attachProcess();
    renderer.setRow(row({ id: 'a12bc345', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    stream.chunks = [];
    stream.columns = 40;
    stream.emit('resize');
    expect(stream.chunks).toHaveLength(0);
    clock.advance(100);
    expect(renderer.currentColumns).toBe(40);
    for (const line of stream.text.split('\n')) {
      expect(line.replace(/\u001b\[[\d?]*[A-Za-z]/g, '').length).toBeLessThanOrEqual(40);
    }
  });

  it('ignores a resize event that did not change the width', () => {
    const { renderer, stream, clock } = makeRenderer();
    renderer.attachProcess();
    renderer.setRow(row({ id: 'a1', state: 'running' }));
    clock.advance(REDRAW_INTERVAL_MS);
    stream.chunks = [];
    stream.emit('resize');
    clock.advance(100 + REDRAW_INTERVAL_MS);
    expect(stream.chunks).toHaveLength(0);
  });
});

describe('the failed count', () => {
  it('moves only when a caller says a TASK outcome failed', () => {
    const { renderer } = makeRenderer();
    expect(renderer.failedCount).toBe(0);
    renderer.countFailedTask();
    expect(renderer.failedCount).toBe(1);
  });
});
