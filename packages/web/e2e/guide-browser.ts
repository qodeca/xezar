import { execFileSync } from 'node:child_process'

import { readTestEnv } from './agent-browser'

/**
 * The ONE new browser-interaction helper for the guide-flow package (browser-test spec § Locator
 * rule). Every guide file drives the app through this class, never through `AgentBrowser`'s
 * CSS-selector methods: every action here resolves an element by ARIA role with an accessible
 * name, an associated label, or visible text — the same three locator classes agent-browser's own
 * `find` command supports — and none of them accepts a class, id, `data-*` attribute or CSS
 * selector string. `agent-browser find <locator> <value> [action]` already implements this
 * server-side (`agent-browser find --help`), so this wrapper is a thin, typed façade over it plus
 * the couple of navigation primitives (URL, plain body text) that carry no implementation detail.
 */

type FindLocator = 'role' | 'text' | 'label' | 'placeholder' | 'alt' | 'title'

type Box = { x: number; y: number; width: number; height: number }

/** Whether two live boxes read exactly equal — `clickRoleWhenStable`'s own "Stable" check,
 *  Playwright's actionability model applied to agent-browser's `get box` numbers verbatim. */
function boxesEqual(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Whether an error thrown by `run()` is agent-browser's own click-interception failure (the
 * click point resolved to a different element than the one requested), as opposed to any other
 * failure `find … click` can raise. `run()`'s own thrown message embeds
 * `JSON.stringify(parsed.error)` verbatim, and the one real occurrence of this failure captured
 * against the installed CLI so far (PR #590's own round-2 scoped re-check, reproduced against a
 * covered "Open in…" trigger) read:
 *   Element '@e54' is covered by <button.inline-flex.shrink-0 inside div#root> at its click point
 * — i.e. the human-readable "covered by" phrase agent-browser's own error text uses, not a
 * separate structured field naming the coverer. This round's own RED attempt (6 foreground runs,
 * temporarily reverting the `clickRoleWhenStable` guard on that same click) did not reproduce the
 * race live to re-confirm the exact JSON shape — the failure is load-dependent (previously 2 of 3
 * fresh-instance runs, this round 0 of 6), consistent with the research's cause 2 (a one-shot
 * hit-test against an accessibility-tree snapshot that can lag by a fraction of a second under
 * contention). The check below matches on that phrase rather than a specific JSON key for exactly
 * that reason: nothing here asserts a field name that has not actually been observed on a live
 * failure.
 *
 * The failure's real transport was finally observed on 2026-09-19 (CI run 35451994733 on main,
 * 35451195569 on PR #702 and #706's neighbour, all red on guide-02's `--name Files` click and all
 * green on re-run): agent-browser writes that same `{"success":false,…,"error":"… covered by
 * …"}` JSON to STDOUT and exits 1, so it reaches this helper through `run()`'s `execFileSync`
 * catch rather than its zero-exit `success:false` branch — and Node's own error message names only
 * the command. `cliFailureDetail` below now carries the CLI's payload into that message, which is
 * what makes this check read the phrase on BOTH failure shapes. The check still matches the
 * human-readable phrase rather than a JSON field name.
 */
function isCoveredClickError(cause: unknown): boolean {
  return cause instanceof Error && /covered by/i.test(cause.message)
}

/**
 * The CLI's own error text from a failure that exited NON-ZERO, for `run()`'s catch branch.
 *
 * agent-browser reports its failures as `{"success":false,"data":null,"error":"…"}` on STDOUT,
 * and it exits 1 while doing so — so that payload arrives as an `execFileSync` throw whose
 * `.message` is only "Command failed: <cmd>" and whose stdout sits on the error object. Throwing
 * the bare wrapper therefore LOST the CLI's own error text, which is why `isCoveredClickError`
 * matched nothing on the one failure it exists for and `clickRoleWhenStable` rethrew a covered
 * click instead of retrying it (guide-02's Files tab, CI run 35451994733).
 *
 * Returns the same `→ "<error>"` suffix the zero-exit `success:false` branch below already builds,
 * so both failure shapes read identically to a caller that matches on the message.
 */
function cliFailureDetail(cause: unknown): string {
  const stdout = (cause as { stdout?: unknown } | null | undefined)?.stdout
  if (typeof stdout !== 'string' || stdout.trim() === '') return ''
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown }
    if (parsed?.error !== undefined) return ` → ${JSON.stringify(parsed.error)}`
  } catch {
    /* not the CLI's JSON — fall through to its raw text */
  }
  return ` → ${stdout.trim()}`
}

