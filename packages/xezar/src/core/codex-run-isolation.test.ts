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
      projectOnlyServers: [],
      keptOff: [],
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

/**
 * #1007 — a server the project declares and the home config also names. Codex merges a per-thread
 * override into the layered config key by key (`merge_toml_values` in codex-rs/config: tables merge
 * recursively, anything else replaces), so these tests merge the override onto the home layer the
 * same way and compare the result with the project layer alone.
 */
function mergeLikeCodex(base: unknown, overlay: unknown): unknown {
  const isTable = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (!isTable(base) || !isTable(overlay)) return overlay;
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) merged[key] = key in merged ? mergeLikeCodex(merged[key], value) : value;
  return merged;
}

/** A `config/read` answer with `includeLayers: true` for one server, shaped like codex-cli 0.156.1's. */
function layeredAnswer(name: string, projectDef: Record<string, unknown>, homeDef: Record<string, unknown>) {
  const leafOrigins = (def: Record<string, unknown>, layer: unknown, prefix: string): [string, unknown][] =>
    Object.entries(def).flatMap(([key, value]) => {
      if (Array.isArray(value)) return value.map((_, i) => [`${prefix}${key}.${i}`, layer] as [string, unknown]);
      if (value && typeof value === 'object') return leafOrigins(value as Record<string, unknown>, layer, `${prefix}${key}.`);
      return [[`${prefix}${key}`, layer] as [string, unknown]];
    });
  const prefix = `mcp_servers.${name}.`;
  return {
    config: { mcp_servers: { [name]: mergeLikeCodex(homeDef, projectDef) } },
    // Project first: a project key hides the home key of the same path from `origins`.
    origins: Object.fromEntries([...leafOrigins(homeDef, user, prefix), ...leafOrigins(projectDef, project, prefix)]),
    layers: [
      { ...project, config: { mcp_servers: { [name]: projectDef } } } as Record<string, unknown>,
      { ...user, config: { mcp_servers: { [name]: homeDef } } },
      { ...system, config: {} },
    ],
  };
}

