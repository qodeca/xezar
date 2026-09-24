import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readRootFile = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');
const readInstructionTree = (path: string, seen = new Set<string>()): string[] => {
  const absolutePath = resolve(repoRoot, path);
  if (seen.has(absolutePath)) return [];
  seen.add(absolutePath);

  const content = readFileSync(absolutePath, 'utf8');
  const imports = content
    .split('\n')
    .filter((line) => line.startsWith('@'))
    .map((line) => resolve(dirname(absolutePath), line.slice(1).trim()));

  return [content, ...imports.flatMap((importPath) => readInstructionTree(importPath, seen))];
};

describe('always-loaded agent instruction budgets', () => {
  it('keeps root AGENTS.md below Codex’s 32 KiB read limit', () => {
    const bytes = Buffer.byteLength(readRootFile('AGENTS.md'));
    expect(bytes, 'AGENTS.md must stay below 32,768 bytes so Codex reads all of it').toBeLessThan(32_768);
  });

  it('keeps root CLAUDE.md and its eager imports below 100,000 characters', () => {
    const characters = readInstructionTree('CLAUDE.md')
      .reduce((total, content) => total + content.length, 0);

    expect(characters, 'root CLAUDE.md plus its eager imports must stay below 100,000 characters')
      .toBeLessThan(100_000);
  });

  it('keeps model routing below the leader context budget', () => {
    const bytes = Buffer.byteLength(readRootFile('.xezar/docs/model-routing.md'));
    expect(bytes, 'model-routing.md must stay below 40,000 bytes').toBeLessThan(40_000);
  });
});
