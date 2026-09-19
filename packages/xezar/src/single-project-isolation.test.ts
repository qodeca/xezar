import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChildEnv } from './core/agent-env.ts';
import { mcpSocketDir, mcpSocketLocation } from './mcp/ipc.ts';
import {
  agentHomePaths,
  claudeStateFilePath,
  serverInstancesDir,
  serverLockPath,
  serverStatePath,
  xezCacheDir,
  xezarHomeDir,
} from './paths.ts';
import { projectKitDir } from './project-kit-paths.ts';
import { bareDirFor, ensureBareClone } from './skills-remote.ts';
import { globalStateLayout, projectStateLayout, setActiveStateLayout } from './state-layout.ts';

/**
 * The isolation EDGE of single-project mode (#600 PR2): everything that still
 * reaches the host after the four state files have moved.
 *
 * Two halves, and the second matters as much as the first. One half proves the
 * things AC-5 and BR-2 move actually move — the skills cache and the MCP socket
 * directory. The other pins, byte for byte, the things that must NOT move: the
 * agent homes (SP-2.3), the host-install records (SP-2.5), and the global
 * layout's own answers, which have to be identical to what every xezar before
 * 0.16.0 gave. AGENTS.md § Changing a mechanism that already works asks for the
 * DEFAULT path to be diffed rather than the feature; this file is that diff.
 */

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xez-sp-home-'));
  project = mkdtempSync(join(tmpdir(), 'xez-sp-project-'));
  process.env.HOME = home;
  setActiveStateLayout(null);
});

afterEach(() => {
  setActiveStateLayout(null);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Put the process in single-project mode for `project`, as the CLI boot does. */
function enterMode(): void {
  setActiveStateLayout(projectStateLayout(project));
}

// ---- SP-2.2 (AC-5): the skills cache is inside the project -------------------------

/** A tiny real git repository with one skill in it — the cheapest honest clone source. */
function skillsRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xez-sp-skills-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'x',
        GIT_AUTHOR_EMAIL: 'x@example.com',
        GIT_COMMITTER_NAME: 'x',
        GIT_COMMITTER_EMAIL: 'x@example.com',
      },
    });
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'demo.md'), '---\nname: demo\n---\nbody\n');
  git('add', '.');
  git('commit', '-qm', 'skills');
  return dir;
}

