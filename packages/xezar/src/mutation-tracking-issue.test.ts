import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// `packages/xezar/mutation/tracking-issue.mjs` is how a red nightly MCP mutation gate (#377) reaches
// a person: one GitHub issue, found by label + hidden marker, commented on while the gate stays red,
// reopened when it goes red again, closed when it goes green. Two things go wrong with that shape if
// nothing pins them — a second issue per red spell, and a feature-branch dispatch closing the issue
// that tracks `main`. The fixture issue lists below are what `gh issue list --json` returns.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Issue = { number: number; state: string; body?: string | null };
type Decision = {
  action: 'skip' | 'none' | 'create' | 'comment' | 'reopen' | 'close' | 'note' | 'create-closed';
  number?: number;
  reason: string;
};
type TrackingModule = {
  LABEL: string;
  MARKER: string;
  MAIN_REF: string;
  TITLE: string;
  normaliseVerdict: (value: unknown) => 'green' | 'red';
  findTrackingIssue: (issues: unknown) => Issue | undefined;
  runMarker: (runId: string | number) => string;
  parseNewSurvivors: (value: unknown) => number | null | undefined;
  alreadyPosted: (issue: { body?: string | null }, comments: unknown, runId: string | number) => boolean;
  decide: (input: { verdict: unknown; ref: string | undefined; issues: unknown; newSurvivors?: number | null }) => Decision;
  ghCommands: (decision: Decision, summary: string, runId?: string | number) => string[][];
  syncTrackingIssue: (options: {
    verdict: unknown;
    ref: string | undefined;
    summary: string;
    gh: (args: string[]) => string;
    runId?: string | number;
    newSurvivors?: number | null;
  }) => Decision;
};

const t = (await import(
  pathToFileURL(join(REPO_ROOT, 'packages/xezar/mutation/tracking-issue.mjs')).href
)) as TrackingModule;

const MAIN = 'refs/heads/main';
const tracked = (number: number, state: 'OPEN' | 'CLOSED'): Issue => ({
  number,
  state,
  body: `${t.MARKER}\n\n## MCP mutation gate — FAILED`,
});

describe('the tracking issue decision (#377)', () => {
  it('uses the agreed label and hidden marker', () => {
    expect(t.LABEL).toBe('mutation-nightly');
    expect(t.MARKER).toBe('<!-- xezar:mutation-nightly -->');
    expect(t.MAIN_REF).toBe(MAIN);
  });

  it('files an issue on the first red night', () => {
    expect(t.decide({ verdict: 'red', ref: MAIN, issues: [] })).toMatchObject({ action: 'create' });
  });

  it('comments on the same open issue on a second red night — never a second issue', () => {
    expect(t.decide({ verdict: 'red', ref: MAIN, issues: [tracked(501, 'OPEN')] })).toMatchObject({
      action: 'comment',
      number: 501,
    });
  });

  it('reopens that same issue when the gate goes red after a green night', () => {
    expect(t.decide({ verdict: 'red', ref: MAIN, issues: [tracked(501, 'CLOSED')] })).toMatchObject({
      action: 'reopen',
      number: 501,
    });
  });

  it('closes the open issue on a green night, and does nothing when none is open', () => {
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'OPEN')] })).toMatchObject({
      action: 'close',
      number: 501,
    });
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'CLOSED')] }).action).toBe('none');
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [] }).action).toBe('none');
  });

  it('touches nothing for a run on any ref but main', () => {
    for (const ref of ['refs/heads/xez/acc2508d', 'refs/heads/mainline', 'refs/tags/v1.0.0', undefined]) {
      expect(t.decide({ verdict: 'green', ref, issues: [tracked(501, 'OPEN')] }).action, String(ref)).toBe('skip');
      expect(t.decide({ verdict: 'red', ref, issues: [] }).action, String(ref)).toBe('skip');
    }
  });

  it('treats anything but an explicit green as red — a lost verdict is not a pass', () => {
    for (const verdict of ['red', '', undefined, 'GREEN', 'success', null]) {
      expect(t.normaliseVerdict(verdict), String(verdict)).toBe('red');
    }
    expect(t.normaliseVerdict('green')).toBe('green');
    expect(t.decide({ verdict: '', ref: MAIN, issues: [] }).action).toBe('create');
  });

  it('ignores a labelled issue without the marker, and picks the newest marked one', () => {
    const impostor: Issue = { number: 900, state: 'OPEN', body: 'someone put the label on this' };
    expect(t.decide({ verdict: 'red', ref: MAIN, issues: [impostor] }).action).toBe('create');
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [impostor] }).action).toBe('none');
    expect(t.findTrackingIssue([tracked(10, 'CLOSED'), impostor, tracked(42, 'OPEN'), { number: 7, state: 'OPEN', body: null }])).toMatchObject({
      number: 42,
    });
  });

  it('refuses an issue list it could not read, instead of filing a duplicate', () => {
    // The populated-input control: an empty ARRAY is a real "no issue yet"; anything that is not
    // an array is "we never loaded the list", and the two must not take the same branch.
    for (const unreadable of [undefined, null, {}, 'not json']) {
      expect(() => t.decide({ verdict: 'red', ref: MAIN, issues: unreadable }), String(unreadable)).toThrow(/not an array/);
    }
  });
});

