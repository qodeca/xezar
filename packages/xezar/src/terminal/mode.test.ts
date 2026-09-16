/**
 * AC-09, first half — what the output MODE is, per transport.
 *
 * Named break: `ansi-in-pipe`. Every one of these rows exists because the wrong answer to
 * "is this a terminal" is a log file full of escape codes, or a person who asked for `rich`
 * and silently got nothing.
 */

import { describe, expect, it } from 'vitest';

import { isCapableTty, NARROW_COLUMNS, resolveOnResize, resolveRender } from './mode.ts';

const TTY = { isTty: true, columns: 80, term: 'xterm-256color' };
const NARROW = { ...TTY, columns: 40 };
const PIPE = { isTty: false, term: 'xterm-256color' };

describe('auto', () => {
  it('is rich on a capable terminal at 80 columns', () => {
    const out = resolveRender('auto', 'auto', TTY);
    expect(out.mode).toBe('rich');
    expect(out.table).toBe(true);
    expect(out.colorEnabled).toBe(true);
    expect(out.fallback).toBeUndefined();
  });

  it('is lines on a terminal narrower than 60 columns', () => {
    const out = resolveRender('auto', 'auto', NARROW);
    expect(out.mode).toBe('lines');
    expect(out.table).toBe(false);
  });

  it('is plain off a terminal, and never coloured there', () => {
    const out = resolveRender('auto', 'auto', PIPE);
    expect(out.mode).toBe('plain');
    expect(out.colorEnabled).toBe(false);
  });

  it('is plain on a build machine, whatever CI claims its TERM is', () => {
    expect(resolveRender('auto', 'auto', { ...TTY, ci: 'true' }).mode).toBe('plain');
  });

  it('is plain on TERM=dumb', () => {
    expect(resolveRender('auto', 'auto', { ...TTY, term: 'dumb' }).mode).toBe('plain');
    expect(isCapableTty({ ...TTY, term: 'dumb' })).toBe(false);
  });

  it('exactly 60 columns is still the table; 59 is not', () => {
    expect(resolveRender('auto', 'auto', { ...TTY, columns: NARROW_COLUMNS }).mode).toBe('rich');
    expect(resolveRender('auto', 'auto', { ...TTY, columns: NARROW_COLUMNS - 1 }).mode).toBe('lines');
  });
});

describe('an explicit --output rich', () => {
  it('falls back to plain off a terminal, and says so exactly once', () => {
    const out = resolveRender('rich', 'auto', PIPE);
    expect(out.mode).toBe('plain');
    expect(out.fallback).toEqual({ asked: 'rich', using: 'plain', reason: 'stderr is not a terminal' });
  });

  it('falls back on TERM=dumb, naming that reason instead', () => {
    const out = resolveRender('rich', 'auto', { ...TTY, term: 'dumb' });
    expect(out.mode).toBe('plain');
    expect(out.fallback?.reason).toBe('TERM is dumb');
  });

  it('falls back on CI even with a capable terminal', () => {
    expect(resolveRender('rich', 'auto', { ...TTY, ci: 'true' }).mode).toBe('plain');
  });

  it('is lines, not a fallback, on a narrow terminal — nothing was refused', () => {
    const out = resolveRender('rich', 'auto', NARROW);
    expect(out.mode).toBe('lines');
    expect(out.fallback).toBeUndefined();
  });
});

describe('an explicit --output lines', () => {
  it('is honoured anywhere, including a file — this is the screen-reader answer', () => {
    expect(resolveRender('lines', 'auto', PIPE).mode).toBe('lines');
    expect(resolveRender('lines', 'auto', { ...TTY, ci: 'true' }).mode).toBe('lines');
    expect(resolveRender('lines', 'auto', { ...TTY, term: 'dumb' }).mode).toBe('lines');
  });

  it('is never coloured in a file, including --color always', () => {
    expect(resolveRender('lines', 'auto', PIPE).colorEnabled).toBe(false);
    expect(resolveRender('lines', 'always', PIPE).colorEnabled).toBe(false);
  });
});

describe('colour', () => {
  it('is never on in plain output, not even with --color always', () => {
    // A colour byte in logfmt is not decoration, it is a broken line for every tool that
    // reads it — which is why `plain` outranks the flag.
    expect(resolveRender('auto', 'always', PIPE).colorEnabled).toBe(false);
    expect(resolveRender('rich', 'always', PIPE).colorEnabled).toBe(false);
  });

  it('honours --color never on a terminal', () => {
    expect(resolveRender('auto', 'never', TTY).colorEnabled).toBe(false);
  });

  it('keeps lines colour-free through a pipe even with --color always', () => {
    expect(resolveRender('lines', 'always', PIPE).colorEnabled).toBe(false);
  });
});

describe('resize', () => {
  it('crosses 60 columns between the table and the one-line summary, both ways', () => {
    const wide = resolveRender('auto', 'auto', TTY);
    const narrow = resolveOnResize(wide, 'auto', 'auto', NARROW);
    expect(narrow.mode).toBe('lines');
    const back = resolveOnResize(narrow, 'auto', 'auto', TTY);
    expect(back.mode).toBe('rich');
  });

  it('never re-decides plain: a window drag must not change a whole session format', () => {
    const plain = resolveRender('auto', 'auto', PIPE);
    expect(resolveOnResize(plain, 'auto', 'auto', TTY)).toBe(plain);
  });

  it('never re-runs the fallback notice, because a plain session is never re-resolved', () => {
    // The notice lives on the resolution a plain session keeps for its whole life. Re-resolving
    // on every resize is what would print "asked for rich, using plain" a second time.
    const first = resolveRender('rich', 'auto', { ...TTY, term: 'dumb' });
    expect(first.fallback).toBeDefined();
    expect(resolveOnResize(first, 'rich', 'auto', { ...TTY, columns: 120 })).toBe(first);
  });

  it('a session that is NOT plain never acquires a fallback on resize', () => {
    const wide = resolveRender('rich', 'auto', TTY);
    expect(resolveOnResize(wide, 'rich', 'auto', NARROW).fallback).toBeUndefined();
  });
});

describe('an unknown width', () => {
  it('lays out for 80 columns rather than refusing to draw', () => {
    expect(resolveRender('auto', 'auto', { isTty: true, term: 'xterm' }).columns).toBe(80);
  });
});

it('CI and dumb transports have no decoration even with explicit lines/rich and always colour', () => {
  for (const facts of [PIPE, { ...TTY, ci: '1' }, { ...TTY, term: 'dumb' }]) {
    for (const mode of ['auto', 'lines', 'rich'] as const) {
      expect(resolveRender(mode, 'always', facts).colorEnabled).toBe(false);
      if (mode === 'rich') expect(resolveRender(mode, 'always', facts).mode).toBe('plain');
    }
  }
});
