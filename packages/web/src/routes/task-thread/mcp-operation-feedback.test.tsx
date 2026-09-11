import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpOperationFeedback, MCP_OPERATION_LABELS, type McpOperation } from './mcp-operation-feedback'

/**
 * Issue #113 (Phase 7 of epic #67): operation-outcome feedback for MCP actions.
 *
 * The sharp requirements are U-M05 (say plainly what a conflict or a retry did) and U-M07 (the
 * short labels), and two of U-M07 are NOT proposals: an acknowledgement is never labelled
 * "Completed", and operation context is preserved on a transient error. U-M04 demands that
 * pending or last-known data is never presented as newly confirmed.
 *
 * This file pins those decisions against the component. The companion `mcp-live-sync.test.tsx`
 * covers the live-sync half (an MCP-caused change reaching an open task view with no reload and no
 * refetch loop); this file covers the outcome feedback half.
 */

function op(overrides: Partial<McpOperation>): McpOperation {
  return {
    operationId: 'op_12345678_abcd',
    action: 'runs.create',
    status: 'completed',
    ...overrides,
  }
}

function renderFeedback(operation: McpOperation, onRetry?: (operationId: string) => void) {
  return render(<McpOperationFeedback operation={operation} onRetry={onRetry} />)
}

afterEach(() => {
  cleanup()
})

describe('MCP operation feedback labels (U-M07)', () => {
  it.each([
    ['accepted', 'Accepted'],
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['conflict', 'Conflict — not applied'],
    ['unverified', 'Outcome being verified'],
  ] as const)('renders the "%s" label as "%s"', (status, label) => {
    const { getByTestId } = renderFeedback(op({ status }))
    expect(getByTestId('mcp-operation-label').textContent).toBe(label)
    // The label map is the single source of truth for the label text.
    expect(MCP_OPERATION_LABELS[status]).toBe(label)
  })

  it('shows the operation identity and action so context is preserved on any status', () => {
    const { container } = renderFeedback(op({ status: 'failed' }))
    const text = container.textContent ?? ''
    expect(text).toContain('op_12345678_abcd')
    expect(text).toContain('runs.create')
  })
})

describe('MCP operation feedback: acknowledgement is never "Completed" (U-M07)', () => {
  it('labels an accepted operation "Accepted", not "Completed"', () => {
    const { getByTestId } = renderFeedback(op({ status: 'accepted' }))
    const label = getByTestId('mcp-operation-label').textContent ?? ''
    expect(label).toBe('Accepted')
    expect(label).not.toContain('Completed')
  })

  it('states that an acknowledgement is not a completion', () => {
    const { getByTestId } = renderFeedback(op({ status: 'accepted' }))
    const copy = getByTestId('mcp-operation-copy').textContent ?? ''
    expect(copy.toLowerCase()).toContain('acknowledgement')
    expect(copy.toLowerCase()).not.toContain('completed')
  })
})

describe('MCP operation feedback: rejection vs failure after execution (U-M05)', () => {
  it('renders a stale-write rejection as "Conflict — not applied" with NOT APPLIED copy', () => {
    const { getByTestId } = renderFeedback(op({ status: 'conflict' }))
    expect(getByTestId('mcp-operation-label').textContent).toBe('Conflict — not applied')
    const copy = getByTestId('mcp-operation-copy').textContent ?? ''
    expect(copy).toContain('NOT applied')
    expect(copy).toContain('Nothing was overwritten')
  })

  it('names re-reading the current state for a rejection (N-03)', () => {
    const { getByTestId } = renderFeedback(op({ status: 'conflict' }))
    const copy = getByTestId('mcp-operation-copy').textContent ?? ''
    const reread = getByTestId('mcp-operation-reread').textContent ?? ''
    expect(copy).toContain('Re-read the current state')
    expect(reread).toContain('re-read the current state')
  })

  it('is NOT confused with a failure after execution', () => {
    const failed = renderFeedback(op({ status: 'failed' })).container.textContent ?? ''
    const conflict = renderFeedback(op({ status: 'conflict' })).container.textContent ?? ''

    // A failure-after-execution says the operation ran and failed — never "not applied".
    expect(failed).toContain('failed after execution')
    expect(failed).not.toContain('NOT applied')
    // The rejection says not applied — never that it ran.
    expect(conflict).toContain('NOT applied')
    expect(conflict).not.toContain('failed after execution')
  })
})

