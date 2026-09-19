import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { registerProject } from '../workspace/projects.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';

/**
 * #600 review M1 — in single-project ROOT mode the registry is the DERIVED row,
 * so the folder that owns its state has no row in the STORED registry. Both MCP
 * doors must resolve it through the layout-aware helper:
 *
 * - `startMcpService` used to find nothing and throw
 *   `project <id> is not in the workspace registry`, so the mode logged
 *   `mcp.unavailable` and the project leader could not drive the folder at all.
 * - the stdio bridge's `resolveMcpTarget` used to answer `not-registered` for
 *   the same folder.
 *
 * Both are RED on the pre-fix source and GREEN through `findRegistryProject`.
 */
describe('single-project mode opens the MCP service (#600 review M1)', () => {
  const dirs: string[] = [];
  const handles: Array<{ close(): void }> = [];
  const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

  /** Short paths under /tmp: the per-worker sandbox is past the 104-byte socket limit on macOS. */
  const tmp = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    process.env.XEZ_HOME = tmp('xzspm-h-');
    process.env.XEZ_DRY_RUN = '1';
  });

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.close();
    setActiveStateLayout(null);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dryRun]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('opens the project socket and the bridge resolves the same folder', async () => {
    const root = tmp('xzspm-p-');
    setActiveStateLayout(projectStateLayout(root));
    const entry = await registerProject(root);

    const handle = await startMcpService({ projectId: entry.id, version: '9.9.9-sp' });
    handles.push(handle);
    expect(handle.path).toContain(entry.id);

    const target = await resolveMcpTarget(root);
    expect(target).toMatchObject({ kind: 'socket', project: { id: entry.id } });
  });
});
