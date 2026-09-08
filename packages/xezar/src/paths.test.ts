import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SERVER_INSTANCE,
  agentHomePaths,
  xezarHomeDir,
  claudeStateFilePath,
  instanceSlug,
  serverInstancesDir,
  serverLockPath,
  serverStatePath,
  workspaceConfigPath,
  workspaceUiStatePath,
} from './paths.ts';

describe('paths', () => {
  const original = process.env.XEZ_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
  });

  it('defaults xezarHomeDir to ~/.xezar', () => {
    delete process.env.XEZ_HOME;
    expect(xezarHomeDir()).toBe(join(homedir(), '.xezar'));
  });

  // Xezar is an independent application, not an upgrade of Cezar (see BACKWARD_COMPATIBILITY.md
  // "The Xezar rename"). These pin the isolation: Xezar must never resolve, read or adopt the
  // other product's state, and must never honour its environment variable.
  describe('identity isolation from Cezar', () => {
    it('never resolves the Cezar home, with or without an override', () => {
      delete process.env.XEZ_HOME;
      const cezarHome = join(homedir(), '.cezar');
      for (const path of [
        xezarHomeDir(),
        workspaceConfigPath(),
        workspaceUiStatePath(),
        serverStatePath(),
        serverInstancesDir(),
        serverLockPath(),
      ]) {
        expect(path.startsWith(cezarHome)).toBe(false);
        expect(path).toContain('.xezar');
      }
    });

    it('ignores CEZ_HOME — the other product\'s variable must not steer this one', () => {
      delete process.env.XEZ_HOME;
      const env = { CEZ_HOME: '/tmp/some-cezar-home' } as unknown as NodeJS.ProcessEnv;
      expect(xezarHomeDir(env)).toBe(join(homedir(), '.xezar'));
      expect(workspaceConfigPath(env)).toBe(join(homedir(), '.xezar', 'config.json'));
    });
  });

  it('honors the XEZ_HOME override', () => {
    process.env.XEZ_HOME = '/tmp/xez-home-test';
    expect(xezarHomeDir()).toBe('/tmp/xez-home-test');
    expect(serverStatePath()).toBe('/tmp/xez-home-test/server.json');
    expect(serverLockPath()).toBe('/tmp/xez-home-test/server.install.lock');
  });

  it('the default instance keeps the legacy un-suffixed paths', () => {
    process.env.XEZ_HOME = '/tmp/xez-home-test';
    expect(serverStatePath(DEFAULT_SERVER_INSTANCE)).toBe('/tmp/xez-home-test/server.json');
    expect(serverLockPath(DEFAULT_SERVER_INSTANCE)).toBe('/tmp/xez-home-test/server.install.lock');
  });

  it('workspace config/ui-state live directly under the xezar home', () => {
    delete process.env.XEZ_HOME;
    expect(workspaceConfigPath()).toBe(join(homedir(), '.xezar', 'config.json'));
    expect(workspaceUiStatePath()).toBe(join(homedir(), '.xezar', 'ui-state.json'));
  });

  it('workspace paths honor the XEZ_HOME override', () => {
    process.env.XEZ_HOME = '/tmp/xez-home-test';
    expect(workspaceConfigPath()).toBe('/tmp/xez-home-test/config.json');
    expect(workspaceUiStatePath()).toBe('/tmp/xez-home-test/ui-state.json');
  });

  it('a named instance lives under server-instances/, keyed by slug', () => {
    process.env.XEZ_HOME = '/tmp/xez-home-test';
    expect(serverInstancesDir()).toBe('/tmp/xez-home-test/server-instances');
    expect(serverStatePath('shop-example-com')).toBe('/tmp/xez-home-test/server-instances/shop-example-com.json');
    expect(serverLockPath('shop-example-com')).toBe(
      '/tmp/xez-home-test/server-instances/shop-example-com.install.lock',
    );
  });
});

describe('instanceSlug', () => {
  it('lowercases and turns every non-alnum run (incl. dots) into a single dash', () => {
    expect(instanceSlug('Shop.Example.COM')).toBe('shop-example-com');
    expect(instanceSlug('a__b--c')).toBe('a-b-c');
    expect(instanceSlug('  lead.trail.  ')).toBe('lead-trail');
  });

  it('degenerate/empty input can never escape the instance namespace', () => {
    expect(instanceSlug('')).toBe(DEFAULT_SERVER_INSTANCE);
    expect(instanceSlug(undefined)).toBe(DEFAULT_SERVER_INSTANCE);
    expect(instanceSlug('.-.-')).toBe(DEFAULT_SERVER_INSTANCE);
  });
});

it('an EMPTY XEZ_HOME falls back to the default instead of a relative cwd path', () => {
  const original = process.env.XEZ_HOME;
  process.env.XEZ_HOME = '';
  try {
    expect(xezarHomeDir().startsWith('/')).toBe(true);
    expect(xezarHomeDir().endsWith('/.xezar')).toBe(true);
  } finally {
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
  }
});

