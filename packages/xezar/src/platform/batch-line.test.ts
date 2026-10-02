import { describe, expect, it } from 'vitest';
import { renderEnvPrefix } from '../core/shell-env.ts';
import {
  CMD_LINE_MAX,
  batchInvocation,
  cmdPathSafe,
  cmdPayloadSafe,
  cmdQuotedPathSafe,
  cmdTokenSafe,
  cmdUrlSafe,
  verbatimLineLength,
} from './batch-line.ts';

const CMD = 'C:\\Windows\\System32\\cmd.exe';

/** The BatBadBut family and every character cmd.exe acts on (AC-3). */
const UNSAFE_TOKENS = [
  'x" & calc & "',
  '%PATH%',
  '!x!',
  'a&b',
  'a|b',
  'a<b',
  'a>b',
  'a^b',
  '(x)',
  'a,b',
  'a;b',
  'a=b',
  'a b',
  'C:\\dir\\',
  '""',
  '',
  'a\tb',
  'a\nb',
];

describe('cmdTokenSafe', () => {
  it.each(['--flag', '-v', 'value', 'C:\\dir\\file.txt', 'src/a.ts', 'user@host', 'a+b', '~x', 'v1.2.3', 'a:b'])(
    'accepts %j',
    (token) => {
      expect(cmdTokenSafe(token)).toBe(true);
    },
  );

  it.each(UNSAFE_TOKENS)('refuses %j', (token) => {
    expect(cmdTokenSafe(token)).toBe(false);
  });
});

describe('cmdPathSafe', () => {
  it.each(['C:\\Users\\Jane Doe\\repo', 'D:\\a (x86)\\b', 'C:\\x\\run.bat', 'c:\\a_b-c.d+e@f#g~h'])('accepts %j', (path) => {
    expect(cmdPathSafe(path)).toBe(true);
  });

  // Q-04: common project folders that cmd.exe reads literally inside the quotes xezar writes.
  it.each([
    'C:\\Users\\Łukasz\\repo',
    'C:\\Users\\Zo\u00EB\\repo', // a precomposed letter with a diaeresis
    'D:\\プロジェクト\\x',
    "C:\\Users\\O'Brien\\repo",
    'C:\\OneDrive - Contoso, Inc\\repo',
    'C:\\x\\run2\u00B2.bat',
  ])('accepts the non-ASCII, apostrophe or comma folder %j', (path) => {
    expect(cmdPathSafe(path)).toBe(true);
  });

  it.each([
    'C:\\A&B',
    'C:\\100%',
    'C:\\a!b',
    'C:\\a"b',
    'C:\\a^b',
    'C:\\a;b',
    'C:\\a=b',
    'C:\\a|b',
    'C:\\a<b',
    'C:\\a\uFF02b', // full-width quotation mark: best-fit maps it to `"`
    'C:\\a\uFF05b', // full-width percent sign
    // C-03: letters and marks Windows best-fits to a cmd.exe character in an ANSI code page.
    'C:\\a\u01C0b', // LATIN LETTER DENTAL CLICK -> |
    'C:\\a\u01C3b', // LATIN LETTER RETROFLEX CLICK -> !
    'C:\\a\u02BAb', // MODIFIER LETTER DOUBLE PRIME -> "
    'C:\\a\u02BCb', // MODIFIER LETTER APOSTROPHE -> '
    'C:\\a\u0302b', // COMBINING CIRCUMFLEX ACCENT -> ^
    'C:\\a\u0308b', // COMBINING DIAERESIS -> " (cp437)
    'C:\\a\u030Eb', // COMBINING DOUBLE VERTICAL LINE ABOVE -> "
    'C:\\Users\\zo\u0301\\repo', // a decomposed letter: the whole combining block stays out
    'C:\\a\tb',
    'relative\\x',
    '\\\\srv\\share\\x',
    'C:x',
    'C:\\',
  ])('refuses %j', (path) => {
    expect(cmdPathSafe(path)).toBe(false);
  });
});

describe('cmdQuotedPathSafe', () => {
  it.each(['"C:\\my work\\wt"', '"C:\\Users\\Łukasz\\a, b"'])('accepts %j', (element) => {
    expect(cmdQuotedPathSafe(element)).toBe(true);
  });

  it.each(['C:\\my work', '"C:\\my work\\"', '"C:\\A&B"', '"C:\\a"b"', '""', '"C:\\x', '"C:\\a;b"'])('refuses %j', (element) => {
    expect(cmdQuotedPathSafe(element)).toBe(false);
  });
});

