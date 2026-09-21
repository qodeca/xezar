import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectListEntry } from '@qodeca/xezar-api-client'
import { OtherProjects, otherProjectRow, startCommand } from '@/components/other-projects'

/**
 * The five row states of `designs/cli-terminal/multi-instance.md` § 6 (#467, PR 4), plus the two
 * the registry and the wire add: a gone folder, and `instance` omitted in hosted mode.
 *
 * The named break these pin is `BREAK-467-LINKS-OPEN-IN-PLACE`: a row that navigates to
 * `/p/<id>/` on THIS origin instead of linking to the other cockpit's own port. "links out" is
 * the whole feature, and a same-origin path looks right in a test that only asks whether a link
 * exists — so every assertion below names the absolute address.
 */

afterEach(cleanup)

function project(overrides: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'beta',
    name: 'beta',
    root: '/home/me/Projects/beta',
    addedAt: '2026-09-01T09:00:00.000Z',
    lastOpenedAt: '2026-09-19T08:00:00.000Z',
    source: 'local',
    status: 'ok',
    ...overrides,
  }
}

const BOOT = project({
  id: 'xezar',
  name: 'xezar',
  root: '/home/me/Projects/xezar',
  lastOpenedAt: '2026-09-20T08:00:00.000Z',
  instance: { state: 'this' },
})

function renderGroup(projects: ProjectListEntry[], localHandoff = true) {
  return render(
    <OtherProjects projects={projects} bootProjectId="xezar" localHandoff={localHandoff} />,
  )
}

const row = (id: string) => document.querySelector(`[data-slot="other-project"][data-project-id="${id}"]`)
const stateText = (id: string) =>
  row(id)?.querySelector('[data-slot="other-project-state"]')?.textContent ?? null

describe('otherProjectRow — the five row states (#467, PR 4)', () => {
  it('running: an ABSOLUTE link to that project s own cockpit, never /p/<id>/ here', () => {
    const answer = otherProjectRow(
      project({ instance: { state: 'running', url: 'http://localhost:4401/p/beta/' } }),
      { localHandoff: true },
    )
    expect(answer.state).toBe('running')
    expect(answer.label).toBe('running')
    expect(answer.href).toBe('http://localhost:4401/p/beta/')
    // The break this exists for: a same-origin path is not a link OUT.
    expect(answer.href?.startsWith('http://')).toBe(true)
    expect(answer.href).not.toBe('/p/beta/')
  })

  it('running with no url on the wire degrades to the address-not-known row, not to a link', () => {
    const answer = otherProjectRow(project({ instance: { state: 'running' } }), {
      localHandoff: true,
    })
    expect(answer.state).toBe('running-unknown-address')
    expect(answer.href).toBeNull()
  })

  it('running-unknown-address: a state word and a hint, no link (the --port 0 start)', () => {
    const answer = otherProjectRow(project({ instance: { state: 'running-unknown-address' } }), {
      localHandoff: true,
    })
    expect(answer.label).toBe('running — address not known')
    expect(answer.hint).toBe('Find the terminal that runs it.')
    expect(answer.href).toBeNull()
  })

  it('stopped: Copy command in local mode, nothing in hosted mode (AC-4.3)', () => {
    const stopped = project({ instance: { state: 'stopped' } })
    expect(otherProjectRow(stopped, { localHandoff: true })).toMatchObject({
      label: 'not running',
      command: 'xez --repo /home/me/Projects/beta',
      href: null,
    })
    expect(otherProjectRow(stopped, { localHandoff: false }).command).toBeNull()
  })

  it('checking: the first probe has not answered yet', () => {
    expect(otherProjectRow(project({ instance: { state: 'checking' } }), { localHandoff: true }))
      .toMatchObject({ state: 'checking', label: 'checking…', href: null })
  })

  it('this: the project this cockpit serves is current, and links nowhere', () => {
    expect(otherProjectRow(project({ instance: { state: 'this' } }), { localHandoff: true }))
      .toMatchObject({ state: 'this', label: 'current', href: null })
  })

  it('instance omitted (hosted mode): no state text at all, never "not running"', () => {
    const answer = otherProjectRow(project(), { localHandoff: false })
    expect(answer.state).toBe('unknown')
    expect(answer.label).toBeNull()
    expect(answer.command).toBeNull()
  })

  it('a gone folder outranks every liveness answer', () => {
    const answer = otherProjectRow(
      project({ status: 'missing', instance: { state: 'running', url: 'http://localhost:4401/p/beta/' } }),
      { localHandoff: true },
    )
    expect(answer.state).toBe('missing')
    expect(answer.href).toBeNull()
  })

  it('startCommand is the one spelling of starting xezar in a folder', () => {
    expect(startCommand('/home/me/Projects/beta')).toBe('xez --repo /home/me/Projects/beta')
  })
})

describe('OtherProjects — the sidebar group', () => {
  it('lists every registered project except the one this cockpit serves (AC-4.1)', () => {
    renderGroup([
      BOOT,
      project({ instance: { state: 'running', url: 'http://localhost:4401/p/beta/' } }),
      project({ id: 'gamma', name: 'gamma', root: '/home/me/Projects/gamma', instance: { state: 'stopped' } }),
    ])
    expect(screen.getByText('Other projects')).toBeTruthy()
    expect(row('beta')).not.toBeNull()
    expect(row('gamma')).not.toBeNull()
    // The boot project has the whole flat nav above; a row repeating it would be a second door.
    expect(row('xezar')).toBeNull()
  })

  it('a running row is an anchor to the other cockpit s OWN origin', () => {
    renderGroup([BOOT, project({ instance: { state: 'running', url: 'http://localhost:4401/p/beta/' } })])
    const link = row('beta')?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('http://localhost:4401/p/beta/')
    expect(stateText('beta')).toBe('running')
  })

  it('a running row with no address renders no anchor and says where to look', () => {
    renderGroup([BOOT, project({ instance: { state: 'running-unknown-address' } })])
    expect(row('beta')?.querySelector('a')).toBeNull()
    expect(stateText('beta')).toBe('running — address not known')
    expect(row('beta')?.querySelector('[data-slot="other-project-hint"]')?.textContent).toBe(
      'Find the terminal that runs it.',
    )
  })

  it('a stopped row offers Copy command in local mode', () => {
    renderGroup([BOOT, project({ instance: { state: 'stopped' } })])
    expect(stateText('beta')).toBe('not running')
    const copy = row('beta')?.querySelector('[data-action="other-project-copy-command"]')
    expect(copy).not.toBeNull()
    expect(copy?.getAttribute('title')).toBe('Copy xez --repo /home/me/Projects/beta')
  })

  it('a stopped row offers NOTHING in hosted mode (AC-4.3)', () => {
    renderGroup([BOOT, project({ instance: { state: 'stopped' } })], false)
    expect(stateText('beta')).toBe('not running')
    expect(row('beta')?.querySelector('[data-action="other-project-copy-command"]')).toBeNull()
  })

  it('omits the state text entirely when the server did not look', () => {
    renderGroup([BOOT, project()], false)
    expect(row('beta')).not.toBeNull()
    expect(stateText('beta')).toBeNull()
  })

  it('renders nothing at all when this project is the only registered one', () => {
    const { container } = renderGroup([BOOT])
    expect(container.innerHTML).toBe('')
  })
})
