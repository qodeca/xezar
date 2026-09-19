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
import type { ContextDisposal, ProjectContexts, ProjectContext } from '../server/project-context.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
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

function withoutAnsi(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
}

/** A store with the four members the activity source touches, and no files behind it. */
class FakeStore extends EventEmitter {
  records: RunRecord[] = [];
  listRuns(): RunRecord[] {
    return this.records;
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

function start(
  stream: FakeStream,
  over: Partial<ResolvedCliSettings> = {},
  display = true,
) {
  const terminal = startTerminalActivity({
    settings: settings(over),
    store: new FakeStore().asStore,
    projectId: 'beta',
    stream: stream as unknown as RenderStream & { isTTY?: boolean; columns?: number },
    env: {},
    glyphs: UTF8_GLYPHS,
  });
  if (display) terminal.startDisplay();
  return terminal;
}

describe('the boot event', () => {
  it('renders historical settlement exactly at 80 and 40 columns', () => {
    const wideStream = new FakeStream({ columns: 80 });
    const wide = start(wideStream, {}, false);
    wide.reportRecovery(13, 13);
    wide.startDisplay();
    wide.stop({ stillRunning: 0 });
    expect(withoutAnsi(wideStream.lines())).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^  \d{2}:\d{2}:\d{2}  info   xezar     13 tasks from the previous session$/),
      ]),
    );
    expect(wideStream.lines()).toContain('                             were settled at start-up');
    expect(wideStream.text.indexOf('13 tasks from the previous session')).toBeLessThan(
      wideStream.text.indexOf('No active tasks'),
    );

    const narrowStream = new FakeStream({ columns: 40 });
    const narrow = start(narrowStream, {}, false);
    narrow.reportRecovery(13, 13);
    narrow.startDisplay();
    narrow.stop({ stillRunning: 0 });
    expect(withoutAnsi(narrowStream.lines())).toEqual(
      expect.arrayContaining([expect.stringMatching(/^  \d{2}:\d{2}:\d{2} info  xezar$/)]),
    );
    expect(narrowStream.lines()).toContain('    13 tasks from the previous session');
    expect(narrowStream.lines()).toContain('    were settled at start-up');
    expect(narrowStream.lines().every((line) => line.length <= 40)).toBe(true);
    expect(narrowStream.text.indexOf('13 tasks from the previous session')).toBeLessThan(
      narrowStream.text.indexOf('No active tasks'),
    );
  });

  it('holds the notice until startDisplay, so it cannot land above the stdout banner (#556, B-1)', () => {
    // `serve` prints the stdout banner between `reportRecovery()` (right after recovery) and
    // `startDisplay()` (once the banner is done) — see index.ts. This stream only carries the
    // terminal's own (stderr) writes, so the banner itself is not modeled here; what is pinned
    // is that reportRecovery writes NOTHING until startDisplay runs, which is what stops the
    // notice from racing the banner onto the screen and landing above it.
    const stream = new FakeStream({ columns: 80 });
    const terminal = start(stream, {}, false);
    terminal.reportRecovery(13, 13);
    expect(stream.text).toBe('');
    terminal.startDisplay();
    expect(stream.text).toContain('13 tasks from the previous session');
    terminal.stop({ stillRunning: 0 });
  });

  it('writes one plain recovery row before ready with only the accepted fields', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.reportRecovery(13, 13);
    terminal.setUrl('http://localhost:4321', { port: 4321 });

    const recovery = stream.lines().filter((line) => line.includes('event=task.recovered'));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatch(
      /^\S+ level=info project=beta event=task\.recovered count=13 settled=13$/,
    );
    expect(stream.text.indexOf('event=task.recovered')).toBeLessThan(
      stream.text.indexOf('event=xezar.ready'),
    );
    expect(stream.text).not.toContain('\u001b');
    terminal.stop({ stillRunning: 0 });
  });

  it('uses singular settlement copy and keeps historical outcomes out of the session totals', () => {
    const stream = new FakeStream({ columns: 80 });
    const terminal = start(stream);
    terminal.reportRecovery(3, 1);
    terminal.stop({ stillRunning: 0 });

    expect(stream.text).toContain('1 task from the previous session');
    expect(stream.text).toContain('was settled at start-up');
    expect(stream.text).toContain('0 done · 0 needs review · 0 failed · 0 cancelled');
  });

  it('omits an empty recovery and hides recovery information under quiet', () => {
    const ordinaryStream = new FakeStream();
    const ordinary = start(ordinaryStream);
    ordinary.reportRecovery(0, 0);
    expect(ordinaryStream.text).not.toContain('task.recovered');
    ordinary.stop({ stillRunning: 0 });

    const quietStream = new FakeStream({ columns: 80 });
    const quiet = start(quietStream, { quiet: true, effectiveLogLevel: 'warn' });
    quiet.reportRecovery(2, 2);
    expect(quietStream.text).not.toContain('previous session');
    expect(quietStream.text).not.toContain('task.recovered');
    quiet.stop({ stillRunning: 0 });
  });

  it('keeps the existing recovered copy when no task was settled at start-up', () => {
    const stream = new FakeStream({ columns: 80 });
    const terminal = start(stream);
    terminal.reportRecovery(2, 0);
    terminal.stop({ stillRunning: 0 });
    expect(stream.text).toContain('recovered 2 tasks from the previous session');
    expect(stream.text).not.toContain('settled at start-up');
  });

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
    expect(stream.text.indexOf('event=xezar.stopping')).toBeGreaterThanOrEqual(0);
    expect(stream.text.indexOf('event=xezar.stopping')).toBeLessThan(stream.text.indexOf('event=session.summary'));
    expect(stream.text.indexOf('event=xezar.stopped')).toBeGreaterThan(stream.text.indexOf('event=session.summary'));
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