describe('carrying the decision out through gh', () => {
  it('creates the issue with the label, the title and the marker at the top of the body', () => {
    const [create, ...rest] = t.ghCommands({ action: 'create', reason: '' }, 'SUMMARY');
    expect(rest).toEqual([]);
    expect(create!.slice(0, 2)).toEqual(['issue', 'create']);
    expect(create).toEqual(expect.arrayContaining(['--label', t.LABEL, '--title', t.TITLE]));
    expect(create![create!.indexOf('--body') + 1]).toBe(`${t.MARKER}\n\nSUMMARY`);
  });

  it('reopens before commenting, and comments before closing', () => {
    expect(t.ghCommands({ action: 'reopen', number: 5, reason: '' }, 'S')).toEqual([
      ['issue', 'reopen', '5'],
      ['issue', 'comment', '5', '--body', 'S'],
    ]);
    expect(t.ghCommands({ action: 'close', number: 5, reason: '' }, 'S')).toEqual([
      ['issue', 'comment', '5', '--body', 'S'],
      ['issue', 'close', '5'],
    ]);
    expect(t.ghCommands({ action: 'comment', number: 5, reason: '' }, 'S')).toEqual([['issue', 'comment', '5', '--body', 'S']]);
    expect(t.ghCommands({ action: 'none', reason: '' }, 'S')).toEqual([]);
    expect(t.ghCommands({ action: 'skip', reason: '' }, 'S')).toEqual([]);
  });

  it('ensures the label, lists by label across every state (not search), then acts', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return args[1] === 'list' ? JSON.stringify([tracked(77, 'CLOSED')]) : '';
    };
    const decision = t.syncTrackingIssue({ verdict: 'red', ref: MAIN, summary: 'S', gh });
    expect(decision).toMatchObject({ action: 'reopen', number: 77 });
    expect(calls[0]!.slice(0, 3)).toEqual(['label', 'create', t.LABEL]);
    expect(calls[0]).toContain('--force');
    expect(calls[1]).toEqual(expect.arrayContaining(['issue', 'list', '--label', t.LABEL, '--state', 'all']));
    expect(calls[1]).not.toContain('--search');
    expect(calls.slice(2)).toEqual([
      ['issue', 'reopen', '77'],
      ['issue', 'comment', '77', '--body', 'S'],
    ]);
  });

  it('calls gh not at all off main', () => {
    const calls: string[][] = [];
    const decision = t.syncTrackingIssue({
      verdict: 'green',
      ref: 'refs/heads/feature',
      summary: 'S',
      gh: (args) => {
        calls.push(args);
        return '[]';
      },
    });
    expect(decision.action).toBe('skip');
    expect(calls).toEqual([]);
  });

  it('fails the step when gh answers something that is not JSON', () => {
    const gh = (args: string[]) => (args[1] === 'list' ? 'HTTP 502' : '');
    expect(() => t.syncTrackingIssue({ verdict: 'red', ref: MAIN, summary: 'S', gh })).toThrow(/did not answer JSON/);
  });
});

