import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, xezarCli, fixtureServeEnv, getJson, removeDataRoot, stopFixtureServer } from './agent-browser'

/**
 * The full-screen /new composer (R4 Steps 1.1 + 1.3) end-to-end against a LIVE dry-run server:
 * client navigation from the sidebar CTA reaches the React hero, the cmdk source dropdown lists
 * this repo's project skills first, picking one + typing + submitting starts a real run — and
 * the API readback pins the created run to the exact skill-chain shape plus the persisted
 * `lastTask`. The second describe proves the protected bookmarklet contract (spec 011,
 * BACKWARD_COMPATIBILITY.md) on full document loads of /new, with the REAL launch key read
 * from `.local/xezar/launch-key` — the documented on-disk contract.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-new-task-${process.pid}`

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`xezar e2e: the new-task server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2) —
 *  what the cockpit's own links and its post-submit navigations actually spell. */
const scoped = (path: string) => `/p/${bootProject}${path}`

interface ProviderRow { provider: string; status: string; enabled: boolean }
interface ComposerConfig { defaultRunner?: string; defaultModels?: Record<string, string> }

/**
 * The runner pill's inputs, read from the two endpoints the composer itself reads
 * (`useProviderStatus` → `GET /providers/status`, `useAgentProfiles` →
 * `GET /workspace/agent-profiles`). Row order is the server's PROVIDER_IDS order, which is the
 * client's `RUNNER_ORDER` — the order `resolveRunner` falls back through.
 */
const providerRows = async (): Promise<ProviderRow[]> =>
  (await getJson<{ providers: ProviderRow[] }>(`${baseUrl}/api/v1/providers/status`)).providers

const usableRunners = async (): Promise<string[]> =>
  (await providerRows())
    .filter((row) => row.enabled && row.status === 'connected')
    .map((row) => row.provider)

/** `new-task.tsx`: the pill renders when there is a choice — more than one usable runner, or more
 *  than one login for one of them (`hasAccountChoice`: one login is not a choice). */
const pillExpected = async (): Promise<boolean> => {
  const usable = await usableRunners()
  if (usable.length > 1) return true
  const { profiles } = await getJson<{ profiles: Array<{ provider: string }> }>(
    `${baseUrl}/api/v1/workspace/agent-profiles`,
  )
  return usable.some((id) => profiles.filter((entry) => entry.provider === id).length > 1)
}

/** `resolveRunner(null, runners, defaultRunner ?? 'claude')` for an untouched composer. */
const resolvedRunner = async (config: ComposerConfig): Promise<string> => {
  const usable = await usableRunners()
  const preferred = config.defaultRunner ?? 'claude'
  return usable.includes(preferred) ? preferred : (usable[0] ?? 'claude')
}

