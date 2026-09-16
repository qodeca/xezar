/**
 * The bounded, read-only terminal renderer (#467, PR 3;
 * `designs/cli-terminal/README.md` § 10.4 "Renderer and redraw budget").
 *
 * Everything the cockpit's service prints while it runs goes through one of these. It owns four
 * things and deliberately nothing else:
 *
 * 1. **A level and quiet filter.** A line under the threshold is never built, let alone written.
 * 2. **Two kinds of line.** Durable lines are written once and never touched again — they are
 *    the person's scrollback and the terminal owns them. The live region (at most 14 lines) is
 *    the only thing ever redrawn.
 * 3. **A redraw budget.** At most 4 redraws a second, merged inside a 250 ms window, and only
 *    when something changed. Nothing changed, nothing drawn.
 * 4. **Its own teardown.** Timers, listeners and the cursor are released on stop, on SIGINT, on
 *    SIGTERM and on a closed output.
 *
 * Three things it must never do, each learned from a terminal UI that did:
 *
 * - **Never clear scrollback, never use the alternate screen.** A person scrolls back to read
 *   the error they just saw. A redraw moves the cursor up over its OWN region and clears from
 *   there to the end of the screen; it cannot reach a line above the region.
 * - **Never let a region line wrap.** Every region line is cut to the terminal's width before
 *   it is painted. A line one column too wide wraps, the next redraw's cursor-up count is then
 *   short by one, and each redraw after that eats a line of real scrollback.
 * - **Never take the service down with it.** A closed stderr (`| head`, a terminal that went
 *   away) detaches the renderer and nothing else. Tasks are not cancelled; the cockpit keeps
 *   serving. Nothing can be printed, so nothing is.
 *
 * The clock is injected so the budget is testable without waiting: a fake clock can push a
 * thousand updates through a simulated second and count the writes (AC-12).
 */

import {
  formatRegion,
  formatStackedEntry,
  formatWideEntry,
  passesLevel,
  sortTaskRows,
  STACKED_COLUMNS,
  tableLayout,
  type ActivityEntry,
  type ActivityLevel,
  type TaskRow,
} from './activity.ts';
import { formatIsoTime, formatLocalTime, glyphsFor, type Glyphs } from './format.ts';
import { logfmt, type LogfmtValue } from './logfmt.ts';
import { createPainter, paintLine, type Painter } from './paint.ts';
import { sanitizeText } from './sanitize.ts';

import type { RenderMode } from './mode.ts';

/** Move the cursor up `n` lines. */
const cursorUp = (n: number) => `\u001b[${n}A`;
/** Clear from the cursor to the end of the screen — the region and nothing above it. */
const CLEAR_BELOW = '\u001b[0J';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/** At most four redraws a second (§ 10.4). */
export const REDRAW_INTERVAL_MS = 250;
/** How often the Time column ticks while a visible row is under an hour. */
const TICK_FAST_MS = 1_000;
/** …and once a task passes an hour, when the minute is all that moves. */
const TICK_SLOW_MS = 15_000;
/** Info and debug lines above this many in one second are folded into a count (§ 10.4). */
export const FOLD_LIMIT_HUMAN = 20;
export const FOLD_LIMIT_PLAIN = 200;
/** A resize is debounced this long so a drag does not redraw at every intermediate width. */
export const RESIZE_DEBOUNCE_MS = 100;

/** The bits of a writable stream the renderer needs. Narrow on purpose, so a test can fake it. */
export interface RenderStream {
  write(chunk: string): boolean;
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  on?(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
}

/** Injected so the redraw budget and the tick are testable without real time passing. */
export interface RendererClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_CLOCK: RendererClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A renderer timer must never be the reason a CLI stays alive: `xez run` finishes when its
    // work finishes, not when a redraw is due.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface RendererOptions {
  stream: RenderStream;
  mode: RenderMode;
  columns: number;
  colorEnabled: boolean;
  /** `ResolvedCliSettings.effectiveLogLevel` — quiet already folded in. */
  level: ActivityLevel;
  /** The project this terminal belongs to. On every plain line, so logs can be merged. */
  projectId?: string;
  /** The cockpit URL, for the empty state and the overflow line. */
  url?: string;
  glyphs?: Glyphs;
  clock?: RendererClock;
  /** Disable decoration during boot or for quiet output. */
  liveRegion?: boolean;
}

