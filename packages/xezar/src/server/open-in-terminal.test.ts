import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLaunchScript, openInTerminal, refuseSpawnUnderTest, wslTerminalLaunchers } from './open-in-terminal.ts';

/** The seam the platform-branch tests below drive. Only `spawn` is replaced — `./wsl.ts` reaches
 *  for `execFileSync` from the same module, and it must keep working. */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

describe('wslTerminalLaunchers (#361 WSL support)', () => {
  it('tries Windows Terminal first, re-entering the distro through wsl.exe', () => {
    const [first] = wslTerminalLaunchers('/tmp/xez-term-abc/launch.sh', 'Ubuntu');
    expect(first).toEqual(['wt.exe', ['wsl.exe', '-d', 'Ubuntu', '--', '/tmp/xez-term-abc/launch.sh']]);
  });

  it('falls back to a classic console window, same wsl.exe re-entry', () => {
    const [, second] = wslTerminalLaunchers('/tmp/xez-term-abc/launch.sh', 'Ubuntu');
    expect(second).toEqual(['conhost.exe', ['wsl.exe', '-d', 'Ubuntu', '--', '/tmp/xez-term-abc/launch.sh']]);
  });

  // Regression guard for the BatBadBut class (CVE-2024-27980) that #459 fixed in the sibling
  // opener: an argument array does not save you when the binary itself is a shell, because libuv
  // leaves space-free arguments unquoted, so `distro` could carry a metacharacter into cmd.
  // Scoped to the WSL launchers on purpose — openInTerminal's native win32 branch still builds a
  // `cmd /c start` line, which this says nothing about.
  it('routes no WSL launcher through a shell', () => {
    for (const [bin] of wslTerminalLaunchers('/tmp/script.sh', 'Ubuntu')) {
      expect(bin).not.toMatch(/^(cmd|command|powershell|pwsh)(\.exe)?$/i);
    }
  });

  it('addresses the distro the launch actually runs in, not a hardcoded default', () => {
    const [first] = wslTerminalLaunchers('/tmp/script.sh', 'Debian');
    expect(first?.[1]).toContain('Debian');
  });
});

/**
 * #785: this opener used to `mkdtemp` a `xez-term-*` directory per launch and never
 * remove it. On a host whose `/tmp` is a tmpfs that never reboots, that litter is part
 * of what exhausts the directory the agents' output capture depends on — the failure
 * this issue is really about. Asserted on `createLaunchScript` rather than through
 * `openInTerminal`, so the test never spawns a real terminal emulator.
 */
describe('launch-script cleanup (#785)', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Poll rather than sleep a fixed span: the cleanup is a real timer, and a
   *  loaded event loop (the full suite runs these files in parallel) makes any
   *  single "long enough" wait a coin toss. */
  const waitGone = async (path: string) => {
    for (let i = 0; i < 200 && existsSync(path); i += 1) await settle(10);
    return !existsSync(path);
  };

  it('writes a runnable script, then removes its directory', async () => {
    const scriptPath = createLaunchScript('/some/worktree', 'claude --resume abc', 5);
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, 'utf8')).toContain('claude --resume abc');
    expect(dirname(scriptPath)).toMatch(/xez-term-/);

    expect(await waitGone(dirname(scriptPath))).toBe(true);
    expect(existsSync(scriptPath)).toBe(false);
  });

  it('survives long enough for a slow emulator to start', async () => {
    const scriptPath = createLaunchScript('/some/worktree', ':', 10_000);
    try {
      await settle(20);
      // Still there — the cleanup is a grace period, not a race with the launcher.
      expect(existsSync(scriptPath)).toBe(true);
    } finally {
      rmSync(dirname(scriptPath), { recursive: true, force: true });
    }
  });
});

describe('openInTerminal env (spec 2026-07-29-agent-profiles)', () => {
  it('refuses to launch anything when the account env cannot be embedded safely', async () => {
    // Fail CLOSED. Launching the bare command would open a terminal on a DIFFERENT account than
    // the user asked for, and nothing in the window would say so — worse than not opening one.
    // The refusal happens before any spawn, which is what makes this assertable without mocks.
    await expect(
      openInTerminal('/tmp', 'claude --resume abc', {
        CLAUDE_CONFIG_DIR: `/home/u${String.fromCharCode(10)}evil`,
      }),
    ).resolves.toBe(false);
  });
});