describe('cmdUrlSafe', () => {
  it.each(['http://127.0.0.1:4777/', 'https://example.com/p/a-b_c~d?x=1#top'])('accepts %j', (url) => {
    expect(cmdUrlSafe(url)).toBe(true);
  });

  it.each(['http://x/?a=1&b=2', 'http://x/%41', 'file:///C:/x', 'javascript:alert(1)', 'http://x/ y', 'http://x/"'])(
    'refuses %j',
    (url) => {
      expect(cmdUrlSafe(url)).toBe(false);
    },
  );
});

describe('cmdPayloadSafe', () => {
  it('accepts what renderEnvPrefix writes, followed by a resume command', () => {
    const prefix = renderEnvPrefix({ CLAUDE_CONFIG_DIR: 'C:\\Users\\Jane Doe\\.claude-work', XEZ_X: '1' }, 'win32');
    expect(prefix).not.toBeNull();
    expect(cmdPayloadSafe(`${prefix!}claude --resume 0f8c2a4e-7d1b-4c9e-9a51-3b2d6e8f1a70`)).toBe(true);
    expect(cmdPayloadSafe('claude --resume 0f8c2a4e')).toBe(true);
    expect(cmdPayloadSafe(':')).toBe(true);
  });

  it('accepts an opening cd into a safe folder and a quoted safe path as a token', () => {
    expect(cmdPayloadSafe('cd /d "C:\\Users\\Jane Doe\\repo" && set "A=1" && tool "C:\\a b\\c.txt" --x')).toBe(true);
  });

  it.each([
    ['& in a value', 'set "A=a&b" && claude'],
    ['^ in a value', 'set "A=a^b" && claude'],
    ['% in a value', 'set "A=%PATH%" && claude'],
    ['a quote in a value', 'set "A=a"b" && claude'],
    ['a bad name', 'set "1A=x" && claude'],
    ['a second command', 'claude && calc'],
    ['a pipe', 'claude | more'],
    ['a redirection', 'claude > out.txt'],
    ['an unsafe token', 'claude %PATH%'],
    ['a double space', 'claude  --x'],
    ['a trailing space', 'claude '],
    ['a cd into an unsafe folder', 'cd /d "C:\\A&B" && claude'],
    ['a cd after the environment', 'set "A=1" && cd /d "C:\\x" && claude'],
    ['an unsafe quoted path', 'tool "C:\\a&b"'],
    ['nothing to run', 'set "A=1" && '],
    ['empty', ''],
  ])('refuses %s', (_label, payload) => {
    expect(cmdPayloadSafe(payload)).toBe(false);
  });
});

describe('batchInvocation', () => {
  it('builds /d /v:off /s /c with the outer quotes /s strips', () => {
    expect(batchInvocation('C:\\x y\\build.bat', ['--fast', 'src/a.ts'], CMD)).toEqual({
      file: CMD,
      args: ['/d', '/v:off', '/s', '/c', '""C:\\x y\\build.bat" --fast src/a.ts"'],
    });
    expect(batchInvocation('C:\\x\\build.bat', [], CMD)).toEqual({
      file: CMD,
      args: ['/d', '/v:off', '/s', '/c', '""C:\\x\\build.bat""'],
    });
  });

  it.each(UNSAFE_TOKENS)('refuses the argument %j by position, before building anything', (token) => {
    expect(batchInvocation('C:\\x\\build.bat', ['ok', token], CMD)).toEqual({ refused: 'XEZ_CMD_UNSAFE_ARG', position: 2 });
  });

  it('refuses a batch file in an unsafe folder', () => {
    expect(batchInvocation('C:\\A&B\\build.bat', [], CMD)).toEqual({ refused: 'XEZ_CMD_UNSAFE_PATH' });
    expect(batchInvocation('build.bat', [], CMD)).toEqual({ refused: 'XEZ_CMD_UNSAFE_PATH' });
  });

  it('allows exactly 8191 characters and refuses 8192', () => {
    const base = verbatimLineLength(CMD, ['/d', '/v:off', '/s', '/c', '""C:\\x\\b.bat" "']);
    const fits = 'a'.repeat(CMD_LINE_MAX - base);
    expect(verbatimLineLength(CMD, (batchInvocation('C:\\x\\b.bat', [fits], CMD) as { args: string[] }).args)).toBe(8191);
    expect(batchInvocation('C:\\x\\b.bat', [`${fits}a`], CMD)).toEqual({ refused: 'XEZ_CMD_TOO_LONG' });
  });
});
