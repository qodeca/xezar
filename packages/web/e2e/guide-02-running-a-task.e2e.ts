import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 02 — Tasks and runs (docs/guide/02-tasks-and-runs.md), one continuous scripted journey
 * against a LIVE dry-run xezar: compose → mode/queue → thread output → Finish/review →
 * Changes/Files/Commits → Draft-PR hand-off (browser-test-spec.md § "PR 2 — Batch 5
 * thread/composer/launch contract"). Every `it` below is a distinct behavior group with its own
 * named regression-sensitivity break recorded in this task's evidence.
 *
 * Finish comes before the git tabs, not after, even though the guide documents them as
 * independent capabilities: Finish is what actually commits the worktree
 * (`autosaveCommit(dir, 'run finalize')` in git-worktree.ts) — a session merely parked
 * `waiting` never has, because the underlying agent process (and so the turn-end flush) stays
 * open until something closes it. The Commits tab has nothing to show before that happens.
 *
 * Composing run B through the REAL `/new` composer is what makes this "compose", not a
 * `POST /api/v1/runs` shortcut (existing specs like composer.e2e.ts create runs over the API and
 * only drive the browser afterwards; this file drives the whole path once). Run A is different:
 * it exists only to occupy the workspace's one agent slot so run B's `queued` state is
 * observable, so it is started and cancelled over the API exactly like queued-stack.e2e.ts's own
 * blocker — it is disposable fixture setup, not a flow this guide documents.
 *
 * Draft PR is asserted PRESENT, never clicked: the dry-run exception register classifies
 * "opening a draft pull request on a remote forge" as stubbed at the forge seam, covered by
 * `packages/xezar/src/server/forge/draft-pr-autosave.test.ts` and
 * `packages/xezar/src/server/cockpit-ownership.test.ts:320-354`. This file completes the task
 * through Accept instead — a real, local, honest transition.
 *
 * The final behavior group (review response round 1, #590) covers the guide's own
 * "actions/notes" section (docs/guide/02-tasks-and-runs.md:87-99) against the finished run:
 * Archive/Unarchive, "Open in…" (trigger plus its static "Terminal (resume session)" item —
 * never an actual CLI/editor/Finder target, the same real-boundary reason Draft PR above is
 * never clicked), Notes (the handoff Markdown a finished run always has), and Continue last,
 * since it is the one action that moves the run out of `done`.
 */

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
  throw new Error(`xezar e2e: the guide-02 server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[], tries = 160): Promise<string> {
  let seen = '(never read)'
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return record.status
    seen = record.status
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`xezar e2e: run ${id} never reached status "${wanted.join('/')}" — stuck at "${seen}"`)
}

const startRun = async (url: string, task: string): Promise<string> => {
  const created = (await (
    await fetch(`${url}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  return created.id
}

/** The composer navigates to `/tasks/<id>` on submit whether the run starts running or lands
 *  `queued` (new-task.e2e.ts asserts the same unconditional navigation) — polling the browser's
 *  own reported URL, never the DOM, is what keeps this a role/text-only spec. */
async function waitForTaskId(browser: GuideBrowser, attempts = 60): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const match = /\/tasks\/([0-9a-f-]+)/.exec(browser.url())
    if (match?.[1] !== undefined) return match[1]
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('xezar e2e: /new never navigated to a task URL')
}

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let blockerId: string
let runId: string

beforeAll(async () => {
  // A REAL git repo — the engine creates a worktree for run B, which needs a commit.
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-02-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@xezar.test')
  git('config', 'user.name', 'xezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# guide-02 e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // One workspace-wide agent slot (browser-test-spec.md § Isolation rule proof 3: unique
  // server/home/data path per file) — the same mechanism queued-stack.e2e.ts uses, so run B
  // demonstrably queues behind run A rather than racing it.
  const xezHome = join(dataRoot, '.xez-home')
  mkdirSync(xezHome, { recursive: true })
  writeFileSync(join(xezHome, 'config.json'), JSON.stringify({ resources: { maxParallel: 1 } }), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    // XEZ_REVIEW_GATE=1 because the review/Draft-PR hand-off is part of this guide's own
    // journey — it is opt-in and OFF by default (#489), so pinning it here is what makes the
    // parked-at-review step reproducible rather than depending on whatever the operator exports.
    { env: fixtureServeEnv(dataRoot, { XEZ_REVIEW_GATE: '1' }), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  browser = GuideBrowser.open(`e2e-guide-02-${process.pid}`)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 02 — tasks and runs', () => {
  it('the composer exposes Worktree, Autonomous and Plan-first, then compose+submit starts run B', async () => {
    // Hold the one agent slot BEFORE run B exists — `mock:slow` keeps run A's turn open for
    // ~25s, long enough that run B's queued state below is not a race (queued-stack.e2e.ts's
    // own reasoning). Setup over the API, not the browser: run A is a disposable blocker this
    // guide never documents, not part of the scripted journey.
    blockerId = await startRun(baseUrl, 'mock:slow occupy the only agent slot')
    await waitForStatus(baseUrl, blockerId, ['running'])

    browser.goto(`${baseUrl}/new`)
    await browser.waitForRole('heading', 'What should the agent work on?')

    // Mode (docs/guide/02 § "To use the composer"): the three composer-level run-mode controls
    // are present. Toggle Autonomous on then off — idempotent (BT-AC-09), and proves the
    // control really responds without changing what run B starts with.
    expect(browser.hasRole('checkbox', 'Worktree')).toBe(true)
    expect(browser.hasRole('checkbox', 'Autonomous')).toBe(true)
    expect(browser.hasRole('radiogroup', 'Run mode')).toBe(true)
    expect(browser.hasRole('radio', 'Start')).toBe(true)
    expect(browser.hasRole('radio', 'Plan first')).toBe(true)
    browser.clickRole('checkbox', 'Autonomous')
    browser.clickRole('checkbox', 'Autonomous')

    // Compose: type the task and submit with Start (plain agent step, no skill/workflow picked
    // — "with no skill or workflow selected, the task runs as one plain agent step").
    browser.fillLabel('Describe a task for the agent', 'Guide 02 e2e: describe the running-a-task journey.')
    browser.clickRole('button', 'Start task')

    runId = await waitForTaskId(browser)
    expect(runId).not.toBe(blockerId)
  }, 60_000)

  it('queue: a queued run B shows its position and does not silently start (BT-AC-07)', async () => {
    await browser.waitForText('Waiting for a free agent slot')
    expect((await waitForStatus(baseUrl, runId, ['queued', 'running'], 4))).not.toBe('done')

    // Free the slot the same way a user's Cancel would — over the API, since run A itself is
    // not part of the guide flow under test.
    await fetch(`${baseUrl}/api/v1/runs/${blockerId}/cancel`, { method: 'POST' })
  })

  it('thread output: the running turn is visible as agent text and real tool activity', async () => {
    await waitForStatus(baseUrl, runId, ['waiting'])
    await browser.waitForText('looking into')
    // The mock's first turn runs a real Bash tool call — its command is real, visible thread
    // content, not implementation markup.
    expect(browser.hasText('git status')).toBe(true)
  }, 30_000)

  it('talking to the running agent: a reply grows the thread and gets a real round trip', async () => {
    browser.fillLabel('Reply to the agent', 'One more thing — note the Compare tab too.')
    browser.clickRole('button', 'Send')
    await browser.waitForText('One more thing — note the Compare tab too.')

    await waitForStatus(baseUrl, runId, ['waiting'])
    await browser.waitForText('Follow-up #1 received')
  }, 30_000)

  it('Finish closes the waiting session — a real diff and the review gate park it at review', async () => {
    // Finish is what actually commits the worktree (`autosaveCommit(..., 'run finalize')`) —
    // a session left merely `waiting` never has, since the underlying agent process (and so
    // the turn-end flush) stays open until something closes it. The Commits tab below depends
    // on Finish having already run, which is why review comes before it in this file even
    // though the guide documents them as independent capabilities.
    browser.clickRole('button', 'Finish')
    await waitForStatus(baseUrl, runId, ['review'])
  }, 30_000)

  it('the Changes, Files and Commits tabs show the task’s real worktree state', async () => {
    browser.clickRole('link', 'Changes')
    await browser.waitForText('notes.md')

    browser.clickRole('link', 'Files')
    await browser.waitForText('notes.md')

    browser.clickRole('link', 'Commits')
    await browser.waitForText('xezar autosave')

    browser.clickRole('link', 'Session')
    await browser.waitForRole('region', 'Review the changes')
  }, 30_000)

  it('review / Draft PR hand-off: the review panel offers Draft PR and Accept; Accept finishes it', async () => {
    // The review surface is a real accessible region (<section aria-label="Review the
    // changes">), not markup this spec reaches into.
    expect(browser.hasRole('region', 'Review the changes')).toBe(true)
    expect(browser.hasRole('button', 'Draft PR')).toBe(true)
    expect(browser.hasRole('button', 'Accept')).toBe(true)

    // Accept — real, local, honest: it finishes the task without ever touching a forge (the
    // dry-run exception register classifies opening a real draft PR as forge-seam-stubbed,
    // covered by draft-pr-autosave.test.ts and cockpit-ownership.test.ts:320-354 instead).
    //
    // The sticky run header's own "Open in…" trigger can transiently sit at Accept's click
    // point right as this panel first mounts — the header's height is still settling (a
    // ResizeObserver tick right after the review panel mounts). `clickRoleWhenStable` (round 3
    // of #590's review, replacing round 2's narrower `waitForUncoveredRole`) waits for Accept's
    // own box to stop moving before clicking, rather than naming a specific coverer in advance.
    await browser.clickRoleWhenStable('button', 'Accept')
    await waitForStatus(baseUrl, runId, ['done'])
  }, 30_000)

  it('actions/notes: the finished run’s header offers Archive, Open in…, Notes and Continue', async () => {
    // Archive/Unarchive: a plain state toggle with no confirmation dialog, unlike Cancel/Delete.
    await browser.waitForRole('button', 'Archive')
    browser.clickRole('button', 'Archive')
    await browser.waitForRole('button', 'Unarchive')
    browser.clickRole('button', 'Unarchive')
    await browser.waitForRole('button', 'Archive')

    // Open in…: the desktop launch menu. Radix renders it as a modal layer that marks
    // everything outside itself `aria-hidden` while open, so the only role-reachable way to
    // close it again is to pick one of its own items — "Terminal (resume session)" or an actual
    // CLI/editor/Finder target would launch a real local process on the machine running this
    // suite, the same real-boundary reason the Draft PR button above is asserted present and
    // never clicked, so "Copy worktree path" is the one item here that is both real and safe:
    // it only writes to the clipboard.
    //
    // The Archive→Unarchive→Archive round trip above mounts/unmounts the header's own Pin
    // button three times in quick succession, which shifts this trigger horizontally in its
    // right-anchored (`ml-auto`) row each time (a synchronous, single-frame DOM/layout jump,
    // not a CSS transition) — `clickRoleWhenStable` waits for its box to stop moving first
    // (round 3 of #590's review; this call had no guard at all through round 2).
    await browser.clickRoleWhenStable('button', 'Open in…')
    await browser.waitForRole('menuitem', 'Terminal (resume session)')
    expect(browser.hasRole('menuitem', 'Copy worktree path')).toBe(true)
    browser.clickRole('menuitem', 'Copy worktree path')

    // Notes: the engine seeds a real handoff Markdown skeleton before the agent step ever runs,
    // and the mock backend appends its own progress line to it — a finished run's Notes panel
    // therefore always renders real content here, never the "No notes yet" empty state that
    // only an unstarted task can show. Wait for the closed menu's exit animation to actually
    // finish first — Radix keeps the rest of the page `aria-hidden` while it plays.
    await browser.waitForRole('button', 'Notes')
    browser.clickRole('button', 'Notes')
    await browser.waitForText('Progress log')
    browser.clickRole('button', 'Notes')

    // Continue: reopens the recorded session for a fresh turn. Last, because it is the one
    // action here that moves the run out of its terminal `done` status — Archive, Open in… and
    // Continue itself are all gated on a non-active run, so anything scripted after this point
    // would no longer find them.
    browser.clickRole('button', 'Continue')
    const reopened = await waitForStatus(baseUrl, runId, ['running', 'waiting'], 40)
    expect(reopened).not.toBe('done')
  }, 30_000)
})