/** Turn one agent off/on for this fixture host — the write behind Settings → Agents. */
const setProviderEnabled = async (provider: string, enabled: boolean): Promise<void> => {
  const response = await fetch(`${baseUrl}/api/v1/providers/${provider}/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  expect(response.status).toBe(200)
}

/**
 * The runner pill is rendered from `GET /providers/status`, so a `count()` taken before that
 * request has landed reports "no pill" for free — on any host. This is that settle signal: the
 * response has been received AND the pill row has re-rendered off it, which is what the model
 * pill leaving its disabled state means (`disabled={!providersReady}`, and `providersReady` is
 * the provider query having succeeded). Both halves, because either alone can be true early:
 * a model pill pinned by `modelsLocked` renders read-only rather than disabled at all.
 */
const composerPillRowReady = (): void => {
  browser.waitForFunction(
    `performance.getEntriesByType('resource')
       .some((entry) => new URL(entry.name).pathname.endsWith('/providers/status'))`,
  )
  browser.waitForFunction(`(() => {
    const pill = document.querySelector('[data-slot="model-pill"]')
    return pill !== null && pill.disabled !== true
  })()`)
}

/** Re-open /new so the pill row is built from the provider status as it stands NOW. A reload
 *  rather than a wait on the live `provider-status` event: the point of the case that uses this
 *  is the RULE, and it must not be able to pass or fail on how fast a push landed. */
const reloadComposer = (): void => {
  browser.goto(`${baseUrl}${scoped('/new')}`)
  browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
  browser.waitForFunction(`document.querySelector('[data-slot="version-chip"]') !== null`)
  browser.waitForFunction(
    `!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`,
  )
  composerPillRowReady()
}

beforeAll(async () => {
  // A REAL git repo: the run needs a worktree, and the base-branch pill needs branches.
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-new-task-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@xezar.test')
  git('config', 'user.name', 'xezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# new-task e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // TWO project skills, so the spec can prove an actual PICK (not just the default): the
  // picker defaults to the first project skill, then we choose the other one.
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/lint-fix.md'),
    '---\ndescription: Fix lint findings in the changed files\n---\n\nRun the linter and fix everything it reports.\n',
    'utf8',
  )
  writeFileSync(
    join(dataRoot, '.ai/skills/spec-writer.md'),
    '---\ndescription: Draft a feature spec from a one-line idea\n---\n\nWrite the spec.\n',
    'utf8',
  )

  // One real workflow file, so the picker has a Workflows group to render: the built-in
  // `quick-task` is not a row of its own any more (it IS the "No skill" row), and a fixture with
  // only the built-in would leave the group empty for reasons that have nothing to do with the
  // grouping under test.
  mkdirSync(join(dataRoot, '.xezar/workflows'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.xezar/workflows/fix-and-verify.yaml'),
    'name: fix-and-verify\ndescription: Fix, then prove it with the tests\nskills:\n  - lint-fix\n',
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('the full-screen /new against a live dry-run server', () => {
  it('the sidebar CTA client-navigates to the React hero, focus already in the textarea', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="sidebar"] a[href="${scoped('/new')}"]') !== null`,
    )
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped('/new')}`)
    expect(browser.text('h1')).toBe('What should the agent work on?')
    expect(browser.isVisible('[data-slot="twinkle-backdrop"]')).toBe(true)
    expect(
      browser.evaluate(
        `document.activeElement === document.querySelector('[data-slot="composer"] textarea')`,
      ),
    ).toBe(true)
    expect(browser.count('[data-slot="suggested-chip"]')).toBe(3)
  })

  it('the pill row resolves: no source picked, runner pill by the choice rule, base: main, ×1', async () => {
    // Sources are ready once the pill stops showing its loading ellipsis. A resolved composer
    // picks NOTHING — the empty state is the default, so there is no name to wait for.
    browser.waitForFunction(
      `!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`,
    )
    expect(browser.evaluate(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind`,
    )).toBe('none')
    // Health must have SETTLED before judging the pill row — the version chip renders from
    // the same response, so it is the "health arrived" signal. The provider status is a SECOND
    // request, and it is the one the runner pill is actually built from.
    browser.waitForFunction(`document.querySelector('[data-slot="version-chip"]') !== null`)
    composerPillRowReady()
    // The rule is the composer's own (`new-task.tsx`): the runner pill renders when there is a
    // CHOICE to make — more than one usable runner, or more than one login for one of them —
    // and a usable runner is a provider row that is `enabled` AND `connected`
    // (`usableRunners`, `hasAccountChoice`). It is NOT the health check list: health reports
    // which agent CLIs are installed on the machine, which is a different question and the one
    // that made this assertion take a different branch on a bare `ubuntu-latest` runner than on
    // a laptop with three agents installed. `scripts/test-env-up.sh` pins only the agents'
    // USER-scope config, and AGENTS.md records that project scope, local scope and credential
    // discovery are NOT isolated, so there is no bare-host assumption to fall back on either.
    // Asserting the rule against the SAME two endpoints the component reads is what makes this
    // hold on every host; the next case then drives both shapes of that input on purpose.
    const expectPill = await pillExpected()
    expect(browser.count('[data-slot="runner-pill"]')).toBe(expectPill ? 1 : 0)
    const config = await getJson<ComposerConfig>(`${baseUrl}/api/v1/config`)
    if (expectPill) {
      // `resolveRunner(null, runners, defaultRunner ?? 'claude')`: an untouched composer shows the
      // host's default runner when that one is usable, else the first usable one in RUNNER_ORDER.
      // The label is `<runner>` or `<runner> · <login>`, so it contains the id either way.
      expect(browser.text('[data-slot="runner-pill"]')).toContain(await resolvedRunner(config))
    }
    // Same class of host dependence as the runner pill above, and the same treatment: the model
    // pill shows the HOST's native default when the installed agent pins one
    // (`readAgentModelDefaults` seeds `defaultModels` from the agent's own settings), and `auto`
    // only when it does not. Asserting `auto` unconditionally failed on any machine whose claude
    // settings name a model.
    expect(browser.text('[data-slot="model-pill"]')).toContain(
      config.defaultModels?.[await resolvedRunner(config)] || 'auto',
    )
    expect(browser.text('[data-slot="variants-pill"]')).toContain('×1')
    expect(browser.text('[data-slot="base-pill"]')).toContain('base: main')
    browser.screenshot(`${artifactsDir}/new-task-hero.png`)
  })

  it('both host shapes reach the same rule: one usable runner hides the pill, two show it', async () => {
    // Host independence PROVEN, not assumed. The pill's input is a host fact — which agents are
    // connected and enabled — so the spec drives that input to each of its two shapes through the
    // same API Settings uses, and asserts what the composer renders for each. A bare CI runner
    // and a developer laptop then reach the SAME two assertions instead of branching apart.
    const config = await getJson<ComposerConfig>(`${baseUrl}/api/v1/config`)
    const providers = (await providerRows()).map(({ provider }) => provider)
    expect(providers.length).toBeGreaterThan(1)
    // The first row stays enabled throughout; every other agent is the shape's variable.
    const rest = providers.slice(1)

    // Shape one: a single usable runner. This fixture's `XEZ_HOME` is a throwaway directory, so
    // that runner has exactly one login and there is nothing left to choose — no pill. The rule
    // is re-derived rather than hard-coded, so a host that somehow does offer a second login
    // fails this loudly instead of quietly skipping the branch it was written to prove.
    for (const provider of rest) await setProviderEnabled(provider, false)
    reloadComposer()
    expect(await pillExpected()).toBe(false)
    expect(browser.count('[data-slot="runner-pill"]')).toBe(0)
    // The composer still runs on that one runner: a hidden pill is "no choice", not "no agent".
    expect(browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').disabled`))
      .toBe(false)

    // Shape two: a second usable runner appears, and the choice becomes visible.
    await setProviderEnabled(rest[0]!, true)
    reloadComposer()
    expect(await pillExpected()).toBe(true)
    expect(browser.count('[data-slot="runner-pill"]')).toBe(1)
    expect(browser.text('[data-slot="runner-pill"]')).toContain(await resolvedRunner(config))

    // Leave the host as this suite found it — the later cases start real runs on it.
    for (const provider of rest) await setProviderEnabled(provider, true)
    reloadComposer()
  }, 120_000)

  it('the source dropdown groups project skills first and picking one updates the pill', () => {
    browser.click('[data-slot="source-pill"]')
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
    const groups = browser.evaluate(`[...document.querySelectorAll('[cmdk-group-heading]')].map(h => h.textContent)`) as string[]
    expect(groups[0]).toBe('Project skills')
    expect(groups).toContain('Workflows')
    // The first row is the heading-less way out of any selection, and the built-in it runs has
    // no second row under Workflows.
    expect(browser.evaluate(
      `[...document.querySelectorAll('[data-slot="source-option"]')][0]?.textContent`,
    )).toContain('No skill')
    expect(browser.count('[data-slot="source-option"][data-source-ref="quick-task"]')).toBe(0)
    const skillRefs = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="source-option"][data-source-kind="skill"]')].map(o => o.dataset.sourceRef)`,
    ) as string[]
    // The fixture's own two skills, in #377 order. Asserted by their relative order rather than
    // by being the first two rows: a machine whose shared team-skill cache is populated
    // (`getTeamSkillsCached`, global and unrelated to this repo) lists those here too, and they
    // must not decide an assertion about the fixture's grouping.
    expect(skillRefs.filter((ref) => ref === 'lint-fix' || ref === 'spec-writer')).toEqual([
      'lint-fix',
      'spec-writer',
    ])
    browser.screenshot(`${artifactsDir}/new-task-source-menu.png`)

    browser.click('[data-slot="source-option"][data-source-ref="spec-writer"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]').textContent.includes('spec-writer')`,
    )
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') === null`)
  })

  it('the ✕ takes the picked skill back off, and the selected row toggles it off too', () => {
    // One click, no menu — the affordance the report asked for.
    browser.click('[data-slot="source-pill-clear"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind === 'none'`,
    )
    // Nothing picked, nothing to clear: the ✕ is gone with the selection.
    expect(browser.count('[data-slot="source-pill-clear"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/new-task-source-empty.png`)

    // The same state from inside the list: pick it, then pick it again.
    const pickSpecWriter = () => {
      browser.click('[data-slot="source-pill"]')
      browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
      browser.click('[data-slot="source-option"][data-source-ref="spec-writer"]')
    }
    pickSpecWriter()
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('spec-writer')`,
    )
    pickSpecWriter()
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind === 'none'`,
    )

    // Leave it picked: the next spec submits from here.
    pickSpecWriter()
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('spec-writer')`,
    )
  })

  it('type + submit → the thread; the run record carries the exact skill chain', async () => {
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'Draft a spec for the new-task hero e2e.')
    browser.click('[aria-label="Start task"]')
    browser.waitForFunction(`location.pathname.startsWith('${scoped('/tasks/')}')`)

    const runId = (browser.evaluate(`location.pathname.split('/').pop()`) as string) ?? ''
    expect(runId).not.toBe('')
    // API readback: the run started from the PICKED skill, as the one-step inline chain.
    const record = await getJson<{
      task: string
      workflowDef?: { steps?: Array<Record<string, unknown>> }
    }>(`${baseUrl}/api/v1/runs/${runId}`)
    expect(record.task).toBe('Draft a spec for the new-task hero e2e.')
    expect(record.workflowDef?.steps).toEqual([
      expect.objectContaining({ id: 'task', name: 'spec-writer', skill: 'spec-writer', prompt: '{{task}}' }),
    ])

    // The source is recorded as lastTask — a record of what ran, not a preselection for the
    // next task (see the next spec, and `resolveSource`).
    const uiState = await getJson<{ lastTask?: { source: string; ref: string } | null }>(
      `${baseUrl}/api/v1/ui-state`,
    )
    expect(uiState.lastTask).toEqual({ source: 'skill', ref: 'spec-writer' })

    // The thread really rendered (the run parks at waiting under the dry-run mock).
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
  }, 90_000)

  it('back on /new the skill is gone with the task it ran; iPhone hero screenshot', () => {
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    // The started skill does NOT follow the user into the next task — the whole point of the
    // empty state. A fresh composer picks nothing and shows the invitation. Waiting on the
    // label rather than the kind: an unpicked pill reports `none` while still loading, and a
    // "does not contain spec-writer" assertion would pass against the ellipsis for free.
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('Skill')`,
    )
    expect(browser.evaluate(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind`,
    )).toBe('none')
    expect(
      browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').value`),
    ).toBe('')

    browser.setViewport(390, 844)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    browser.screenshot(`${artifactsDir}/new-task-hero-iphone.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })
})

describe('the bookmarklet contract on full /new loads (spec 011, Step 1.3)', () => {
  const runCount = async (): Promise<number> =>
    (await getJson<unknown[]>(`${baseUrl}/api/v1/runs`)).length

  it('auto=1 with the REAL launch key starts a run unattended and lands in its thread', async () => {
    // The documented on-disk contract: the server bakes this secret into the bookmarklets it
    // generates; only a page holding it may start runs. Read it exactly where users can.
    const key = readFileSync(join(dataRoot, '.local/xezar/launch-key'), 'utf8').trim()
    expect(key).not.toBe('')
    const before = await runCount()

    browser.goto(
      `${baseUrl}/new?skill=lint-fix&ref=hello&auto=1&key=${encodeURIComponent(key)}`,
    )
    // Unattended: no clicks from here — the cockpit takes us to the thread by itself.
    browser.waitForFunction(`location.pathname.startsWith('${scoped('/tasks/')}')`)

    const runId = (browser.evaluate(`location.pathname.split('/').pop()`) as string) ?? ''
    const record = await getJson<{
      task: string
      workflowDef?: { steps?: Array<Record<string, unknown>> }
    }>(`${baseUrl}/api/v1/runs/${runId}`)
    expect(record.task).toBe('hello')
    expect(record.workflowDef?.steps).toEqual([
      expect.objectContaining({ id: 'task', name: 'lint-fix', skill: 'lint-fix', prompt: '{{task}}' }),
    ])
    expect(await runCount()).toBe(before + 1)
  }, 90_000)

  it('a wrong key only prefills — the composer, a toast, and NOT one run more', async () => {
    const before = await runCount()

    browser.goto(`${baseUrl}/new?skill=lint-fix&ref=hello&auto=1&key=definitely-wrong`)
    browser.waitForFunction(`document.querySelector('[data-route="new"] [data-slot="composer"]') !== null`)

    // Prefilled, blocked, and honest about it.
    expect(browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').value`)).toBe('hello')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('lint-fix')`,
    )
    browser.waitForFunction(`document.querySelector('[data-slot="toast"]') !== null`)
    expect(browser.text('[data-slot="toast"]')).toContain('Auto-start blocked')
    browser.screenshot(`${artifactsDir}/new-task-bookmarklet-blocked.png`)

    // The key (right or wrong) never survives in the URL, and no run started.
    browser.waitForFunction(`location.search === ''`)
    // The legacy flat `/new?…` the bookmarklet grammar guarantees landed on the scoped twin —
    // the redirect BACKWARD_COMPATIBILITY.md's bookmarklet contract now rests on.
    expect(browser.url()).toBe(`${baseUrl}${scoped('/new')}`)
    expect(await runCount()).toBe(before)
  }, 90_000)

  it('/new?legacy=1 serves the React shell on this server too — the hatch retired in R7', () => {
    browser.goto(`${baseUrl}/new?legacy=1`)
    browser.waitForFunction(`document.getElementById('root') !== null`)
    expect(browser.evaluate(`document.getElementById('brand') === null`)).toBe(true)
  })
})