describe('MCP operation feedback: unverified (D-06)', () => {
  it('renders the "Outcome being verified" label and names reading current state', () => {
    const { getByTestId } = renderFeedback(op({ status: 'unverified' }))
    expect(getByTestId('mcp-operation-label').textContent).toBe('Outcome being verified')
    const copy = getByTestId('mcp-operation-copy').textContent ?? ''
    expect(copy).toContain('Read the current state')
  })

  it('states that a new operation id is a new action and warns against a blind repeat', () => {
    const { getByTestId } = renderFeedback(op({ status: 'unverified' }))
    const copy = getByTestId('mcp-operation-copy').textContent ?? ''
    const newKey = getByTestId('mcp-operation-new-key').textContent ?? ''
    expect(copy).toContain('a new operation id is a new action')
    expect(newKey).toContain('Do not blindly repeat this with a new key')
  })
})

describe('MCP operation feedback: retry preserves the operation identity (U-M05)', () => {
  it('invokes onRetry with the SAME operation id, never a fresh one', () => {
    const onRetry = vi.fn<(operationId: string) => void>()
    const { getByTestId } = renderFeedback(op({ status: 'failed' }), onRetry)

    fireEvent.click(getByTestId('mcp-operation-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // The identity handed back is the one already shown — a retry is a replay, not a new action.
    expect(onRetry).toHaveBeenCalledWith('op_12345678_abcd')
  })

  it('does not render a retry control unless an onRetry handler is provided', () => {
    const { queryByTestId } = renderFeedback(op({ status: 'failed' }))
    expect(queryByTestId('mcp-operation-retry')).toBeNull()
  })

  it('renders no retry control for a state where a same-id retry is not a recovery', () => {
    const { queryByTestId } = renderFeedback(op({ status: 'completed' }), vi.fn())
    expect(queryByTestId('mcp-operation-retry')).toBeNull()
  })

  it('marks a retried operation as replaying the original identity and outcome', () => {
    const { getByTestId } = renderFeedback(op({ status: 'conflict', retried: true }))
    const retried = getByTestId('mcp-operation-retried').textContent ?? ''
    expect(retried).toContain('same operation identity')
    expect(retried).toContain('original or current outcome')
    // It explicitly says this is NOT a fresh action, and never invents a new operation identity.
    expect(retried).toContain('not a new action')
    expect(retried).not.toContain('new operation identity')
  })
})

describe('MCP operation feedback: last-known data is never newly confirmed (U-M04)', () => {
  it('renders a visible last-known badge when the connection is reconnecting', () => {
    const { getByTestId } = renderFeedback(op({ status: 'completed', lastKnown: true }))
    const badge = getByTestId('mcp-operation-last-known').textContent ?? ''
    expect(badge).toContain('Last known state')
    expect(badge).toContain('reconnecting')
  })

  it('does not render the last-known badge when the data is current', () => {
    const { queryByTestId } = renderFeedback(op({ status: 'completed' }))
    expect(queryByTestId('mcp-operation-last-known')).toBeNull()
  })
})

describe('MCP operation feedback: no unprocessed unicode escape leaks', () => {
  it('never renders a raw "\\u" escape in the copy or label', () => {
    for (const status of ['accepted', 'running', 'completed', 'failed', 'conflict', 'unverified'] as const) {
      const { container } = renderFeedback(op({ status }))
      const text = container.textContent ?? ''
      expect(text).not.toContain('\\u')
      cleanup()
    }
  })
})
