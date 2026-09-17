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

  private run(args: string[]): Record<string, unknown> {
    let stdout: string
    try {
      stdout = execFileSync(this.bin, ['--session', this.session, ...args, '--json'], {
        encoding: 'utf8',
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
   *  PR 1 (#579) did not need it. If both land, keep whichever copy of this file has this method. */
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