describe('the skills cache follows the layout (SP-2.2, AC-5)', () => {
  it('a real refresh in the mode writes inside the project and never under ~/.cache/xez', async () => {
    const source = skillsRepo();
    try {
      enterMode();
      const cached = bareDirFor(source);
      expect(cached.startsWith(join(project, '.local', 'xezar', 'cache') + '/')).toBe(true);

      const { created } = await ensureBareClone(source);
      expect(created).toBe(true);
      // The clone is really there — a path assertion alone would pass against a
      // refresh that silently did nothing.
      expect(existsSync(join(cached, 'HEAD'))).toBe(true);
      // ...and the shared machine cache was never created. This is the
      // assertion the criterion turns on: "anything appears under ~/.cache/xez"
      // is the falsifier.
      expect(existsSync(join(home, '.cache', 'xez'))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('the same refresh in the global layout still writes ~/.cache/xez, unchanged', async () => {
    const source = skillsRepo();
    try {
      const cached = bareDirFor(source);
      expect(cached.startsWith(join(home, '.cache', 'xez', 'skills') + '/')).toBe(true);
      await ensureBareClone(source);
      expect(existsSync(join(cached, 'HEAD'))).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('the global cache root ignores XEZ_HOME, exactly as it always did', () => {
    // `skills-remote.ts` hardcoded `homedir()` here before the layout existed,
    // so `XEZ_HOME` never moved the cache. Making it do so now would change a
    // working default for every existing user in the name of a feature they did
    // not switch on.
    const withXezHome = mkdtempSync(join(tmpdir(), 'xez-sp-xezhome-'));
    const before = xezCacheDir();
    const previous = process.env.XEZ_HOME;
    process.env.XEZ_HOME = withXezHome;
    try {
      expect(xezCacheDir()).toBe(before);
      expect(xezCacheDir()).toBe(join(home, '.cache', 'xez'));
    } finally {
      if (previous === undefined) delete process.env.XEZ_HOME;
      else process.env.XEZ_HOME = previous;
      rmSync(withXezHome, { recursive: true, force: true });
    }
  });
});

// ---- SP-2.3 (AC-5, BR-7): agent homes, and everything else on the host --------------

describe('the host stays the host (SP-2.3, BR-7)', () => {
  it('agentHomePaths answers byte-identically with and without the mode', () => {
    const outside = agentHomePaths();
    enterMode();
    expect(agentHomePaths()).toEqual(outside);
    // Not just equal: none of the four may have wandered into the project.
    for (const path of Object.values(outside)) {
      expect(path.startsWith(project)).toBe(false);
    }
  });

  it('the four documented relocation variables still win in the mode', () => {
    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: '/pinned/claude',
      CODEX_HOME: '/pinned/codex',
      OPENCODE_CONFIG_DIR: '/pinned/opencode',
      PI_CODING_AGENT_DIR: '/pinned/pi',
    } as NodeJS.ProcessEnv;
    const outside = agentHomePaths(env);
    enterMode();
    expect(agentHomePaths(env)).toEqual(outside);
    expect(outside).toEqual({
      claude: '/pinned/claude',
      codex: '/pinned/codex',
      opencodeConfig: '/pinned/opencode',
      pi: '/pinned/pi',
    });
  });

  it("Claude's own state file resolves the same in the mode", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const outside = claudeStateFilePath(join(home, '.claude'), env);
    enterMode();
    expect(claudeStateFilePath(join(home, '.claude'), env)).toBe(outside);
  });

  it('the env an agent, gh or git spawn is byte-identical in the mode (SP-2.3, #644 Minor 5)', () => {
    // `gh` (server/forge/github.ts) and `git` (server/git.ts) are spawned with the INHERITED
    // process.env — neither passes an `env` — and the mode changes no environment variable, only
    // an in-process layout. The agent backends share the one builder that DOES construct an env
    // (`buildChildEnv`), so pinning that plus the inherited env covers all three.
    const source = {
      HOME: home,
      PATH: '/usr/bin:/bin',
      GITHUB_TOKEN: 'gh-token',
      ANTHROPIC_API_KEY: 'anthropic-key',
      XEZ_ENV_PASSTHROUGH: 'MY_VAR',
      MY_VAR: 'forwarded',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    } as NodeJS.ProcessEnv;
    const agentEnv = buildChildEnv({ backend: 'claude', source });
    const inherited = { ...process.env };
    enterMode();
    expect(buildChildEnv({ backend: 'claude', source })).toEqual(agentEnv);
    // gh/git inherit this verbatim, so the mode must not have written a variable into it.
    expect({ ...process.env }).toEqual(inherited);
    // Not merely equal: the credential the handoff needs is still there, and the secret is not.
    expect(agentEnv.GITHUB_TOKEN).toBe('gh-token');
    expect(agentEnv.ANTHROPIC_API_KEY).toBe('anthropic-key');
    expect(agentEnv.MY_VAR).toBe('forwarded');
    expect(agentEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

// ---- SP-2.5 (AC-8): the host-install records stay in ~/.xezar ------------------------

describe('host-install records describe the machine, not the project (SP-2.5, AC-8, FR-8.2)', () => {
  it('server.json, server-instances/ and the install lock stay under the per-user home', () => {
    const outside = {
      state: serverStatePath(),
      named: serverStatePath('acme-example-com'),
      instances: serverInstancesDir(),
      lock: serverLockPath(),
    };
    enterMode();
    expect({
      state: serverStatePath(),
      named: serverStatePath('acme-example-com'),
      instances: serverInstancesDir(),
      lock: serverLockPath(),
    }).toEqual(outside);
    for (const path of Object.values(outside)) {
      expect(path.startsWith(xezarHomeDir())).toBe(true);
      expect(path.startsWith(project)).toBe(false);
    }
  });

  it('the systemd unit and the nginx site are generated identically in the mode', async () => {
    // These two describe a host's service and a host's reverse proxy. A cockpit
    // serving a single-project root is still installed on one machine, and a
    // unit file inside a git repository would commit one host's service
    // definition to every clone of it.
    const { nginxVhost, systemdUnit } = await import('./server-install/platforms/ubuntu-vps.ts');
    const unitArgs = [project, 7777, 'user', '/usr/bin/node /opt/xezar/index.js'] as const;
    const outside = { vhost: nginxVhost(7777, 'acme.example.com'), unit: systemdUnit(...unitArgs) };
    enterMode();
    expect(nginxVhost(7777, 'acme.example.com')).toBe(outside.vhost);
    expect(systemdUnit(...unitArgs)).toBe(outside.unit);
    // The vhost and the htpasswd it points at are `/etc` paths, not per-user
    // ones, so nothing in them can be relocated by a state layout at all.
    expect(outside.vhost).toContain('/etc/xezar/htpasswd');
  });
});

// ---- BR-2: the MCP socket directory -------------------------------------------------

describe('the MCP socket directory follows the layout (BR-2)', () => {
  it('is ~/.xezar/ipc globally and inside the project in the mode', () => {
    expect(mcpSocketDir()).toBe(join(xezarHomeDir(), 'ipc'));
    enterMode();
    expect(mcpSocketDir()).toBe(join(project, '.local', 'xezar', 'ipc'));
    // A socket is a working file: it must not land in the COMMITTED state dir.
    expect(mcpSocketDir().startsWith(join(project, '.xezar'))).toBe(false);
  });

  it('a too-long socket path names the real directory, not the old wording (Nit 6, #644)', () => {
    // The leader reads this message and needs the actual path, so the global layout keeps naming
    // `~/.xezar/ipc` (here through the resolved `XEZ_HOME` root). This PINS that wording rather
    // than restoring the old phrasing.
    const longHome = join(home, 'x'.repeat(120));
    const global = mcpSocketLocation(
      { id: 'p', root: '/repo' },
      { HOME: home, XEZ_HOME: longHome } as NodeJS.ProcessEnv,
      'darwin',
    );
    expect(global.kind).toBe('unavailable');
    if (global.kind !== 'unavailable') throw new Error('expected an unavailable socket');
    expect(global.reason).toContain(join(longHome, 'ipc'));
    expect(global.reason).toContain('point XEZ_HOME at a shorter directory');

    // In the mode the folder decides where the socket lives, and the message names that folder —
    // `point XEZ_HOME somewhere shorter` would be advice the user cannot act on.
    const longProject = join(project, 'p'.repeat(120));
    setActiveStateLayout(projectStateLayout(longProject));
    const local = mcpSocketLocation({ id: 'p', root: longProject }, { HOME: home } as NodeJS.ProcessEnv, 'darwin');
    expect(local.kind).toBe('unavailable');
    if (local.kind !== 'unavailable') throw new Error('expected an unavailable socket');
    expect(local.reason).toContain(join(longProject, '.local', 'xezar', 'ipc'));
    expect(local.reason).toContain('move the project to a shorter path');
  });
});

// ---- The kit and the state share a directory on purpose ------------------------------

describe('<project>/.xezar is both the kit and the state (project-kit-paths)', () => {
  it('the kit dir is not diverted in the mode, and no state file collides with a kit asset', () => {
    enterMode();
    expect(projectKitDir(project)).toBe(join(project, '.xezar'));
    const layout = projectStateLayout(project);
    // The project config IS the kit's config, by design (FR-2.2). The other
    // three state files take names the kit has never used.
    expect(layout.configPath).toBe(join(projectKitDir(project), 'config.json'));
    for (const path of [layout.workspacePath, layout.uiStatePath, layout.accountsPath]) {
      expect(path).not.toBe(layout.configPath);
      expect(path.endsWith('config.json')).toBe(false);
    }
  });
});

// ---- The global layout is byte-for-byte what it was ---------------------------------

describe('the default path did not change (AGENTS.md § Changing a mechanism that already works)', () => {
  it('every derived root in the global layout is exactly the pre-0.16.0 one', () => {
    const layout = globalStateLayout({ HOME: home } as NodeJS.ProcessEnv);
    expect(layout).toEqual({
      mode: 'global',
      root: join(home, '.xezar'),
      projectRoot: null,
      configPath: null,
      workspacePath: join(home, '.xezar', 'config.json'),
      uiStatePath: join(home, '.xezar', 'ui-state.json'),
      accountsPath: join(home, '.xezar', 'agent-accounts.json'),
      dataDir: null,
      cacheDir: join(home, '.cache', 'xez'),
      ipcDir: join(home, '.xezar', 'ipc'),
    });
  });

  it('and the project layout keeps working files out of the committed directory', () => {
    const layout = projectStateLayout(project);
    for (const path of [layout.dataDir!, layout.cacheDir, layout.ipcDir]) {
      expect(path.startsWith(join(project, '.local', 'xezar'))).toBe(true);
    }
    for (const path of [layout.configPath!, layout.workspacePath, layout.uiStatePath, layout.accountsPath]) {
      expect(path.startsWith(join(project, '.xezar'))).toBe(true);
    }
  });
});
