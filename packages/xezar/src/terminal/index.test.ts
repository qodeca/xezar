/**
 * The one call `serve` makes (#467, PR 3): what reaches the stream, and what does not.
 *
 * The suites beside this one test each part on its own. This one tests the wiring — the three
 * places where a fact belongs to one surface and must NOT appear on the other:
 *
 * - `xezar.ready` is the machine record of the boot. A log file that captured only stderr would
 *   otherwise have no record of the port at all, while a person on a terminal already has it on
 *   the banner and does not want it twice (`designs/cli-terminal/README.md` § 10.2, row 1).
 * - the fallback notice is printed **once**, before anything else, and only when an explicit
 *   `rich` really was refused.
 * - the session summary is a human block on a terminal and one logfmt line off it, and under
 *   `--quiet` the block goes while the failure counts do not (`quiet-hides-failure`).
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { startTerminalActivity } from './index.ts';
import { UTF8_GLYPHS } from './format.ts';
import { entry } from './renderer.ts';

import type { ResolvedCliSettings } from '../cli-settings.ts';
import type { RunStore } from '../runs/store.ts';
import type { RenderStream } from './renderer.ts';

class FakeStream extends EventEmitter {
  chunks: string[] = [];
  isTTY: boolean | undefined;
  columns: number | undefined;

  constructor(tty?: { columns: number }) {
    super();
    if (tty) {
      this.isTTY = true;
      this.columns = tty.columns;
    }
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join('');
  }

  lines(): string[] {
    return this.text.split('\n').filter((line) => line.trim() !== '');
  }
}

/** A store with the four members the activity source touches, and no files behind it. */
class FakeStore extends EventEmitter {
  listRuns(): [] {
    return [];
  }
  getRun(): undefined {
    return undefined;
  }
  get asStore(): RunStore {
    return this as unknown as RunStore;
  }
}

function settings(over: Partial<ResolvedCliSettings> = {}): ResolvedCliSettings {
  return {
    port: { value: 4321, ephemeral: false, source: 'default' },
    output: 'auto',
    color: 'auto',
    colorEnabled: false,
    logLevel: 'info',
    quiet: false,
    effectiveLogLevel: 'info',
    warnings: [],
    ...over,
  } as ResolvedCliSettings;
}

function start(stream: FakeStream, over: Partial<ResolvedCliSettings> = {}) {
  return startTerminalActivity({
    settings: settings(over),
    store: new FakeStore().asStore,
    projectId: 'beta',
    stream: stream as unknown as RenderStream & { isTTY?: boolean; columns?: number },
    env: {},
    glyphs: UTF8_GLYPHS,
  });
}

describe('the boot event', () => {
  it('records the port in plain output, where the banner is not on this stream', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.setUrl('http://localhost:4321', { port: 4321, requestedPort: 4321 });

    const ready = stream.lines().find((line) => line.includes('event=xezar.ready'));
    expect(ready).toBeDefined();
    expect(ready).toContain('url=http://localhost:4321');
    expect(ready).toContain('port=4321');
    // The port was the one that was asked for, so there is nothing to explain.
    expect(ready).not.toContain('start=');
    expect(ready).not.toContain('reason=');
  });

  it('says which port was asked for, and why it moved, when it moved', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.setUrl('http://localhost:4323', { port: 4323, requestedPort: 4322, reason: 'busy' });

    const ready = stream.lines().find((line) => line.includes('event=xezar.ready'));
    expect(ready).toContain('port=4323');
    expect(ready).toContain('start=4322');
    expect(ready).toContain('reason=busy');
  });

  it('says nothing on a terminal, where the banner already said it', () => {
    const stream = new FakeStream({ columns: 100 });
    const terminal = start(stream);
    terminal.setUrl('http://localhost:4321', { port: 4321 });

    expect(stream.text).not.toContain('xezar.ready');
    // And the URL still reached the live region, which is what it was handed over for.
    expect(terminal.renderer.hasRegion).toBe(true);
  });

  it('reports no start port for --port 0, because none was asked for', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.setUrl('http://localhost:53122', { port: 53122, requestedPort: 0 });

    const ready = stream.lines().find((line) => line.includes('event=xezar.ready'));
    expect(ready).toContain('port=53122');
    // `start=0` would read as a port. "Any free port" is not a port that was asked for.
    expect(ready).not.toContain('start=');
    expect(ready).not.toContain('reason=');
  });

  it('says nothing at all when the caller has no boot facts to give', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.setUrl('http://localhost:4321');
    expect(stream.text).not.toContain('xezar.ready');
  });
});

describe('the fallback notice', () => {
  it('is printed once, and only when an explicit rich was refused', () => {
    const stream = new FakeStream();
    start(stream, { output: 'rich' });
    const notices = stream.lines().filter((line) => line.includes('event=output.fallback'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('asked=rich');
    expect(notices[0]).toContain('using=plain');
  });

  it('is absent when nothing was refused', () => {
    const stream = new FakeStream();
    start(stream, { output: 'auto' });
    expect(stream.text).not.toContain('output.fallback');
  });
});

describe('stopping', () => {
  it('off a terminal, the summary is one logfmt line and no block', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.stop({ stillRunning: 2, projectName: 'beta' });

    const summary = stream.lines().filter((line) => line.includes('event=session.summary'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('still_running=2');
    expect(stream.text).not.toContain('Session summary');
  });

  it('under quiet the block goes, and so does the info line — nothing is invented', () => {
    // `quiet-hides-failure` in the other direction: quiet may drop information, and the counts
    // here ARE information. What it may never drop is a warning or an error, which the level
    // filter proves in `renderer.test.ts`.
    const stream = new FakeStream({ columns: 100 });
    const terminal = start(stream, { quiet: true, effectiveLogLevel: 'warn' });
    terminal.stop({ stillRunning: 0, projectName: 'beta' });

    expect(stream.text).not.toContain('Session summary');
    expect(stream.text).not.toContain('session.summary');
  });

  it('on a terminal the block is printed and the cursor is given back', () => {
    const stream = new FakeStream({ columns: 100 });
    const terminal = start(stream);
    terminal.log(entry({ level: 'info', subject: 'mcp', message: 'ready', event: 'mcp.ready' }));
    terminal.stop({ stillRunning: 0, projectName: 'beta' });

    expect(stream.text).toContain('Session summary');
    expect(stream.text).toContain('xezar stopped for beta.');
    expect(stream.text).toContain('\u001b[?25h');
    expect(terminal.renderer.isStopped).toBe(true);
  });
});