/**
 * One terminal's worth of output. Built once per `serve`; `xez run` builds one too, for the
 * activity lines that go beside its transcript.
 */
export class TerminalRenderer {
  private readonly stream: RenderStream;
  private readonly clock: RendererClock;
  private readonly level: ActivityLevel;
  private readonly projectId: string | undefined;
  private readonly painter: Painter;
  private glyphs: Glyphs;
  private mode: RenderMode;
  private columns: number;
  private url: string | undefined;

  /** How many lines the live region occupied at the last write. 0 = nothing to erase. */
  private regionLines = 0;
  private liveRegion: boolean;
  /** Durable lines built since the last write, waiting for the next one. */
  private pending: string[] = [];
  private rows = new Map<string, TaskRow>();
  private failedSinceStart = 0;

  private stopped = false;
  private cursorHidden = false;
  private redrawTimer: unknown;
  private tickTimer: unknown;
  private resizeTimer: unknown;
  private lastDrawMs = 0;
  private regionDirty = false;

  /** Burst folding: the second currently being counted, and what it has swallowed. */
  private foldWindowStart = 0;
  private foldShown = 0;
  private foldSwallowed = 0;
  private foldTimer: unknown;

  /** Every listener this renderer added, with the exact removal for it. */
  private readonly detachers: Array<() => void> = [];

  /** Test seam and AC-12 evidence: how many times `write()` was really called. */
  public writes = 0;

  constructor(options: RendererOptions) {
    this.stream = options.stream;
    this.liveRegion = options.liveRegion ?? true;
    this.clock = options.clock ?? REAL_CLOCK;
    this.mode = options.mode;
    this.columns = options.columns;
    this.level = options.level;
    this.projectId = options.projectId;
    this.url = options.url;
    this.glyphs = options.glyphs ?? glyphsFor();
    this.painter = createPainter(options.colorEnabled);
    this.foldWindowStart = this.clock.now();
  }

  /**
   * Does this renderer keep a live region?
   *
   * `rich` always does. `lines` does on a terminal (a one-line summary) and does not in a file —
   * that is what makes `--output lines` the screen-reader and log-file answer. `plain` never
   * does: not one cursor movement, not one escape byte, even when `rich` was asked for.
   */
  get hasRegion(): boolean {
    if (this.stopped || !this.liveRegion) return false;
    if (this.mode === 'plain') return false;
    return this.stream.isTTY === true;
  }

  /** Enable the region only after the stdout banner is complete. */
  startDisplay(): void {
    this.liveRegion = true;
    this.markRegionDirty();
  }

  /** The cockpit URL, once the bind has really happened. */
  setUrl(url: string): void {
    this.url = url;
  }

  // ---- activity -------------------------------------------------------------

  /**
   * Record one thing that happened.
   *
   * Returns true when the entry produced output. A caller never needs the answer; the tests do,
   * because "the level filter dropped it" and "the burst fold swallowed it" are different facts
   * and a renderer that reported them the same way would hide a lost error.
   */
  log(entry: ActivityEntry): boolean {
    if (this.stopped) return false;
    if (!passesLevel(entry.level, this.level)) return false;
    if (this.shouldFold(entry)) return false;
    this.pending.push(...this.renderEntry(entry));
    this.scheduleDraw();
    return true;
  }

  /**
   * Write lines that are not activity entries — the session summary, a banner the renderer owns.
   * They go through the same region-aware path, so the summary never lands above the table.
   */
  logRaw(lines: readonly string[]): void {
    if (this.stopped || lines.length === 0) return;
    this.pending.push(...lines);
    this.scheduleDraw();
  }

  private renderEntry(entry: ActivityEntry): string[] {
    if (this.mode === 'plain') {
      const projectId = entry.projectId ?? this.projectId;
      const fields: Array<readonly [string, LogfmtValue]> = [
        ['level', entry.level],
        ...(projectId ? ([['project', projectId]] as const) : []),
        ['event', entry.event],
        ...(entry.fields ?? []),
      ];
      return [`${formatIsoTime(entry.at)} ${logfmt(fields)}`];
    }
    const options = { columns: this.columns, glyphs: this.glyphs, time: formatLocalTime(entry.at) };
    const stacked = this.columns < STACKED_COLUMNS;
    const lines = stacked ? formatStackedEntry(entry, options) : formatWideEntry(entry, options);
    const kind = stacked ? ('entry-stacked' as const) : ('entry-wide' as const);
    return lines.map((line, index) =>
      index === 0
        ? paintLine(line, kind, this.painter, { level: entry.level })
        : paintLine(line, 'continuation', this.painter),
    );
  }

