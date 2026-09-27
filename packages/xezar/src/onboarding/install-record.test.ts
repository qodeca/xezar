import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { installRecordPath, readInstallRecord } from './install-record.ts';

/** The committed `.xezar/onboarding.json` read: present, absent, and every malformed shape. */
describe('readInstallRecord', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-install-record-'));
  });

  const write = (content: string) => {
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(installRecordPath(root), content);
  };

  it('reads the record the 3.0.3 onboarding writes, keeping only what the engine relies on', async () => {
    write(
      JSON.stringify({
        version: 1,
        skill: 'xez-onboard-opinionated',
        date: '2026-09-27T09:11:23Z',
        baseCommit: '5459cc6',
        files: { 'AGENTS.md': { origin: 'copied', sha256: 'abc' } },
      }),
    );
    await expect(readInstallRecord(root)).resolves.toEqual({
      skill: 'xez-onboard-opinionated',
      date: '2026-09-27T09:11:23Z',
    });
  });

  it('is null when the file is absent', async () => {
    await expect(readInstallRecord(root)).resolves.toBeNull();
  });

  it.each([
    ['empty file', ''],
    ['not JSON', '{ "skill": '],
    ['JSON that is not an object', '[1, 2]'],
    ['another skill wrote it', JSON.stringify({ skill: 'xez-onboard', date: '2026-09-01T00:00:00Z' })],
    ['no date', JSON.stringify({ skill: 'xez-onboard-opinionated' })],
  ])('treats a malformed record (%s) as absent, without throwing', async (_label, content) => {
    write(content);
    await expect(readInstallRecord(root)).resolves.toBeNull();
  });
});
