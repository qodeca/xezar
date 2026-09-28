import { describe, expect, it } from 'vitest';
import { withPlatform } from '../../test/helpers/platform.ts';
import type { ProjectListEntry } from '../workspace/projects.ts';
import { withBootProject } from './server.ts';

/**
 * The list the automations warm-up and the skills-update coordinator work from (#963 Q3): the boot
 * repo is prepended only when no registry row names it. On Windows a row in another letter case
 * names it; POSIX keeps the exact compare.
 */
describe('withBootProject', () => {
  const row = (root: string): ProjectListEntry => ({
    id: 'stored',
    root,
    name: 'stored',
    addedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    source: 'local',
    status: 'ok',
  });
  const bootRow = (root: string) => ({ id: 'boot', root, status: 'ok' as const });

  it('keeps the registry as it is when a row names the boot repo exactly', async () => {
    const projects = [row('/work/Repo')];
    for (const platform of ['linux', 'win32'] as const) {
      expect(await withPlatform(platform, () => withBootProject(projects, '/work/Repo', 'boot'))).toBe(projects);
    }
  });

  it('treats a row in another letter case as the boot repo on Windows, so it is listed once', async () => {
    const projects = [row('C:\\WORK\\REPO')];
    expect(await withPlatform('win32', () => withBootProject(projects, 'C:\\work\\Repo', 'boot'))).toBe(projects);
  });

  it.each(['linux', 'darwin'] as const)('prepends the boot repo on %s when only another letter case is stored', async (platform) => {
    const projects = [row('/WORK/REPO')];
    expect(await withPlatform(platform, () => withBootProject(projects, '/work/Repo', 'boot'))).toEqual([bootRow('/work/Repo'), ...projects]);
  });

  it("prepends the boot repo under 'default' when the boot project has no id", async () => {
    expect(await withPlatform('win32', () => withBootProject([], 'C:\\work\\Repo', undefined))).toEqual([
      { id: 'default', root: 'C:\\work\\Repo', status: 'ok' },
    ]);
  });
});