  /**
   * Burst folding: above the limit, the rest of that second becomes one count line.
   *
   * Warnings and errors are NEVER folded, at any rate. That asymmetry is the whole point — the
   * failure mode folding exists to prevent is a terminal so full of routine lines that the one
   * error scrolls away, and a folder that could swallow the error would be that same bug with
   * extra steps.
   */
  private shouldFold(entry: ActivityEntry): boolean {
    if (entry.level === 'warn' || entry.level === 'error' || entry.neverFold) return false;
    const limit = this.mode === 'plain' ? FOLD_LIMIT_PLAIN : FOLD_LIMIT_HUMAN;
    const now = this.clock.now();
    if (now - this.foldWindowStart >= 1000) {
      this.flushFold(now);
      this.foldWindowStart = now;
      this.foldShown = 0;
    }
    if (this.foldShown < limit) {
      this.foldShown++;
      return false;
    }
    this.foldSwallowed++;
    // The window may end with nothing else arriving, so the count line needs its own wake-up.
    if (this.foldTimer === undefined) {
      this.foldTimer = this.clock.setTimeout(() => {
        this.foldTimer = undefined;
        const at = this.clock.now();
        this.flushFold(at);
        this.foldWindowStart = at;
        this.foldShown = 0;
      }, 1000);
    }
    return true;
  }

  private flushFold(nowMs: number): void {
    if (this.foldSwallowed === 0) return;
    const count = this.foldSwallowed;
    this.foldSwallowed = 0;
    const entry: ActivityEntry = {
      at: new Date(nowMs),
      level: 'info',
      subject: 'xezar',
      message: `${count} more info lines in the last second were folded ${this.glyphs.dash} see the cockpit`,
      event: 'output.folded',
      fields: [['count', count]],
      neverFold: true,
    };
    this.pending.push(...this.renderEntry(entry));
    this.scheduleDraw();
  }

  // ---- the live table -------------------------------------------------------

  /** Put a task on the table, or update the one that is there. */
  setRow(row: TaskRow): void {
    const previous = this.rows.get(row.id);
    if (
      previous &&
      previous.state === row.state &&
      previous.step === row.step &&
      previous.agent === row.agent &&
      previous.title === row.title &&
      previous.startedAtMs === row.startedAtMs
    ) {
      return;
    }
    this.rows.set(row.id, row);
    this.markRegionDirty();
  }

  /** Take a task off the table — it reached a terminal state. */
  removeRow(id: string): void {
    if (!this.rows.delete(id)) return;
    this.markRegionDirty();
  }

  /** Count one task OUTCOME that was `failed`. A failed check step is never counted (§ 6.3). */
  countFailedTask(): void {
    this.failedSinceStart++;
    this.markRegionDirty();
  }

  get activeRows(): TaskRow[] {
    return sortTaskRows([...this.rows.values()]);
  }

  get failedCount(): number {
    return this.failedSinceStart;
  }

  private markRegionDirty(): void {
    if (!this.hasRegion) return;
    this.regionDirty = true;
    this.scheduleDraw();
  }

  // ---- drawing --------------------------------------------------------------

  private scheduleDraw(): void {
    if (this.stopped) return;
    if (!this.hasRegion) {
      // No region to merge into, so nothing is gained by waiting: a log file wants its line now.
      this.flushPending();
      return;
    }
    if (this.redrawTimer !== undefined) return;
    const since = this.clock.now() - this.lastDrawMs;
    if (since >= REDRAW_INTERVAL_MS) {
      this.draw();
      return;
    }
    this.redrawTimer = this.clock.setTimeout(() => {
      this.redrawTimer = undefined;
      this.draw();
    }, REDRAW_INTERVAL_MS - since);
  }

  /** Write the durable lines straight out, with no region arithmetic. */
  private flushPending(): void {
    if (this.pending.length === 0) return;
    const out = this.pending.map((line) => `${line}\n`).join('');
    this.pending = [];
    this.write(out);
  }

