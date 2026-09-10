import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, resolve } from 'node:path'

/**
 * The agent-browser provider seam. Every e2e spec drives the app through this module and
 * never through a browser library directly, because `.ai/agentic.config.json` names the
 * provider (`browser.provider`) and `docs/testing/agent-browser.md` defines the operations.
 * Swapping providers must mean rewriting this file only.
 *
 * Each exported function maps to one operation in that descriptor: open, snapshot, eval/get
 * (assert), screenshot, close.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const descriptorPath = resolve(repoRoot, '.local/qa/test-env.json')

/**
 * The built CLI a spec spawns when it needs its OWN xezar rather than the shared test env
 * (a pinned `runs.json` fixture, an empty repo, a second project).
 *
 * Exported from here rather than re-derived per spec because it is one fact about the build
 * layout, and it has already moved once: `npm run build` emits the server into the workspace
 * package (`packages/xezar/dist`), not into a root-level `dist/`.
 */
export const xezarCli = resolve(repoRoot, 'packages/xezar/dist/index.js')

type EnvDescriptor = {
  baseUrl: string
  browser: { installed: boolean; command: string; version: string; notes: string }
}

/** The shared descriptor written by scripts/test-env-up.sh — QA and e2e attach to the
 *  exact same instance rather than each booting their own. */
export function readTestEnv(): EnvDescriptor {
  try {
    return JSON.parse(readFileSync(descriptorPath, 'utf8')) as EnvDescriptor
  } catch (cause) {
    throw new Error(
      `xezar e2e: cannot read ${descriptorPath}. Run \`npm run test:e2e\`, which boots the env first.`,
      { cause },
    )
  }
}

/**
 * The environment for a spec-owned `xezar serve` over a throwaway `dataRoot`.
 *
 * `XEZ_DRY_RUN` is why these boots need no network and no agent login. `XEZ_HOME` is why they
 * are *isolated*: since the multi-project workspace landed, booting in an unregistered folder
 * APPENDS it to `~/.xezar/config.json`, so an unpinned fixture server would (a) litter the
 * developer's real registry with a dead `/tmp/xezar-e2e-…` entry per run and (b) make every
 * spec order-dependent — once the registry holds more than one project the sidebar renders
 * the grouped multi-project shell instead of the flat one these specs assert against.
 * Pinning it inside `dataRoot` means the spec's own `rmSync(dataRoot)` cleans it up too.
 *
 * The shared test env pins the same variable under `.local/qa/xez-home`
 * (`scripts/test-env-up.sh`); this is that rule for the specs that boot their own server.
 */
export function fixtureServeEnv(
  dataRoot: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // One line on purpose: the `fixture-serve-must-pin-xez-home` design guardian reads these
    // two together, and a XEZ_DRY_RUN without XEZ_HOME beside it is exactly the mistake it
    // exists to catch.
    XEZ_DRY_RUN: '1', XEZ_HOME: resolve(dataRoot, '.xez-home'),
    // A fixture repo must hold exactly the skills the fixture wrote. Open Mercato skill updates
    // are default-on (AGENTS.md § Zero config), so a boot inside the six-hour window installs the
    // whole `om-*` collection INTO the fixture and every "these are the project skills"
    // assertion starts depending on the machine's cache and network. The shared test env
    // (`skills-update.e2e.ts` attaches to it) is where that behaviour is exercised on purpose;
    // `extra` can still turn it back on for a spec that wants it.
    XEZ_SKILLS_AUTO_UPDATE: '0',
    ...extra,
  }
}

/**
 * A JSON GET that survives a RESET idle connection.
 *
 * Specs boot a server, drive the browser for tens of seconds, then read the API back. Node's
 * fetch pools the connection opened during the health probe, and reusing a socket the server has
 * since closed surfaces as `ECONNRESET` — a dead connection, never a dead server (the process is
 * still answering the browser at that moment). One retry opens a fresh one.
 */
export async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await (await fetch(url)).json()) as T
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/**
 * The id of the project a server booted in — the `/p/<projectId>` prefix every cockpit URL
 * carries since the multi-project spec's step 3.2.
 *
 * Specs resolve it from the live server rather than deriving it from the fixture's folder name:
 * the slug is allocated by the registry (lowercased, deduplicated), so only the server knows it.
 */
export async function bootProjectId(baseUrl: string): Promise<string> {
  const { bootProject } = (await (await fetch(`${baseUrl}/api/v1/projects`)).json()) as {
    bootProject: string
  }
  if (!bootProject) throw new Error(`xezar e2e: ${baseUrl}/api/v1/projects named no boot project`)
  return bootProject
}

