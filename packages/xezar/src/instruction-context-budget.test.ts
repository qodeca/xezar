import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readRootFile = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

describe('always-loaded agent instruction budgets', () => {
  it('keeps root AGENTS.md below Codex’s 32 KiB read limit', () => {
    const bytes = Buffer.byteLength(readRootFile('AGENTS.md'));
    expect(bytes, 'AGENTS.md must stay below 32,768 bytes so Codex reads all of it').toBeLessThan(32_768);
  });

  it('keeps root CLAUDE.md and its eager imports below 100,000 characters', () => {
    const rootClaude = readRootFile('CLAUDE.md');
    const imports = rootClaude
      .split('\n')
      .filter((line) => line.startsWith('@'))
      .map((line) => line.slice(1).trim());
    const characters = [rootClaude, ...imports.map(readRootFile)]
      .reduce((total, content) => total + content.length, 0);

    expect(characters, 'root CLAUDE.md plus its eager imports must stay below 100,000 characters')
      .toBeLessThan(100_000);
  });
});