class FakeContexts extends EventEmitter {
  existing = new Map<string, ProjectContext>();
  ids() { return [...this.existing.keys()]; }
  peek(id: string) { return this.existing.get(id); }
  // The REAL hook signatures (#647), not a convenient subset: this fake is handed over as
  // `as unknown as ProjectContexts`, so it compiles however wrong it is, and a fake that does not
  // publish the generation and the disposal payload would let the terminal's guards be tested
  // against a contract nothing else speaks.
  onStoreCreated(fn: (store: RunStore, id: string, generation: number) => void) { this.on('store', fn); return () => this.off('store', fn); }
  onContextBuilt(fn: (ctx: ProjectContext) => void) { this.on('built', fn); return () => this.off('built', fn); }
  onContextDisposed(fn: (id: string, disposal: ContextDisposal) => void) { this.on('disposed', fn); return () => this.off('disposed', fn); }
}
function liveRecord(): RunRecord {
  return { id: 'recovered', title: 'A task', status: 'running', createdAt: new Date().toISOString(), tokensUsed: 0, steps: [] } as unknown as RunRecord;
}
it('recovery-replayed-for-later-projects: suppresses recovery until that context is published', () => {
  const stream = new FakeStream();
  const terminal = start(stream);
  const contexts = new FakeContexts();
  terminal.onContexts(contexts as unknown as ProjectContexts);
  terminal.endRecovery();
  const store = new FakeStore();
  const run = liveRecord();
  store.records = [run];
  contexts.emit('store', store.asStore, 'later', 0);
  store.emit('run', { ...run, status: 'failed', error: 'interrupted' });
  store.emit('run', run);
  expect(stream.text).not.toContain('task.failed');
  expect(stream.text).not.toContain('reason=interrupted');
  expect(terminal.renderer.failedCount).toBe(0);
  contexts.emit('built', { id: 'later', store: store.asStore, generation: 0 });
  store.emit('run', { ...run, status: 'failed', error: 'real failure' });
  const failure = stream.lines().find((line) => line.includes('event=task.failed'));
  expect(failure).toContain('project=later');
  expect(failure).not.toContain('project=beta');
  expect(terminal.renderer.failedCount).toBe(1);
  terminal.stop();
  expect(stream.text).toContain('failed=1');
  expect(store.listenerCount('run')).toBe(0);
  expect(contexts.listenerCount('built')).toBe(0);
});
it('attaches to contexts already published before the callback', () => {
  const stream = new FakeStream();
  const terminal = start(stream);
  const contexts = new FakeContexts();
  const store = new FakeStore();
  store.records = [liveRecord()];
  contexts.existing.set('existing', { id: 'existing', store: store.asStore, generation: 0 } as ProjectContext);
  terminal.onContexts(contexts as unknown as ProjectContexts);
  expect(terminal.renderer.activeRows).toHaveLength(1);
  store.emit('run', { ...liveRecord(), status: 'failed' });
  expect(terminal.renderer.failedCount).toBe(1);
  terminal.stop();
});
/**
 * RP-4 (#647), first case — `terminal-delete-on-stale-generation`.
 *
 * `dispose()` drops the context from the map synchronously but notifies only after the teardown
 * has finished, so the same project can be re-added and REBUILT before the notification lands.
 * Keyed on the id alone, the terminal then released the LIVE project's source on behalf of the
 * dead registration, and nothing re-attached it: its rows vanished for the rest of the session.
 *
 * The first dispose in this test is the AC-8 half, and it is not decoration: a project's FIRST
 * removal carries `generation: 0`, a real registration and not an absent one, and a guard that
 * read it as "no generation" would make every first removal a no-op.
 */
