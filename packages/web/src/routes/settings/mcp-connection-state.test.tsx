import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import {
  connectionStateFromOwner,
  McpConnectionState as McpConnectionStateComponent,
  type McpConnectionState,
} from './mcp-connection-state'

/**
 * Issue #112 (Phase 7 of epic #67): the whole MCP connection state inventory, rendered honestly.
 *
 * Every state in the requirements' "State inventory and recovery" table (§13) is a member of
 * `McpConnectionState`, and each renders its OWN distinguishing copy. This suite renders EACH
 * state and asserts its meaning, and then pins the specific boundaries §13 and U-M03/U-M02 set:
 *
 *  - occupied is NOT a generic server failure;
 *  - occupied is NOT expired (the two are distinguishable);
 *  - the disconnected state says tasks continue and NEVER says "task failed";
 *  - the restarting state labels its data last-known;
 *  - no rendered string contains a countdown, a timeout value, or another owner's session
 *    identifier;
 *  - no control exists with a disconnect, takeover or role-toggle affordance.
 */

function renderState(state: McpConnectionState) {
  return render(
    <MemoryRouter>
      <McpConnectionStateComponent state={state} />
    </MemoryRouter>,
  )
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? ''
}

/** Every member of the inventory, in the order §13 lists them. */
const INVENTORY: McpConnectionState[] = [
  { kind: 'empty' },
  { kind: 'loading' },
  { kind: 'ready' },
  { kind: 'connecting' },
  { kind: 'active' },
  { kind: 'occupied' },
  { kind: 'waiting' },
  { kind: 'leader-paused' },
  { kind: 'server-restarting' },
  { kind: 'disconnected' },
  { kind: 'expired' },
  { kind: 'error', outcome: 'unverified' },
  { kind: 'unsupported', missing: 'adapter' },
]

afterEach(() => {
  cleanup()
})

describe('MCP connection state inventory (issue #112)', () => {
  it('renders every state with a distinguishing title and copy', () => {
    for (const state of INVENTORY) {
      const { container } = renderState(state)
      const el = container.querySelector('[data-slot="mcp-connection-state"]')
      expect(el).toBeTruthy()
      expect(el?.getAttribute('data-state')).toBe(state.kind)
    }
  })

  it('renders the empty state without asking the user to invent connection data', () => {
    const { container } = renderState({ kind: 'empty' })
    const text = textOf(container)
    expect(text).toContain('Configuration not generated yet')
    expect(text).toContain('generates the connection configuration automatically')
    // The user is never asked to invent connection data by hand.
    expect(text).not.toContain('create it yourself')
    expect(text).not.toContain('write your own')
  })

  it('renders the loading state as bounded progress that withholds unconfirmed capability values', () => {
    const { container } = renderState({ kind: 'loading' })
    const text = textOf(container)
    expect(text).toContain('Discovering connection state')
    expect(text).toContain('nothing is shown as confirmed before that')
    expect(text).toContain('bounded progress')
  })

  it('renders the ready state as setup guidance without implying a running model or session', () => {
    const { container } = renderState({ kind: 'ready' })
    const text = textOf(container)
    expect(text).toContain('Ready to connect')
    expect(text).toContain('No model is running and no session is active yet')
    expect(text).toContain('Follow the one-time setup')
  })

  it('renders connecting as distinct from model startup, with repeated requests not being multiple clients', () => {
    const { container } = renderState({ kind: 'connecting' })
    const text = textOf(container)
    expect(text).toContain('Connecting')
    expect(text).toContain('separate from starting a model')
    expect(text).toContain('are not additional clients')
  })

  it('renders active as owner/session live, not necessarily generating, with the cockpit able to mutate', () => {
    const { container } = renderState({ kind: 'active' })
    const text = textOf(container)
    expect(text).toContain('Connected')
    expect(text).toContain('not necessarily that the model is generating')
    expect(text).toContain('The cockpit can still mutate project state')
  })
})

describe('MCP connection state: occupied vs expired (U-M03, UX-M02)', () => {
  it('renders occupied as THIS PROJECT IS OCCUPIED, not a generic server failure', () => {
    const { container } = renderState({ kind: 'occupied' })
    const text = textOf(container)
    expect(text).toContain('This project is occupied')
    // U-M03: a second client shows the project is occupied, NOT a generic server failure.
    // The copy explicitly denies a server failure rather than presenting as one.
    expect(text).toContain('not a server failure')
    expect(text).not.toContain('The server failed')
    expect(text).not.toContain('Internal server error')
    // U-M03: the cockpit still works and running tasks are unaffected.
    expect(text).toContain('the cockpit still works')
    expect(text).toContain('running tasks are unaffected')
    // U-M03: no forced takeover — the project is released automatically, no control to take it over.
    expect(text).toContain('becomes available automatically')
    expect(text).not.toContain('Force takeover')
    expect(text).not.toContain('Take over')
    expect(text).not.toContain('Disconnect other client')
  })

  it('renders expired distinctly from occupied', () => {
    const { container } = renderState({ kind: 'expired' })
    const text = textOf(container)
    expect(text).toContain('Owner session expired')
    expect(text).toContain('must reinitialize')
    expect(text).toContain('a new client may already own the project')
    // Distinguishable: expired must not read as "occupied".
    expect(text).not.toContain('This project is occupied')
    expect(text).not.toContain('another logical client already owns')
  })
})