/**
 * Tear a fixture server down the way its own data directory needs: signal it, then WAIT for
 * the process to actually exit before anything touches its files. `kill()` only delivers the
 * signal — the server can still be flushing its NDJSON transcript when the caller returns,
 * which is what made `rmSync` throw `ENOTEMPTY` on a suite whose every test had passed.
 *
 * A server that ignores SIGTERM gets SIGKILL rather than a hang; the wait is bounded so a
 * wedged fixture surfaces as its own slow teardown instead of a 60s hook timeout.
 */
export async function stopFixtureServer(server: ChildProcess | undefined): Promise<void> {
  if (server === undefined || server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise<void>((done) => server.once('exit', () => done()))
  server.kill()
  // `ref: false`: the race below leaves this timer pending, and a referenced one would hold
  // the worker's event loop open for five seconds after every fixture teardown.
  const escalate = delay(5_000, undefined, { ref: false }).then(() => {
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
    return exited
  })
  await Promise.race([exited, escalate])
}

/**
 * Remove a fixture data root once its server is gone. The directory is this suite's own
 * litter, so a removal that loses a race with the last write is retried rather than swallowed
 * — and a removal that keeps failing is reported, not hidden: a data root that cannot be
 * deleted is a fixture still holding it open, which is worth knowing.
 */
export async function removeDataRoot(dataRoot: string | undefined): Promise<void> {
  if (!dataRoot) return
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dataRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 10) throw error
      await delay(100)
    }
  }
}

/**
 * The page-side halves of `AgentBrowser.diagnostics`.
 *
 * Each returns a STRING rather than an object: the CLI serializes an eval result through CDP, and
 * a plain string is the one shape that survives every page state — including a document whose own
 * `JSON.stringify` has been shadowed by app code, and an element handle, which CDP refuses.
 */
const WHERE_JS = `(() => {
  try {
    return JSON.stringify({
      url: location.href,
      readyState: document.readyState,
      title: document.title,
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    })
  } catch (error) { return 'threw: ' + error }
})()`

/** Every `data-slot` value currently in the document, with how many nodes carry it. */
const SLOT_CENSUS_JS = `(() => {
  try {
    const counts = {}
    for (const node of document.querySelectorAll('[data-slot]')) {
      counts[node.dataset.slot] = (counts[node.dataset.slot] ?? 0) + 1
    }
    const names = Object.keys(counts).sort()
    return names.length === 0
      ? '(no [data-slot] nodes at all)'
      : names.map((n) => n + '×' + counts[n]).join(', ')
  } catch (error) { return 'threw: ' + error }
})()`

/**
 * The nodes carrying one `data-slot`, each with its own attributes and trimmed text.
 *
 * "The row I wanted is missing" and "the rows are all there but none carries the id I asked for"
 * are different bugs with the same timeout, and only an enumeration tells them apart.
 */
function slotDigestJs(slot: string): string {
  return `(() => {
    try {
      const nodes = [...document.querySelectorAll('[data-slot=' + ${JSON.stringify(JSON.stringify(slot))} + ']')]
      if (nodes.length === 0) return '0 nodes'
      return nodes.length + ' nodes: ' + nodes.slice(0, 12).map((node) => {
        const attrs = [...node.attributes]
          .filter((a) => a.name.startsWith('data-') || a.name === 'aria-current' || a.name === 'disabled')
          .map((a) => a.name + '=' + JSON.stringify(a.value))
          .join(' ')
        return '{' + attrs + ' text=' + JSON.stringify((node.textContent ?? '').trim().slice(0, 60)) + '}'
      }).join(' ')
    } catch (error) { return 'threw: ' + error }
  })()`
}

/** The `data-slot` values a failed selector or predicate mentioned, in first-seen order. */
function slotsNamedIn(expression: string): string[] {
  const found = new Set<string>()
  for (const match of expression.matchAll(/data-slot=["']([^"']+)["']/g)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found]
}

