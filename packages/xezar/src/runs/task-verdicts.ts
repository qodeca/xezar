import { lstatSync, openSync, readFileSync, closeSync, fstatSync, unlinkSync } from 'node:fs';

import {
  TASK_VERDICT_ISSUE_REASON_MAX,
  TASK_VERDICT_MAX_BYTES,
  TASK_VERDICT_MAX_ISSUES,
  taskVerdictPacketSchema,
  type TaskVerdict,
  type TaskVerdictIssue,
  type TaskVerdictPacket,
  type TaskVerdictRole,
} from '@qodeca/xezar-contract';

import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import { handoffPath } from '../handoff.ts';

import type { RunRecord, RunStore } from './store.ts';

/**
 * TAKING IN A REVIEWER'S REPORT (#460).
 *
 * A reviewing task posts its review where reviews go — a forge comment — and then drops one JSON
 * packet beside its own handoff journal. This module is the other end: at that step's settlement
 * the engine reads the packet, proves it is about THIS task and THIS step, and records it on the
 * run. Nothing here talks to a forge, and nothing a task reports is treated as proof of forge
 * state — the packet says what the reviewer SAID, which is a different and smaller claim.
 *
 * WHY A FILE. The alternative was a new write capability for task agents, which would have meant
 * every task able to record a verdict about any task. A file the engine already owns the path of,
 * read once, at one moment, with the step's own identity checked, grants exactly the authority the
 * feature needs and no more.
 *
 * WHAT IS REFUSED, and it is refused into an `verdictIssue` rather than silence — "the engine threw
 * this away" must never look like "no reviewer ran":
 *
 *  - anything that is not a regular file. A symlink is the attack: the path sits in xezar's own
 *    data directory, and following one would let a task hand the engine any file this process can
 *    read. `lstat` first, then read through the descriptor that `lstat` described, so a file
 *    swapped for a link between the two checks is caught by the second.
 *  - anything over 40 KB. A verdict is a headline and a few labels.
 *  - anything that is not valid JSON in the packet shape — including a role carrying another
 *    role's vocabulary, an abbreviated SHA, or `unavailable` label evidence with an observed list.
 *  - a packet naming another task, or another step of this one. That is the guard that stops an
 *    earlier step's leftover packet from being collected by whatever runs next.
 *  - a packet whose `role` is not the role the settling step DECLARES (#851), including every
 *    packet from a step that declares none. The declaration is the step's `verdictRole` in its
 *    workflow definition, read by the engine — never the packet's word about itself. Without it
 *    any agent step of any task could write a `code-review` packet and have it recorded over the
 *    real reviewer's, a verdict on the record that no reviewer made.
 *  - a packet reusing an already-recorded id with DIFFERENT content. One report may be re-reported
 *    (a retry, a recovery) and stay one report; it may not quietly become a different one.
 *  - a packet that cannot even be LOOKED UP. `ENOENT` is the one lookup failure that means "this
 *    task reported nothing"; a permission error is a failure to look, and the whole rule above is
 *    that a failure to look never reads as an absence.
 *
 * ORDER. The packet is written to the run with `publication: 'pending'` and FLUSHED to disk before
 * anything announces it, and the packet file is only removed after that — so a process that dies
 * anywhere in the sequence leaves either a re-readable packet or a recoverable record, never a lost
 * verdict and never a second one. The run store's ordinary write is a 300 ms debounce and the
 * journal's append is immediate, so without the flush the announcement row could reach disk before
 * the record it announces. See `taskVerdictSchema`'s note and `mcp/event-catalog.ts`.
 */

/** Where a task's reviewer packet is read from: its handoff journal's path plus one suffix. */
export function taskVerdictPacketPath(dataDir: string, runId: string): string {
  return `${handoffPath(dataDir, runId)}.verdict.json`;
}

/** What one ingestion attempt did. `undefined` means there was no packet at all. */
export type TaskVerdictIngestion =
  | { readonly outcome: 'recorded'; readonly verdict: TaskVerdict }
  | { readonly outcome: 'unchanged'; readonly verdict: TaskVerdict }
  | { readonly outcome: 'refused'; readonly reason: string };

