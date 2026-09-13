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
});

describe('isXezarBridge', () => {
  it.each([
    ['xezar', {}],
    ['XEZAR', { command: 'node' }],
    ['leader', { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] }],
    ['leader', { command: 'npx', args: ['-y', '@qodeca/xezar@0.14.0', 'mcp'] }],
    ['leader', { command: '/usr/local/bin/xezar', args: ['mcp'] }],
    ['leader', { command: 'xez', args: ['mcp'] }],
    ['leader', { command: 'C:\\npm\\xezar.cmd', args: ['mcp'] }],
  ])('recognises %s %j', (name, server) => {
    expect(isXezarBridge(name, server)).toBe(true);
  });

  it.each([
    ['chrome-devtools', { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }],
    ['other', { command: 'npx', args: ['-y', '@qodeca/xezar-skills'] }],
    ['other', { command: 'xezar', args: ['serve'] }],
    ['xezar-docs', { url: 'http://127.0.0.1:1/mcp' }],
  ])('does not flag %s %j', (name, server) => {
    expect(isXezarBridge(name, server)).toBe(false);
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
