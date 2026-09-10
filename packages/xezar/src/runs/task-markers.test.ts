import { describe, expect, it } from 'vitest';
import { parseTaskMarkers, stripTaskMarkers } from './task-markers.ts';

/** Spec 2026-07-18-task-ref-markers — the in-band declaration layer above the fuzzy tiers. */
describe('parseTaskMarkers', () => {
  it('reads each marker off its own line', () => {
    expect(parseTaskMarkers('Working on it.\nXEZ:PR=442\nXEZ:ISSUE=433\nXEZ:TITLE=fixing plan rendering\ndone soon')).toEqual({
      pr: 442,
      issue: 433,
      title: 'fixing plan rendering',
    });
  });

  it('the last occurrence of a marker wins', () => {
    expect(parseTaskMarkers('XEZ:PR=1\nsome progress\nXEZ:PR=500')).toEqual({ pr: 500 });
    expect(parseTaskMarkers('XEZ:TITLE=first guess\nXEZ:TITLE=implementing comment threads')).toEqual({
      title: 'implementing comment threads',
    });
  });

  it('is line-anchored — prose mentions and inline text never parse', () => {
    expect(parseTaskMarkers('I will emit XEZ:PR=442 when the PR exists')).toEqual({});
    expect(parseTaskMarkers('  XEZ:PR=442')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR=442 (the review PR)')).toEqual({});
  });

  it('the instruction placeholder and junk values are inert', () => {
    expect(parseTaskMarkers('XEZ:PR=<number>')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR=')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR=0')).toEqual({});
    expect(parseTaskMarkers('XEZ:PR=99999999999')).toEqual({});
    expect(parseTaskMarkers('XEZ:TITLE=   ')).toEqual({});
  });

  it('tolerates trailing whitespace and CRLF line endings', () => {
    expect(parseTaskMarkers('XEZ:PR=7  \r\nXEZ:ISSUE=9\r\n')).toEqual({ pr: 7, issue: 9 });
  });

  it('finds nothing in plain prose', () => {
    expect(parseTaskMarkers('renamed the settings page')).toEqual({});
    expect(parseTaskMarkers('')).toEqual({});
  });
});

/** Spec 2026-07-21-report-ref-discovery — the report-tier lines skills end their runs with. */
describe('parseTaskMarkers — report-tier reference lines', () => {
  it('reads the human-friendly PR/Issue report lines', () => {
    const report = [
      'om-auto-create-pr: add dark mode',
      'Issue: #433 (link: https://github.com/qodeca/xezar/issues/433)',
      'PR: #442 (link: https://github.com/qodeca/xezar/pull/442)',
      'Status: complete',
    ].join('\n');
    expect(parseTaskMarkers(report)).toEqual({ pr: 442, issue: 433 });
  });

  it('a XEZ declaration in the same turn outranks a report line', () => {
    expect(
      parseTaskMarkers('XEZ:PR=7\nPR: #442 (link: https://github.com/o/r/pull/442)'),
    ).toEqual({ pr: 7 });
    expect(
      parseTaskMarkers('Issue: #9 (link: https://github.com/o/r/issues/9)\nXEZ:ISSUE=3'),
    ).toEqual({ issue: 3 });
  });

  it('still accepts the legacy env-style markers from older skill versions', () => {
    expect(parseTaskMarkers('PR_URL=https://github.com/o/r/pull/442\nPR_NUMBER=442')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('PR_URL=https://github.com/o/r/pull/442')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('ISSUE_NUMBER=12')).toEqual({ issue: 12 });
  });

  it('a report line outranks a legacy marker; the last report line wins', () => {
    expect(parseTaskMarkers('PR_NUMBER=1\nPR: #2 (link: https://github.com/o/r/pull/2)')).toEqual({ pr: 2 });
    expect(
      parseTaskMarkers(
        'PR: #1 (link: https://github.com/o/r/pull/1)\nPR: #2 (link: https://github.com/o/r/pull/2)',
      ),
    ).toEqual({ pr: 2 });
  });

  it('is line-anchored and exact-shape — prose, placeholders and decorated lines never parse', () => {
    expect(parseTaskMarkers('the report ends with PR: #442 (link: https://github.com/o/r/pull/442)')).toEqual({});
    expect(parseTaskMarkers('PR: #<PR number> (link: <full PR URL>)')).toEqual({});
    expect(parseTaskMarkers('- PR: #442 (link: https://github.com/o/r/pull/442)')).toEqual({});
    expect(parseTaskMarkers('PR: #442 (link: https://github.com/o/r/pull/442) — merged')).toEqual({});
    expect(parseTaskMarkers('PR: 442')).toEqual({});
  });

  it('tolerates trailing whitespace and CRLF', () => {
    expect(parseTaskMarkers('PR: #7 (link: https://github.com/o/r/pull/7)  \r\n')).toEqual({ pr: 7 });
  });
});

/**
 * Fenced code blocks (#124) — a marker an agent DEMONSTRATES is not a marker it emits.
 * The instructions have always said "put markers in plain message text, never inside a
 * code fence"; before this the rule rested on emitter compliance alone and a real agent
 * tripped it. Everything in this block is NEW behaviour unless a test says GUARD.
 */