/** Everything the packet carries, with the engine's own stamps removed — the comparison that
 *  decides whether a re-reported id is the same report or a different one. */
function reportedPart(verdict: TaskVerdict): TaskVerdictPacket {
  const { source: _source, ingestedAt: _ingestedAt, publication: _publication, ...reported } = verdict;
  return reported as TaskVerdictPacket;
}

function sameReport(a: TaskVerdictPacket, b: TaskVerdictPacket): boolean {
  return JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
}

/** A key-ordered copy, so two packets that differ only in key order compare equal. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortedKeys(inner)]));
}

function clipReason(reason: string): string {
  return reason.length <= TASK_VERDICT_ISSUE_REASON_MAX
    ? reason
    : `${reason.slice(0, TASK_VERDICT_ISSUE_REASON_MAX - 1)}…`;
}

/**
 * Read the packet file as bytes, or say why not. Refuses anything that is not a regular file and
 * anything over the byte bound — both BEFORE the content is parsed, and the regular-file check is
 * made twice: once on the path, once on the opened descriptor, because only the second one
 * describes the bytes actually being read.
 */
function readPacketFile(file: string): { ok: true; text: string } | { ok: false; reason: string } | undefined {
  let onDisk;
  try {
    onDisk = lstatSync(file);
  } catch (err) {
    // ENOENT is the ordinary case for every non-reviewing task and is the ONLY one that means
    // "nothing was reported". Anything else — a permission error, an unreadable directory — is a
    // failure to look, and the module's own rule is that those never read as an absence.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `the reviewer packet could not be looked up (${detail})` };
  }
  if (!onDisk.isFile()) return { ok: false, reason: 'the reviewer packet is not a regular file' };
  if (onDisk.size > TASK_VERDICT_MAX_BYTES) {
    return { ok: false, reason: `the reviewer packet is larger than ${TASK_VERDICT_MAX_BYTES} bytes` };
  }
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { ok: false, reason: 'the reviewer packet is not a regular file' };
    if (opened.size > TASK_VERDICT_MAX_BYTES) {
      return { ok: false, reason: `the reviewer packet is larger than ${TASK_VERDICT_MAX_BYTES} bytes` };
    }
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > TASK_VERDICT_MAX_BYTES) {
      return { ok: false, reason: `the reviewer packet is larger than ${TASK_VERDICT_MAX_BYTES} bytes` };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: `the reviewer packet could not be read (${err instanceof Error ? err.message : String(err)})` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the descriptor is ours and already read from — a failed close changes nothing
      }
    }
  }
}

/** Append a bounded ingestion problem to the run, keeping the newest `TASK_VERDICT_MAX_ISSUES`. */
function recordIssue(store: RunStore, run: RunRecord, stepId: string, reason: string): void {
  const issue: TaskVerdictIssue = { stepId, at: new Date().toISOString(), reason: clipReason(reason) };
  const kept = [...(run.verdictIssues ?? []), issue].slice(-TASK_VERDICT_MAX_ISSUES);
  store.updateRun(run.id, { verdictIssues: kept });
}

/**
 * Read this step's reviewer packet, if it left one, and record it on the run.
 *
 * Called at every AGENT step's settlement; a step that wrote no packet costs one failed `lstat`.
 * Never throws: a reviewer report is evidence about a task, and no problem with it may fail the
 * task itself.
 *
 * `declaredRole` is the settling step's own `verdictRole` as the ENGINE read it from the workflow
 * definition, `undefined` when the step declares none. It is a required parameter rather than an
 * optional one on purpose: a caller that forgets it must not compile into "no role check".
 */
export function ingestTaskVerdict(
  store: RunStore,
  dataDir: string,
  runId: string,
  stepId: string,
  declaredRole: TaskVerdictRole | undefined,
): TaskVerdictIngestion | undefined {
  try {
    return ingest(store, dataDir, runId, stepId, declaredRole);
  } catch {
    return undefined;
  }
}

