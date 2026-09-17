import { describe, expect, it } from 'vitest';

import { countSettledRecovery, recoverAndReport, snapshotRecoveryCandidates } from './recovery.ts';

import type { RunRecord, RunStatus } from '../runs/store.ts';

function run(id: string, status: RunStatus): RunRecord {
  return { id, status } as RunRecord;
}

describe('boot recovery accounting', () => {
  it('counts only originally waiting tasks that recovery settled', () => {
    const candidates = snapshotRecoveryCandidates([
      run('queued', 'queued'),
      run('running', 'running'),
      run('waiting', 'waiting'),
      run('history', 'done'),
    ]);

    expect(candidates).toEqual([
      { id: 'queued', status: 'queued' },
      { id: 'running', status: 'running' },
      { id: 'waiting', status: 'waiting' },
    ]);
    expect(
      countSettledRecovery(candidates, [
        run('queued', 'done'),
        run('running', 'review'),
        run('waiting', 'review'),
        run('history', 'done'),
      ]),
    ).toBe(1);
  });

  it('does not classify failed, cancelled or missing waiting tasks as settled', () => {
    const candidates = snapshotRecoveryCandidates([
      run('failed', 'waiting'),
      run('cancelled', 'waiting'),
      run('missing', 'waiting'),
    ]);
    expect(
      countSettledRecovery(candidates, [
        run('failed', 'failed'),
        run('cancelled', 'cancelled'),
      ]),
    ).toBe(0);
  });

  it('reports only after recovery succeeds and says nothing when recovery fails', async () => {
    let runs = [run('waiting', 'waiting')];
    const reports: Array<readonly [number, number]> = [];
    await recoverAndReport(
      () => runs,
      async () => {
        expect(reports).toEqual([]);
        runs = [run('waiting', 'done')];
      },
      (count, settled) => reports.push([count, settled]),
    );
    expect(reports).toEqual([[1, 1]]);

    await expect(
      recoverAndReport(
        () => [run('running', 'running')],
        async () => { throw new Error('recovery failed'); },
        (count, settled) => reports.push([count, settled]),
      ),
    ).rejects.toThrow('recovery failed');
    expect(reports).toEqual([[1, 1]]);
  });
});