describe('parseTaskMarkers — fenced code blocks (#124)', () => {
  it('ignores a marker inside a plain ``` fence (issue #124, first example)', () => {
    expect(parseTaskMarkers('For example:\n```\nXEZ:PR=442\n```\nthat is the shape.')).toEqual({});
  });

  it('ignores a marker inside every fence form agents actually write', () => {
    // an info string
    expect(parseTaskMarkers('```js\nXEZ:PR=442\n```')).toEqual({});
    expect(parseTaskMarkers('```text\nXEZ:ISSUE=47\n```')).toEqual({});
    // tildes
    expect(parseTaskMarkers('~~~\nXEZ:PR=442\n~~~')).toEqual({});
    expect(parseTaskMarkers('~~~md\nXEZ:TITLE=documenting the contract\n~~~')).toEqual({});
    // longer runs, and a shorter run inside them that does not close the block
    expect(parseTaskMarkers('````\n```\nXEZ:PR=442\n```\n````')).toEqual({});
    // an indented fence (CommonMark allows up to three leading spaces)
    expect(parseTaskMarkers('   ```\nXEZ:PR=442\n   ```')).toEqual({});
    // a closing fence carrying trailing blanks, and CRLF line endings
    expect(parseTaskMarkers('```\r\nXEZ:PR=442\r\n```  \r\n')).toEqual({});
  });

  /**
   * DELIBERATE CHOICE: an unclosed fence swallows everything after it. That is
   * CommonMark's own rule and what the cockpit's markdown renderer already shows the
   * user for a half-streamed block, so the record agrees with the transcript instead of
   * binding a task to a line the user is reading as code.
   */
  it('treats everything after an unclosed fence as inside it', () => {
    expect(parseTaskMarkers('Here is the shape:\n```\nXEZ:PR=442')).toEqual({});
    expect(parseTaskMarkers('~~~\nstill streaming\nXEZ:ISSUE=47\nXEZ:TITLE=half a block')).toEqual({});
  });

  it('ignores the report-tier and legacy lines inside a fence too', () => {
    expect(parseTaskMarkers('```\nPR: #442 (link: https://github.com/o/r/pull/442)\n```')).toEqual({});
    expect(parseTaskMarkers('```sh\nPR_NUMBER=442\nISSUE_NUMBER=12\n```')).toEqual({});
  });

  it('lets a real marker outside the fence win over a demonstrated one', () => {
    expect(parseTaskMarkers('```\nXEZ:PR=442\n```\nXEZ:PR=7')).toEqual({ pr: 7 });
    expect(parseTaskMarkers('XEZ:PR=7\n```\nXEZ:PR=442\n```')).toEqual({ pr: 7 });
  });

  /** GUARD — passes before and after the fix. A fence that opens and closes must not
   *  disturb the markers around it: this is the load-bearing behaviour every task
   *  depends on, and the shape most likely to break when fence tracking goes wrong. */
  it('GUARD: markers outside a closed fence still bind exactly as before', () => {
    expect(parseTaskMarkers('```js\nconst a = 1;\n```\nXEZ:PR=442\nXEZ:ISSUE=47')).toEqual({
      pr: 442,
      issue: 47,
    });
    expect(parseTaskMarkers('XEZ:PR=442\n```\ncode\n```\nXEZ:TITLE=fixing the parser')).toEqual({
      pr: 442,
      title: 'fixing the parser',
    });
  });

  /** GUARD — a lone triple backtick used inline, not as a block opener, must not start a
   *  fence and swallow the turn's real marker. */
  it('GUARD: a one-line ```inline``` span does not open a block', () => {
    expect(parseTaskMarkers('the ```fence``` shape\nXEZ:PR=442')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('```fence``` is the shape\nXEZ:PR=442')).toEqual({ pr: 442 });
  });
});

describe('stripTaskMarkers', () => {
  it('removes complete marker lines and keeps the surrounding text', () => {
    expect(stripTaskMarkers('Opened the PR.\nXEZ:PR=442\nXEZ:TITLE=fixing plan rendering\nNext: tests.')).toBe(
      'Opened the PR.\nNext: tests.',
    );
  });

  it('leaves prose mentions and non-marker lines alone', () => {
    const text = 'I will emit XEZ:PR=442 later\nnormal line';
    expect(stripTaskMarkers(text)).toBe(text);
  });

  it('is a no-op on text without any XEZ prefix', () => {
    expect(stripTaskMarkers('plain progress update')).toBe('plain progress update');
  });

  it('leaves report-tier reference lines visible — they are human-readable by design', () => {
    const text = 'PR: #442 (link: https://github.com/o/r/pull/442)\nXEZ:PR=442\ndone';
    expect(stripTaskMarkers(text)).toBe('PR: #442 (link: https://github.com/o/r/pull/442)\ndone');
  });

  /** NEW behaviour (#124): a demonstrated marker stays put. Stripping it gutted the
   *  agent's own example and left an empty fence in the transcript. */
  it('leaves a marker inside a fenced code block in place (issue #124, second example)', () => {
    expect(stripTaskMarkers('```\nXEZ:PR=442\n```')).toBe('```\nXEZ:PR=442\n```');
    expect(stripTaskMarkers('```js\nXEZ:TITLE=an example\n```')).toBe('```js\nXEZ:TITLE=an example\n```');
    expect(stripTaskMarkers('~~~\nXEZ:ISSUE=47\n~~~')).toBe('~~~\nXEZ:ISSUE=47\n~~~');
    expect(stripTaskMarkers('```\nXEZ:PR=442')).toBe('```\nXEZ:PR=442');
  });

  it('strips the emitted marker while keeping the demonstrated one', () => {
    expect(stripTaskMarkers('Like this:\n```\nXEZ:PR=442\n```\nXEZ:PR=7\ndone')).toBe(
      'Like this:\n```\nXEZ:PR=442\n```\ndone',
    );
  });
});
