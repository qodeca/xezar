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
type Decision = { action: 'skip' | 'none' | 'create' | 'comment' | 'reopen' | 'close'; number?: number; reason: string };
type TrackingModule = {
  LABEL: string;
  MARKER: string;
  MAIN_REF: string;
  TITLE: string;
  normaliseVerdict: (value: unknown) => 'green' | 'red';
  findTrackingIssue: (issues: unknown) => Issue | undefined;
  decide: (input: { verdict: unknown; ref: string | undefined; issues: unknown }) => Decision;
  ghCommands: (decision: Decision, summary: string) => string[][];
  syncTrackingIssue: (options: {
    verdict: unknown;
    ref: string | undefined;
    summary: string;
    gh: (args: string[]) => string;
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
