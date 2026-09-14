import { describe, expect, it } from 'vitest';
import { codexIsolationNote, codexRunIsolation, isXezarBridge } from './codex-run-isolation.ts';

const user = { name: { type: 'user', file: '/home/u/.codex/config.toml', profile: null }, version: 'sha256:u' };
const project = { name: { type: 'project', dotCodexFolder: '/repo/.codex' }, version: 'sha256:p' };
const system = { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'sha256:s' };

describe('codexRunIsolation (#324)', () => {
  it('switches off every server the home config contributes, and plugins and apps', () => {
    const isolation = codexRunIsolation({
      config: { mcp_servers: { 'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] } } },
      origins: { 'mcp_servers.chrome-devtools.command': user, 'mcp_servers.chrome-devtools.args.0': user },
    });
    expect(isolation.disabledServers).toEqual(['chrome-devtools']);
    expect(isolation.config).toEqual({
      mcp_servers: { 'chrome-devtools': { enabled: false } },
      features: { plugins: false, apps: false },
    });
  });

  it('keeps a server the project alone declares', () => {
    const isolation = codexRunIsolation({
      config: { mcp_servers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } },
      origins: { 'mcp_servers.playwright.command': project, 'mcp_servers.playwright.args.0': project },
    });
    expect(isolation.disabledServers).toEqual([]);
    expect(isolation.config).toEqual({ features: { plugins: false, apps: false } });
  });

  it('switches off a project server the home config also touches', () => {
    const isolation = codexRunIsolation({
      config: { mcp_servers: { tool: { command: 'node', env: { HOME_DIR: '/home/u' } } } },
      origins: { 'mcp_servers.tool.command': project, 'mcp_servers.tool.env.HOME_DIR': user },
    });
    expect(isolation.disabledServers).toEqual(['tool']);
  });

  it('switches off a server from a machine or managed layer', () => {
    const isolation = codexRunIsolation({
      config: { mcp_servers: { managed: { command: 'node' } } },
      origins: { 'mcp_servers.managed.command': system },
    });
    expect(isolation.disabledServers).toEqual(['managed']);
  });

  it('switches off a server Codex reports no origin for', () => {
    const isolation = codexRunIsolation({ config: { mcp_servers: { unknown: { command: 'node' } } }, origins: {} });
    expect(isolation.disabledServers).toEqual(['unknown']);
    // …and one whose answer carries no origins map at all.
    expect(codexRunIsolation({ config: { mcp_servers: { unknown: { url: 'http://x' } } } }).disabledServers).toEqual(['unknown']);
  });

  it("switches off xezar's bridge even when the project declares it (#323)", () => {
    const isolation = codexRunIsolation({
      config: { mcp_servers: { leader: { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] } } },
      origins: { 'mcp_servers.leader.command': project, 'mcp_servers.leader.args.2': project },
    });
    expect(isolation.disabledServers).toEqual(['leader']);
  });

  it('does not confuse a server name that prefixes another', () => {
    const isolation = codexRunIsolation({
      config: { mcp_servers: { db: { command: 'node' }, 'db-admin': { command: 'node' } } },
      origins: { 'mcp_servers.db.command': project, 'mcp_servers.db-admin.command': user },
    });
    expect(isolation.disabledServers).toEqual(['db-admin']);
  });

  it('turns plugins and apps off even when no server is configured', () => {
    expect(codexRunIsolation({ config: {}, origins: {} })).toEqual({
      config: { features: { plugins: false, apps: false } },
      disabledServers: [],
    });
  });

  it('refuses an answer without a config instead of reading it as "nothing to switch off"', () => {
    expect(() => codexRunIsolation({})).toThrow('without a config');
    expect(() => codexRunIsolation(undefined)).toThrow('without a config');
    expect(() => codexRunIsolation({ config: null })).toThrow('without a config');
  });

  it('puts a home server named __proto__ on the wire, not only in the note (#415 review)', () => {
    // JSON.parse makes `__proto__` an own key, exactly as the app-server's answer arrives.
    const answer: unknown = JSON.parse(
      JSON.stringify({ config: { mcp_servers: { placeholder: { command: 'node', args: ['proto.mjs'] } } } }).replace(
        '"placeholder"',
        '"__proto__"',
      ),
    );
    const isolation = codexRunIsolation({
      ...(answer as object),
      origins: { 'mcp_servers.__proto__.command': user, 'mcp_servers.__proto__.args.0': user },
    });
    expect(isolation.disabledServers).toEqual(['__proto__']);

    // What `thread/start` actually sends is the JSON text, so check the round trip.
    const wire = JSON.parse(JSON.stringify(isolation.config)) as { mcp_servers: Record<string, unknown> };
    expect(Object.hasOwn(wire.mcp_servers, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(wire.mcp_servers, '__proto__')?.value).toEqual({ enabled: false });
  });

  it('reads the answer codex-cli 0.154.0 gave for a trusted project (recorded live)', () => {
    // Recorded from a real `config/read` (throwaway CODEX_HOME, trusted project). Defaults Codex
    // fills in (`enabled`, `environment_id`, `tool_timeout_sec`, an empty `args`) carry NO origin,
    // so a project server must not be switched off for lacking one.
    const answer = {
      config: {
        mcp_servers: {
          projsrv: { command: 'node', args: ['a.mjs', 'b'], env: { K: 'v' }, environment_id: 'local', enabled: true, tool_timeout_sec: null },
          mixed: { command: 'node', args: [], env: { A: 'home' }, environment_id: 'local', enabled: true, tool_timeout_sec: null },
          leader: { command: '/usr/bin/env', args: ['xezar', 'mcp'], environment_id: 'local', enabled: true, tool_timeout_sec: null },
          ambient: { command: 'node', args: ['home.mjs'], environment_id: 'local', enabled: true, tool_timeout_sec: null },
        },
      },
      origins: {
        'mcp_servers.projsrv.command': project,
        'mcp_servers.projsrv.args.0': project,
        'mcp_servers.projsrv.args.1': project,
        'mcp_servers.projsrv.env.K': project,
        'mcp_servers.mixed.command': project,
        'mcp_servers.mixed.env.A': user,
        'mcp_servers.leader.command': project,
        'mcp_servers.leader.args.0': project,
        'mcp_servers.leader.args.1': project,
        'mcp_servers.ambient.command': user,
        'mcp_servers.ambient.args.0': user,
      },
    };
    expect(codexRunIsolation(answer).disabledServers).toEqual(['ambient', 'leader', 'mixed']);
  });
});

describe('isXezarBridge', () => {
  it.each([
    ['leader', { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] }],
    ['leader', { command: 'npx', args: ['-y', '@qodeca/xezar@0.14.0', 'mcp'] }],
    ['leader', { command: '/usr/local/bin/xezar', args: ['mcp'] }],
    ['leader', { command: 'xez', args: ['mcp'] }],
    ['leader', { command: 'C:\\npm\\xezar.cmd', args: ['mcp'] }],
    // The two launch lines the #415 review found slipping through.
    ['leader', { command: '/usr/bin/env', args: ['xezar', 'mcp'] }],
    ['leader', { command: 'node', args: ['/opt/node_modules/@qodeca/xezar/dist/index.js', 'mcp'] }],
    // Other wrappers around the same bridge.
    ['leader', { command: 'env', args: ['XEZ_HOME=/tmp/x', 'xez', 'mcp'] }],
    ['leader', { command: 'sh', args: ['-c', 'exec npx -y @qodeca/xezar mcp'] }],
    ['leader', { command: 'bash', args: ['-lc', '"xezar" mcp'] }],
    ['leader', { command: 'npx', args: ['--package=@qodeca/xezar', 'xezar', 'mcp'] }],
    ['leader', { command: 'npm', args: ['exec', '@qodeca/xezar@latest', '--', 'mcp'] }],
    ['leader', { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@qodeca\\xezar\\dist\\index.js', 'mcp'] }],
    // A checkout: the entry point the package `bin` points at, built or from source.
    ['leader', { command: 'node', args: ['/src/xezar/packages/xezar/dist/index.js', 'mcp'] }],
    ['leader', { command: 'npx', args: ['tsx', 'packages/xezar/src/index.ts', 'mcp'] }],
    // The entry point with no `mcp` is not a working MCP server either; off, at no cost.
    ['leader', { command: 'node', args: ['/opt/node_modules/@qodeca/xezar/dist/index.js'] }],
  ])('recognises %s %j', (name, server) => {
    expect(isXezarBridge(name, server)).toBe(true);
  });

  it.each([
    ['chrome-devtools', { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }],
    ['other', { command: 'npx', args: ['-y', '@qodeca/xezar-skills'] }],
    ['other', { command: 'xezar', args: ['serve'] }],
    ['xezar-docs', { url: 'http://127.0.0.1:1/mcp' }],
    ['docs', { command: 'node', args: ['tools/xezar-docs-server.mjs', 'mcp'] }],
    ['docs', { command: 'node', args: ['tools/docs.mjs', '--root', '/src/xezar'] }],
    ['docs', { command: 'node', args: ['/src/xezar/tools/docs.mjs'] }],
  ])('does not flag %s %j', (name, server) => {
    expect(isXezarBridge(name, server)).toBe(false);
  });

  it('reserves the name xezar, whatever the server runs (the rename remedy is in the README)', () => {
    expect(isXezarBridge('xezar', {})).toBe(true);
    expect(isXezarBridge('XEZAR', { command: 'node', args: ['tools/docs-server.mjs'] })).toBe(true);
  });
});

describe('codexIsolationNote', () => {
  it('names the switched-off servers', () => {
    const note = codexIsolationNote({ config: {}, disabledServers: ['ambient', 'xezar'] });
    expect(note).toContain('off: ambient, xezar');
    expect(note).toContain('plugins and apps are off');
  });

  it('stays quiet when nothing was switched off', () => {
    expect(codexIsolationNote({ config: {}, disabledServers: [] })).toBeNull();
  });
});
