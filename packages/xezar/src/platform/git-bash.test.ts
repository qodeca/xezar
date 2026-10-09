import { describe, expect, it } from 'vitest';
import { gitBashEnv, gitRoot, msysQuote } from './git-bash.ts';

const GIT = 'C:\\Program Files\\Git';

/** A fake disk: `files` exist; `links` maps a path to the real path it resolves to. */
function disk(files: string[], links: Record<string, string> = {}) {
  const lower = new Set(files.map((f) => f.toLowerCase()));
  return {
    exists: (path: string) => lower.has(path.toLowerCase()),
    realpath: (path: string) => {
      for (const [from, to] of Object.entries(links)) {
        if (path.toLowerCase().startsWith(from.toLowerCase())) return to + path.slice(from.length);
      }
      return lower.has(path.toLowerCase()) || files.some((f) => f.toLowerCase().startsWith(`${path.toLowerCase()}\\`)) ? path : null;
    },
  };
}

const fullGit = (root: string) => [`${root}\\cmd\\git.exe`, `${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`];
const env = (path: string): NodeJS.ProcessEnv => ({ PATH: path, SystemRoot: 'C:\\Windows' });

describe('gitRoot (#963)', () => {
  it('finds Git from a PATH folder holding git.exe in Git\'s layout', () => {
    expect(gitRoot(env(`C:\\Windows\\System32;${GIT}\\cmd`), disk(fullGit(GIT)))).toBe(GIT);
    expect(gitRoot(env(`${GIT}\\mingw64\\bin`), disk([...fullGit(GIT), `${GIT}\\mingw64\\bin\\git.exe`]))).toBe(GIT);
  });

  it('falls back to the install folders', () => {
    const files = [`${GIT}\\bin\\bash.exe`, `${GIT}\\usr\\bin\\bash.exe`];
    expect(gitRoot({ PATH: '', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' }, disk(files))).toBe(GIT);
  });

  it('never takes the bash.exe Windows ships (WSL\'s), even first on PATH', () => {
    const files = ['C:\\Windows\\System32\\bash.exe'];
    expect(gitRoot(env('C:\\Windows\\System32'), disk(files))).toBeNull();
  });

  it('refuses a Git layout without both bash.exe files', () => {
    expect(gitRoot(env(`${GIT}\\cmd`), disk([`${GIT}\\cmd\\git.exe`, `${GIT}\\bin\\bash.exe`]))).toBeNull();
  });

  it('refuses a root whose usr\\bin\\bash.exe is a junction into System32', () => {
    const fake = 'C:\\Tools\\Git';
    const files = [...fullGit(fake), 'C:\\Windows\\System32\\bash.exe'];
    const links = { [`${fake}\\usr\\bin`]: 'C:\\Windows\\System32' };
    expect(gitRoot(env(`${fake}\\cmd`), disk(files, links))).toBeNull();
  });

  it('refuses a root whose bash.exe really lives outside it', () => {
    const fake = 'C:\\Shim\\Git';
    const files = [...fullGit(fake), 'D:\\elsewhere\\bash.exe'];
    const links = { [`${fake}\\usr\\bin\\bash.exe`]: 'D:\\elsewhere\\bash.exe' };
    expect(gitRoot(env(`${fake}\\cmd`), disk(files, links))).toBeNull();
  });

  it('skips a refused candidate and takes the next real one', () => {
    const fake = 'C:\\Shim\\Git';
    const files = [...fullGit(fake), ...fullGit(GIT), 'D:\\elsewhere\\bash.exe'];
    const links = { [`${fake}\\usr\\bin\\bash.exe`]: 'D:\\elsewhere\\bash.exe' };
    expect(gitRoot(env(`${fake}\\cmd;${GIT}\\cmd`), disk(files, links))).toBe(GIT);
  });

  it('ignores relative PATH entries', () => {
    expect(gitRoot(env('cmd;.\\cmd'), disk(['cmd\\git.exe', 'bin\\bash.exe', 'usr\\bin\\bash.exe']))).toBeNull();
  });
});

describe('gitBashEnv (#963)', () => {
  it('adds noglob, the working-folder rule, MSYSTEM and Git\'s folders first on PATH, one key each', () => {
    const next = gitBashEnv(GIT, { Path: 'C:\\x', msys: 'winsymlinks:nativestrict', MSYSTEM: 'MSYS' });
    expect(next.PATH).toBe(`${GIT}\\mingw64\\bin;${GIT}\\usr\\bin;C:\\x`);
    expect(next.MSYS).toBe('winsymlinks:nativestrict noglob');
    expect(next.MSYSTEM).toBe('MINGW64');
    expect(next.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(Object.keys(next).filter((k) => /^(path|msys|msystem)$/i.test(k)).sort()).toEqual(['MSYS', 'MSYSTEM', 'PATH']);
  });

  it('keeps noglob once', () => {
    expect(gitBashEnv(GIT, { MSYS: 'noglob' }).MSYS).toBe('noglob');
  });
});

describe('msysQuote (#963)', () => {
  it('wraps in double quotes and writes a double quote closed, single-quoted and reopened', () => {
    expect(msysQuote('a b')).toBe('"a b"');
    expect(msysQuote('')).toBe('""');
    expect(msysQuote('say "hi"')).toBe(`"say "'"'"hi"'"'""`);
  });
});
