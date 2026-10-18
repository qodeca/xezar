import { describe, expect, it } from 'vitest'

import { listCounts } from './task-groups'
import { attentionKey, needsYou, summarizeAttention, type AttentionRow } from './workspace-attention'
import type { RunRecord, RunStatus } from '@qodeca/xezar-api-client'

function row(projectId: string, status: RunStatus, over: Partial<AttentionRow> = {}): AttentionRow {
  return { projectId, id: `${projectId}-${status}`, title: 't', status, archived: false, ...over }
}

describe('summarizeAttention', () => {
  it('is zero and empty for no rows — the boundary every fresh workspace starts at', () => {
    const attention = summarizeAttention([])
    expect(attention.total).toBe(0)
    expect([...attention.byProject]).toEqual([])
  })

  it('counts waiting and review, per project and in total', () => {
    const attention = summarizeAttention([
      row('web', 'waiting'),
      row('web', 'review', { id: 'w2' }),
      row('web', 'running'),
      row('brief', 'waiting'),
      row('paper', 'done'),
    ])
    expect(attention.total).toBe(3)
    expect(attention.byProject.get('web')).toBe(2)
    expect(attention.byProject.get('brief')).toBe(1)
    // A project with nothing waiting has no entry, so a reader cannot mistake it for unknown.
    expect(attention.byProject.has('paper')).toBe(false)
  })

  it.each<RunStatus>(['queued', 'running', 'done', 'failed', 'cancelled'])('does not count %s', (status) => {
    expect(needsYou({ status, archived: false })).toBe(false)
  })

  it('does not count archived work, whatever its status says', () => {
    expect(needsYou({ status: 'waiting', archived: true })).toBe(false)
  })

  it('agrees with the per-project Tasks tab dot (listCounts) for every status', () => {
    const statuses: RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']
    const records = statuses.flatMap((status) =>
      [false, true].map(
        (archived): RunRecord => ({
          id: `${status}-${archived}`,
          title: status,
          workflow: 'default',
          task: 'x',
          status,
          createdAt: '2026-07-14T10:00:00.000Z',
          tokensUsed: 0,
          archived,
          steps: [],
        }),
      ),
    )
    const rows = records.map((record) => ({ ...record, projectId: 'p' }))
    expect(summarizeAttention(rows).total).toBe(listCounts(records).waiting)
  })
})

describe('attentionKey', () => {
  it('keeps the same run id in two projects apart', () => {
    expect(attentionKey({ projectId: 'a', id: 'r1' })).not.toBe(attentionKey({ projectId: 'b', id: 'r1' }))
  })
})
