import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_INSTRUCTIONS,
  HANDOFF_ONLY_INSTRUCTIONS,
  FOLLOWUP_INSTRUCTIONS,
  appendHandoffHeartbeat,
  deleteHandoff,
  followupsEnabled,
  handoffPath,
  handoffProgressExcerpt,
  readHandoff,
  seedHandoffFile,
} from './handoff.ts';
import { parseAskMarker } from './core/ask.ts';
import { parseTaskMarkers, stripTaskMarkers } from './runs/task-markers.ts';
import { todoSchema } from './todos.ts';

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});

/**
 * The marker vocabulary this module hands every agent (#47, gap R8).
 *
 * `BACKWARD_COMPATIBILITY.md` §8 declares `XEZ:DONE`, `XEZ:MONITORING`, `XEZ:PR=<n>`,
 * `XEZ:ISSUE=<n>` and `XEZ:TITLE=<phrase>` a protected, agent-facing contract: a running
 * agent's emitted marker has to keep meaning what it meant when its session started. This
 * module's `HANDOFF_ONLY_INSTRUCTIONS` is the *only* place that promise is made to the
 * agent, and the parsers that honour it live elsewhere (`runs/task-markers.ts`,
 * `core/ask.ts`, `workflows/run.ts`). These tests pin the two halves against each other —
 * what the instructions promise against what the parsers actually do — and cover the
 * branches the happy path in `runs/task-markers.test.ts` does not reach. They deliberately
 * do not restate what that sibling suite already asserts.
 */
