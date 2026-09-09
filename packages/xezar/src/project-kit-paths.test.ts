import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectKitDir } from './project-kit-paths.ts';
import { loadConfig, gatedSkillsRepos } from './config.ts';
import { agentModelsLocked } from './core/agent-model-policy.ts';
import { discoverSkills } from './skills.ts';
import { loadWorkflows } from './workflows/load.ts';

describe('project kit layout', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xez-kit-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  function write(path: string, value: string) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }
  function kit(dir: string, name: string) {
    write(`${dir}/config.json`, JSON.stringify({ baseBranch: name, modelsLocked: true, skillsRepos: [] }));
    write(`${dir}/workflows/custom.yaml`, `name: ${name}\nsteps:\n  - id: work\n    prompt: custom\n`);
    write(`${dir}/skills/custom.md`, `---\nname: ${name}\n---\nCustom guidance`);
  }

  it('uses .xezar without creating files in a new project', () => {
    expect(projectKitDir(root)).toBe(join(root, '.xezar'));
    expect(existsSync(join(root, '.xezar'))).toBe(false);
  });

  it('never treats the global workspace directory as a project kit', async () => {
    const saved = process.env.XEZ_HOME;
    process.env.XEZ_HOME = join(root, '.xezar');
    try {
      write('.xezar/config.json', '{"baseBranch":"global-only","modelsLocked":true}');
      expect(projectKitDir(root)).toBe(join(root, '.local/xezar/kit'));
      expect((await loadConfig(root)).baseBranch).not.toBe('global-only');
      expect(readFileSync(join(root, '.xezar/config.json'), 'utf8'))
        .toBe('{"baseBranch":"global-only","modelsLocked":true}');
    } finally {
      if (saved === undefined) delete process.env.XEZ_HOME;
      else process.env.XEZ_HOME = saved;
    }
  });

  it('loads config, model policy, workflows and skills from .xezar', async () => {
    kit('.xezar', 'project-custom');
    expect((await loadConfig(root)).baseBranch).toBe('project-custom');
    expect(agentModelsLocked(root, {})).toBe(true);
    expect(await gatedSkillsRepos(root)).toEqual(new Set());
    expect((await loadWorkflows(root)).workflows.map(w => w.name)).toContain('project-custom');
    expect((await discoverSkills(root)).find(s => s.name === 'project-custom')?.path)
      .toBe(join(root, '.xezar/skills/custom.md'));
    expect(projectKitDir(root)).toBe(join(root, '.xezar'));
  });

  it('never reads a pre-.xezar directory, and leaves its bytes untouched on disk', async () => {
    kit('.ai/xezar', 'old-custom');
    write('.ai/xezar/runs.json', '[]');
    const before = readFileSync(join(root, '.ai/xezar/config.json'), 'utf8');
    for (let restart = 0; restart < 2; restart++) {
      expect(projectKitDir(root)).toBe(join(root, '.xezar'));
      expect((await loadConfig(root)).baseBranch).not.toBe('old-custom');
      expect(agentModelsLocked(root, {})).toBe(false);
      expect((await loadWorkflows(root)).workflows.map(w => w.name)).toEqual(['quick-task']);
      expect((await discoverSkills(root)).map(s => s.name)).not.toContain('old-custom');
    }
    expect(readFileSync(join(root, '.ai/xezar/config.json'), 'utf8')).toBe(before);
    expect(existsSync(join(root, '.xezar'))).toBe(false);
  });

  it('keeps the canonical kit when an old directory sits beside it', async () => {
    kit('.ai/xezar', 'old-custom');
    kit('.xezar', 'new-custom');
    expect((await loadConfig(root)).baseBranch).toBe('new-custom');
    expect((await loadWorkflows(root)).workflows.map(w => w.name)).not.toContain('old-custom');
    rmSync(join(root, '.xezar/workflows'), { recursive: true });
    expect((await loadWorkflows(root)).workflows.map(w => w.name)).toEqual(['quick-task']);
  });
});
