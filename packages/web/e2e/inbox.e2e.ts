import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'
import { bootFixtureServer, type FixtureServer } from './fixture-server'

/**
 * The inbox (R6 Step 1.2) end to end, in both of its states.
 *
 * The default-off state runs against the shared dry-run environment, which boots without the
 * opt-in exactly like a default xezar does. The enabled state runs against a spec-owned fixture
 * booted with `XEZ_FOLLOWUPS=1` (`bootFixtureServer`), so it runs on every `test:e2e` instead of
 * skipping unless someone exported the flag for the whole shared server.
 *
 * Reachability: the inbox is `todos.json`-driven and the server watches the file — so this
 * suite seeds real entries in the data dir of the server under test and asserts real cards
 * (and the nav badge) render LIVE over the stream, no reload. Dismiss is honestly reachable
 * (DELETE only rewrites the fixture's own todos.json) and is exercised below; the shared
 * server's todos.json, which the default-off case writes, is restored in `afterAll`. Run is a
 * client-side navigation to a prefilled
 * `/new` (#374 — it no longer POSTs `/api/v1/todos/:id/start` itself, so no run is ever created
 * just by clicking it) but a full new-task submit is its own surface with its own coverage, so
 * the Run flow past the navigation stays unit-pinned in routes/inbox.test.tsx.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-inbox-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Where `src/index.ts` puts the data dir, for the server booted from this worktree.
const dataDir = resolve(import.meta.dirname, '../../../.local/xezar')
const todosFile = resolve(dataDir, 'todos.json')

const CARD = '[data-slot="todo-card"]'

let browser: AgentBrowser
let baseUrl: string
let previousTodos: string | null = null
let followupsAvailable = false

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as {
    capabilities: { followups: boolean }
  }
  followupsAvailable = health.capabilities.followups
  previousTodos = existsSync(todosFile) ? readFileSync(todosFile, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave a developer's inbox holding this test's entries.
  if (previousTodos === null) rmSync(todosFile, { force: true })
  else writeFileSync(todosFile, previousTodos, 'utf8')
  browser?.close()
})

function writeTodos(items: Array<Record<string, string>>, file = todosFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(items, null, 2), 'utf8')
}

describe('the inbox against the live dry-run server', () => {
  it('the default-off inbox stays reachable and hides entries already on disk', ({ skip }) => {
    skip(followupsAvailable, 'the shared environment explicitly enabled the inbox')
    writeTodos([
      { id: 'e2e-hidden-1', summary: 'This existing follow-up must stay hidden' },
      { id: 'e2e-hidden-2', summary: 'This one must stay hidden too' },
    ])
    browser.goto(`${baseUrl}/inbox`)
    browser.waitForFunction(
      `document.querySelector('[data-route="inbox"] [data-slot="centered-state"]') !== null`,
    )

    expect(browser.text('[data-slot="centered-state"]')).toContain('The follow-up inbox is off')
    expect(browser.text('[data-route="inbox"] header')).toContain(
      'Disabled for this server; per-task Notes still run.',
    )
    expect(browser.text('[data-route="inbox"] header')).not.toContain(
      'Follow-ups agents suggested',
    )
    expect(browser.count(CARD)).toBe(0)
  })
})

/**
 * The enabled inbox, on a spec-owned `XEZ_FOLLOWUPS=1` fixture. The fixture's data dir is
 * `<checkout>/.local/xezar`, so `todos.json` there is the file the fixture server watches; the
 * whole root is deleted in `afterAll`, so nothing needs restoring.
 */
