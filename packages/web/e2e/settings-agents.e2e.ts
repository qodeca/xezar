import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser } from './agent-browser'
import { bootFixtureServer, type FixtureServer } from './fixture-server'

/**
 * Settings → Agents (R6 Step 1.5) end-to-end against a spec-owned fixture server: edit each knob
 * through the real form and read the write back from `GET /api/v1/config` — the server's truth,
 * not the query cache — then prove a cold load renders the persisted values.
 *
 * The fixture is booted by `bootFixtureServer` (the one shared helper, also used by
 * `repo-git.e2e.ts`) over a `createFixtureRepo` checkout, so the base-branch picker has a real
 * non-`xez/*` branch to offer. That is the #671 F-05 fix: `getBranches` (`src/server/git.ts`)
 * filters `xez/*` names out, so a spec attached to the shared env — which serves the checkout the
 * suite runs in, and CI checks out a task branch — waited 25 s for a second option that could
 * never arrive.
 *
 * Reachability: fully reachable — the section needs no forge and no agent CLI; the fixture is a
 * git checkout, asserted rather than assumed. The suite mutates exactly one store, the FIXTURE's
 * `.xezar/config.json`, which `stop()` deletes with the rest of its data root: unlike the shared
 * env it never writes this repository's own kit config.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-settings-agents-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

let browser: AgentBrowser
let baseUrl: string
let fixture: FixtureServer

beforeAll(async () => {
  fixture = await bootFixtureServer()
  baseUrl = fixture.baseUrl
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(async () => {
  browser?.close()
  await fixture?.stop()
})

interface ConfigAnswer {
  baseBranch: string | null
  defaultRunner: string
  systemPrompt: string | null
  defaultModels: Record<string, string>
}

/** The PUT behind a control is fire-and-forget from the UI's point of view — poll the additive
 *  GET /api/v1/config until the write lands rather than assume it beat this assertion. */
