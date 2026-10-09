import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../test/helpers/platform.ts';
import { ensureProjectDataIgnored, projectDataDir } from './project-data-paths.ts';

describe('ensureProjectDataIgnored', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'xez-data-ignore-'));
  });
  afterEach(() => {
    rmSync(repo, TEST_DIR_RM_OPTIONS);
  });

  const ignoreFile = () => join(repo, '.local', '.gitignore');

  it('writes the blanket rule into a new .local/.gitignore', () => {
    ensureProjectDataIgnored(projectDataDir(repo));
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('\n*\n');
  });

  it('leaves an LF file that already ignores everything byte-for-byte as it is', () => {
    mkdirSync(join(repo, '.local'));
    writeFileSync(ignoreFile(), '*\n');
    ensureProjectDataIgnored(projectDataDir(repo));
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('*\n');
  });

  it('does not append the rule again to a CRLF file that already has it (#963)', () => {
    mkdirSync(join(repo, '.local'));
    writeFileSync(ignoreFile(), '*\r\n');
    ensureProjectDataIgnored(projectDataDir(repo));
    ensureProjectDataIgnored(projectDataDir(repo));
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('*\r\n');
  });
});