describe('the inbox opted in (spec-owned XEZ_FOLLOWUPS=1 fixture)', () => {
  let fixture: FixtureServer
  let fixtureTodos: string
  const inboxUrl = () => `${fixture.baseUrl}/p/${fixture.projectId}/inbox`
  const write = (items: Array<Record<string, string>>) => writeTodos(items, fixtureTodos)

  beforeAll(async () => {
    fixture = await bootFixtureServer({ env: { XEZ_FOLLOWUPS: '1' } })
    fixtureTodos = join(fixture.root, '.local/xezar/todos.json')
  }, 90_000)

  afterAll(async () => {
    await fixture?.stop()
  })

  it('an enabled empty inbox renders the shared CenteredState template', () => {
    write([])
    browser.goto(inboxUrl())
    browser.waitForFunction(
      `document.querySelector('[data-route="inbox"] [data-slot="centered-state"]') !== null`,
    )

    expect(browser.text('[data-slot="centered-state"]')).toContain('Inbox empty')
    expect(browser.count(CARD)).toBe(0)
  })

  it('real cards render LIVE from a server-side todos.json write — no reload', () => {
    // An agent files two follow-ups while the page just sits there on /inbox.
    write([
      {
        id: 'e2e-inbox-1',
        ts: new Date().toISOString(),
        summary: 'Open a follow-up PR for the flaky retry test',
        action: 'follow-up',
        suggestedSkill: 'xez-fix',
        taskId: 'e2e-no-such-run',
      },
      { id: 'e2e-inbox-2', summary: 'Rerun the failed checks' },
    ])

    // No goto: file watch → SSE → todos query → cards. Debounced ~300ms server-side.
    browser.waitForFunction(`document.querySelectorAll('${CARD}').length === 2`)

    expect(browser.text(`${CARD}[data-id="e2e-inbox-1"]`)).toContain(
      'Open a follow-up PR for the flaky retry test',
    )
    // The attention dot: the "needs you" rung of the shared grammar, amber.
    expect(
      browser.count(`${CARD} [data-slot="status-dot"][data-tone="pending"]`),
    ).toBe(2)
    // The meta row is honest about a source task the server no longer has.
    expect(browser.text(`${CARD}[data-id="e2e-inbox-1"]`)).toContain('source task deleted')
    expect(browser.text(`${CARD}[data-id="e2e-inbox-1"]`)).toContain('skill: xez-fix')
    // The primary action follows actionability (spec 007): e2e-inbox-1 carries a skill, so it
    // is runnable and keeps Run + Dismiss; e2e-inbox-2 has nothing to execute, so it is a note
    // and offers Acknowledge alone.
    expect(browser.count(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-run"]`)).toBe(1)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-dismiss"]`)).toBe(1)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-acknowledge"]`)).toBe(0)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"] [data-action="todo-acknowledge"]`)).toBe(1)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"] [data-action="todo-run"]`)).toBe(0)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"] [data-action="todo-dismiss"]`)).toBe(0)

    browser.screenshot(`${artifactsDir}/inbox-cards.png`)
  })

  it('Dismiss checks the entry off — card gone, server inbox down to one', async () => {
    browser.click(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-dismiss"]`)

    browser.waitForFunction(`document.querySelectorAll('${CARD}').length === 1`)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"]`)).toBe(1)

    // The server agreed: the DELETE landed in todos.json, not just in the query cache.
    const res = await fetch(`${fixture.baseUrl}/api/v1/todos`)
    const items = (await res.json()) as Array<{ id: string }>
    expect(items.map((item) => item.id)).toEqual(['e2e-inbox-2'])
  })

  /**
   * The global SSE stream, end to end (moved here from smoke.e2e.ts, which only had the shared,
   * default-off server): a server-side `todos.json` write reaches the nav badge with nobody
   * reloading anything. `todos.json` is a documented external contract (agents append to it via
   * `XEZ_TODOS_FILE`), the server watches the file and re-broadcasts the whole array on `todos`,
   * and the badge renders whatever the todos query holds — so writing that file *is* a live event.
   */
  it('live-updates the inbox badge from a server-side change, with no reload', () => {
    const BADGE = '[data-slot="nav-badge"]'
    write([])
    browser.goto(`${fixture.baseUrl}/p/${fixture.projectId}/`)
    // The shell is up and its queries have answered — so the app's stream effect has run too.
    browser.waitForFunction(`document.querySelector('[data-slot="repo-chip"]') !== null`)
    expect(browser.count(BADGE)).toBe(0)

    // An agent files two follow-ups while the page just sits there.
    write([
      { id: 'e2e-1', summary: 'Review the PR' },
      { id: 'e2e-2', summary: 'Rerun the checks' },
    ])

    // No goto: if this ever passes, it passed because file watch → SSE → reducer → badge worked.
    // (Debounced ~300ms server-side, so this waits rather than samples.)
    browser.waitForFunction(`document.querySelector('${BADGE}')?.textContent === '2'`)
    expect(browser.text(BADGE)).toBe('2')

    browser.screenshot(`${artifactsDir}/inbox-badge-live.png`)

    // And the reverse: the payload is the whole inbox, so emptying it empties the badge.
    write([])
    browser.waitForFunction(`document.querySelector('${BADGE}') === null`)
    expect(browser.count(BADGE)).toBe(0)

    // The stream outliving several seconds of this is the "stays alive" assertion: the shell is
    // still the shell, not a blank root left by a handler that threw.
    expect(browser.isVisible('[data-slot="sidebar"]')).toBe(true)
    expect(browser.text('[data-slot="sidebar"] nav')).toContain('Inbox')
  })
})