describe('marker vocabulary — instructions vs. parsers (#47)', () => {
  it('teaches every protected marker of BACKWARD_COMPATIBILITY §8', () => {
    for (const marker of ['XEZ:DONE', 'XEZ:MONITORING', 'XEZ:PR=', 'XEZ:ISSUE=', 'XEZ:TITLE=', 'XEZ:ASK'])
      expect(HANDOFF_ONLY_INSTRUCTIONS).toContain(marker);
  });

  /**
   * The instruction fragment is pasted into the system prompt of every agent step, and
   * agents quote their own contract back at themselves. `task-markers.ts:19` claims the
   * placeholders are "non-numeric and inert" — that claim is load-bearing and untested:
   * spelling one example as `XEZ:PR=123` would bind every task to PR 123.
   */
  it('is itself inert — the contract text declares no reference and asks no question', () => {
    expect(parseTaskMarkers(HANDOFF_ONLY_INSTRUCTIONS)).toEqual({});
    expect(parseTaskMarkers(FOLLOWUP_INSTRUCTIONS)).toEqual({});
    expect(parseTaskMarkers(HANDOFF_INSTRUCTIONS)).toEqual({});
    expect(parseAskMarker(HANDOFF_INSTRUCTIONS)).toBeNull();
  });

  /**
   * GUARD TEST — passes before and after any change, by design (#47's acceptance
   * criterion). Forward compatibility rests on an unknown `XEZ:*` line being inert: an
   * older xezar has to survive a newer agent's vocabulary. So an unrecognised marker must
   * neither parse nor knock out a real marker sharing the turn.
   */
  it('an unknown XEZ:* marker is inert and does not disturb a real one', () => {
    expect(parseTaskMarkers('XEZ:BRANCH=xez/1234ab')).toEqual({});
    expect(parseTaskMarkers('XEZ:FUTURE=42\nXEZ:PR=7')).toEqual({ pr: 7 });
    expect(parseAskMarker('XEZ:FUTURE=42')).toBeNull();
  });

  /**
   * The other half of "inert": an unknown marker is not stripped either, so a forward
   * marker stays visible as raw text instead of vanishing from the transcript. Same for
   * `XEZ:DONE`/`XEZ:MONITORING`, which `workflows/run.ts` strips with its own stripper.
   */
  it('leaves an unknown marker and the lifecycle markers visible to stripTaskMarkers', () => {
    expect(stripTaskMarkers('XEZ:BRANCH=xez/1234ab\nkeep')).toBe('XEZ:BRANCH=xez/1234ab\nkeep');
    expect(stripTaskMarkers('all good\nXEZ:DONE')).toBe('all good\nXEZ:DONE');
    expect(stripTaskMarkers('still going\nXEZ:MONITORING')).toBe('still going\nXEZ:MONITORING');
  });

  /** The instructions spell every marker in capitals. Pinning that the parser agrees: a
   *  lowercase or mixed-case spelling is NOT the contract and must not bind a task. */
  it('accepts only the upper-case spelling', () => {
    expect(parseTaskMarkers('xez:pr=442')).toEqual({});
    expect(parseTaskMarkers('Xez:Pr=442')).toEqual({});
    expect(parseTaskMarkers('XEZ:pr=442')).toEqual({});
    expect(parseTaskMarkers('XEZ:Issue=47')).toEqual({});
  });

  /** Whitespace contract: trailing blanks are forgiven (agents pad line ends), leading
   *  indentation and spaces inside the marker are not. */
  it('forgives trailing blanks but not indentation or spaces inside the marker', () => {
    expect(parseTaskMarkers('XEZ:PR=442\t')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('XEZ:ISSUE=47 \t ')).toEqual({ issue: 47 });
    expect(parseTaskMarkers('\tXEZ:PR=442')).toEqual({});
    expect(parseTaskMarkers('  XEZ:ISSUE=47')).toEqual({});
    expect(parseTaskMarkers('XEZ: PR=442')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR = 442')).toEqual({});
  });

  it('reads a marker on the last line of a turn that has no trailing newline', () => {
    expect(parseTaskMarkers('Opened it.\nXEZ:PR=442')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('XEZ:TITLE=covering the marker parser')).toEqual({
      title: 'covering the marker parser',
    });
  });

  /**
   * The instructions tell the agent "Put markers in plain message text, never inside a
   * code fence". #124 made the parser enforce that rule instead of trusting the emitter:
   * a marker demonstrated inside a fence is prose, exactly like the quoted and decorated
   * mentions below, and `stripTaskMarkers` leaves it in place rather than gutting the
   * block. The fence forms themselves are covered in `runs/task-markers.test.ts`.
   */
  it('does not parse a marker written inside a fenced code block', () => {
    expect(parseTaskMarkers('For example:\n```\nXEZ:PR=442\n```\nthat is the shape.')).toEqual({});
    expect(stripTaskMarkers('```\nXEZ:PR=442\n```')).toBe('```\nXEZ:PR=442\n```');
  });

  /** Prose that merely mentions or quotes a marker is not an emission — the layer that
   *  `7187b42` fixed for the fuzzy tiers. Backticks and list bullets are the shapes an
   *  agent actually produces when it explains the contract. */
  it('treats a quoted or decorated mention as prose, not an emission', () => {
    expect(parseTaskMarkers('I will emit "XEZ:PR=442" once the PR exists')).toEqual({});
    expect(parseTaskMarkers('`XEZ:PR=442`')).toEqual({});
    expect(parseTaskMarkers('- XEZ:PR=442')).toEqual({});
    expect(parseTaskMarkers('> XEZ:ISSUE=47')).toEqual({});
  });

  /** A truncated or nonsensical payload degrades to "no marker". It must never throw:
   *  `parseTaskMarkers` runs on every turn of every run, inside the turn-end handler. */
  it('degrades a truncated or malformed payload to no marker instead of throwing', () => {
    expect(parseTaskMarkers('XEZ:PR')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR=-3')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR=4.5')).toEqual({});
    expect(parseTaskMarkers('XEZ:ISSUE=47abc')).toEqual({});
    expect(parseTaskMarkers('XEZ:')).toEqual({});
    expect(() => parseTaskMarkers('XEZ:PR='.repeat(5_000))).not.toThrow();
    expect(() => stripTaskMarkers('XEZ:PR='.repeat(5_000))).not.toThrow();
  });
});

/**
 * The handoff journal itself (#47, gap R8): the branches that make this module
 * "best-effort — the handoff is a journal, never a reason to fail a run". Every entry
 * point here is called from the run lifecycle, so a throw would take a run down with it.
 */
