import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

import {
  AgentTempDirError,
  agentTmpDir,
  agentTmpDirEnabled,
  agentTmpEnv,
  agentTmpRoots,
  removeAgentTmpDir,
  sweepAgentTmpDirs,
} from './agent-tmpdir.ts';

/**
 * #785: every agent shared the host's temp directory, and when that directory
 * stopped accepting writes the Claude backend's output capture silently
 * truncated to nothing. These cover the two properties that fix it — a per-run
 * directory, and a preflight that fails loudly instead of spawning blind — plus
 * the reaping that keeps the first one from becoming its own leak.
 */
describe('agentTmpEnv — per-run temp directory (#785)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'xez-agent-tmpdir-'));
  });

  afterEach(() => {
    sweepAgentTmpDirs(dataDir, []); // also the short links a Linux host makes (#1065)
    rmSync(dataDir, TEST_DIR_RM_OPTIONS);
  });

  it('gives the run its own directory and creates it before the backend spawns', () => {
    const env = agentTmpEnv(dataDir, 'run-a', {});
    // On Linux a folder this deep is reached through a short link (#1065); either way it is
    // this run's own folder.
    expect(realpathSync(env.TMPDIR as string)).toBe(realpathSync(agentTmpDir(dataDir, 'run-a')));
    expect(agentTmpDir(dataDir, 'run-a')).toBe(join(dataDir, 'tmp', 'run-a'));
    expect(existsSync(env.TMPDIR as string)).toBe(true);
  });

  // A tool that reads TMP (or TEMP) would otherwise follow the host value straight
  // back to the exhausted directory this whole change exists to escape.
  it('sets all three spellings, so nothing falls back to the host value', () => {
    const env = agentTmpEnv(dataDir, 'run-b', {});
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.TMP).toBe(env.TMPDIR);
  });

  it('keeps runs out of each other’s scratch', () => {
    expect(agentTmpEnv(dataDir, 'run-a', {}).TMPDIR)
      .not.toBe(agentTmpEnv(dataDir, 'run-b', {}).TMPDIR);
  });

  it('fails with a named, actionable error when the directory cannot be created', () => {
    // `<dataDir>/tmp` occupied by a FILE — mkdir cannot make the run's directory
    // under it. Deterministic and portable, unlike simulating a quota.
    writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
    let thrown: unknown;
    try {
      agentTmpEnv(dataDir, 'run-c', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTempDirError);
    expect((thrown as Error).message).toContain('agent temp directory is not writable');
    expect((thrown as Error).message).toContain(join(dataDir, 'tmp', 'run-c'));
    // The remedy names the opt-out, so the message alone is enough to act on.
    expect((thrown as Error).message).toContain('XEZ_AGENT_TMPDIR=0');
  });

  // The failure this exists for is a directory that exists and accepts an inode but
  // rejects the write (`EDQUOT`). A read-only directory is the portable stand-in —
  // skipped under root, which ignores the mode bits.
  // win32-skip(#972): Windows ignores POSIX mode bits, so a chmod'd read-only directory stays writable
  it.skipIf(onWindows || process.getuid?.() === 0)(
    'fails when the directory exists but rejects writes',
    () => {
      const dir = agentTmpDir(dataDir, 'run-d');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        expect(() => agentTmpEnv(dataDir, 'run-d', {})).toThrow(AgentTempDirError);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('a writable directory passes, and the probe leaves nothing behind', () => {
    const env = agentTmpEnv(dataDir, 'run-e', {});
    expect(readdirSync(env.TMPDIR as string)).toEqual([]);
  });

  describe('XEZ_AGENT_TMPDIR=0 opt-out', () => {
    it('leaves the host TMPDIR in force and mints no directory', () => {
      const host = mkdtempSync(join(realpathSync(tmpdir()), 'xez-host-tmp-'));
      try {
        const env = agentTmpEnv(dataDir, 'run-f', { XEZ_AGENT_TMPDIR: '0', TMPDIR: host });
        expect(env).toEqual({});
        expect(existsSync(agentTmpDir(dataDir, 'run-f'))).toBe(false);
      } finally {
        rmSync(host, TEST_DIR_RM_OPTIONS);
      }
    });

    // The hatch turns the whole feature off, preflight included. An escape hatch
    // that still imposed the new check would be one you cannot escape through,
    // and a run that used to start must still start with it set.
    it('does not preflight anything either, however broken the host TMPDIR is', () => {
      expect(() =>
        agentTmpEnv(dataDir, 'run-g', {
          XEZ_AGENT_TMPDIR: '0',
          TMPDIR: join(dataDir, 'does-not-exist'),
        }),
      ).not.toThrow();
    });

    it('is not fooled by an unusable directory it would otherwise have minted', () => {
      writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
      expect(agentTmpEnv(dataDir, 'run-h', { XEZ_AGENT_TMPDIR: '0' })).toEqual({});
    });

    it('only an exact "0" disables it', () => {
      expect(agentTmpDirEnabled({})).toBe(true);
      expect(agentTmpDirEnabled({ XEZ_AGENT_TMPDIR: '1' })).toBe(true);
      expect(agentTmpDirEnabled({ XEZ_AGENT_TMPDIR: 'false' })).toBe(true);
      expect(agentTmpDirEnabled({ XEZ_AGENT_TMPDIR: '0' })).toBe(false);
    });
  });
});

describe('reaping the per-run temp directories (#785)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'xez-agent-tmpdir-reap-'));
  });

  afterEach(() => {
    sweepAgentTmpDirs(dataDir, []); // also the short links a Linux host makes (#1065)
    rmSync(dataDir, TEST_DIR_RM_OPTIONS);
  });

  it('removes one run’s directory and everything in it', () => {
    const dir = agentTmpEnv(dataDir, 'run-a', {}).TMPDIR as string;
    writeFileSync(join(dir, 'scratch.txt'), 'x', 'utf8');
    removeAgentTmpDir(dataDir, 'run-a');
    expect(existsSync(dir)).toBe(false);
  });

  it('is idempotent and never throws on a directory that is already gone', () => {
    expect(() => removeAgentTmpDir(dataDir, 'never-existed')).not.toThrow();
  });

  // Path-traversal guard: a run id is a uuid, and nothing that is not one may ever
  // reach a recursive rmSync.
  it('refuses a run id that is not a plain identifier', () => {
    const sibling = join(dataDir, 'runs');
    mkdirSync(sibling, { recursive: true });
    removeAgentTmpDir(dataDir, '../runs');
    expect(existsSync(sibling)).toBe(true);
  });

  // The one input that turns this helper into data loss: `join(dataDir, 'tmp', '..')`
  // is `<dataDir>` itself, so a guard that admits it would recursively remove every
  // run's state — runs.json included.
  it.each(['.', '..'])('refuses the relative id %j, which would resolve onto dataDir', (id) => {
    writeFileSync(join(dataDir, 'runs.json'), '[]', 'utf8');
    agentTmpEnv(dataDir, 'live', {});
    removeAgentTmpDir(dataDir, id);
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true);
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
  });

  it('sweeps orphans left by a crash while keeping the live runs', () => {
    agentTmpEnv(dataDir, 'live', {});
    agentTmpEnv(dataDir, 'orphan-1', {});
    agentTmpEnv(dataDir, 'orphan-2', {});
    const reaped = sweepAgentTmpDirs(dataDir, ['live']);
    expect(reaped.sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
    expect(existsSync(agentTmpDir(dataDir, 'orphan-1'))).toBe(false);
  });

  // `.local/xezar/` is a protected surface. The sweep is
  // confined to its own `tmp/` subtree and must never see a sibling.
  it('never touches sibling run state', () => {
    agentTmpEnv(dataDir, 'orphan', {});
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), '[]', 'utf8');
    writeFileSync(join(dataDir, 'runs', 'a.ndjson'), '{}', 'utf8');
    sweepAgentTmpDirs(dataDir, []);
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'runs', 'a.ndjson'))).toBe(true);
  });

  it('is a no-op before any run has minted a directory', () => {
    expect(sweepAgentTmpDirs(dataDir, [])).toEqual([]);
  });
});