function ingest(
  store: RunStore,
  dataDir: string,
  runId: string,
  stepId: string,
  declaredRole: TaskVerdictRole | undefined,
): TaskVerdictIngestion | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  const file = taskVerdictPacketPath(dataDir, runId);
  const read = readPacketFile(file);
  if (read === undefined) return undefined;
  // A refusal is recorded, made durable, and only THEN is the packet removed. Consuming is what
  // stops the same bad packet being re-offered at every later step of the chain, and doing it last
  // means a crash in the middle costs a re-offer rather than the note explaining the refusal.
  const refuse = (reason: string): TaskVerdictIngestion => {
    recordIssue(store, run, stepId, reason);
    store.flush();
    consume(file);
    return { outcome: 'refused', reason };
  };
  if (!read.ok) return refuse(read.reason);

  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return refuse('the reviewer packet is not valid JSON');
  }

  const parsed = taskVerdictPacketSchema.safeParse(json);
  if (!parsed.success) {
    // The message names the failing FIELDS, never their values: the packet is untrusted text.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].slice(0, 8);
    return refuse(`the reviewer packet does not match the verdict schema (${fields.join(', ')})`);
  }

  // F-15's own scrubber, over the whole packet: `summary` is the reviewer's prose and the label
  // values are strings a task chose. The run store scrubs `title`/`error` on the way in and knows
  // nothing about this field, so it is scrubbed here, before it is written.
  const packet = redactDeep(parsed.data, collectSecretValues());

  if (packet.taskId !== runId) return refuse('the reviewer packet reports on a different task');
  if (packet.stepId !== stepId) return refuse('the reviewer packet reports on a different step of this task');
  // The role check (#851). Both roles are schema-validated enum values, so naming them quotes
  // nothing the task chose freely.
  if (declaredRole === undefined) {
    return refuse(`the step that settled declares no verdict role, so its ${packet.role} packet cannot be recorded`);
  }
  if (packet.role !== declaredRole) {
    return refuse(`the reviewer packet reports a ${packet.role} verdict, but this step declares ${declaredRole}`);
  }

  const existing = run.verdicts ?? [];
  const sameId = existing.find((candidate) => candidate.id === packet.id);
  if (sameId) {
    if (!sameReport(reportedPart(sameId), packet)) {
      return refuse('a different report already carries this report id');
    }
    // The same report, reported again — a retry or a recovery. One logical report, so nothing is
    // written and nothing is announced a second time. The record already holds it, so the packet
    // has done its job and is consumed.
    consume(file);
    return { outcome: 'unchanged', verdict: sameId };
  }

  const verdict: TaskVerdict = {
    ...packet,
    source: 'task-reported',
    ingestedAt: new Date().toISOString(),
    publication: 'pending',
  };
  // One current packet per role: a newer report supersedes that role's previous one and leaves
  // every other role exactly as it was.
  const kept = [...existing.filter((candidate) => candidate.role !== packet.role), verdict];
  store.updateRun(runId, { verdicts: kept });
  // Then DURABLY, and only then is the packet gone. Both halves are load-bearing:
  //
  //  - `updateRun` alone mutates memory and arms a 300 ms DEBOUNCED index save, while the journal
  //    row the announcer appends is an immediate `appendFileSync`. Without the flush the row can
  //    reach disk before the record it announces — the exact inversion the two-step publication
  //    exists to rule out.
  //  - consuming BEFORE the record is written puts the packet, the verdict and the recoverability
  //    in one gap: a crash there loses all three. Consuming after costs at worst a re-offer at the
  //    next step, which the stable report id turns into `unchanged`.
  store.flush();
  consume(file);
  return { outcome: 'recorded', verdict };
}

function consume(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // best effort: a packet that cannot be removed is still only ever ingested once per step
  }
}

/**
 * Mark a recorded verdict announced. The second half of the two-step publication: the announcer
 * appends its journal row and then calls this, so a crash before it leaves a `pending` record that
 * the next announcer picks up by the same stable id.
 */
export function markTaskVerdictAnnounced(store: RunStore, runId: string, verdictId: string): void {
  const run = store.getRun(runId);
  if (!run?.verdicts?.some((verdict) => verdict.id === verdictId && verdict.publication === 'pending')) return;
  store.updateRun(runId, {
    verdicts: run.verdicts.map((verdict) =>
      verdict.id === verdictId ? { ...verdict, publication: 'announced' as const } : verdict,
    ),
  });
}