describe('handoff journal file', () => {
  const roots: string[] = [];

  function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'xez-handoff-'));
    roots.push(dir);
    return dir;
  }

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  const seed = { id: 'run1', title: 'Cover the parser', workflow: 'quick-task', task: '  do the thing  ' };

  it('writes the skeleton next to the run events and returns its path', () => {
    const dir = dataDir();
    const file = seedHandoffFile(dir, seed);

    expect(file).toBe(handoffPath(dir, 'run1'));
    expect(file).toBe(join(dir, 'runs', 'run1.handoff.md'));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# Handoff — Cover the parser');
    expect(text).toContain('**Task id:** run1');
    expect(text).toContain('**Workflow:** quick-task');
    expect(text).toContain('## Goal\n\ndo the thing\n'); // task is trimmed
    expect(text).toContain('## Progress log');
    expect(text).toContain('## Resume notes');
  });

  it('omits the branch and worktree lines when the run has neither', () => {
    const dir = dataDir();
    const text = readFileSync(seedHandoffFile(dir, seed), 'utf8');
    expect(text).not.toContain('**Branch:**');
    expect(text).not.toContain('**Worktree:**');
  });

  it('records the branch and worktree when the run has them', () => {
    const dir = dataDir();
    const text = readFileSync(
      seedHandoffFile(dir, { ...seed, branch: 'xez/2d3d9183', worktreePath: '/wt/2d3d9183' }),
      'utf8',
    );
    expect(text).toContain('**Branch:** xez/2d3d9183\n');
    expect(text).toContain('**Worktree:** /wt/2d3d9183\n');
  });

  it('never overwrites an existing journal — a resume keeps the previous session notes', () => {
    const dir = dataDir();
    const file = seedHandoffFile(dir, seed);
    writeFileSync(file, '# Handoff\n\n## Progress log\n\n- earlier session\n\n## Resume notes\nhalf done\n', 'utf8');

    expect(seedHandoffFile(dir, { ...seed, title: 'A different title' })).toBe(file);
    expect(readFileSync(file, 'utf8')).toContain('- earlier session');
    expect(readFileSync(file, 'utf8')).not.toContain('A different title');
  });

  it('swallows an unwritable data dir instead of failing the run', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'runs'), 'not a directory', 'utf8'); // mkdirSync will ENOTDIR

    let file = '';
    expect(() => {
      file = seedHandoffFile(dir, seed);
    }).not.toThrow();
    expect(file).toBe(handoffPath(dir, 'run1'));
    expect(readHandoff(dir, 'run1')).toBe('');
  });

  it('inserts a heartbeat under the Progress log header, newest first', () => {
    const dir = dataDir();
    seedHandoffFile(dir, seed);
    appendHandoffHeartbeat(dir, 'run1', 'step "setup" complete');
    appendHandoffHeartbeat(dir, 'run1', 'step "author" complete');

    const lines = readHandoff(dir, 'run1').split('\n');
    const header = lines.indexOf('## Progress log');
    expect(lines[header + 1]).toBe('');
    expect(lines[header + 2]).toContain('step "author" complete');
    expect(lines[header + 3]).toContain('step "setup" complete');
    expect(lines[header + 2]).toMatch(/^- \d{4}-\d{2}-\d{2}T[\d:.]+Z — /);
  });

  it('appends at the end when the journal has no Progress log header', () => {
    const dir = dataDir();
    const file = seedHandoffFile(dir, seed);
    writeFileSync(file, 'freeform notes\n', 'utf8');
    appendHandoffHeartbeat(dir, 'run1', 'still ran');

    expect(readHandoff(dir, 'run1')).toMatch(/^freeform notes\n- .* — still ran\n$/);
  });

  it('keeps the appended line on its own line when the journal has no trailing newline', () => {
    const dir = dataDir();
    const file = seedHandoffFile(dir, seed);
    writeFileSync(file, 'freeform notes', 'utf8');
    appendHandoffHeartbeat(dir, 'run1', 'still ran');

    expect(readHandoff(dir, 'run1')).toMatch(/^freeform notes\n- .* — still ran\n$/);
  });

  it('appends to an empty journal without a leading blank line', () => {
    const dir = dataDir();
    const file = seedHandoffFile(dir, seed);
    writeFileSync(file, '', 'utf8');
    appendHandoffHeartbeat(dir, 'run1', 'still ran');

    expect(readHandoff(dir, 'run1')).toMatch(/^- .* — still ran\n$/);
  });

  it('is a no-op when the journal was never seeded', () => {
    const dir = dataDir();
    mkdirSync(join(dir, 'runs'), { recursive: true });

    expect(() => appendHandoffHeartbeat(dir, 'never-seeded', 'note')).not.toThrow();
    expect(readHandoff(dir, 'never-seeded')).toBe('');
  });

  it('reads back the whole journal, and an empty string when there is none', () => {
    const dir = dataDir();
    expect(readHandoff(dir, 'run1')).toBe('');
    seedHandoffFile(dir, seed);
    expect(readHandoff(dir, 'run1')).toContain('# Handoff — Cover the parser');
  });

  it('deletes the journal and tolerates a second delete', () => {
    const dir = dataDir();
    seedHandoffFile(dir, seed);
    deleteHandoff(dir, 'run1');
    expect(readHandoff(dir, 'run1')).toBe('');
    expect(() => deleteHandoff(dir, 'run1')).not.toThrow();
    expect(() => deleteHandoff(dir, 'never-existed')).not.toThrow();
  });
});

