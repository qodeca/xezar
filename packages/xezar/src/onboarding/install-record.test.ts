import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { installRecordPath, readInstallRecord } from './install-record.ts';

/** The committed `.xezar/onboarding.json` read: present, absent, and every malformed shape. */
describe('readInstallRecord', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-install-record-'));
  });

  afterEach(() => {
    rmSync(root, TEST_DIR_RM_OPTIONS);
  });

  const write = (content: string) => {
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(installRecordPath(root), content);
  };

  it('reads the record the onboarding writes, keeping only what the engine relies on', async () => {
    write(
      JSON.stringify({
        version: '3.2.1',
        skill: 'xez-onboard-opinionated',
        date: '2026-09-27T09:11:23Z',
        baseCommit: '5459cc6',
        files: { 'AGENTS.md': { origin: 'copied', sha256: 'abc' } },
      }),
    );
    await expect(readInstallRecord(root)).resolves.toEqual({
      skill: 'xez-onboard-opinionated',
      date: '2026-09-27T09:11:23Z',
      version: '3.2.1',
    });
  });

  // The record still counts without a usable version: `version` is read, never required, so an
  // older record keeps reading as a finished setup and status.ts never calls it old on no evidence.
  it.each([
    ['absent', {}],
    ['a number', { version: 1 }],
    ['an empty string', { version: '' }],
    ['null', { version: null }],
    ['an object', { version: { major: 3 } }],
  ])('reads a record whose version is %s as version null, never as absent', async (_label, extra) => {
    write(JSON.stringify({ skill: 'xez-onboard-opinionated', date: '2026-09-27T09:11:23Z', ...extra }));
    await expect(readInstallRecord(root)).resolves.toEqual({
      skill: 'xez-onboard-opinionated',
      date: '2026-09-27T09:11:23Z',
      version: null,
    });
  });

  it('keeps a version it cannot parse verbatim — judging it is not the reader’s job', async () => {
    write(JSON.stringify({ skill: 'xez-onboard-opinionated', date: '2026-09-27T09:11:23Z', version: 'next' }));
    await expect(readInstallRecord(root)).resolves.toMatchObject({ version: 'next' });
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
