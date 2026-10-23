import { describe, expect, it } from 'vitest';
import { renderEnvPrefix, shellQuote, terminalCommandLine, terminalLineRefusal, withEnvPrefix } from './shell-env.ts';

/**
 * Rendering an agent account's config dir into a shell command (spec 2026-07-29-agent-profiles).
 *
 * The two properties worth pinning: the assignment must PERSIST for the session (the terminal
 * window stays open and the user types the next `claude` themselves), and an unrenderable value
 * must produce `null` rather than a best guess — a terminal silently pointed at the wrong account
 * is the failure this whole path exists to prevent.
 */
describe('renderEnvPrefix', () => {
  it('adds nothing for an empty env — the zero-config command is untouched', () => {
    expect(renderEnvPrefix({}, 'linux')).toBe('');
    expect(withEnvPrefix('claude --resume abc', {}, 'linux')).toBe('claude --resume abc');
  });

  it('exports on POSIX so the variable outlives the command', () => {
    expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz' }, 'darwin'))
      .toBe("export CLAUDE_CONFIG_DIR='/home/u/.claude-klaudiusz'; ");
  });

  it('uses `set` on Windows, where a POSIX assignment is meaningless', () => {
    expect(renderEnvPrefix({ CODEX_HOME: 'C:\\Users\\u\\codex-klaudiusz' }, 'win32'))
      .toBe('set "CODEX_HOME=C:\\Users\\u\\codex-klaudiusz" && ');
  });

  it('quotes a POSIX path containing spaces and single quotes', () => {
    expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: "/home/u/it's here" }, 'linux'))
      .toBe("export CLAUDE_CONFIG_DIR='/home/u/it'\\''s here'; ");
  });

  it('refuses control characters on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: `/home/u${String.fromCharCode(10)}evil` }, platform))
        .toBeNull();
    }
  });

  // #833 review round 2. Break: a C0-only check — U+009B (8-bit CSI) survives single-quoting and a
  // terminal honours it as an escape, so the "safe" command carried it to the terminal raw.
  it('refuses C1 control characters and DEL on every platform, but not ordinary non-ASCII', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const code of [0x7f, 0x80, 0x9b, 0x9f]) {
        expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: `/home/u${String.fromCharCode(code)}31m` }, platform), `${platform} U+${code.toString(16)}`)
          .toBeNull();
      }
      // The first character past the range, and an accented folder name, still render.
      expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: '/home/u x' }, platform)).not.toBeNull();
      expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: '/home/zoë' }, platform)).not.toBeNull();
    }
  });

  it('refuses cmd.exe metacharacters that have no escape inside a quoted `set`', () => {
    for (const bad of ['C:\\a"b', 'C:\\a%PATH%b', 'C:\\a!b!']) {
      expect(renderEnvPrefix({ CODEX_HOME: bad }, 'win32'), bad).toBeNull();
    }
    // The same paths are fine on POSIX, where single-quoting makes them inert — refusing them
    // there would be a limitation with no cause.
    for (const ok of ['C:\\a"b', 'C:\\a%PATH%b']) {
      expect(renderEnvPrefix({ CODEX_HOME: ok }, 'linux'), ok).not.toBeNull();
    }
  });

  it('refuses a name that is not a shell identifier', () => {
    expect(renderEnvPrefix({ 'NOT AN IDENT': '/x' }, 'linux')).toBeNull();
    expect(renderEnvPrefix({ '1LEADING': '/x' }, 'linux')).toBeNull();
  });

  it('renders several assignments in order', () => {
    expect(renderEnvPrefix({ A: '1', B: '2' }, 'linux')).toBe("export A='1'; export B='2'; ");
  });
});