/** The variant-comparison column (spec 010): the first few progress lines, and nothing else. */
describe('handoffProgressExcerpt', () => {
  const journal = [
    '# Handoff — x',
    '',
    '## Progress log',
    '',
    '- third',
    '',
    '  - second  ',
    '- first',
    '- fourth',
    '',
    '## Resume notes',
    '- not progress',
  ].join('\n');

  it('returns the first lines under the header, trimmed, skipping blanks', () => {
    expect(handoffProgressExcerpt(journal)).toBe('- third\n- second\n- first');
  });

  it('honours maxLines', () => {
    expect(handoffProgressExcerpt(journal, 1)).toBe('- third');
    expect(handoffProgressExcerpt(journal, 10)).toBe('- third\n- second\n- first\n- fourth');
  });

  it('stops at the next section header', () => {
    expect(handoffProgressExcerpt(journal, 10)).not.toContain('not progress');
  });

  it('is empty when there is no Progress log section, or it holds nothing yet', () => {
    expect(handoffProgressExcerpt('')).toBe('');
    expect(handoffProgressExcerpt('# Handoff — x\n\n## Resume notes\n- later\n')).toBe('');
    expect(handoffProgressExcerpt('## Progress log\n\n\n## Resume notes\n- later\n')).toBe('');
    // A journal with no Progress log header at all must yield nothing, never a slice of
    // whatever prose happens to sit at the header's would-be offset.
    expect(handoffProgressExcerpt('no progress section here\n- but a bullet\n')).toBe('');
  });
});

/**
 * `#471` — the follow-up inbox is opt-in and off by default, because stale pre-saved
 * follow-ups made skill behaviour unpredictable. This is the single source of truth the
 * HTTP route, the CLI and the inbox's "▶ Run" all read, so the exact `'1'` spelling is
 * the contract (AGENTS.md: "opt-in behind a `XEZ_*` flag, off by default").
 */
describe('followupsEnabled', () => {
  it('opts in on exactly "1"', () => {
    expect(followupsEnabled({ XEZ_FOLLOWUPS: '1' })).toBe(true);
  });

  it('stays off for every other spelling, and when the var is absent', () => {
    for (const value of ['0', 'true', 'TRUE', 'yes', 'on', '', ' 1', '1 '])
      expect(followupsEnabled({ XEZ_FOLLOWUPS: value })).toBe(false);
    expect(followupsEnabled({})).toBe(false);
  });

  it('falls back to process.env when no env is passed', () => {
    const previous = process.env.XEZ_FOLLOWUPS;
    try {
      process.env.XEZ_FOLLOWUPS = '1';
      expect(followupsEnabled()).toBe(true);
      delete process.env.XEZ_FOLLOWUPS;
      expect(followupsEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.XEZ_FOLLOWUPS;
      else process.env.XEZ_FOLLOWUPS = previous;
    }
  });
});