describe('codexRunIsolation: a project server the home config also names (#1007)', () => {
  // The reported machine, key for key (values are stand-ins): the project pins the server and sets
  // a default approval mode; the home config runs `@latest` and approves one tool on its own.
  const projectDef = {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.10.1', '--isolated', '--headless'],
    startup_timeout_sec: 30,
    default_tools_approval_mode: 'prompt',
    enabled_tools: ['navigate_page', 'take_screenshot'],
  };
  const homeDef = {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    tools: { navigate_page: { approval_mode: 'approve' } },
  };

  it('keeps the server on and sends the project definition in place of the merged one', () => {
    const isolation = codexRunIsolation(layeredAnswer('chrome-devtools', projectDef, homeDef));
    expect(isolation.disabledServers).toEqual([]);
    expect(isolation.projectOnlyServers).toEqual(['chrome-devtools']);
    expect(isolation.config).toEqual({
      mcp_servers: {
        'chrome-devtools': { ...projectDef, tools: { navigate_page: { approval_mode: 'prompt' } } },
      },
      features: { plugins: false, apps: false },
    });
  });

  it('lets no home-config key reach the run: home + override behaves as the project layer alone', () => {
    const isolation = codexRunIsolation(layeredAnswer('chrome-devtools', projectDef, homeDef));
    const override = (isolation.config.mcp_servers as Record<string, unknown>)['chrome-devtools'];
    const effective = mergeLikeCodex(homeDef, override) as Record<string, unknown>;
    // Every key the run gets is the project's, except the one approval mode, which is pinned to
    // the value the project-only config resolves it to (per-tool mode, else the server default).
    const { tools, ...rest } = effective;
    expect(rest).toEqual(projectDef);
    expect(tools).toEqual({ navigate_page: { approval_mode: projectDef.default_tools_approval_mode } });
    expect(JSON.stringify(effective)).not.toContain('@latest');
  });

  it('keeps a server the home config alone declares off, layers or not', () => {
    const answer = layeredAnswer('ambient', {}, homeDef);
    answer.layers[0] = { ...project, config: {} };
    const isolation = codexRunIsolation(answer);
    expect(isolation.disabledServers).toEqual(['ambient']);
    expect(isolation.projectOnlyServers).toEqual([]);
  });

  it.each([
    ['an env entry', { env: { TOKEN: 'secret-value' } }, 'env.TOKEN'],
    ['a url beside the project command', { url: 'http://127.0.0.1:9/mcp' }, 'url'],
    ['a tool approval mode with no project default', { tools: { navigate_page: { approval_mode: 'approve' } } }, 'tools.navigate_page.approval_mode'],
    ['enabled = false', { enabled: false }, 'enabled'],
  ])('keeps the server off when the home config adds %s no override can leave out', (_label, homeExtra, key) => {
    const { default_tools_approval_mode: _ignored, ...withoutDefault } = projectDef;
    const isolation = codexRunIsolation(layeredAnswer('chrome-devtools', withoutDefault, { ...homeDef, ...homeExtra }));
    expect(isolation.disabledServers).toEqual(['chrome-devtools']);
    expect(isolation.projectOnlyServers).toEqual([]);
    const note = codexIsolationNote(isolation) ?? '';
    expect(note).toContain(key);
    // Key paths only: a value from the person's own config never reaches the note.
    expect(note).not.toContain('secret-value');
    expect(note).not.toContain('127.0.0.1');
  });

  it('keeps the server off when Codex reports no layers (an older CLI, or includeLayers ignored)', () => {
    const { layers: _layers, ...answer } = layeredAnswer('chrome-devtools', projectDef, homeDef);
    const isolation = codexRunIsolation(answer);
    expect(isolation.disabledServers).toEqual(['chrome-devtools']);
    expect(codexIsolationNote(isolation)).toContain("did not report the project's own settings");
  });

  it('ignores a project layer Codex disabled (an untrusted project)', () => {
    const answer = layeredAnswer('chrome-devtools', projectDef, homeDef);
    answer.layers[0] = { ...answer.layers[0], disabledReason: 'add the project as trusted' };
    expect(codexRunIsolation(answer).disabledServers).toEqual(['chrome-devtools']);
  });

  it("keeps xezar's bridge off even when the project definition is the bridge (#323)", () => {
    const bridge = { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] };
    const isolation = codexRunIsolation(layeredAnswer('leader', bridge, { command: 'node', args: ['home.mjs'] }));
    expect(isolation.disabledServers).toEqual(['leader']);
    expect(isolation.projectOnlyServers).toEqual([]);
  });

  it('puts a project-only definition for a server named __proto__ on the wire', () => {
    const answer: unknown = JSON.parse(
      JSON.stringify(layeredAnswer('placeholder', projectDef, homeDef)).replaceAll('placeholder', '__proto__'),
    );
    const isolation = codexRunIsolation(answer);
    expect(isolation.projectOnlyServers).toEqual(['__proto__']);
    const wire = JSON.parse(JSON.stringify(isolation.config)) as { mcp_servers: Record<string, unknown> };
    expect(Object.getOwnPropertyDescriptor(wire.mcp_servers, '__proto__')?.value).toMatchObject({ command: 'npx', args: projectDef.args });
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
    const note = codexIsolationNote({ config: {}, disabledServers: ['ambient', 'xezar'], projectOnlyServers: [], keptOff: [] });
    expect(note).toContain('off: ambient, xezar');
    expect(note).toContain('plugins and apps are off');
  });

  it('stays quiet when nothing was switched off', () => {
    expect(codexIsolationNote({ config: {}, disabledServers: [], projectOnlyServers: [], keptOff: [] })).toBeNull();
  });

  it('says which servers run with the project settings only (#1007)', () => {
    const note = codexIsolationNote({ config: {}, disabledServers: [], projectOnlyServers: ['chrome-devtools'], keptOff: [] });
    expect(note).toContain("chrome-devtools is set up with the project's own settings only");
  });
});