it('keeps a rebuilt project\'s source when the dispose names the registration it replaced', () => {
  const stream = new FakeStream();
  const terminal = start(stream);
  const contexts = new FakeContexts();
  terminal.onContexts(contexts as unknown as ProjectContexts);
  terminal.endRecovery();

  const first = new FakeStore();
  contexts.emit('store', first.asStore, 'later', 0);
  expect(first.listenerCount('run')).toBe(1);

  // A FIRST dispose, generation 0 with no prior entry in `generations` — it must still release.
  contexts.emit('disposed', 'later', { generation: 0, superseded: false });
  expect(first.listenerCount('run')).toBe(0);

  // The re-added project's own build opens its store and publishes.
  const rebuilt = new FakeStore();
  contexts.emit('store', rebuilt.asStore, 'later', 1);
  contexts.emit('built', { id: 'later', store: rebuilt.asStore, generation: 1 });

  // The late dispose of generation 0, arriving after all of that: it names a registration this
  // source does not belong to, so it must change nothing.
  contexts.emit('disposed', 'later', { generation: 0, superseded: true });

  expect(rebuilt.listenerCount('run')).toBe(1);
  rebuilt.emit('run', { ...liveRecord(), status: 'failed', error: 'after the late dispose' });
  expect(terminal.renderer.failedCount).toBe(1);
  expect(stream.text).toContain('project=later');
  terminal.stop();
});

/**
 * RP-4 (#647), second case — `terminal-attach-accepts-older-generation`.
 *
 * The pre-existing clobber on the BUILD side, older than the dispose payload: `onStoreCreated`
 * fires as a store opens, which is before its build knows whether it won, so a superseded build
 * can announce its store after the build that replaced it has already published. Replacing
 * unconditionally handed the live project's rows to a store that is about to be torn down.
 */
it('refuses a store announced by a build an earlier registration already lost', () => {
  const stream = new FakeStream();
  const terminal = start(stream);
  const contexts = new FakeContexts();
  terminal.onContexts(contexts as unknown as ProjectContexts);
  terminal.endRecovery();

  const winner = new FakeStore();
  contexts.emit('store', winner.asStore, 'later', 1);
  contexts.emit('built', { id: 'later', store: winner.asStore, generation: 1 });

  const loser = new FakeStore();
  contexts.emit('store', loser.asStore, 'later', 0);

  expect(loser.listenerCount('run')).toBe(0);
  expect(winner.listenerCount('run')).toBe(1);
  winner.emit('run', { ...liveRecord(), status: 'failed', error: 'still the live source' });
  expect(terminal.renderer.failedCount).toBe(1);
  terminal.stop();
});

it('quiet never creates a live region, including after resize and seeded rows', () => {
  const stream = new FakeStream({ columns: 80 });
  const terminal = start(stream, { quiet: true, effectiveLogLevel: 'warn' });
  terminal.renderer.setRow({ id: 'a', state: 'running', title: 'A task', startedAtMs: Date.now() });
  terminal.renderer.setMode('rich', 100);
  terminal.log(entry({ level: 'error', subject: 'a', message: 'failed', event: 'task.failed' }));
  terminal.stop();
  expect(stream.text).toContain('failed');
  expect(stream.text).not.toMatch(/active tasks|Session summary|\u001b\[[0-9;?]*[AHJhl]/);
});

it('uses a singular pronoun when one task remains at shutdown', () => {
  const stream = new FakeStream({ columns: 160 });
  const terminal = start(stream);
  terminal.stop({ stillRunning: 1 });
  expect(stream.text).toContain('1 task was still running. xezar picks it up on the next start.');
});

describe('MCP journal rows (#467, PR 4)', () => {
  const stalled = {
    eventId: 'beta:3',
    journalSeq: 3,
    ts: '2026-09-16T12:04:09.000Z',
    projectId: 'beta',
    category: 'E-01',
    kind: 'task.stalled',
    subject: { type: 'run', id: 'a12bc345-0000', version: null },
    origin: 'system',
    causedBy: null,
    summary: 'task may be stalled: step implement has used 80% of its time limit (advisory — the task is still running and nothing was stopped)',
  } as const;

  it('prints a stall advisory the journal wrote, with the task link once the cockpit listens', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.setUrl('http://localhost:4321', { port: 4321 });
    terminal.onEventRow({ ...stalled });
    const line = stream.lines().find((l) => l.includes('event=task.stalled'));
    expect(line).toBeDefined();
    expect(line).toContain('level=warn');
    expect(line).toContain('project=beta');
    expect(line).toContain('run=a12bc345');
  });

  it('prints nothing for a row the store bridge owns, and nothing after stop', () => {
    const stream = new FakeStream();
    const terminal = start(stream);
    terminal.onEventRow({ ...stalled, kind: 'task.done', summary: 'task finished: done, no reviewer verdict recorded' });
    expect(stream.text).not.toContain('event=task.done');
    terminal.stop();
    const before = stream.text;
    terminal.onEventRow({ ...stalled });
    expect(stream.text).toBe(before);
  });
});