describe('agentHomePaths', () => {
  it('defaults to the agents\' documented home directories', () => {
    const paths = agentHomePaths({ HOME: '/home/u' } as NodeJS.ProcessEnv);
    expect(paths.claude).toBe('/home/u/.claude');
    expect(paths.codex).toBe('/home/u/.codex');
    expect(paths.opencodeConfig).toBe('/home/u/.config/opencode');
  });

  it('honors agent-specific home overrides', () => {
    const paths = agentHomePaths({
      HOME: '/home/u',
      CLAUDE_CONFIG_DIR: '/opt/claude-klaudiusz',
      CODEX_HOME: '/opt/codex',
      XDG_CONFIG_HOME: '/xdg',
    } as NodeJS.ProcessEnv);
    expect(paths.claude).toBe('/opt/claude-klaudiusz');
    expect(paths.codex).toBe('/opt/codex');
    expect(paths.opencodeConfig).toBe('/xdg/opencode');
  });

  it('ignores a blank CLAUDE_CONFIG_DIR rather than yielding a relative path', () => {
    const paths = agentHomePaths({ HOME: '/home/u', CLAUDE_CONFIG_DIR: '   ' } as NodeJS.ProcessEnv);
    expect(paths.claude).toBe('/home/u/.claude');
  });

  // OpenCode's own variable wins over the XDG one so that relocating ONE agent's config does not
  // require moving every XDG-aware tool in the process — the e2e boot pins this to sandbox
  // opencode without deauthenticating `gh` or hiding the developer's global git config.
  it('prefers OPENCODE_CONFIG_DIR over XDG_CONFIG_HOME for opencode', () => {
    const paths = agentHomePaths({
      HOME: '/home/u',
      OPENCODE_CONFIG_DIR: '/opt/opencode-cfg',
      XDG_CONFIG_HOME: '/xdg',
    } as NodeJS.ProcessEnv);
    expect(paths.opencodeConfig).toBe('/opt/opencode-cfg');
  });

  it('uses OPENCODE_CONFIG_DIR verbatim — it names the config dir, not a parent', () => {
    const paths = agentHomePaths({
      HOME: '/home/u',
      OPENCODE_CONFIG_DIR: '/opt/opencode-cfg',
    } as NodeJS.ProcessEnv);
    expect(paths.opencodeConfig).toBe('/opt/opencode-cfg');
    expect(paths.opencodeConfig).not.toContain('opencode/opencode');
  });

  it('ignores a blank OPENCODE_CONFIG_DIR and falls back through XDG', () => {
    const paths = agentHomePaths({
      HOME: '/home/u',
      OPENCODE_CONFIG_DIR: '  ',
      XDG_CONFIG_HOME: '/xdg',
    } as NodeJS.ProcessEnv);
    expect(paths.opencodeConfig).toBe('/xdg/opencode');
  });

  it('leaves the other agents alone when only opencode is repointed', () => {
    const paths = agentHomePaths({
      HOME: '/home/u',
      OPENCODE_CONFIG_DIR: '/opt/opencode-cfg',
    } as NodeJS.ProcessEnv);
    expect(paths.claude).toBe('/home/u/.claude');
    expect(paths.codex).toBe('/home/u/.codex');
  });

  it('falls back to USERPROFILE when HOME is unset', () => {
    const paths = agentHomePaths({ USERPROFILE: 'C:\\Users\\u' } as unknown as NodeJS.ProcessEnv);
    expect(paths.claude).toContain('.claude');
  });
});

describe('claudeStateFilePath', () => {
  it('is a SIBLING of the default ~/.claude', () => {
    const env = { HOME: '/home/u' } as NodeJS.ProcessEnv;
    expect(claudeStateFilePath(agentHomePaths(env).claude, env)).toBe('/home/u/.claude.json');
  });

  it('moves INSIDE an overridden config dir', () => {
    const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz' } as NodeJS.ProcessEnv;
    expect(claudeStateFilePath(agentHomePaths(env).claude, env)).toBe('/home/u/.claude-klaudiusz/.claude.json');
  });

  it('moves inside for a profile dir passed explicitly, with no env override', () => {
    // The agent-profile path: the env still says "default", but the caller resolved
    // a second account's dir. Reading `dirname()` here would hit the WRONG account's file.
    const env = { HOME: '/home/u' } as NodeJS.ProcessEnv;
    expect(claudeStateFilePath('/home/u/.claude-klaudiusz', env)).toBe('/home/u/.claude-klaudiusz/.claude.json');
  });

  it('reads an account\'s OWN state file when the xezar process carries an override', () => {
    // Review case: xezar started with CLAUDE_CONFIG_DIR=/opt/work, and `~/.claude` added as a NAMED
    // account (legal — the discovered account is /opt/work, so it is not a duplicate). The answer is
    // the file INSIDE it, because that is the one the CLI will read when xezar runs that account as
    // `CLAUDE_CONFIG_DIR=~/.claude claude`. The sibling would describe a login it never uses.
    const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/opt/work' } as NodeJS.ProcessEnv;
    expect(claudeStateFilePath('/home/u/.claude', env)).toBe('/home/u/.claude/.claude.json');
    expect(claudeStateFilePath('/opt/work', env)).toBe('/opt/work/.claude.json');
  });

  it('keeps the SIBLING spelling for the discovered account on a plain machine', () => {
    // The zero-config path, and the one case where the file is not inside: no override anywhere, so
    // the CLI never sees the variable.
    const env = { HOME: '/home/u' } as NodeJS.ProcessEnv;
    expect(claudeStateFilePath('/home/u/.claude', env)).toBe('/home/u/.claude.json');
  });
});
