/**
 * The terminal's `event=` vocabulary, reconciled with the MCP event catalog (#467, PR 4).
 *
 * PR 3 typed `ActivityEntry.event` as a bare `string` and spelled the catalog's kinds again as
 * string literals. Nothing tied the two together: a catalog kind renamed or split (#460 added
 * `task.blocked`, `task.stalled`, `task.resumed` and `verdict.posted`) left the terminal printing
 * the old meaning under the same name. This module is the one place both halves meet:
 *
 * - a CATALOG kind is `McpEventKind` from `@qodeca/xezar-contract`, never re-spelled here;
 * - a TERMINAL-ONLY name is listed below, and may never collide with a catalog kind
 *   (`event-names.test.ts` fails the day the catalog grows one of these names);
 * - every catalog kind has a row in `CATALOG_KIND_SOURCE`, typed `Record<McpEventKind, …>`, so a
 *   new kind in the contract is a compile error here until someone decides how the terminal
 *   shows it.
 */

import type { McpEventKind } from '@qodeca/xezar-contract';

import type { LogLevel } from '../cli-settings.ts';

/** Names the terminal prints that are not catalog kinds: its own lifecycle and diagnostics. */
export const TERMINAL_ONLY_EVENTS = [
  'task.queued',
  'task.started',
  'task.recovered',
  'step.started',
  'output.fallback',
  'output.folded',
  'xezar.ready',
  'xezar.stopping',
  'xezar.stopped',
  'session.summary',
  'registry.invalid',
  'registry.port',
  'instance.mode',
  'mcp.ready',
  'mcp.unavailable',
  'http.error',
  'http.refused',
  'http.repeated',
] as const;
export type TerminalOnlyEvent = (typeof TERMINAL_ONLY_EVENTS)[number];

/** Every name an `ActivityEntry` may carry as `event=`. */
export type TerminalEvent = McpEventKind | TerminalOnlyEvent;

/**
 * How the terminal learns about each catalog kind.
 *
 * - `store`: derived from the project's `RunStore` by `activity-source.ts`, the same bus the
 *   catalog listens to. The journal row for these kinds is ignored, or every one would print twice.
 * - `journal`: printed from the project's event journal row as it is appended — the kinds the
 *   store alone cannot reproduce faithfully (the stall monitor's advisory pair, reviewer reports,
 *   executor availability and writer-reported changes). `level` is the line's level.
 */
export type CatalogKindSource = { readonly from: 'store' } | { readonly from: 'journal'; readonly level: LogLevel };

export const CATALOG_KIND_SOURCE: Readonly<Record<McpEventKind, CatalogKindSource>> = {
  'task.done': { from: 'store' },
  'task.failed': { from: 'store' },
  'task.cancelled': { from: 'store' },
  'task.blocked': { from: 'store' },
  'task.stalled': { from: 'journal', level: 'warn' },
  'task.resumed': { from: 'journal', level: 'info' },
  'question.asked': { from: 'store' },
  'question.answered': { from: 'store' },
  'gate.passed': { from: 'store' },
  'gate.failed': { from: 'store' },
  'result.ready': { from: 'store' },
  'verdict.posted': { from: 'journal', level: 'info' },
  // E-04 is a person's own change, usually made in the cockpit the person is looking at.
  'goal.changed': { from: 'journal', level: 'debug' },
  'instruction.added': { from: 'journal', level: 'debug' },
  'instruction.queued': { from: 'journal', level: 'debug' },
  'instruction.edited': { from: 'journal', level: 'debug' },
  'instruction.removed': { from: 'journal', level: 'debug' },
  'config.changed': { from: 'journal', level: 'info' },
  'workflow.saved': { from: 'journal', level: 'info' },
  'workflow.deleted': { from: 'journal', level: 'info' },
  'agent-config.changed': { from: 'journal', level: 'info' },
  'executor.available': { from: 'journal', level: 'info' },
  'executor.unavailable': { from: 'journal', level: 'warn' },
};
