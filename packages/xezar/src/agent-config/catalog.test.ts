import { describe, expect, it } from 'vitest';
import { CONFIG_FILES, findConfigFile, listConfigFiles, type AgentHomePaths } from './catalog.ts';

const HOME: AgentHomePaths = {
  claude: '/home/u/.claude',
  codex: '/home/u/.codex',
  opencodeConfig: '/home/u/.config/opencode',
  pi: '/home/u/.pi/agent',
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

  it('<repo>/AGENTS.md is ONE entry read by two runners', () => {
    const agents = CONFIG_FILES.filter((f) => f.label === 'AGENTS.md' && f.scope === 'project');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runners).toEqual(['codex', 'opencode']);
  });

  it('resolves repo-relative paths under the repo root', () => {
    const proj = findConfigFile('claude.project.settings')!;
    expect(proj.resolve('/repo', HOME)).toBe('/repo/.claude/settings.json');
  });

  it('honours the injected home dirs (so $CODEX_HOME / $XDG_CONFIG_HOME flow through)', () => {
    expect(findConfigFile('codex.user.config')!.resolve('/repo', HOME)).toBe('/home/u/.codex/config.toml');
    expect(findConfigFile('opencode.user.config')!.resolve('/repo', HOME)).toBe(
      '/home/u/.config/opencode/opencode.json',
    );
    expect(findConfigFile('claude.user.settings')!.resolve('/repo', HOME)).toBe('/home/u/.claude/settings.json');
  });

  /**
   * #330 WP4. The entries themselves, and the two exclusions that are the point of the block:
   * `auth.json` holds pi's credentials and `models.json` holds an `apiKey` per custom provider, and
   * a catalog entry is a file `GET /api/v1/agent-config/:id` hands over whole (F-15).
   */
  describe('pi', () => {
    it('catalogs pi’s settings, MCP and global-instruction files, resolved in pi’s own home', () => {
      expect(findConfigFile('pi.user.settings')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/settings.json');
      expect(findConfigFile('pi.user.mcp')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/mcp.json');
      expect(findConfigFile('pi.user.memory')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/AGENTS.md');
      expect(findConfigFile('pi.project.settings')!.resolve('/repo', HOME)).toBe('/repo/.pi/settings.json');
      expect(findConfigFile('pi.project.mcp')!.resolve('/repo', HOME)).toBe('/repo/.pi/mcp.json');
    });

    it('catalogs NO file in pi’s home that holds a credential', () => {
      // The control the "no secret" claim needs: pi's home IS catalogued (so an empty result
      // would not be why this passes), and these two names are absent from it by name.
      const piHomeFiles = CONFIG_FILES.filter((f) => f.resolve('/repo', HOME).startsWith('/home/u/.pi/agent/'));
      expect(piHomeFiles.length).toBeGreaterThan(0);
      const names = piHomeFiles.map((f) => f.resolve('/repo', HOME).split('/').pop());
      expect(names).not.toContain('auth.json');
      expect(names).not.toContain('models.json');
      expect(names).not.toContain('models-store.json');
      expect(names.sort()).toEqual(['AGENTS.md', 'mcp.json', 'settings.json']);
    });

    it('every pi entry belongs to pi alone, and no other entry claims to be pi’s', () => {
      const piEntries = CONFIG_FILES.filter((f) => f.runners.includes('pi'));
      expect(piEntries.map((f) => f.id).sort()).toEqual([
        'pi.project.mcp',
        'pi.project.settings',
        'pi.user.mcp',
        'pi.user.memory',
        'pi.user.settings',
      ]);
      for (const f of piEntries) expect(f.runners).toEqual(['pi']);
    });

    /**
     * A guard, not a change: pi's native default model is deliberately NOT wired, because pi's
     * ids are `provider/model` composites while its settings split the halves. Adding `modelKey`
     * here without composing them in `model-settings/pi.ts` would report a bare half that
     * `pi --model` does not name.
     */
    it('carries no model key — wiring pi’s native default is a separate change', () => {
      const piEntries = CONFIG_FILES.filter((f) => f.runners.includes('pi'));
      // Two controls: pi entries EXIST (an empty list would pass this vacuously), and some entry
      // somewhere does carry a model key (so "undefined" means "not set for pi", not "never set").
      expect(piEntries.some((f) => f.kind === 'settings')).toBe(true);
      expect(CONFIG_FILES.some((f) => f.modelKey !== undefined)).toBe(true);
      for (const f of piEntries) {
        expect(f.modelKey, f.id).toBeUndefined();
        expect(f.modelPriority, f.id).toBeUndefined();
      }
    });

    it('quotes the adapter’s ordering sentence identically in both MCP entries', () => {
      // Both files are ranked by ONE sentence; two paraphrases would be the drift this table exists
      // to prevent, and the order is what tells a user which of their two files actually wins.
      const quote =
        '“Precedence is (later entries win): 1. ~/.config/mcp/mcp.json 2. ~/.agents/mcp.json 3. ~/.agents/mcp/mcp.json 4. <Pi agent dir>/mcp.json 5. .mcp.json 6. .pi/mcp.json”.';
      expect(findConfigFile('pi.user.mcp')!.precedence).toContain(quote);
      expect(findConfigFile('pi.project.mcp')!.precedence).toContain(quote);
    });
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
      if (f.tracked === 'gitignored') expect(f.resolve('/repo', HOME).startsWith('/repo/')).toBe(true);
    }
  });

  it('holdsMcp is set exactly where MCP servers actually live', () => {
    const mcp = CONFIG_FILES.filter((f) => f.holdsMcp).map((f) => f.id).sort();
    expect(mcp).toEqual([
      'claude.project.mcp',
      'codex.project.config',
      'codex.user.config',
      'opencode.project.config',
      'opencode.user.config',
      'pi.project.mcp',
      'pi.user.mcp',
    ]);
  });

  it('listConfigFiles returns the table; findConfigFile is undefined for junk', () => {
    expect(listConfigFiles().length).toBe(CONFIG_FILES.length);
    expect(findConfigFile('../../etc/passwd')).toBeUndefined();
    expect(findConfigFile('nope')).toBeUndefined();
  });
});
