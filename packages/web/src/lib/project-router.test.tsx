import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { Link, pathnameProjectId, scopeTo, stripProjectPrefix } from './project-router'

afterEach(cleanup)

describe('pathnameProjectId', () => {
  it('reads the /p/:projectId prefix', () => {
    expect(pathnameProjectId('/p/xezar/tasks/abc')).toBe('xezar')
    expect(pathnameProjectId('/p/xezar')).toBe('xezar')
    expect(pathnameProjectId('/p/my%20proj/git')).toBe('my proj')
  })

  it('answers null for flat paths — and never mistakes lookalikes', () => {
    expect(pathnameProjectId('/tasks/abc')).toBeNull()
    expect(pathnameProjectId('/proxy/x')).toBeNull()
    expect(pathnameProjectId('/p')).toBeNull()
    expect(pathnameProjectId('/p/')).toBeNull()
  })
})

describe('stripProjectPrefix', () => {
  it('returns the flat route-map pathname', () => {
    expect(stripProjectPrefix('/p/xezar/git/commits')).toBe('/git/commits')
    expect(stripProjectPrefix('/p/xezar')).toBe('/')
    expect(stripProjectPrefix('/p/xezar/')).toBe('/')
  })

  it('is the identity for unprefixed paths', () => {
    expect(stripProjectPrefix('/git/commits')).toBe('/git/commits')
    expect(stripProjectPrefix('/')).toBe('/')
  })
})

describe('scopeTo', () => {
  it('prefixes string targets, keeping search and hash', () => {
    expect(scopeTo('xezar', '/new')).toBe('/p/xezar/new')
    expect(scopeTo('xezar', '/skills?skill=x')).toBe('/p/xezar/skills?skill=x')
    expect(scopeTo('xezar', '/')).toBe('/p/xezar/')
  })

  it('prefixes partial-path objects', () => {
    expect(scopeTo('xezar', { pathname: '/skills', search: '?skill=x' })).toEqual({
      pathname: '/p/xezar/skills',
      search: '?skill=x',
    })
  })

  it('is the identity when unscoped', () => {
    expect(scopeTo(null, '/new')).toBe('/new')
  })

  it('leaves relative and already-scoped targets alone', () => {
    expect(scopeTo('xezar', 'commits')).toBe('commits')
    expect(scopeTo('xezar', '/p/other/tasks/x')).toBe('/p/other/tasks/x')
  })

  it('percent-encodes the project id', () => {
    expect(scopeTo('my proj', '/new')).toBe('/p/my%20proj/new')
  })
})

describe('Link', () => {
  it('scopes from the ProjectScopeProvider when one is mounted', () => {
    render(
      <MemoryRouter initialEntries={['/p/xezar/']}>
        <ProjectScopeProvider projectId="xezar">
          <Link to="/new">New task</Link>
        </ProjectScopeProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/p/xezar/new')
  })

  it("falls back to the URL's own prefix — the app shell renders outside the provider", () => {
    render(
      <MemoryRouter initialEntries={['/p/xezar/git']}>
        <Link to="/new">New task</Link>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/p/xezar/new')
  })

  it('is the plain react-router Link on a flat URL (component tests, mid-redirect)', () => {
    render(
      <MemoryRouter initialEntries={['/git']}>
        <Link to="/new">New task</Link>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/new')
  })
})
