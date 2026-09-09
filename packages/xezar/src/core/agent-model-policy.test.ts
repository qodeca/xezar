import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentModelsLocked } from './agent-model-policy.ts';

describe('agentModelsLocked', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('is off by default and only exact 1 enables it', () => {
    const home = mkdtempSync(join(tmpdir(), 'xez-model-policy-home-'));
    roots.push(home);
    expect(agentModelsLocked(undefined, { XEZ_HOME: home })).toBe(false);
    expect(agentModelsLocked(undefined, { XEZ_HOME: home, XEZ_AGENT_MODELS_LOCKED: '0' })).toBe(false);
    expect(agentModelsLocked(undefined, { XEZ_HOME: home, XEZ_AGENT_MODELS_LOCKED: 'true' })).toBe(false);
    expect(agentModelsLocked(undefined, { XEZ_HOME: home, XEZ_AGENT_MODELS_LOCKED: '1' })).toBe(true);
  });

  it('also accepts the optional repo config flag and degrades malformed files', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'xez-model-policy-'));
    const home = mkdtempSync(join(tmpdir(), 'xez-model-policy-home-'));
    roots.push(repoRoot, home);
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });

    writeFileSync(join(repoRoot, '.xezar', 'config.json'), '{"modelsLocked":true}\n');
    expect(agentModelsLocked(repoRoot, { XEZ_HOME: home })).toBe(true);

    writeFileSync(join(repoRoot, '.xezar', 'config.json'), '{"modelsLocked":false}\n');
    expect(agentModelsLocked(repoRoot, { XEZ_HOME: home })).toBe(false);

    writeFileSync(join(repoRoot, '.xezar', 'config.json'), '{broken');
    expect(agentModelsLocked(repoRoot, { XEZ_HOME: home })).toBe(false);
  });

  it('accepts the global workspace flag for every repository', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'xez-model-policy-'));
    const home = mkdtempSync(join(tmpdir(), 'xez-model-policy-home-'));
    roots.push(repoRoot, home);
    writeFileSync(join(home, 'config.json'), '{"modelsLocked":true}\n');

    expect(agentModelsLocked(repoRoot, { XEZ_HOME: home })).toBe(true);
    expect(agentModelsLocked(undefined, { XEZ_HOME: home })).toBe(true);
  });
});
