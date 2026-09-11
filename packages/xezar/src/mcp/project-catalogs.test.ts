import { describe, expect, it, vi } from 'vitest';
import { registerProjectCatalog, reportProjectChange, type ProjectChangeReporter } from './project-catalogs.ts';

const reporter = (): ProjectChangeReporter & { configChanged: ReturnType<typeof vi.fn> } => ({
  configChanged: vi.fn(() => undefined),
  workflowChanged: vi.fn(() => undefined),
  agentConfigChanged: vi.fn(() => undefined),
});

describe('the per-project catalog lookup (#252)', () => {
  it('reports to the project’s own catalog and to no other', () => {
    const alpha = reporter();
    const beta = reporter();
    const releases = [registerProjectCatalog('pc-alpha', alpha), registerProjectCatalog('pc-beta', beta)];
    reportProjectChange('pc-alpha', (catalog) => catalog.configChanged({ keys: ['baseBranch'] }));
    expect(alpha.configChanged).toHaveBeenCalledTimes(1);
    expect(beta.configChanged).not.toHaveBeenCalled();
    for (const release of releases) release();
  });

  it('does nothing for a project without a catalog, and after its release', () => {
    const report = vi.fn();
    reportProjectChange('pc-none', report);
    expect(report).not.toHaveBeenCalled();

    const gamma = reporter();
    registerProjectCatalog('pc-gamma', gamma)();
    reportProjectChange('pc-gamma', (catalog) => catalog.configChanged({ keys: ['baseBranch'] }));
    expect(gamma.configChanged).not.toHaveBeenCalled();
  });

  it('never lets a late release from an older composition evict the newer one', () => {
    const older = reporter();
    const newer = reporter();
    const releaseOlder = registerProjectCatalog('pc-delta', older);
    const releaseNewer = registerProjectCatalog('pc-delta', newer);
    releaseOlder();
    reportProjectChange('pc-delta', (catalog) => catalog.configChanged({ keys: ['baseBranch'] }));
    expect(newer.configChanged).toHaveBeenCalledTimes(1);
    expect(older.configChanged).not.toHaveBeenCalled();
    releaseNewer();
  });

  it('swallows a reporter that throws, so the write route never fails', () => {
    const release = registerProjectCatalog('pc-epsilon', reporter());
    expect(() =>
      reportProjectChange('pc-epsilon', () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
    release();
  });
});