export class GuideBrowser {
  private constructor(
    private readonly bin: string,
    private readonly session: string,
  ) {}

  static open(session: string): GuideBrowser {
    const env = readTestEnv()
    if (!env.browser.installed) {
      throw new Error(`xezar e2e: the agent-browser provider is not installed (${env.browser.notes})`)
    }
    return new GuideBrowser(env.browser.command, session)
  }

  /**
   * The same object `open` builds, around an explicit binary. `open` resolves its binary from the
   * shared test-env descriptor that only `npm run test:e2e` writes; the unit test that pins
   * `clickRoleWhenStable`'s retry against the CLI's REAL failure shape drives a fake CLI through
   * this instead.
   */
  static forBinary(bin: string, session: string): GuideBrowser {
    return new GuideBrowser(bin, session)
  }

  private run(args: string[]): Record<string, unknown> {
    let stdout: string
    try {
      stdout = execFileSync(this.bin, ['--session', this.session, ...args, '--json'], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (cause) {
      throw new Error(`xezar e2e: agent-browser ${args.join(' ')} failed${cliFailureDetail(cause)}`, { cause })
    }
    const parsed = JSON.parse(stdout) as { success: boolean; data?: unknown; error?: unknown }
    if (!parsed.success) {
      throw new Error(`xezar e2e: agent-browser ${args.join(' ')} → ${JSON.stringify(parsed.error)}`)
    }
    return (parsed.data ?? {}) as Record<string, unknown>
  }

  /** Same signature `find` itself exposes: locator kind, its value, an action, and — for `role`
   *  only — the accessible-name filter `find` calls `--name`. */
  private find(
    locator: FindLocator,
    value: string,
    action: 'click' | 'fill' | 'check' | 'hover' | 'text',
    opts: { name?: string; fillValue?: string; exact?: boolean } = {},
  ): Record<string, unknown> {
    const args = ['find', locator, value, action]
    if (opts.fillValue !== undefined) args.push(opts.fillValue)
    if (opts.name !== undefined) args.push('--name', opts.name)
    if (opts.exact) args.push('--exact')
    return this.run(args)
  }

  goto(url: string): void {
    this.run(['open', url])
  }

  /** Desktop viewport — several run-header actions (Finish, Cancel, Continue) render only at
   *  the `md` breakpoint, the same reason every other fixture spec pins one (`AgentBrowser`'s
   *  own `setViewport`, reused verbatim here since it carries no selector). Added in browser-test
   *  pull request 2 (#549) because guide 02 is the first guide file to reach those controls;
   *  PR 1 (#579) did not need it. */
  setViewport(width: number, height: number): void {
    this.run(['set', 'viewport', String(width), String(height)])
  }

  /** Navigation state, not markup — the descriptor's `get url` operation. */
  url(): string {
    return String(this.run(['get', 'url']).url ?? '')
  }

  /** The full document's visible text, for guide prose that carries no ARIA role at all (a
   *  paragraph explaining local-only scope, a capability's "Unavailable — why" note). This reads
   *  the `body` element itself, not an implementation hook, and is the closest agent-browser
   *  operation to the spec's third locator class, "visible text". */
  bodyText(): string {
    return String(this.run(['get', 'text', 'body']).text ?? '')
  }

  /** Whether `text` appears anywhere in the current page's visible text. */
  hasText(text: string): boolean {
    return this.bodyText().includes(text)
  }

  /** Click the element with this ARIA role and accessible name (e.g. `clickRole('link', 'Agents')`,
   *  `clickRole('menuitemradio', 'codex', { exact: false })`). */
  clickRole(role: string, name: string, opts: { exact?: boolean } = {}): void {
    this.find('role', role, 'click', { name, exact: opts.exact })
  }

  /** Click the element carrying this exact visible text. */
  clickText(text: string): void {
    this.find('text', text, 'click', { exact: true })
  }

  /** Clear and fill the control associated with this accessible label. */
  fillLabel(label: string, value: string): void {
    this.find('label', label, 'fill', { fillValue: value })
  }

  /** The text content of the element with this role and accessible name. Throws when no element
   *  matches — used both to read a value and, wrapped in `hasRole`, to prove one exists. */
  textOfRole(role: string, name: string, opts: { exact?: boolean } = {}): string {
    return String(this.find('role', role, 'text', { name, exact: opts.exact }).text ?? '')
  }

  /** Whether an element with this role and accessible name exists right now — a semantic
   *  presence check with no selector literal, for empty/unavailable-state assertions. */
  hasRole(role: string, name: string, opts: { exact?: boolean } = {}): boolean {
    try {
      this.textOfRole(role, name, opts)
      return true
    } catch {
      return false
    }
  }

  /** Whether a form control with this placeholder text exists — the input-level counterpart to
   *  `hasRole`/`hasText`, for a control (such as the command palette's search box) whose only
   *  accessible name comes from its `placeholder`, not a role name, a label, or rendered text. */
  hasPlaceholder(text: string, opts: { exact?: boolean } = {}): boolean {
    try {
      this.find('placeholder', text, 'text', { exact: opts.exact })
      return true
    } catch {
      return false
    }
  }

  /**
   * The current VALUE of a form control addressed by role and accessible name — a `<select>` or
   * `<input>`'s own `.value`, which `find`'s `text` action cannot read (a native control has no
   * `textContent`; a `<select>`'s is every option concatenated, not the selected one). Reads it
   * off `snapshot`'s own rendering instead, which already prints a field's value after `]: ` on
   * its own line for exactly this reason. Still zero selectors: the lookup key is the same role
   * and accessible name every other method here takes.
   */
  valueOfRole(role: string, name: string): string {
    const snapshot = String(this.run(['snapshot', '-i']).snapshot ?? '')
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^\\s*-\\s*${role}\\s+"${escaped}"[^\\n]*\\]:\\s?(.*)$`, 'm')
    const match = pattern.exec(snapshot)
    if (!match) {
      throw new Error(`xezar e2e: no ${role} named "${name}" with a readable value in the current snapshot`)
    }
    return match[1] ?? ''
  }

  /** The live accessibility-tree reference (`@e1`, …) for the element with this role and
   *  accessible name — `snapshot`'s own JSON `refs` map, still zero selectors: the lookup key
   *  is the same role/name pair every other method here takes, never a class, id or `data-*`
   *  attribute. Throws when no element matches, the same contract `textOfRole` already has. */
  private refFor(role: string, name: string): string {
    const snapshot = this.run(['snapshot', '-i']) as { refs?: Record<string, { role: string; name: string }> }
    for (const [id, info] of Object.entries(snapshot.refs ?? {})) {
      if (info.role === role && info.name === name) return `@${id}`
    }
    throw new Error(`xezar e2e: no ${role} named "${name}" in the current snapshot`)
  }

  /** The live bounding box of the element with this role and accessible name. */
  boxOfRole(role: string, name: string): Box {
    const raw = this.run(['get', 'box', this.refFor(role, name)])
    return {
      x: Number(raw.x ?? 0),
      y: Number(raw.y ?? 0),
      width: Number(raw.width ?? 0),
      height: Number(raw.height ?? 0),
    }
  }

  /** Scroll the element with this role and accessible name into view. */
  scrollIntoViewRole(role: string, name: string): void {
    this.run(['scrollintoview', this.refFor(role, name)])
  }

  /**
   * Click the element with this role and accessible name once its OWN bounding box has read the
   * same value on two consecutive polls (Playwright's "Stable" actionability check, applied here
   * with no coverer to name in advance — see `docs/testing/agent-browser.md` and the round-3
   * research this replaced `waitForUncoveredRole` with, `.local/xezar-tasks/9a994a7d-…/
   * click-race-research.md` Remedy A). A sibling action button in this app can mount/unmount
   * (e.g. Pin on Archive/Unarchive), which shifts every button after it in a right-anchored
   * (`ml-auto`) flex row by a single, synchronous, single-frame DOM/layout jump — not a CSS
   * transition — so "stable" here means "the same commit's geometry has been read twice in a
   * row", not "no longer animating".
   *
   * If the click itself still lands on a moment where agent-browser reports the click point
   * covered, this retries within the same bounded attempt budget after a fresh box read, rather
   * than failing on the first transient race: `find … click`'s own covered-click error is a
   * one-shot hit-test with no retry of its own (agent-browser issue #1434), and re-reading the
   * accessibility-tree snapshot is agent-browser's own documented remedy for that failure.
   */
  async clickRoleWhenStable(
    role: string,
    name: string,
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const attempts = opts.attempts ?? 40
    const intervalMs = opts.intervalMs ?? 250
    this.scrollIntoViewRole(role, name)

    let lastBox: Box | null = null
    for (let i = 0; i < attempts; i += 1) {
      const box = this.boxOfRole(role, name)
      const stable = lastBox !== null && boxesEqual(lastBox, box)
      lastBox = box
      if (stable) {
        try {
          this.clickRole(role, name)
          return
        } catch (cause) {
          if (!isCoveredClickError(cause)) throw cause
          lastBox = null // a covered click means the geometry just changed again; re-establish stability
        }
      }
      this.run(['wait', String(intervalMs)])
    }
    throw new Error(`xezar e2e: ${role} "${name}" never became stable and clickable`)
  }

  /**
   * The current CHECKED state of a checkbox/radio addressed by role and accessible name — read
   * off `snapshot`'s own `[checked=true|false]` annotation, the same source `valueOfRole` reads
   * a combobox's value from. `find`'s `text` action has no notion of "checked": a checkbox has no
   * text content to report, only the boolean the accessibility tree already carries.
   */
  isChecked(role: string, name: string): boolean {
    const snapshot = String(this.run(['snapshot', '-i']).snapshot ?? '')
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^\\s*-\\s*${role}\\s+"${escaped}"[^\\n]*\\[checked=(true|false)`, 'm')
    const match = pattern.exec(snapshot)
    if (!match) {
      throw new Error(`xezar e2e: no ${role} named "${name}" with a checked state in the current snapshot`)
    }
    return match[1] === 'true'
  }

