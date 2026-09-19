/**
 * One call that turns a resolved settings object into a live terminal (#467, PR 3).
 *
 * `serve` calls `startTerminalActivity` once, threads the handle's three seams into the parts
 * that produce events — the boot store, the project-context map and the HTTP boundary — and
 * calls `stop()` on the way out. Nothing else in the CLI knows the renderer exists.
 *
 * Everything this builds is on **stderr**. The boot banner, version, backend checks and the
 * `cockpit → <url>` stdout line remain exactly the bytes they were, so `xez | tee` and every
 * script that reads the URL keep working
 * (`open-questions.md` Q-11). That also means a person piping stdout still sees the activity on
 * their screen, which is the whole reason the split is that way round.
 */

import { resolveCapabilities } from '../server/capabilities.ts';
import { wrapTo } from './activity.ts';
import { attachRunStoreActivity, type ActivitySource } from './activity-source.ts';
import { journalRowEntry } from './journal-source.ts';
import { glyphsFor, formatDuration, type Glyphs } from './format.ts';
import { HttpDiagnostics, type HttpFailure } from './http-diagnostics.ts';
import { isCapableTty, readTerminalFacts, resolveOnResize, resolveRender, type RenderMode } from './mode.ts';
import { entry, TerminalRenderer, type RenderStream } from './renderer.ts';
import { cutToWidth, displayWidth, sanitizeText } from './sanitize.ts';

import type { ResolvedCliSettings } from '../cli-settings.ts';
import type { ProjectContexts } from '../server/project-context.ts';
import type { RunStore } from '../runs/store.ts';
import type { ActivityEntry } from './activity.ts';
import type { McpJournalRow } from '@qodeca/xezar-contract';

export interface TerminalActivityOptions {
  settings: ResolvedCliSettings;
  /** The boot project's store — attached before its recovery. */
  store: RunStore;
  /** The boot project's registry id, for the plain `project=` field and the task URLs. */
  projectId?: string;
  /** Overridable for tests; defaults to `process.stderr`. */
  stream?: RenderStream & { isTTY?: boolean; columns?: number };
  env?: NodeJS.ProcessEnv;
  glyphs?: Glyphs;
}

export interface TerminalActivity {
  readonly renderer: TerminalRenderer;
  readonly mode: RenderMode;
  /** Hand to `startServer` as `onHttpFailure`. */
  readonly onHttpFailure: (failure: HttpFailure) => void;
  /** Hand to `startServer` as `onContexts`, so later projects' stores are watched too. */
  readonly onContexts: (contexts: ProjectContexts) => void;
  /** The cockpit URL, once the bind really happened. */
  /**
   * The cockpit is really listening, at this URL.
   *
   * `boot` carries what a machine reader needs and a person already has on the banner: the port,
   * and — when the requested one was taken — the port that was asked for and why it moved. It
   * produces the `xezar.ready` line in plain output and nothing at all on a terminal (§ 10.2).
   */
  setUrl(url: string, boot?: { port: number; requestedPort?: number; reason?: string }): void;
  /** Called after all stdout boot output has finished. */
  startDisplay(): void;
  /** Boot recovery is over; everything from here prints normally. */
  endRecovery(): void;
  /** Report the previous session once, without turning historical settlements into outcomes. */
  reportRecovery(count: number, settled: number): void;
  /** One activity line, from a caller that is not a store (MCP, registry, ports). */
  log(entry: ActivityEntry): void;
  /**
   * One boot-project journal row as it was appended (#467, PR 4). Hand to the MCP service as
   * `onEventRow`. Prints only the catalog kinds the store bridge cannot derive
   * (`CATALOG_KIND_SOURCE`); every other row is ignored.
   */
  onEventRow(row: McpJournalRow): void;
  /** Erase the region, print the session summary, restore the cursor, release everything. */
  stop(options?: { stillRunning?: number; projectName?: string }): void;
}

/** Counted for the session summary — task outcomes only, never a failed check step (§ 6.3). */
interface SessionCounts {
  done: number;
  review: number;
  failed: number;
  cancelled: number;
}

