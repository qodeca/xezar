import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILES, findConfigFile, listConfigFiles, type AgentHomePaths } from './catalog.ts';

const HOME: AgentHomePaths = {
  claude: '/home/u/.claude',
  codex: '/home/u/.codex',
  qwen: '/home/u/.qwen',
};

describe('agent-config catalog', () => {
  it('every id is unique and URL-safe', () => {
    const ids = CONFIG_FILES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9.]+$/);
  });

  it('every entry carries a non-empty precedence string and a docs URL', () => {
    for (const f of CONFIG_FILES) {
      expect(f.precedence.trim().length).toBeGreaterThan(0);
      expect(f.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('<repo>/AGENTS.md is ONE entry, read by Codex', () => {
    const agents = CONFIG_FILES.filter((f) => f.label === 'AGENTS.md' && f.scope === 'project');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runners).toEqual(['codex']);
  });

  it('resolves repo-relative paths under the repo root', () => {
    const proj = findConfigFile('claude.project.settings')!;
    expect(proj.resolve('/repo', HOME)).toBe(join('/repo', '.claude', 'settings.json'));
  });

  it('honours the injected home dirs (so $CODEX_HOME flows through)', () => {
    expect(findConfigFile('codex.user.config')!.resolve('/repo', HOME)).toBe(join('/home/u', '.codex', 'config.toml'));
    expect(findConfigFile('qwen.user.settings')!.resolve('/repo', HOME)).toBe(join('/home/u', '.qwen', 'settings.json'));
    expect(findConfigFile('claude.user.settings')!.resolve('/repo', HOME)).toBe(join('/home/u', '.claude', 'settings.json'));
  });

  it('marks only Claude’s gitignored personal layer as seeded', () => {
    const seeded = CONFIG_FILES.filter((f) => f.seeded).map((f) => f.id).sort();
    expect(seeded).toEqual(['claude.local.memory', 'claude.local.settings']);
    for (const f of CONFIG_FILES) {
      if (f.seeded) expect(f.tracked).toBe('gitignored');
    }
  });

  it('every seeded/gitignored file is a repo-relative path (never in $HOME)', () => {
    for (const f of CONFIG_FILES) {
      if (f.tracked === 'gitignored') expect(f.resolve('/repo', HOME).startsWith(join('/repo') + sep)).toBe(true);
    }
  });

  it('holdsMcp is set exactly where MCP servers actually live', () => {
    const mcp = CONFIG_FILES.filter((f) => f.holdsMcp).map((f) => f.id).sort();
    expect(mcp).toEqual([
      'claude.project.mcp',
      'codex.project.config',
      'codex.user.config',
      'qwen.project.settings',
      'qwen.user.settings',
    ]);
  });

  it('listConfigFiles returns the table; findConfigFile is undefined for junk', () => {
    expect(listConfigFiles().length).toBe(CONFIG_FILES.length);
    expect(findConfigFile('../../etc/passwd')).toBeUndefined();
    expect(findConfigFile('nope')).toBeUndefined();
  });
});