async function waitForConfig(check: (config: ConfigAnswer) => boolean): Promise<ConfigAnswer> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/v1/config`)
    const config = (await res.json()) as ConfigAnswer
    if (check(config)) return config
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('GET /api/v1/config never showed the expected knobs')
}

/** Set a native <select> the way a user would, through React's synthetic change — the native
 *  value setter defeats React's value tracker so the dispatched event is not deduped away. */
function setSelect(selector: string, value: string) {
  browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

/** Bumped per navigation, so each cold load can be told apart from the one before it. */
let coldLoads = 0

/**
 * A cold load of Settings → Agents, waited for as a NEW document.
 *
 * The wait needs both halves. `agents-section` lives inside `AgentsForm`, which `AgentsSection`
 * mounts only once `useConfig()` has resolved (`agents-loading` renders until then —
 * routes/settings/agents-section.tsx:66-82), so it IS "GET /api/v1/config has answered" and it is
 * the only query any assertion in this file depends on for the runner, model and prompt values.
 *
 * But it is equally true of the page being LEFT: every case here navigates to /settings/agents
 * from /settings/agents, so a predicate about the section alone can be satisfied by the outgoing
 * document and the assertions then run against the incoming one while it is still blank — which
 * is what `expected +0 to be 1` looks like (#183). The marker rides in the query string, which
 * `LegacyPathRedirect` carries through to /p/<boot>/settings/agents (routes.tsx), and only the new
 * document can have it. No settings route reads the query string, so it changes nothing else.
 */
const gotoAgents = () => {
  coldLoads += 1
  const marker = `xezcold=${coldLoads}`
  browser.goto(`${baseUrl}/settings/agents?${marker}`)
  browser.waitForFunction(
    `location.search.includes(${JSON.stringify(marker)})
     && document.querySelector('[data-slot="agents-section"]') !== null`,
  )
}

describe('settings → agents against a spec-owned fixture server', () => {
  it('renders every knob, agent-agnostically named', () => {
    gotoAgents()
    browser.waitForFunction(`document.querySelector('[data-slot="agents-base-branch"]') !== null`)
    // claude · codex · opencode · pi — `pi` is offered unconditionally (new-task-form.ts).
    expect(browser.count('[data-slot="agents-runner"] [role="radio"]')).toBe(4)
    // One model preset per runner, `pi` included.
    expect(browser.count('[data-slot="agents-model"]')).toBe(4)
    expect(browser.count('[data-slot="agents-system-prompt"]')).toBe(1)
    // The dry-run fixture is a git checkout, so the base-branch picker is the real control.
    expect(browser.count('[data-slot="agents-base-branch"]')).toBe(1)
  })

  it('default runner: click writes config.json and GET /api/v1/config reads it back', async () => {
    gotoAgents()
    browser.click('[data-slot="agents-runner"] [data-value="codex"]')
    await waitForConfig((c) => c.defaultRunner === 'codex')
    // The server having the value is not the cockpit having it: this spec polls the API over
    // its own HTTP connection, while the page learns through the mutation's query invalidation.
    // Wait for the control itself, then assert on it — the same contract, without the race.
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="agents-runner"] [data-value="codex"][aria-checked="true"]').length === 1`,
    )
    expect(browser.count('[data-slot="agents-runner"] [data-value="codex"][aria-checked="true"]')).toBe(1)
  })

  it('per-runner model preset: select writes the runner key, others untouched', async () => {
    const before = await waitForConfig(() => true)
    setSelect('[data-slot="agents-model"][data-runner="claude"]', 'opus')
    const config = await waitForConfig((c) => c.defaultModels.claude === 'opus')
    for (const runner of ['codex', 'opencode', 'pi']) {
      expect(config.defaultModels[runner]).toEqual(before.defaultModels[runner])
    }
  })

  it('system prompt: explicit save persists the trimmed text', async () => {
    browser.fill('[data-slot="agents-system-prompt"]', 'Always add tests. (e2e)')
    browser.click('[data-action="agents-save-prompt"]')
    await waitForConfig((c) => c.systemPrompt === 'Always add tests. (e2e)')
  })

  it('base branch: picking a real branch persists; clearing goes back to the checkout', async () => {
    // The fixture's own branch is the first option after "follow checked-out branch". `useRepo`
    // is the one query on this screen that really is late for a control: the select is rendered
    // only once `repo.data?.info` exists and its options come from `repo.data.branches`
    // (agents-section.tsx:483-497), so wait for a branch option to exist before reading it. The
    // read cannot tell "this checkout has no branches" from "the list has not arrived yet", and
    // both answer `''` (#183) — which is exactly why the fixture must own a real branch (#671
    // F-05): the endpoint drops `xez/*` names, so a task-branch checkout offers no second option.
    browser.waitForFunction(
      `(document.querySelector('[data-slot="agents-base-branch"]')?.options.length ?? 0) > 1`,
    )
    const branch = String(
      browser.evaluate(`document.querySelector('[data-slot="agents-base-branch"]').options[1]?.value ?? ''`),
    )
    expect(branch).toBe('main')
    setSelect('[data-slot="agents-base-branch"]', branch)
    await waitForConfig((c) => c.baseBranch === branch)

    setSelect('[data-slot="agents-base-branch"]', '')
    await waitForConfig((c) => c.baseBranch === null)
  })

  it('a cold load renders the persisted knobs — the form is a view of config.json', async () => {
    // `gotoAgents()` returns on the NEW document with the section mounted, and that is a weaker
    // fact than "the picker has rendered": the count below reads `aria-checked`, and a read that
    // lands before the picker's rows have painted answers 0 without any wrong value existing
    // (`expected +0 to be 1`, run 35091385012). So wait for the ROW SET to be rendered — four
    // rows, each carrying its own checked state — and keep the three value assertions exactly as
    // they are. This is a structural signal on purpose: it looks at no value at all, so a wrong
    // persisted runner still renders four rows, still passes the wait, and still fails the
    // assertion below with the value it really shows. Repeating the three assertions as a wait
    // would be the version that masks a wrong value, which is what this case must not become.
    gotoAgents()
    browser.waitForFunction(`(() => {
      const rows = [...document.querySelectorAll('[data-slot="agents-runner"] [role="radio"]')]
      return rows.length === 4 && rows.every((row) => row.hasAttribute('aria-checked'))
    })()`)
    expect(browser.count('[data-slot="agents-runner"] [data-value="codex"][aria-checked="true"]')).toBe(1)
    expect(
      String(browser.evaluate(`document.querySelector('[data-slot="agents-model"][data-runner="claude"]').value`)),
    ).toBe('opus')
    expect(
      String(browser.evaluate(`document.querySelector('[data-slot="agents-system-prompt"]').value`)),
    ).toBe('Always add tests. (e2e)')
    browser.screenshot(`${artifactsDir}/settings-agents.png`)

    // Neutralize for the suites that follow — the fixture's config is discarded by `stop()`.
    browser.click('[data-slot="agents-runner"] [data-value="claude"]')
    await waitForConfig((c) => c.defaultRunner === 'claude')
  })
})