export function startTerminalActivity(options: TerminalActivityOptions): TerminalActivity {
  const env = options.env ?? process.env;
  const stream = options.stream ?? (process.stderr as unknown as RenderStream);
  const glyphs = options.glyphs ?? glyphsFor(env);
  const facts = readTerminalFacts(stream, env);
  let render = resolveRender(options.settings.output, options.settings.color, facts);

  const capabilities = resolveCapabilities(env);
  const renderer = new TerminalRenderer({
    stream,
    liveRegion: false,
    mode: render.mode,
    columns: render.columns,
    colorEnabled: render.colorEnabled,
    level: options.settings.effectiveLogLevel,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    glyphs,
  });

  // The ONE fallback notice, first, before anything else reaches the stream: a person who asked
  // for `rich` and got plain lines must be told why once, not left to wonder.
  if (render.fallback) {
    renderer.log(
      entry({
        level: 'warn',
        subject: 'xezar',
        message: `output ${glyphs.dash} asked for ${render.fallback.asked}, using ${render.fallback.using} ${glyphs.dash} ${render.fallback.reason}`,
        event: 'output.fallback',
        fields: [
          ['asked', render.fallback.asked],
          ['using', render.fallback.using],
          ['reason', render.fallback.reason],
        ],
      }),
    );
  }

  renderer.attachProcess({
    onResize: () => {
      const next = resolveOnResize(
        render,
        options.settings.output,
        options.settings.color,
        readTerminalFacts(stream, env),
      );
      render = next;
      renderer.setMode(next.mode, next.columns);
    },
  });

  const counts: SessionCounts = { done: 0, review: 0, failed: 0, cancelled: 0 };
  const startedAtMs = Date.now();
  let url: string | undefined;
  // A rich/lines terminal has no region yet at boot (`startDisplay()` has not run), so a line
  // logged now is ordinary scrollback, written immediately — ABOVE the stdout banner that has
  // not been printed yet (#556, B-1). Held here until `startDisplay()`, it lands after the
  // banner instead. Plain output has no banner to land above and keeps the immediate order
  // (`task.recovered` before `xezar.ready`, non-tty.txt).
  let pendingRecovery: ActivityEntry | undefined;
  let displayStarted = false;

  const emit = (activity: ActivityEntry): void => {
    renderer.log(activity);
    switch (activity.event) {
      case 'task.done':
        counts.done++;
        break;
      case 'result.ready':
        counts.review++;
        break;
      case 'task.cancelled':
        counts.cancelled++;
        break;
      case 'task.failed':
        counts.failed++;
        break;
      default:
        break;
    }
  };

  const sourceOptions = {
    emit,
    setRow: (row: Parameters<Parameters<typeof attachRunStoreActivity>[1]['setRow']>[0]) =>
      renderer.setRow(row),
    removeRow: (id: string) => renderer.removeRow(id),
    countFailedTask: () => renderer.countFailedTask(),
    glyphs,
    url: () => url,
    hideTokens: !capabilities.tokenUsageMetrics,
    hideCost: !capabilities.costMetrics,
  };

  const bootSource = attachRunStoreActivity(options.store, {
    ...sourceOptions,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  });
  /**
   * Every project's source, so a dispose releases exactly its own.
   *
   * Tagged with the REGISTRATION the store was opened for (#647), because an id alone cannot tell
   * two registrations of the same project apart and this map is keyed on the id: a dispose that
   * arrives after the project was re-added and rebuilt names the DEAD registration, and a source
   * tagged with the live one must survive it.
   */
  const sources = new Map<string, { source: ActivitySource; generation: number }>();

  const http = new HttpDiagnostics({ emit, glyphs });

  let disposeUnsubscribe: (() => void) | undefined;
  let storeUnsubscribe: (() => void) | undefined;
  let builtUnsubscribe: (() => void) | undefined;

  return {
    renderer,
    get mode() {
      return render.mode;
    },
    onHttpFailure: (failure) => http.record(failure),
    onContexts: (contexts) => {
      /**
       * Attach this project's rows to `store`, unless what is already here belongs to a LATER
       * registration.
       *
       * `onStoreCreated` fires as a store opens, which is before its build knows whether it won:
       * a build the removal route already superseded still opens a store and still announces it,
       * and it can do so after the build that replaced it has published. Replacing on a strictly
       * OLDER generation is what used to hand the live project's rows to a losing build's store
       * (#647) — a defect that predates the dispose payload and is fixed here with it. An EQUAL
       * generation still replaces, which is the unchanged default path: the same registration
       * announced twice, and the last store is the one that counts.
       */
      const attach = (store: RunStore, projectId: string, generation: number): ActivitySource | undefined => {
        const held = sources.get(projectId);
        if (held && generation < held.generation) return undefined;
        held?.source.detach();
        const source = attachRunStoreActivity(store, { ...sourceOptions, projectId });
        sources.set(projectId, { source, generation });
        return source;
      };
      storeUnsubscribe = contexts.onStoreCreated(attach);
      // Publication follows this project's recovery, even when it was opened long after boot.
      builtUnsubscribe = contexts.onContextBuilt((ctx) => sources.get(ctx.id)?.source.endRecovery());
      for (const id of contexts.ids()) {
        const ctx = contexts.peek(id);
        if (ctx) attach(ctx.store, id, ctx.generation)?.endRecovery();
      }
      // A dispose names the registration it is about, and this map is keyed on the id alone: a
      // dispose whose teardown outlived a re-add and a rebuild names a registration this source
      // no longer belongs to, and releasing it there would take the LIVE project's rows off the
      // screen with no second `store` event to put them back (#647). The generation held here is
      // exactly the one the matching dispose will name, so an equality test is the whole guard —
      // and `generation: 0` is a real registration, never "no generation": a project's FIRST
      // dispose carries 0 and must still release the source attached at 0.
      disposeUnsubscribe = contexts.onContextDisposed((projectId, disposal) => {
        const held = sources.get(projectId);
        if (!held || held.generation !== disposal.generation) return;
        held.source.detach();
        sources.delete(projectId);
      });
    },
    setUrl: (next, boot) => {
      url = next;
      renderer.setUrl(next);
      if (!boot || render.mode !== 'plain') return;
      // `--port 0` is "any free port", so there is no port that was asked for and nothing moved.
      // Reporting `start=0` would read as a port, which is exactly what it is not.
      const asked = boot.requestedPort === 0 ? undefined : boot.requestedPort;
      const moved = asked !== undefined && asked !== boot.port;
      emit(
        entry({
          level: 'info',
          subject: 'xezar',
          message: `cockpit ready at ${next}`,
          event: 'xezar.ready',
          fields: [
            ['url', next],
            ['port', boot.port],
            ...(moved ? ([['start', asked ?? null]] as const) : []),
            ...(moved && boot.reason ? ([['reason', boot.reason]] as const) : []),
          ],
        }),
      );
    },
    endRecovery: () => {
      bootSource.endRecovery();
    },
    reportRecovery: (count, settled) => {
      if (count <= 0) return;
      const singular = settled === 1;
      const recoveryEntry = entry({
        level: 'info',
        subject: 'xezar',
        message:
          settled > 0
            ? `${settled} ${singular ? 'task' : 'tasks'} from the previous session`
            : `recovered ${count} ${count === 1 ? 'task' : 'tasks'} from the previous session`,
        ...(settled > 0
          ? { continuation: [`${singular ? 'was' : 'were'} settled at start-up`] }
          : {}),
        event: 'task.recovered',
        fields: [
          ['count', count],
          ['settled', settled],
        ],
      });
      // Plain mode has already flushed by the time `startDisplay()` runs, so holding it there
      // would drop the notice — emit it now, same as before. A rich/lines terminal holds it
      // until `startDisplay()` unless the display already started (a caller that reports
      // recovery after boot, same as any other activity line).
      if (render.mode === 'plain' || displayStarted) emit(recoveryEntry);
      else pendingRecovery = recoveryEntry;
    },
    startDisplay: () => {
      displayStarted = true;
      if (pendingRecovery) {
        emit(pendingRecovery);
        pendingRecovery = undefined;
      }
      if (!options.settings.quiet && isCapableTty(facts) && !facts.ci) renderer.startDisplay();
    },
    log: (activity) => emit(activity),
    onEventRow: (row) => {
      if (renderer.isStopped) return;
      const line = journalRowEntry(row, { url: () => url, dash: glyphs.dash, ...(options.projectId ? { projectId: options.projectId } : {}) });
      if (line) emit(line);
    },
    stop: (stopOptions = {}) => {
      if (renderer.isStopped) return;
      const stillRunning = stopOptions.stillRunning ?? renderer.activeRows.length;
      http.stop();
      bootSource.detach();
      for (const { source } of sources.values()) source.detach();
      sources.clear();
      storeUnsubscribe?.();
      builtUnsubscribe?.();
      disposeUnsubscribe?.();

      if (render.mode === 'plain') {
        emit(entry({
          level: 'info', subject: 'xezar', message: 'stopping', event: 'xezar.stopping',
          fields: [['still_running', stillRunning]],
        }));
      }

      // One activity line in EVERY mode, carrying the counts as fields — that is what a machine
      // reading the plain output gets, and what `tty.txt` 149 shows above the human block. Under
      // quiet it is an info line, so the level filter drops it, which is the intended behaviour:
      // the cockpit URL and every failure have already been printed.
      emit(
        entry({
          level: 'info',
          subject: 'xezar',
          message: `stopping${stillRunningNote(stillRunning, glyphs)}`,
          event: 'session.summary',
          fields: [
            ['duration_ms', Date.now() - startedAtMs],
            ['done', counts.done],
            ['review', counts.review],
            ['failed', counts.failed],
            ['cancelled', counts.cancelled],
            ['still_running', stillRunning],
          ],
        }),
      );
      // The human block is information rather than a warning, so quiet leaves it out, and plain
      // output has no block at all — the line above already said everything, in one row.
      if (!options.settings.quiet && render.mode !== 'plain') {
        renderer.eraseRegion();
        renderer.logRaw(
          summaryLines(
            counts,
            stillRunning,
            startedAtMs,
            glyphs,
            renderer.currentColumns,
            stopOptions.projectName,
          ),
        );
      }
      if (render.mode === 'plain') {
        emit(entry({
          level: 'info', subject: 'xezar', message: 'stopped', event: 'xezar.stopped',
        }));
      }
      renderer.stop();
    },
  };
}