  /**
   * One redraw: move up over the region, clear from there down, write the durable lines that
   * arrived since the last draw, then the region. ONE `write()`, so a terminal never shows a
   * half-erased table.
   */
  private draw(): void {
    if (this.stopped) return;
    if (!this.hasRegion) {
      this.flushPending();
      return;
    }
    if (this.pending.length === 0 && !this.regionDirty && this.regionLines > 0) return;

    this.lastDrawMs = this.clock.now();
    this.regionDirty = false;

    let out = '';
    if (!this.cursorHidden) {
      out += HIDE_CURSOR;
      this.cursorHidden = true;
    }
    if (this.regionLines > 0) out += cursorUp(this.regionLines) + CLEAR_BELOW;
    for (const line of this.pending) out += `${line}\n`;
    this.pending = [];

    const region = this.buildRegion();
    for (const line of region) out += `${line}\n`;
    this.regionLines = region.length;

    this.write(out);
    this.scheduleTick();
  }

  private buildRegion(): string[] {
    const plain = formatRegion([...this.rows.values()], {
      columns: this.columns,
      glyphs: this.glyphs,
      failedSinceStart: this.failedSinceStart,
      nowMs: this.clock.now(),
      ...(this.url ? { url: this.url } : {}),
      ...(this.projectId ? { projectId: this.projectId } : {}),
    });
    if (!this.painter.enabled) return plain;

    const layout = tableLayout(this.columns);
    if (layout === null) return plain.map((line) => paintLine(line, 'summary', this.painter));

    const stateFrom = 2 + layout.task + 2;
    const stateCell = [stateFrom, stateFrom + layout.state] as const;
    const placeholders: Array<readonly [number, number]> = [];
    let cursor = stateCell[1] + 2;
    if (layout.step !== undefined) {
      placeholders.push([cursor, cursor + layout.step]);
      cursor += layout.step + 2;
    }
    if (layout.agent !== undefined) {
      placeholders.push([cursor, cursor + layout.agent]);
    }

    return plain.map((line, index) => {
      if (index === 0) return paintLine(line, 'rule', this.painter);
      if (index === plain.length - 1) return paintLine(line, 'summary', this.painter);
      if (index === 1) return paintLine(line, 'header', this.painter);
      if (line.trimStart().startsWith('+')) return line;
      return paintLine(line, 'row', this.painter, { stateCell, placeholderCells: placeholders });
    });
  }

  /**
   * Keep the Time column honest without animating: once a second while a visible row is under
   * an hour, once every fifteen seconds after that. An empty table needs no tick at all — the
   * one redraw that is never worth doing is the one that changes nothing.
   */
  private scheduleTick(): void {
    if (this.tickTimer !== undefined) {
      this.clock.clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.stopped || !this.hasRegion || this.rows.size === 0) return;
    const now = this.clock.now();
    const anyUnderAnHour = [...this.rows.values()].some((r) => now - r.startedAtMs < 3_600_000);
    this.tickTimer = this.clock.setTimeout(
      () => {
        this.tickTimer = undefined;
        this.regionDirty = true;
        this.draw();
      },
      anyUnderAnHour ? TICK_FAST_MS : TICK_SLOW_MS,
    );
  }

