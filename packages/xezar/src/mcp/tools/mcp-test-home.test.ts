import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * #671 — the pin that keeps a developer's own skill catalog out of an MCP fixture.
 *
 * This file is the retained proof for `mcp-test-home.testkit.ts`. It makes the "process HOME
 * carries a skill" condition DETERMINISTIC instead of depending on the machine the suite runs on:
 * `vi.hoisted` installs a scratch HOME that carries `~/.agents/skills/xez-issue-create/SKILL.md`
 * before any import below is evaluated — exactly the state a developer's machine reaches once
 * xezar's default-on skills update has written that catalog.
 *
 * The testkit import then replaces that HOME with its own empty scratch. Discovery resolves its
 * global dirs from `os.homedir()` once, at module load, so if the pin is removed the dirs point at
 * the skill-bearing home and `discoverSkills` returns the skill — this case goes red. With the pin
 * the catalog is empty, which is what "a project with no skills" has to mean.
 */
const ambient = vi.hoisted(() => {
  const base = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '');
  const home = `${base}/xez-mcp-ambient-home-${process.pid}`;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home };
});

// Imported AFTER the ambient home above is installed and BEFORE anything that reaches skills.ts:
// this is the pin under test. `mcpAmbientHome` records the home the testkit replaced.
import { mcpAmbientHome, mcpTestHome } from './mcp-test-home.testkit.ts';
import { discoverSkills } from '../../skills.ts';

const SKILL = 'xez-issue-create';

describe('the MCP test home pin (#671)', () => {
  it('the fixture catalog is empty even when the process HOME carries a skill', async () => {
    // Control 1 — the home this file started from really does carry the skill, so the assertion
    // below is made against a catalog that a developer's machine would really have.
    const skillFile = join(ambient.home, '.agents', 'skills', SKILL, 'SKILL.md');
    mkdirSync(join(ambient.home, '.agents', 'skills', SKILL), { recursive: true });
    writeFileSync(skillFile, `---\nname: ${SKILL}\ndescription: the ambient home skill\n---\nDo it.\n`, 'utf8');
    expect(existsSync(skillFile)).toBe(true);

    // Control 2 — the pin replaced that home, and the pin is what discovery resolved against.
    expect(mcpAmbientHome).toBe(ambient.home);
    expect(process.env.HOME).toBe(mcpTestHome);
    expect(process.env.HOME).not.toBe(ambient.home);

    // The fixture's catalog: a project root with no skills of its own, against the pinned empty
    // home. Without the pin this list is the ambient `xez-issue-create` and the case fails.
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'xez-mcp-empty-root-'));
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    try {
      expect(await discoverSkills(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