/** `— <n> tasks are still running`, or nothing at all when none is. */
function stillRunningNote(stillRunning: number, glyphs: Glyphs): string {
  if (stillRunning === 0) return '';
  const subject = stillRunning === 1 ? '1 task is' : `${stillRunning} tasks are`;
  return ` ${glyphs.dash} ${subject} still running`;
}

/**
 * § 6.4: a blank line, the counts, the still-running sentence, the stop line.
 *
 * Every line is fitted to the terminal it is printed on. The counts WRAP rather than get cut
 * (`tty-narrow.txt` 96–102): a summary that runs off the edge hides how many tasks failed, and
 * that is the one number a person came back to the terminal to read.
 */
function summaryLines(
  counts: SessionCounts,
  stillRunning: number,
  startedAtMs: number,
  glyphs: Glyphs,
  columns: number,
  projectName?: string,
): string[] {
  const room = Math.max(columns - 4, 12);
  const halves = [
    `${counts.done} done ${glyphs.dot} ${counts.review} needs review`,
    `${counts.failed} failed ${glyphs.dot} ${counts.cancelled} cancelled`,
  ];
  const oneLine = halves.join(` ${glyphs.dot} `);
  const lines = [
    '',
    cutToWidth(`  Session summary ${glyphs.dash} ${formatDuration(Date.now() - startedAtMs)}`, columns, glyphs.ellipsis),
    ...(displayWidth(oneLine) <= room ? [`    ${oneLine}`] : halves.map((half) => `    ${half}`)),
  ];
  // Left out at zero: "0 tasks were still running" is a sentence nobody needs to read.
  if (stillRunning > 0) {
    const subject = stillRunning === 1 ? '1 task was' : `${stillRunning} tasks were`;
    const sentence = `${subject} still running. xezar picks ${stillRunning === 1 ? 'it' : 'them'} up on the next start.`;
    lines.push(...wrapTo(sentence, room, 4, glyphs.ellipsis).map((line) => `    ${line}`));
  }
  const who = projectName
    ? ` for ${sanitizeText(projectName, { maxWidth: Math.max(columns - 20, 8) })}`
    : '';
  lines.push(cutToWidth(`  xezar stopped${who}.`, columns, glyphs.ellipsis));
  return lines;
}

export { entry } from './renderer.ts';
export type { HttpFailure } from './http-diagnostics.ts';