describe('the early note: new survivors on a green night (#377, owner decision 2026-09-15)', () => {
  it('stays green and notes new survivors on the closed issue — a comment, never a reopen', () => {
    // Named break: drop the note branch from `decide`, and a green night with new survivors does nothing.
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'CLOSED')], newSurvivors: 3 })).toMatchObject({
      action: 'note',
      number: 501,
    });
    expect(t.ghCommands({ action: 'note', number: 501, reason: '' }, 'S')).toEqual([['issue', 'comment', '501', '--body', 'S']]);
  });

  it('keeps the green close when the issue is open, with the new survivors in that one comment', () => {
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'OPEN')], newSurvivors: 3 })).toMatchObject({ action: 'close', number: 501 });
  });

  it('files the note as a closed issue when there is no tracking issue at all', () => {
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [], newSurvivors: 2 }).action).toBe('create-closed');
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') return 'https://github.com/qodeca/xezar/issues/612\n';
      return '';
    };
    t.syncTrackingIssue({ verdict: 'green', ref: MAIN, summary: 'S', gh, runId: 42, newSurvivors: 2 });
    expect(calls.slice(2).map((c) => c.slice(0, 3))).toEqual([
      ['issue', 'create', '--title'],
      ['issue', 'close', '612'],
    ]);
  });

  it('adds nothing on a green night with no new survivors, and nothing changes for a red one', () => {
    // The control: the note is about NEW survivors, not about survivors.
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'CLOSED')], newSurvivors: 0 }).action).toBe('none');
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [], newSurvivors: 0 }).action).toBe('none');
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'CLOSED')] }).action).toBe('none');
    // Below the floor the verdict is red, and red decides — new survivors or not.
    expect(t.decide({ verdict: 'red', ref: MAIN, issues: [tracked(501, 'CLOSED')], newSurvivors: 9 }).action).toBe('reopen');
    expect(t.decide({ verdict: 'red', ref: MAIN, issues: [tracked(501, 'OPEN')], newSurvivors: 0 }).action).toBe('comment');
  });

  it('treats a grouping that did not run as worth a note, not as "nothing new"', () => {
    expect(t.parseNewSurvivors('unknown')).toBeNull();
    expect(t.parseNewSurvivors('')).toBeNull();
    expect(t.parseNewSurvivors('4')).toBe(4);
    expect(t.parseNewSurvivors('0')).toBe(0);
    expect(t.parseNewSurvivors(undefined)).toBeUndefined();
    expect(t.decide({ verdict: 'green', ref: MAIN, issues: [tracked(501, 'CLOSED')], newSurvivors: null })).toMatchObject({ action: 'note' });
  });

  it('never notes off main', () => {
    expect(t.decide({ verdict: 'green', ref: 'refs/heads/feature', issues: [tracked(501, 'CLOSED')], newSurvivors: 3 }).action).toBe('skip');
  });
});

describe('one comment per run', () => {
  const RUN = 34999068325;

  it('stamps every body with the run, so a re-run can see what it already posted', () => {
    expect(t.runMarker(RUN)).toBe('<!-- xezar:mutation-nightly run=34999068325 -->');
    const [create] = t.ghCommands({ action: 'create', reason: '' }, 'S', RUN);
    expect(create![create!.indexOf('--body') + 1]).toBe(`${t.MARKER}\n\n${t.runMarker(RUN)}\nS`);
    expect(t.ghCommands({ action: 'reopen', number: 5, reason: '' }, 'S', RUN)[1]).toEqual(['issue', 'comment', '5', '--body', `${t.runMarker(RUN)}\nS`]);
  });

  const syncWith = (issue: Issue, comments: { body: string }[], verdict: string, newSurvivors?: number) => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[1] === 'list') return JSON.stringify([issue]);
      if (args[1] === 'view') return JSON.stringify({ comments });
      return '';
    };
    const decision = t.syncTrackingIssue({ verdict, ref: MAIN, summary: 'S', gh, runId: RUN, newSurvivors });
    return { decision, acted: calls.filter((c) => c[0] === 'issue' && !['list', 'view'].includes(c[1]!)) };
  };

  it('posts no second comment when this run already commented — a re-run of the report job', () => {
    // Named break: skip the `alreadyPosted` check in `syncTrackingIssue`, and the re-run comments twice.
    const again = syncWith(tracked(501, 'OPEN'), [{ body: 'someone else' }, { body: `${t.runMarker(RUN)}\nS` }], 'red');
    expect(again.decision.action).toBe('comment');
    expect(again.acted).toEqual([]);
  });

  it('still changes the issue state on a re-run, and skips only the comment', () => {
    const reopen = syncWith(tracked(501, 'CLOSED'), [{ body: `${t.runMarker(RUN)}\nS` }], 'red');
    expect(reopen.acted).toEqual([['issue', 'reopen', '501']]);
    const close = syncWith(tracked(501, 'OPEN'), [{ body: `${t.runMarker(RUN)}\nS` }], 'green', 2);
    expect(close.acted).toEqual([['issue', 'close', '501']]);
  });

  it('counts an issue this run created as already posted', () => {
    const created = { number: 501, state: 'OPEN', body: `${t.MARKER}\n\n${t.runMarker(RUN)}\nS` };
    expect(syncWith(created, [], 'red').acted).toEqual([]);
  });

  it('comments normally when only OTHER runs have posted — the control', () => {
    const other = syncWith(tracked(501, 'CLOSED'), [{ body: `${t.runMarker(RUN - 1)}\nS` }], 'green', 1);
    expect(other.decision.action).toBe('note');
    expect(other.acted).toEqual([['issue', 'comment', '501', '--body', `${t.runMarker(RUN)}\nS`]]);
  });

  it('refuses a comment list it could not read, instead of posting a duplicate', () => {
    expect(() => t.alreadyPosted({ body: '' }, undefined, RUN)).toThrow(/not an array/);
    const gh = (args: string[]) => (args[1] === 'list' ? JSON.stringify([tracked(501, 'OPEN')]) : args[1] === 'view' ? 'HTTP 502' : '');
    expect(() => t.syncTrackingIssue({ verdict: 'red', ref: MAIN, summary: 'S', gh, runId: RUN })).toThrow(/did not answer JSON/);
  });
});
