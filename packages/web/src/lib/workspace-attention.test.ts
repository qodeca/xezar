import { describe, expect, it } from 'vitest'

import { listCounts } from './task-groups'
import {
  attentionKey,
  needsYou,
  resolveAttentionCounts,
  selectWorkspaceAttention,
  summarizeAttention,
  type AttentionRow,
} from './workspace-attention'
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

describe('the tail beyond the row cap', () => {
  it('adds each project’s beyondLimit to its live rows', () => {
    const attention = summarizeAttention([row('web', 'waiting')], {
      web: { beyondLimit: 2 },
      old: { beyondLimit: 1 },
    })
    expect(attention.byProject.get('web')).toBe(3)
    // A project whose only waiting tasks are older than its newest rows still has a count.
    expect(attention.byProject.get('old')).toBe(1)
    expect(attention.total).toBe(4)
  })

  it('reads the index answer, and tolerates one cached before the field existed', () => {
    const base = { referenceStatuses: {}, perProjectLimit: 200, truncated: ['web'] }
    const rows = [{ ...row('web', 'review'), createdAt: '', workflow: 'w', runner: 'claude' as const }]
    expect(selectWorkspaceAttention({ ...base, runs: rows, attention: { web: { total: 3, beyondLimit: 2 } } }).total).toBe(3)
    const legacy = { ...base, runs: rows } as unknown as Parameters<typeof selectWorkspaceAttention>[0]
    expect(selectWorkspaceAttention(legacy).total).toBe(1)
  })
})

describe('resolveAttentionCounts', () => {
  const index = summarizeAttention([row('web', 'waiting'), row('brief', 'waiting'), row('brief', 'review', { id: 'b2' })])

  it('uses the index alone while it is current', () => {
    const counts = resolveAttentionCounts({ index, indexFailed: false, activeProjectId: 'web', activeCount: 9 })
    expect(counts.countFor('web')).toBe(1)
    expect(counts.countFor('brief')).toBe(2)
    expect(counts.countFor('none')).toBe(0)
    expect(counts.total).toBe(3)
    expect(counts.stale).toBe(false)
  })

  it('is unknown, not zero and not stale, while the index is loading', () => {
    const counts = resolveAttentionCounts({ index: undefined, indexFailed: false, activeProjectId: 'web', activeCount: 2 })
    expect(counts.countFor('web')).toBeNull()
    expect(counts.total).toBeNull()
    expect(counts.stale).toBe(false)
  })

  it('falls back to the active project’s own list when the index never answered', () => {
    const counts = resolveAttentionCounts({ index: undefined, indexFailed: true, activeProjectId: 'web', activeCount: 2 })
    expect(counts.countFor('web')).toBe(2)
    // Unknown elsewhere — never a silent zero.
    expect(counts.countFor('brief')).toBeNull()
    expect(counts.total).toBe(2)
    expect(counts.stale).toBe(true)
  })

  it('keeps the last known counts elsewhere and swaps in the live active count after a failed refresh', () => {
    const counts = resolveAttentionCounts({ index, indexFailed: true, activeProjectId: 'web', activeCount: 4 })
    expect(counts.countFor('web')).toBe(4)
    expect(counts.countFor('brief')).toBe(2)
    expect(counts.total).toBe(6)
    expect(counts.stale).toBe(true)
  })

  it('stays unknown for the active project too while its own list has not loaded', () => {
    const counts = resolveAttentionCounts({ index: undefined, indexFailed: true, activeProjectId: 'web', activeCount: undefined })
    expect(counts.countFor('web')).toBeNull()
    expect(counts.total).toBeNull()
    expect(counts.stale).toBe(true)
  })
})

describe('resolveAttentionCounts — never an old count presented as live', () => {
  const index = summarizeAttention([row('web', 'waiting')])

  it('names no live project while the index is current', () => {
    expect(resolveAttentionCounts({ index, indexFailed: false, activeProjectId: 'web', activeCount: 1 }).activeProjectId).toBeNull()
  })

  it('names no live project when the active list is unavailable, and keeps the index’s number', () => {
    const counts = resolveAttentionCounts({ index, indexFailed: true, activeProjectId: 'web', activeCount: undefined })
    expect(counts.activeProjectId).toBeNull()
    expect(counts.countFor('web')).toBe(1)
  })

  it('names the live project only while its own list is the source', () => {
    expect(resolveAttentionCounts({ index, indexFailed: true, activeProjectId: 'web', activeCount: 3 }).activeProjectId).toBe('web')
  })
})
