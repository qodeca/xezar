import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

/**
 * Show details on an agent-account row names the login's kind (#867 AC-36, #908 design review).
 *
 * `account-limits.test.tsx` pins the words in jsdom; this is the rendered half the design review
 * asked for: open Show details on a Claude Code account row, read the "Login kind" line, and look
 * at it in light and dark, at 375 px and at desktop width. It owns its server over a throwaway data
 * root, so the quota check it triggers never lands in the shared environment. Dry run answers every
 * check with a subscription login, so the line reads "Subscription"; the screenshots under
 * `.local/qa/account-limits-captures/` are the evidence a design re-review reads.
 */

const sessionId = `e2e-account-limits-${process.pid}`
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/account-limits-captures')
const WIDTHS = [375, 1440] as const
const THEMES = ['light', 'dark'] as const
const LOGIN_KINDS = ['Subscription', 'API key — plan limits do not apply', 'Unknown — Claude Code did not say']
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string

function read<T>(expression: string): T {
  return JSON.parse(browser.evaluate(`JSON.stringify((() => { return (${expression}) })())`) as string) as T
}

/** The Claude Code row that carries plan limits — the row whose Show details opens its details. */
const ROW = `[...document.querySelectorAll('[data-slot="account-row"], li')].find(li => li.querySelector('[data-slot="account-limits"][aria-label$=", Claude Code"]') && li.querySelector('[data-action="account-details-toggle"]'))`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'xezar-e2e-account-limits-'))
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=al', '-c', 'user.email=al@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'])
  mkdirSync(join(root, '.xez-home'), { recursive: true })
  const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); const n = typeof a === 'object' && a ? a.port : 0; s.close(() => done(n)) }) })
  url = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    // The agents' own homes are pinned inside the data root too: Show details also opens the
    // account's identity, and a capture must never carry the developer's real login.
    env: fixtureServeEnv(root, { CLAUDE_CONFIG_DIR: join(root, 'home/.claude'), CODEX_HOME: join(root, 'home/.codex') }),
    stdio: 'ignore',
  })
  let healthy = false
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${url}/api/v1/health`)).ok) { healthy = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  if (!healthy) throw new Error('account-limits fixture server did not start')
  // A dry-run check answers at once; waiting for it here keeps the rendered row off "not checked yet".
  await fetch(`${url}/api/v1/workspace/agent-quota/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: '{}' })
  browser = AgentBrowser.open(sessionId)
  mkdirSync(artifacts, { recursive: true })
}, 60_000)
afterAll(async () => { browser?.close(); await stopFixtureServer(server); if (root) await removeDataRoot(root) })

describe('Show details on an account row', () => {
  for (const theme of THEMES) {
    it.each(WIDTHS)(`names the login kind in ${theme} at %i px`, (width) => {
      browser.setViewport(width, 900)
      browser.goto(`${url}/settings/global/accounts`)
      read(`(() => { localStorage.setItem('xez-theme', '${theme}'); return true })()`)
      browser.setMedia(theme)
      browser.goto(`${url}/settings/global/accounts`)
      browser.waitForFunction(`!!(${ROW})`)
      // The cockpit is dark unless the root carries `light` (lib/theme.ts).
      browser.waitForFunction(`document.documentElement.classList.contains('light') === ${theme === 'light'}`)

      read(`(() => { const row = ${ROW}; row.querySelector('[data-action="account-details-toggle"]').scrollIntoView({ block: 'center' }); row.querySelector('[data-action="account-details-toggle"]').click(); return true })()`)
      browser.waitForFunction(`!!(${ROW})?.querySelector('[data-slot="account-limits-details"]')`)

      const line = read<{ term: string; value: string; visible: boolean; toggle: string | null }>(`(() => {
        const row = ${ROW};
        const details = row.querySelector('[data-slot="account-limits-details"]');
        const term = [...details.querySelectorAll('dt')].find(dt => dt.textContent.trim() === 'Login kind');
        const value = term?.nextElementSibling;
        value?.scrollIntoView({ block: 'center' });
        const box = value?.getBoundingClientRect();
        return {
          term: term?.textContent.trim() ?? '',
          value: value?.textContent.trim() ?? '',
          visible: !!box && box.width > 0 && box.height > 0 && box.left >= -0.5 && box.right <= innerWidth + 0.5,
          toggle: row.querySelector('[data-action="account-details-toggle"]').getAttribute('aria-expanded'),
        };
      })()`)
      expect(line.term).toBe('Login kind')
      expect(LOGIN_KINDS).toContain(line.value)
      // Dry run answers a subscription login, so the line never calls it an API key.
      expect(line.value).toBe('Subscription')
      expect(line.visible).toBe(true)
      expect(line.toggle).toBe('true')
      expect(read<boolean>(`document.documentElement.scrollWidth > innerWidth`)).toBe(false)
      browser.screenshot(join(artifacts, `${theme}-${width}-login-kind.png`), { viewport: true })
    }, 60_000)
  }
})