/**
 * #820 — the backstop. A test that reaches a real launcher opens a window on the developer's
 * machine; the suite once left a Terminal sitting in a fixture directory it had already deleted.
 * The guard makes that omission impossible to commit, because it fails loudly instead of
 * succeeding quietly.
 */
describe('the spawn guard (#820)', () => {
  const saved = process.env.XEZ_ALLOW_TEST_SPAWN;
  afterEach(() => {
    if (saved === undefined) delete process.env.XEZ_ALLOW_TEST_SPAWN;
    else process.env.XEZ_ALLOW_TEST_SPAWN = saved;
  });

  it('refuses, naming the command and the seam to inject', () => {
    delete process.env.XEZ_ALLOW_TEST_SPAWN;
    expect(() => refuseSpawnUnderTest('osascript', ['-e', 'tell application "Terminal"']))
      .toThrow(/refusing to spawn a launcher from a test: osascript -e tell application "Terminal"/)
    expect(() => refuseSpawnUnderTest('osascript', [])).toThrow(/ServerDeps\.openTerminal/);
  });

  it('lets a file that has mocked child_process through, explicitly', () => {
    process.env.XEZ_ALLOW_TEST_SPAWN = '1';
    expect(() => refuseSpawnUnderTest('osascript', ['-e', 'x'])).not.toThrow();
  });

  it('never fires outside a test run', () => {
    delete process.env.XEZ_ALLOW_TEST_SPAWN;
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => refuseSpawnUnderTest('osascript', ['-e', 'x'])).not.toThrow();
    } finally {
      if (vitest !== undefined) process.env.VITEST = vitest;
    }
  });

  it('stops openInTerminal before it can reach the OS', async () => {
    delete process.env.XEZ_ALLOW_TEST_SPAWN;
    // The exact call #820 reported: `openInApp('terminal', dir)` → `openInTerminal(dir, ':')`.
    await expect(openInTerminal('/tmp/some-account-folder', ':')).rejects.toThrow(/refusing to spawn/);
  });
});

/**
 * The platform branches, driven with `node:child_process` replaced — the one case
 * `refuseSpawnUnderTest`'s doc comment names as the deliberate `XEZ_ALLOW_TEST_SPAWN=1`
 * exception. Nothing here reaches a real process, and asserting the argv a launcher WOULD pass
 * is the only way the quoting is pinned at all: every launch line is assembled by string
 * concatenation, so a lost quote is a silent command injection into the user's own shell.
 */