/** One diagnostic value as a single readable line — `undefined` when the browser would not say. */
function format(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export class AgentBrowser {
  // A unique session per run, per the descriptor's rules — never attach to a user's profile.
  private constructor(
    private readonly bin: string,
    private readonly session: string,
  ) {}

  static open(session: string): AgentBrowser {
    const env = readTestEnv()
    if (!env.browser.installed) {
      throw new Error(`xezar e2e: the agent-browser provider is not installed (${env.browser.notes})`)
    }
    return new AgentBrowser(env.browser.command, session)
  }

  /** One agent-browser invocation. `--json` on every call so results are parsed, not scraped. */
  private run(args: string[]): Record<string, unknown> {
    let stdout: string
    try {
      stdout = execFileSync(this.bin, ['--session', this.session, ...args, '--json'], {
        encoding: 'utf8',
        // A hung browser must fail the spec, not the whole suite's wall clock.
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (cause) {
      throw new Error(`xezar e2e: agent-browser ${args.join(' ')} failed`, { cause })
    }
    const parsed = JSON.parse(stdout) as { success: boolean; data?: unknown; error?: unknown }
    if (!parsed.success) {
      throw new Error(`xezar e2e: agent-browser ${args.join(' ')} → ${JSON.stringify(parsed.error)}`)
    }
    return (parsed.data ?? {}) as Record<string, unknown>
  }

  /**
   * `run`, but for the failure path: it answers `undefined` instead of throwing.
   *
   * Everything the diagnostic below asks the browser is best-effort by construction. A page that
   * just failed a wait is a page that may also refuse a snapshot, and a diagnostic that threw
   * would replace the real failure with its own — which is precisely how rounds 1–3 of this
   * blocker (#136, #148, #160) ended up diagnosed from a bare "timed out".
   */
  private safe(args: string[]): Record<string, unknown> | undefined {
    try {
      return this.run(args)
    } catch {
      return undefined
    }
  }

  /**
   * What the page held and what the server answered, at the moment a wait or a click gave up.
   *
   * This exists because a bare `Wait timed out after 25000ms` names neither. Three rounds of this
   * suite's intermittent failures (#133→#136, #145→#148, #155→#160) were each diagnosed by hand
   * from that one line, and the last of them turned out to be a real product bug (`POST
   * /runs/:id/finish` answering `409`) that the timeout had been hiding all along. A failure that
   * reports the DOM it was waiting on and the HTTP statuses behind it is the difference between
   * one run and three.
   *
   * Never throws: see `safe`. Every section degrades to a `(unavailable)` line of its own.
   */
  private diagnostics(subject: string): string {
    const lines: string[] = ['', `--- page diagnostics (${subject}) ---`]

    const where = this.safe(['eval', WHERE_JS])
    lines.push(`  where: ${format(where?.result) ?? '(unavailable)'}`)

    // The slots the failed expression itself named — "what was there instead" is the question a
    // missing `[data-slot="skill-row"][data-skill="…"]` actually raises, and only the expression
    // knows which slot to enumerate.
    for (const slot of slotsNamedIn(subject)) {
      const found = this.safe(['eval', slotDigestJs(slot)])
      lines.push(`  [data-slot="${slot}"]: ${format(found?.result) ?? '(unavailable)'}`)
    }

    const slots = this.safe(['eval', SLOT_CENSUS_JS])
    lines.push(`  slots present: ${format(slots?.result) ?? '(unavailable)'}`)

    const errors = (this.safe(['errors'])?.errors ?? []) as unknown[]
    lines.push(`  page errors: ${errors.length === 0 ? 'none' : format(errors.slice(-5))}`)

    const messages = (this.safe(['console'])?.messages ?? []) as Array<Record<string, unknown>>
    const loud = messages.filter((m) => m.type === 'error' || m.type === 'warning')
    lines.push(`  console (error/warning): ${loud.length === 0 ? 'none' : format(loud.slice(-5))}`)

    // The API half of the answer. Only the app's own calls, reduced to the three fields that
    // matter — a full request record is mostly headers and drowns the status it carries.
    const requests = (this.safe(['network', 'requests'])?.requests ?? []) as Array<
      Record<string, unknown>
    >
    const api = requests
      .filter((r) => typeof r.url === 'string' && (r.url as string).includes('/api/'))
      .slice(-25)
      .map((r) => `${r.status ?? '???'} ${r.method ?? '?'} ${new URL(String(r.url)).pathname}`)
    lines.push(`  api calls: ${api.length === 0 ? 'none recorded' : `\n    ${api.join('\n    ')}`}`)

    const failed = requests
      .filter((r) => typeof r.status === 'number' && ((r.status as number) >= 400 || r.status === 0))
      .slice(-10)
      .map((r) => `${r.status} ${r.method ?? '?'} ${r.url}`)
    if (failed.length > 0) lines.push(`  NON-OK responses:\n    ${failed.join('\n    ')}`)

    lines.push('--- end page diagnostics ---')
    return lines.join('\n')
  }

  /** operation: open */
  goto(url: string): void {
    this.run(['open', url])
  }

  /** operation: snapshot — the accessibility tree, as the string the descriptor documents. */
  snapshot(): string {
    return String(this.run(['snapshot', '-i']).snapshot ?? '')
  }

  /** operation: assert (`get text`) */
  text(selector: string): string {
    return String(this.run(['get', 'text', selector]).text ?? '')
  }

  /** operation: assert (`get url`) */
  url(): string {
    return String(this.run(['get', 'url']).url ?? '')
  }

  /** operation: assert (`is visible`).
   *
   *  Throws when nothing matches — the CLI reports an absent element as a failed query, not as
   *  "not visible". Use `count` for anything that unmounts rather than hides. */
  isVisible(selector: string): boolean {
    return this.run(['is', 'visible', selector]).visible === true
  }

  /** operation: assert (`eval`) — how many nodes match.
   *
   *  The distinction from `isVisible` is real and load-bearing: the desktop sidebar is in the DOM
   *  but display:none, while a closed Radix dialog is not in the DOM at all. Only this can say
   *  which of the two a surface is, and only this can assert absence without erroring. */
  count(selector: string): number {
    return Number(this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`))
  }

  /** operation: interact (`wait --fn`) — block until a predicate is truthy in the page.
   *
   *  Animated surfaces need this. The drawer slides in over 500ms, so for half a second after the
   *  tap that opened it, it is mounted, "visible", and still entirely off-screen — sampling it in
   *  that window answers every question wrong. */
  waitForFunction(js: string): void {
    try {
      this.run(['wait', '--fn', js])
    } catch (cause) {
      throw new Error(`${(cause as Error).message}${this.diagnostics(js)}`, { cause })
    }
  }

  /** operation: interact (`press`) — a key press against whatever currently has focus. */
  press(key: string): void {
    this.run(['press', key])
  }

  /** operation: interact (`fill`) — set a field's value the way typing would (real input
   *  events, so controlled React inputs — the ⌘K palette's filter — see the change). */
  fill(selector: string, value: string): void {
    this.run(['fill', selector, value])
  }

  /** operation: interact (`mouse move`/`down`/`up`) — a tap at a viewport coordinate.
   *
   *  `click` targets an element's center point and, by design, refuses when something covers it.
   *  A modal backdrop is exactly that case: it spans the viewport, so its center sits under the
   *  drawer it is dimming, and the only honest way to tap the backdrop *beside* the drawer is by
   *  coordinate. */
  tapAt(x: number, y: number): void {
    this.run(['mouse', 'move', String(x), String(y)])
    this.run(['mouse', 'down'])
    this.run(['mouse', 'up'])
  }

  /** operation: interact (`mouse move`/`down`/`up`) — press at one viewport coordinate, move to
   *  another, release. A real, trusted pointer stream, which is the only kind that can exercise
   *  a drag built on pointer capture (`setPointerCapture` rejects a pointer id the browser is
   *  not actually tracking, so a synthetically dispatched PointerEvent cannot test one).
   *
   *  The intermediate move exists because a single jump from press to release is indistinguishable
   *  from a click for anything that samples movement — the sidebar's resize handle reads each
   *  move, so it needs more than one. */
  dragTo(from: { x: number; y: number }, to: { x: number; y: number }): void {
    this.run(['mouse', 'move', String(from.x), String(from.y)])
    this.run(['mouse', 'down'])
    this.run(['mouse', 'move', String(Math.round((from.x + to.x) / 2)), String(Math.round((from.y + to.y) / 2))])
    this.run(['mouse', 'move', String(to.x), String(to.y)])
    this.run(['mouse', 'up'])
  }

  /** operation: assert (`eval`) — for DOM facts no selector query can express, such as a
   *  computed style resolved from a CSS custom property. */
  evaluate(js: string): unknown {
    return this.run(['eval', js]).result
  }

  /** operation: interact (`set viewport`) — the descriptor's "other actions use the matching
   *  CLI command" clause. Responsive layout is a real behavior of this app, so the specs must be
   *  able to ask for an iPhone-sized window rather than assume the default one. */
  setViewport(width: number, height: number): void {
    this.run(['set', 'viewport', String(width), String(height)])
  }

  /** operation: interact (`click`). */
  click(selector: string): void {
    try {
      this.run(['click', selector])
    } catch (cause) {
      throw new Error(`${(cause as Error).message}${this.diagnostics(selector)}`, { cause })
    }
  }

  /** operation: interact (`hover`) — hover-revealed affordances (the table's rename pencil)
   *  only exist under a real pointer; tests must produce one, not reach past it. */
  hover(selector: string): void {
    this.run(['hover', selector])
  }

  /** operation: screenshot. The descriptor requires an absolute path — a relative
   *  multi-segment path is read as a selector by the CLI.
   *
   *  `viewport: true` captures the visible viewport only. Full-page capture stitches by
   *  scrolling through the document, which is both pathological on a virtualized thread and
   *  destroys scroll-dependent UI state (it re-pins the thread and unmounts the jump pill) —
   *  any spec asserting such state after the shot must use the viewport mode. */
  screenshot(path: string, { viewport = false } = {}): string {
    const absolute = resolve(path)
    mkdirSync(dirname(absolute), { recursive: true })
    this.run(viewport ? ['screenshot', absolute] : ['screenshot', '--full', absolute])
    if (statSync(absolute).size === 0) throw new Error(`xezar e2e: empty screenshot at ${absolute}`)
    return absolute
  }

  /** operation: close. Never throws — teardown must not mask a real failure. */
  close(): void {
    try {
      this.run(['close'])
    } catch {
      /* already closed */
    }
  }
}