/**
 * #1065: on Linux `<project>/.local/xezar/tmp/<runId>` is too deep for a Unix socket below it,
 * and Chrome aborted with "Socket path too long" in every task. The run now gets a short link
 * in the host temp folder; the bytes still land in its own folder.
 */
describe('a short TMPDIR where the per-run folder is too deep for a socket (#1065)', () => {
  const CHROME_SOCKET_SUFFIX = '/com.google.Chrome.XXXXXX/SingletonSocket';
  const RUN = '2342db59-f969-4758-a94a-e0d8f8a1c0de';
  let dataDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'xez-agent-tmpdir-deep-'));
    dataDir = join(base, 'Projects', 'a-fairly-long-project-name', '.local', 'xezar');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    removeAgentTmpDir(dataDir, RUN);
    rmSync(join(dataDir, '..', '..', '..', '..'), TEST_DIR_RM_OPTIONS);
  });

  it('on Linux hands the agent a path with room for Chrome’s socket, leading to the run’s folder', () => {
    const env = agentTmpEnv(dataDir, RUN, {}, 'linux');
    const visible = env.TMPDIR as string;
    expect(visible).not.toBe(agentTmpDir(dataDir, RUN));
    expect(Buffer.byteLength(visible + CHROME_SOCKET_SUFFIX)).toBeLessThan(108);
    expect(env.TEMP).toBe(visible);
    expect(env.TMP).toBe(visible);
    writeFileSync(join(visible, 'scratch.txt'), 'x', 'utf8');
    expect(existsSync(join(agentTmpDir(dataDir, RUN), 'scratch.txt'))).toBe(true);
  });

  it('lets the sandbox write both the short path and the real folder', () => {
    const visible = agentTmpEnv(dataDir, RUN, {}, 'linux').TMPDIR as string;
    expect(agentTmpRoots(dataDir, RUN, visible)).toEqual([visible, agentTmpDir(dataDir, RUN)]);
  });

  it('removes the link with the run, and in the start-up sweep', () => {
    const first = agentTmpEnv(dataDir, RUN, {}, 'linux').TMPDIR as string;
    removeAgentTmpDir(dataDir, RUN);
    expect(existsSync(first)).toBe(false);
    const again = agentTmpEnv(dataDir, RUN, {}, 'linux').TMPDIR as string;
    expect(sweepAgentTmpDirs(dataDir, [])).toEqual([RUN]);
    expect(existsSync(again)).toBe(false);
  });

  it('keeps the real folder on Windows and macOS', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(agentTmpEnv(dataDir, RUN, {}, platform).TMPDIR).toBe(agentTmpDir(dataDir, RUN));
    }
    expect(agentTmpRoots(dataDir, RUN, agentTmpDir(dataDir, RUN))).toEqual([agentTmpDir(dataDir, RUN)]);
  });

  it('still makes no link and no folder under XEZ_AGENT_TMPDIR=0', () => {
    expect(agentTmpEnv(dataDir, RUN, { XEZ_AGENT_TMPDIR: '0' }, 'linux')).toEqual({});
    expect(existsSync(agentTmpDir(dataDir, RUN))).toBe(false);
  });
});