  /**
   * The write itself. Every failure here — a closed pipe, a destroyed stream — detaches the
   * renderer and returns. It never throws and never rejects: the caller is a run-store listener
   * or an HTTP handler, and a throw there would take down work that has nothing to do with the
   * terminal.
   */
  private write(chunk: string): void {
    if (this.stopped || chunk === '') return;
    if (this.stream.destroyed === true || this.stream.writableEnded === true) {
      this.detach();
      return;
    }
    try {
      this.stream.write(chunk);
      this.writes++;
    } catch {
      this.detach();
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Watch the real process: resize, a closed output, and the two signals.
   *
   * Everything registered here is registered with a matching remover, because a renderer is
   * built per `serve` and a test builds dozens in one process. A leaked `SIGINT` listener is
   * how a suite starts printing Node's MaxListenersExceededWarning and then, much later, how a
   * shutdown runs a handler belonging to a renderer that stopped an hour ago.
   */
  attachProcess(options: { onResize?: () => void } = {}): void {
    const stream = this.stream;
    if (typeof stream.on === 'function' && typeof stream.off === 'function') {
      const onError = (err: unknown) => {
        // EPIPE is the ordinary case (`| head` ended). Anything else on stderr is just as fatal
        // to drawing and just as harmless to the service, so both take the same exit.
        void err;
        this.detach();
      };
      const onResize = () => {
        if (this.resizeTimer !== undefined) this.clock.clearTimeout(this.resizeTimer);
        this.resizeTimer = this.clock.setTimeout(() => {
          this.resizeTimer = undefined;
          this.handleResize(options.onResize);
        }, RESIZE_DEBOUNCE_MS);
      };
      stream.on('error', onError as never);
      stream.on('resize', onResize as never);
      this.detachers.push(() => {
        stream.off?.('error', onError as never);
        stream.off?.('resize', onResize as never);
      });
    }

    // The last-resort cursor restore. `stop()` is the normal path and removes this again; this
    // covers the paths that do not reach it — an uncaught error, a `process.exit` somewhere
    // else. A hidden cursor is the one piece of damage a crashed CLI leaves in a terminal that
    // outlives it, and the fix is a synchronous six-byte write.
    const onExit = () => {
      if (!this.cursorHidden) return;
      this.cursorHidden = false;
      try {
        this.stream.write(SHOW_CURSOR);
      } catch {
        // Nowhere to write to. Nothing left to do about it.
      }
    };
    process.once('exit', onExit);
    this.detachers.push(() => process.off('exit', onExit));
  }

  /**
   * A resize: erase the region, re-measure, redraw at the new width. Lines already printed are
   * NOT reflowed — the terminal owns scrollback, and rewriting it is how a renderer turns one
   * window drag into a screenful of duplicated history.
   */
  private handleResize(onResize?: () => void): void {
    if (this.stopped) return;
    const columns = typeof this.stream.columns === 'number' ? this.stream.columns : this.columns;
    if (columns === this.columns) return;
    this.columns = columns;
    onResize?.();
    this.regionDirty = true;
    this.draw();
  }

  /** Change the mode after a resize crossed the 60-column line. */
  setMode(mode: RenderMode, columns: number): void {
    this.mode = mode;
    this.columns = columns;
    this.regionDirty = true;
  }

  get currentColumns(): number {
    return this.columns;
  }

  get currentMode(): RenderMode {
    return this.mode;
  }

  /**
   * Erase the live region and leave the cursor where the region began.
   *
   * Used before the session summary, so the summary is ordinary scrollback rather than
   * something the next redraw would erase.
   */
  eraseRegion(): void {
    if (this.stopped || this.regionLines === 0) return;
    this.write(cursorUp(this.regionLines) + CLEAR_BELOW);
    this.regionLines = 0;
  }

  /**
   * Stop drawing for good: flush what is pending, erase the region, show the cursor again and
   * release every timer and listener. Safe to call twice — a second Ctrl-C does call it twice.
   */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.eraseRegion();
    this.flushPending();
    if (this.cursorHidden) {
      this.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }
    this.detach();
  }

  /**
   * Release everything without writing anything. This is the closed-output path: there is
   * nowhere to put a cursor-restore sequence, and trying would loop straight back here.
   */
  detach(): void {
    this.stopped = true;
    for (const handle of [this.redrawTimer, this.tickTimer, this.resizeTimer, this.foldTimer]) {
      if (handle !== undefined) this.clock.clearTimeout(handle);
    }
    this.redrawTimer = undefined;
    this.tickTimer = undefined;
    this.resizeTimer = undefined;
    this.foldTimer = undefined;
    for (const off of this.detachers.splice(0)) {
      try {
        off();
      } catch {
        // A stream that is already gone cannot un-register a listener. Nothing to do, and
        // nothing that should stop the rest of the teardown.
      }
    }
    this.pending = [];
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

/** Sanitize the human text and every string field before either output format sees it. */
export function entry(input: {
  level: ActivityLevel;
  projectId?: string;
  subject: string;
  message: string;
  event: string;
  continuation?: readonly string[];
  fields?: ActivityEntry['fields'];
  at?: Date;
}): ActivityEntry {
  return {
    at: input.at ?? new Date(),
    level: input.level,
    ...(input.projectId ? { projectId: sanitizeText(input.projectId) } : {}),
    subject: sanitizeText(input.subject, { maxWidth: 8 }),
    message: sanitizeText(input.message),
    event: input.event,
    ...(input.continuation
      ? { continuation: input.continuation.map((line) => sanitizeText(line)).filter((l) => l !== '') }
      : {}),
    ...(input.fields ? { fields: input.fields.map(([key, value]) =>
      [key, typeof value === 'string' ? sanitizeText(value) : value] as const) } : {}),
  };
}