describe('MCP connection state boundaries (U-M02, §13)', () => {
  it('says disconnected tasks continue and NEVER says "task failed"', () => {
    const { container } = renderState({ kind: 'disconnected' })
    const text = textOf(container)
    expect(text).toContain('Disconnected')
    expect(text).toContain('Started tasks continue to run')
    expect(text).toContain('reconciled after reconnect')
    // The boundary: disconnected is a connection problem, NOT a task failure.
    expect(text).toContain('This is a connection problem, not a task failure')
    expect(text).not.toContain('task failed')
    expect(text).not.toContain('task has failed')
    expect(text).not.toContain('failed')
  })

  it('labels the restarting state data as last-known and does not imply tasks were cancelled', () => {
    const { container } = renderState({ kind: 'server-restarting' })
    const text = textOf(container)
    expect(text).toContain('Server restarting')
    expect(text).toContain('last-known')
    expect(text).toContain('not newly confirmed')
    // The affirmative negation is honest and required; the copy must not CLAIM a cancellation.
    expect(text).toContain('not cancelled by the restart')
    expect(text).not.toContain('tasks were cancelled')
    expect(text).not.toContain('tasks have been cancelled')
  })

  it('renders error states that clearly state the outcome', () => {
    const { container: notApplied } = renderState({ kind: 'error', outcome: 'not-applied' })
    expect(textOf(notApplied)).toContain('Operation not applied')
    expect(textOf(notApplied)).toContain('No mutation occurred')

    const { container: accepted } = renderState({ kind: 'error', outcome: 'accepted' })
    expect(textOf(accepted)).toContain('Operation accepted')

    const { container: unverified } = renderState({ kind: 'error', outcome: 'unverified' })
    expect(textOf(unverified)).toContain('Outcome needs verification')
    // The error state must not OFFER a blind repeat with a new key — it must negate it and
    // direct the user to preserve the operation identity instead.
    expect(textOf(unverified)).toContain('Do not repeat a blind retry with a new key')
    expect(textOf(unverified)).toContain('preserve the operation identity')
    // And no control anywhere offers a new-key retry.
    expect(unverified.querySelectorAll('button, a[href]').length).toBe(0)
  })

  it('names the missing capability without disclosing secrets or other projects', () => {
    const { container } = renderState({ kind: 'unsupported', missing: 'adapter' })
    const text = textOf(container)
    expect(text).toContain('Capability unavailable')
    expect(text).toContain('missing adapter')
    expect(text).toContain('not a secret and not another project')
  })

  it('links to the relevant task in the waiting state', () => {
    const { container } = renderState({
      kind: 'waiting',
      task: { href: '/p/xezar/tasks/abc123', title: 'A question' },
    })
    const text = textOf(container)
    expect(text).toContain('Waiting on a decision')
    expect(text).toContain('Open the task')
    expect(container.querySelector('a[href="/p/xezar/tasks/abc123"]')).toBeTruthy()
  })
})

describe('MCP connection state hard boundaries (F-15, U-M02, U-M03, §13)', () => {
  it('never renders a countdown, a timeout value, or another owner session identifier in any state', () => {
    for (const state of INVENTORY) {
      const { container } = renderState(state)
      const text = textOf(container)
      // No countdown or ticking-clock language.
      expect(text).not.toContain('countdown')
      expect(text).not.toContain('expires in')
      expect(text).not.toContain('expiring in')
      // No invented timeout value ("30s", "5 minutes", etc.).
      expect(text).not.toMatch(/\b\d+\s*(seconds?|minutes?|ms)\b/i)
      expect(text).not.toContain('timeout')
      // No another owner's session identifier (UUID-shaped, session-id-shaped, pid-shaped).
      expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)).toBe(false)
      expect(text).not.toContain('session-id')
      expect(text).not.toContain('sessionId')
      expect(text).not.toContain('pid')
    }
  })

  it('contains no CONTROL with a disconnect, takeover or role-toggle affordance in any state', () => {
    for (const state of INVENTORY) {
      const { container } = renderState(state)
      // The affordance is a rendered interactive control, not the copy's prose (which may
      // honestly NEGATE a disconnect/takeover). Inspect buttons and links.
      const controls = container.querySelectorAll('button, a[href]')
      for (const control of Array.from(controls)) {
        const label = (control.textContent ?? '').toLowerCase()
        expect(label).not.toContain('disconnect')
        expect(label).not.toContain('take over')
        expect(label).not.toContain('force takeover')
        expect(label).not.toContain('role')
        expect(label).not.toContain('toggle')
        expect(label).not.toContain('permission')
        expect(label).not.toContain('release')
      }
    }
  })

  it('maps the Phase-4 owner state to the base connection state', () => {
    expect(connectionStateFromOwner('unowned')).toEqual({ kind: 'ready' })
    expect(connectionStateFromOwner('owned')).toEqual({ kind: 'active' })
    expect(connectionStateFromOwner('expired')).toEqual({ kind: 'expired' })
  })
})