describe('withEnvPrefix', () => {
  it('prefixes the command, or answers null when the env cannot be rendered', () => {
    expect(withEnvPrefix('claude --resume abc', { CLAUDE_CONFIG_DIR: '/w' }, 'linux'))
      .toBe("export CLAUDE_CONFIG_DIR='/w'; claude --resume abc");
    expect(withEnvPrefix('claude', { CLAUDE_CONFIG_DIR: 'a"b' }, 'win32')).toBeNull();
  });
});

describe('shellQuote', () => {
  it('makes every non-control character inert', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('a b$c`d')).toBe("'a b$c`d'");
  });
});

describe('terminalCommandLine – the one copy-paste takeover line', () => {
  const account = { CLAUDE_CONFIG_DIR: '/home/p/.claude-work' };

  it('POSIX: single-quotes the folder (also a quote inside it) and keeps the account', () => {
    expect(terminalCommandLine("/r/it's here", 'claude --resume s1', account, 'linux')).toBe(
      `cd '/r/it'\\''s here' && export CLAUDE_CONFIG_DIR='/home/p/.claude-work'; claude --resume s1`,
    );
    expect(terminalCommandLine('/r/wt', 'codex resume s1', {}, 'darwin')).toBe(`cd '/r/wt' && codex resume s1`);
  });

  it('Windows: `cd /d` with the folder in double quotes, and the account as `set`', () => {
    expect(terminalCommandLine('C:\\dev\\my proj', 'claude --resume s1', { CLAUDE_CONFIG_DIR: 'C:\\acc' }, 'win32')).toBe(
      'cd /d "C:\\dev\\my proj" && set "CLAUDE_CONFIG_DIR=C:\\acc" && claude --resume s1',
    );
  });

  it('fails closed: a Windows folder cmd.exe would re-read, or an account it cannot embed, is null', () => {
    expect(terminalCommandLine('C:\\dev\\a"b', 'claude --resume s1', {}, 'win32')).toBeNull();
    expect(terminalCommandLine('C:\\dev\\a%PATH%', 'claude --resume s1', {}, 'win32')).toBeNull();
    expect(terminalCommandLine('C:\\dev', 'claude --resume s1', { CLAUDE_CONFIG_DIR: 'C:\\a%b' }, 'win32')).toBeNull();
    expect(terminalCommandLine('/r', 'claude --resume s1', { CLAUDE_CONFIG_DIR: '/a\nb' }, 'linux')).toBeNull();
  });
});

describe('terminalLineRefusal – one reason per refused line', () => {
  it('Windows: a folder cmd.exe would re-read is a folder refusal, not an account one', () => {
    expect(terminalLineRefusal('C:\\dev\\a"b', 'claude --resume s1', {}, 'win32')).toBe('folder');
    expect(terminalLineRefusal('C:\\dev\\a%PATH%', 'claude --resume s1', { CLAUDE_CONFIG_DIR: 'C:\\acc' }, 'win32')).toBe('folder');
  });

  it('Windows: an account folder cmd.exe cannot embed is an account refusal, even in a good folder', () => {
    expect(terminalLineRefusal('C:\\dev', 'claude --resume s1', { CLAUDE_CONFIG_DIR: 'C:\\a%b' }, 'win32')).toBe('account');
  });

  it('agrees with terminalCommandLine: null exactly when a line is built', () => {
    const cases: Array<[string, Record<string, string>, NodeJS.Platform]> = [
      ['C:\\dev', {}, 'win32'],
      ['C:\\dev\\a"b', {}, 'win32'],
      ['C:\\dev', { CLAUDE_CONFIG_DIR: 'C:\\a!b' }, 'win32'],
      ['/r/a"b', {}, 'linux'],
      ['/r', { CLAUDE_CONFIG_DIR: '/a\nb' }, 'linux'],
    ];
    for (const [cwd, env, platform] of cases) {
      expect(terminalLineRefusal(cwd, 'claude --resume s1', env, platform) === null).toBe(
        terminalCommandLine(cwd, 'claude --resume s1', env, platform) !== null,
      );
    }
  });
});