describe('the platform launch lines', () => {
  const realPlatform = process.platform;
  const savedAllow = process.env.XEZ_ALLOW_TEST_SPAWN;
  const savedDistro = process.env.WSL_DISTRO_NAME;

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  };

  /** A spawned child that never errors — `runDetached` resolves true once its settle timer fires. */
  const quietChild = () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    return child;
  };

  /** A child that reports the launcher is missing, the way an absent emulator does. */
  const failingChild = () => {
    const child = quietChild();
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  };

  /** Resolve `openInTerminal` with the 250 ms settle window driven by fake timers rather than
   *  waited out — seven Linux candidates would otherwise cost nearly two seconds of real time. */
  const settleAll = async (promise: Promise<boolean>): Promise<boolean> => {
    await vi.advanceTimersByTimeAsync(250 * 10);
    return promise;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    process.env.XEZ_ALLOW_TEST_SPAWN = '1';
    delete process.env.WSL_DISTRO_NAME;
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(realPlatform);
    if (savedAllow === undefined) delete process.env.XEZ_ALLOW_TEST_SPAWN;
    else process.env.XEZ_ALLOW_TEST_SPAWN = savedAllow;
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
  });

  describe('macOS', () => {
    beforeEach(() => setPlatform('darwin'));

    it('activates Terminal, then hands it one `do script` line carrying the env', async () => {
      spawnMock.mockImplementation(quietChild);

      expect(
        await settleAll(
          openInTerminal('/tmp/my worktree', 'claude --resume abc', {
            CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
          }),
        ),
      ).toBe(true);

      // `export …;` rather than a `VAR=v cmd` prefix: the window stays open and the user types
      // the next `claude` in it themselves, so the account has to survive the command.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe('osascript');
      expect(spawnMock.mock.calls[0]?.[1]).toEqual([
        '-e',
        'tell application "Terminal" to activate',
        '-e',
        'tell application "Terminal" to do script "cd \'/tmp/my worktree\' && export CLAUDE_CONFIG_DIR=\'/home/u/.claude-work\'; claude --resume abc"',
      ]);
      expect(spawnMock.mock.calls[0]?.[2]).toEqual({ stdio: 'ignore', detached: true });
    });

    it('escapes the quotes and backslashes AppleScript would otherwise eat', async () => {
      spawnMock.mockImplementation(quietChild);

      await settleAll(openInTerminal('/tmp/a"b\\c', ':'));

      // Backslash first, then quote — the reverse order would double-escape the escapes.
      expect(spawnMock.mock.calls[0]?.[1]?.[3]).toBe(
        'tell application "Terminal" to do script "cd \'/tmp/a\\"b\\\\c\' && :"',
      );
    });

    it('reports failure when Terminal cannot be reached at all', async () => {
      spawnMock.mockImplementation(failingChild);

      expect(await settleAll(openInTerminal('/tmp/w', ':'))).toBe(false);
    });

    it('reports failure when the spawn itself throws', async () => {
      spawnMock.mockImplementation(() => {
        throw new Error('EACCES');
      });

      // A throwing spawn is not an exception the caller has to handle — it is a false, and the
      // caller shows the copy-the-command fallback.
      expect(await settleAll(openInTerminal('/tmp/w', ':'))).toBe(false);
    });
  });

  describe('Windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('prefers Windows Terminal and renders the env as a persisting `set`', async () => {
      spawnMock.mockImplementation(quietChild);

      expect(
        await settleAll(
          openInTerminal('C:\\work\\wt', 'claude --resume abc', {
            CLAUDE_CONFIG_DIR: 'C:\\Users\\u\\.claude-work',
          }),
        ),
      ).toBe(true);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual([
        'cmd',
        [
          '/c',
          'start',
          '',
          'wt',
          '-d',
          'C:\\work\\wt',
          'cmd',
          '/K',
          'set "CLAUDE_CONFIG_DIR=C:\\Users\\u\\.claude-work" && claude --resume abc',
        ],
      ]);
    });

    it('falls back to a classic cmd window that cds itself in', async () => {
      spawnMock.mockImplementationOnce(failingChild).mockImplementation(quietChild);

      expect(await settleAll(openInTerminal('C:\\work\\wt', 'claude --resume abc'))).toBe(true);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock.mock.calls[1]?.[1]).toEqual([
        '/c',
        'start',
        '',
        'cmd',
        '/K',
        'cd /d "C:\\work\\wt" && claude --resume abc',
      ]);
    });

    it('gives up after both launchers fail', async () => {
      spawnMock.mockImplementation(failingChild);

      expect(await settleAll(openInTerminal('C:\\work\\wt', ':'))).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('refuses the whole launch when the env cannot be spelled for cmd.exe', async () => {
      // `cmd.exe` has no escape inside a quoted `set`, so a `%` would expand. Fail closed
      // BEFORE any spawn rather than open a window aimed at the wrong account.
      expect(
        await settleAll(openInTerminal('C:\\w', ':', { CLAUDE_CONFIG_DIR: 'C:\\%USERNAME%' })),
      ).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('Linux', () => {
    beforeEach(() => setPlatform('linux'));

    it('probes the emulators in order and stops at the first that starts', async () => {
      spawnMock.mockImplementationOnce(failingChild).mockImplementation(quietChild);

      expect(await settleAll(openInTerminal('/tmp/w', ':'))).toBe(true);

      expect(spawnMock.mock.calls.map((call) => call[0])).toEqual([
        'x-terminal-emulator',
        'gnome-terminal',
      ]);
    });

    it('tries every candidate before giving up, each on the temp launch script', async () => {
      spawnMock.mockImplementation(failingChild);

      expect(await settleAll(openInTerminal('/tmp/w', ':'))).toBe(false);

      expect(spawnMock.mock.calls.map((call) => call[0])).toEqual([
        'x-terminal-emulator',
        'gnome-terminal',
        'konsole',
        'wezterm',
        'kitty',
        'alacritty',
        'xterm',
      ]);
      // One script for the whole probe, and every candidate points at that same file.
      const scripts = new Set(
        spawnMock.mock.calls.map((call) => (call[1] as string[]).at(-1)),
      );
      expect(scripts.size).toBe(1);
      expect([...scripts][0]).toMatch(/xez-term-[^/]+\/launch\.sh$/);
    });

    it('writes the cd, the env and the command into the script the emulator runs', async () => {
      spawnMock.mockImplementation(quietChild);

      await settleAll(
        openInTerminal('/tmp/my worktree', 'claude --resume abc', {
          CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
        }),
      );

      const scriptPath = (spawnMock.mock.calls[0]?.[1] as string[]).at(-1) as string;
      // The script is the whole reason the Linux branch exists: it sidesteps seven different
      // emulators' quoting rules, so the quoting has to be right exactly once, here.
      expect(readFileSync(scriptPath, 'utf8')).toBe(
        "#!/usr/bin/env bash\ncd '/tmp/my worktree'\nexport CLAUDE_CONFIG_DIR='/home/u/.claude-work'; claude --resume abc\nexec bash\n",
      );
      rmSync(dirname(scriptPath), { recursive: true, force: true });
    });
  });

  describe('WSL (#361)', () => {
    beforeEach(() => {
      setPlatform('linux');
      // What WSL sets for every process it starts — `isWsl()` reads it without a mock.
      process.env.WSL_DISTRO_NAME = 'Ubuntu-24.04';
    });

    it('goes through interop to a Windows terminal instead of a Linux emulator', async () => {
      spawnMock.mockImplementation(quietChild);

      expect(await settleAll(openInTerminal('/home/u/wt', ':'))).toBe(true);

      const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe('wt.exe');
      // Re-enters THIS distro: the script path stays POSIX because wsl.exe reads its command
      // line inside the distro, not on the Windows side.
      expect(args.slice(0, 4)).toEqual(['wsl.exe', '-d', 'Ubuntu-24.04', '--']);
      expect(args.at(-1)).toMatch(/^\/.*xez-term-[^/]+\/launch\.sh$/);
      rmSync(dirname(args.at(-1) as string), { recursive: true, force: true });
    });

    it('falls back to a classic console window, and never probes a Linux emulator', async () => {
      spawnMock.mockImplementationOnce(failingChild).mockImplementation(quietChild);

      expect(await settleAll(openInTerminal('/home/u/wt', ':'))).toBe(true);
      expect(spawnMock.mock.calls.map((call) => call[0])).toEqual(['wt.exe', 'conhost.exe']);
    });

    it('gives up on WSL rather than falling through to the Linux candidates', async () => {
      spawnMock.mockImplementation(failingChild);

      expect(await settleAll(openInTerminal('/home/u/wt', ':'))).toBe(false);
      // Exactly the two interop launchers — there is no Linux desktop here to fall back to.
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('substitutes WSL\'s own default for a distro name that fails validation', async () => {
      // `wsl --import <name>` lets the user pick this, so it is untrusted input on a command
      // line. A name like `a&calc&` must never reach one.
      process.env.WSL_DISTRO_NAME = 'a&calc&';
      spawnMock.mockImplementation(quietChild);

      await settleAll(openInTerminal('/home/u/wt', ':'));

      expect(spawnMock.mock.calls[0]?.[1]).toContain('Ubuntu');
      expect(spawnMock.mock.calls[0]?.[1]).not.toContain('a&calc&');
    });
  });
});