  /** Whether a control is currently DISABLED — `snapshot`'s own bare `[disabled, ...]` flag,
   *  read the same way `isChecked` reads `[checked=…]`. Used for a form's own submit-readiness
   *  (e.g. "Start drafting" stays disabled until its one required field has text). */
  isDisabled(role: string, name: string): boolean {
    const snapshot = String(this.run(['snapshot', '-i']).snapshot ?? '')
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^\\s*-\\s*${role}\\s+"${escaped}"\\s*\\[([^\\]]*)\\]`, 'm')
    const match = pattern.exec(snapshot)
    if (!match) {
      throw new Error(`xezar e2e: no ${role} named "${name}" found in the current snapshot`)
    }
    return /(^|,\s*)disabled(\s*,|$)/.test(match[1] ?? '')
  }

  /** Poll for a role+name to exist, the semantic-locator equivalent of `waitForFunction` — no
   *  markup expression, just repeated `find … text` attempts a fixed number of times. */
  async waitForRole(role: string, name: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<void> {
    const attempts = opts.attempts ?? 40
    const intervalMs = opts.intervalMs ?? 250
    for (let i = 0; i < attempts; i += 1) {
      if (this.hasRole(role, name)) return
      this.run(['wait', String(intervalMs)])
    }
    throw new Error(`xezar e2e: role "${role}" named "${name}" never appeared`)
  }

  /** Poll for a role+name to STOP existing — `waitForRole`'s negation, for a loading/pending
   *  indicator that must clear before the settled content underneath it can be asserted. Waiting
   *  on the settled text alone cannot tell "still loading" from "loaded, but not this state" —
   *  this makes that distinction a real, separately-failing assertion instead of folding both
   *  into one generic "never appeared" (#579 round 3). */
  async waitForRoleGone(role: string, name: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<void> {
    const attempts = opts.attempts ?? 40
    const intervalMs = opts.intervalMs ?? 250
    for (let i = 0; i < attempts; i += 1) {
      if (!this.hasRole(role, name)) return
      this.run(['wait', String(intervalMs)])
    }
    throw new Error(`xezar e2e: role "${role}" named "${name}" never disappeared`)
  }

  /** Poll for `text` to appear anywhere in the page's visible text — the `hasText` counterpart to
   *  `waitForRole`, for data-dependent prose (a fetched health/config value) that can render after
   *  a static heading in the same section already exists. */
  async waitForText(text: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<void> {
    const attempts = opts.attempts ?? 40
    const intervalMs = opts.intervalMs ?? 250
    for (let i = 0; i < attempts; i += 1) {
      if (this.hasText(text)) return
      this.run(['wait', String(intervalMs)])
    }
    throw new Error(`xezar e2e: text "${text}" never appeared`)
  }

  /** Poll for the URL to reach an exact value — navigation state, not markup. */
  async waitForUrl(url: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<void> {
    const attempts = opts.attempts ?? 40
    const intervalMs = opts.intervalMs ?? 250
    for (let i = 0; i < attempts; i += 1) {
      if (this.url() === url) return
      this.run(['wait', String(intervalMs)])
    }
    throw new Error(`xezar e2e: URL never reached ${url} (last: ${this.url()})`)
  }

  /** A fixed pause for content that has no role/text to poll on yet (freshly opened page before
   *  its first paint settles) — never used as a substitute for `waitForRole`/`waitForUrl` once a
   *  semantic anchor exists. */
  pause(ms: number): void {
    this.run(['wait', String(ms)])
  }

  close(): void {
    try {
      this.run(['close'])
    } catch {
      /* already closed */
    }
  }
}
