// The story the capture agents tell (#448 PR-1b design review, B-1 to B-3).
//
// The bundled dry-run mocks answer every task with the same test-oriented turn — "(dry-run mock)",
// a `mock notes` line, the same `+1 -0`, the same `#123` and the same token counts — which is
// right for tests and wrong for a README. These scripted agents are the capture harness's own:
// each seeded task is matched by its title and plays its own turn — its own tools, its own edits,
// its own token counts and references — through the real backend protocol, so the cockpit renders
// it exactly the way it would render a real agent. Nothing here is shipped or read by a test.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DATES_TS_BEFORE = `export function deliveryDate(date: Date): string {
  return date.toLocaleDateString()
}

export function orderDate(date: Date): string {
  return \`\${date.getMonth() + 1}/\${date.getDate()}/\${date.getFullYear()}\`
}

export function parseCardExpiry(value: string): Date {
  const [month, year] = value.split('/')
  return new Date(Number(\`20\${year}\`), Number(month) - 1, 1)
}
`

const DATES_TS_AFTER = `import { format, parse } from 'date-fns'

/** One spelling for every date the checkout shows: 15 Sep 2026. */
const DISPLAY = 'd MMM yyyy'

export function deliveryDate(date: Date): string {
  return format(date, DISPLAY)
}

export function orderDate(date: Date): string {
  return format(date, DISPLAY)
}

export function parseCardExpiry(value: string): Date {
  return parse(value, 'MM/yy', new Date())
}
`

const lines = (...rows) => `${rows.join('\n')}\n`

/**
 * A turn: what the agent says, the tools it calls (with results), the files it really writes in
 * its worktree, the handoff progress line it leaves and the usage it reports. `hold` keeps the
 * turn open (a task that must still read "running"); `ask` ends it with an XEZ:ASK question;
 * `fail` ends it the way that backend reports a failure.
 */
export const SCENARIOS = [
  {
    title: 'Upgrade the payment SDK to v5',
    turn: { fail: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' },
  },
  {
    title: 'Add a dark-mode toggle to the site header',
    turn: {
      reply: 'Added a theme toggle to the header. It follows the system setting until the user picks one, and remembers the choice.',
      refs: 'XEZ:ISSUE=131',
      tools: [
        { name: 'Read', input: { file_path: 'src/ui/header.ts' }, result: 'export function renderHeader(): string {' },
        { name: 'Bash', input: { command: 'npm test -- ui' }, result: 'Test Files  2 passed (2)\n     Tests  9 passed (9)' },
      ],
      files: {
        'src/ui/theme-toggle.ts': lines(
          "type Theme = 'light' | 'dark'",
          '',
          "const KEY = 'demo-shop-theme'",
          '',
          'export function preferredTheme(): Theme {',
          '  const stored = localStorage.getItem(KEY)',
          "  if (stored === 'light' || stored === 'dark') return stored",
          "  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
          '}',
          '',
          'export function applyTheme(theme: Theme): void {',
          "  document.documentElement.classList.toggle('dark', theme === 'dark')",
          '  localStorage.setItem(KEY, theme)',
          '}',
          '',
          'export function renderThemeToggle(): string {',
          "  const next = preferredTheme() === 'dark' ? 'light' : 'dark'",
          '  return `<button class="theme-toggle" data-next="${next}" aria-label="Switch to ${next} mode"></button>`',
          '}',
          '',
          'export function bindThemeToggle(root: HTMLElement): void {',
          "  root.addEventListener('click', (event) => {",
          "    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.theme-toggle')",
          '    if (!button) return',
          "    applyTheme(button.dataset.next === 'dark' ? 'dark' : 'light')",
          '  })',
          '}',
        ),
        'src/ui/theme.css': lines(
          ':root { --bg: #ffffff; --fg: #14151a; }',
          ':root.dark { --bg: #111217; --fg: #e8e9ee; }',
          'body { background: var(--bg); color: var(--fg); }',
          '.theme-toggle { width: 32px; height: 32px; border-radius: 999px; }',
        ),
      },
      replace: [['src/ui/header.ts', "  return `<header class=\"site-header\">${logo()}${nav()}</header>`", "  return `<header class=\"site-header\">${logo()}${nav()}${renderThemeToggle()}</header>`"]],
      prepend: [['src/ui/header.ts', "import { renderThemeToggle } from './theme-toggle'\n\n"]],
      progress: 'theme toggle in the header, persisted in localStorage; ui tests green',
      usage: { input: 38412, output: 2187 },
    },
  },
  {
    title: 'Fix the rounding error in the cart total',
    turn: {
      reply: 'The total summed floating-point prices. It now sums whole cents and divides once, with a test for the 0.1 + 0.2 case.',
      refs: 'XEZ:ISSUE=127',
      tools: [
        { name: 'Read', input: { file_path: 'src/cart/total.ts' }, result: 'export function cartTotal(lines: CartLine[]): number {' },
        { name: 'Bash', input: { command: 'npm test -- cart' }, result: 'Tests  4 passed (4)' },
      ],
      replace: [['src/cart/total.ts', '  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)\n', '  const cents = lines.reduce((sum, line) => sum + line.quantity * Math.round(line.unitPrice * 100), 0)\n  return cents / 100\n']],
      files: {
        'test/cart/total.test.ts': lines(
          "import { describe, expect, it } from 'vitest'",
          "import { cartTotal } from '../../src/cart/total'",
          '',
          "describe('cartTotal', () => {",
          "  it('adds prices in whole cents', () => {",
          "    expect(cartTotal([{ sku: 'a', quantity: 1, unitPrice: 0.1 }, { sku: 'b', quantity: 1, unitPrice: 0.2 }])).toBe(0.3)",
          '  })',
          '})',
        ),
      },
      progress: 'cart total sums whole cents; regression test for 0.1 + 0.2',
      usage: { input: 12704, output: 946 },
    },
  },
  {
    title: 'Speed up the product search query',
    turn: {
      reply: 'The search runs a `LIKE \'%term%\'` scan over every product, about 1.9 s at p95 on the seed data. Tell me which way to take it.',
      tools: [
        { name: 'Grep', input: { pattern: 'LIKE', path: 'src/search' }, result: "src/search/products.ts:7:    WHERE name ILIKE '%' || $1 || '%'" },
        { name: 'Read', input: { file_path: 'src/search/products.ts' }, result: 'export async function searchProducts(db: Db, term: string) {' },
      ],
      progress: 'profiled search: sequential scan on products.name, p95 1.9 s',
      usage: { input: 18230, output: 1102 },
    },
    followups: [
      {
        match: 'trigram index',
        reply: 'Added a trigram index migration. The same query now uses the index: p95 140 ms.',
        tools: [{ name: 'Bash', input: { command: 'npm run db:migrate && npm run bench:search' }, result: 'search p95  1912 ms → 141 ms' }],
        files: {
          'db/migrations/0042_products_name_trgm.sql': lines(
            'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
            'CREATE INDEX CONCURRENTLY products_name_trgm',
            '  ON products USING gin (name gin_trgm_ops);',
          ),
        },
        progress: 'trigram index on products.name; p95 1.9 s → 140 ms',
        usage: { input: 23000, output: 2016 },
      },
      {
        match: 'Cache',
        reply: 'Cached search results for 60 seconds, keyed by the normalised term, and cleared on product updates. Repeat searches return in 4 ms; the first one is still slow.',
        tools: [
          { name: 'Bash', input: { command: 'npm test -- search' }, result: 'Tests  11 passed (11)' },
          { name: 'Bash', input: { command: 'npm run bench:search' }, result: 'search p95  1912 ms → 1880 ms (cold), 4 ms (warm)' },
        ],
        files: {
          'src/search/cache.ts': lines(
            'interface Entry<T> {',
            '  value: T',
            '  expiresAt: number',
            '}',
            '',
            'const TTL_MS = 60_000',
            'const entries = new Map<string, Entry<unknown>>()',
            '',
            'export function cacheKey(term: string): string {',
            "  return term.trim().toLowerCase().replace(/\\s+/g, ' ')",
            '}',
            '',
            'export async function cached<T>(term: string, load: () => Promise<T>): Promise<T> {',
            '  const key = cacheKey(term)',
            '  const hit = entries.get(key)',
            '  if (hit && hit.expiresAt > Date.now()) return hit.value as T',
            '  const value = await load()',
            '  entries.set(key, { value, expiresAt: Date.now() + TTL_MS })',
            '  return value',
            '}',
            '',
            'export function clearSearchCache(): void {',
            '  entries.clear()',
            '}',
          ),
          'test/search/cache.test.ts': lines(
            "import { describe, expect, it, vi } from 'vitest'",
            "import { cached, clearSearchCache } from '../../src/search/cache'",
            '',
            "describe('cached', () => {",
            "  it('loads a term once per minute', async () => {",
            "    const load = vi.fn(async () => ['lamp'])",
            "    await cached('Lamp ', load)",
            "    await cached('lamp', load)",
            '    expect(load).toHaveBeenCalledTimes(1)',
            '    clearSearchCache()',
            '  })',
            '})',
          ),
        },
        replace: [['src/search/products.ts', 'export async function searchProducts(db: Db, term: string) {\n  return db.query(', "export async function searchProducts(db: Db, term: string) {\n  return cached(term, () => db.query("]],
        prepend: [['src/search/products.ts', "import { cached } from './cache'\n"]],
        progress: 'in-memory search cache, 60 s TTL; warm p95 4 ms, cold unchanged',
        usage: { input: 39674, output: 4300 },
      },
    ],
  },
  {
    title: 'Fix the login redirect that drops the session cookie',
    turn: {
      reply: 'The login redirect set the session cookie without `sameSite`, so the browser dropped it on the cross-site return from the identity provider. The cookie options now live in one place.',
      refs: 'XEZ:ISSUE=142',
      tools: [
        { name: 'Grep', input: { pattern: 'res.cookie', path: 'src' }, result: "src/auth/login.ts:18:  res.cookie('session', token)" },
        { name: 'Read', input: { file_path: 'src/auth/session.ts' }, result: 'export function readSession(req: Request): Session | undefined {' },
      ],
      files: {
        'src/auth/cookies.ts': lines(
          "import type { CookieOptions } from 'express'",
          '',
          '/** Every session cookie is set with these options, so a redirect cannot drop it. */',
          'export const SESSION_COOKIE: CookieOptions = {',
          '  httpOnly: true,',
          '  secure: true,',
          "  sameSite: 'lax',",
          '  signed: true,',
          '  maxAge: 1000 * 60 * 60 * 24 * 7,',
          '}',
        ),
      },
      progress: 'session cookie options in one place (sameSite lax, signed)',
      usage: { input: 52811, output: 2410 },
    },
    followups: [
      {
        match: 'regression test',
        reply: 'Added a regression test for the redirect: it reads the signed cookie the login sets, and the redirect keeps the page the user came from.',
        tools: [{ name: 'Bash', input: { command: 'npm test -- auth' }, result: 'Tests  7 passed (7)' }],
        progress: 'regression test for the login redirect; auth tests green',
        usage: { input: 43404, output: 2420 },
      },
    ],
  },
  {
    title: 'Pick a date library for the checkout',
    turn: {
      reply: 'Checkout formats dates in three different ways and parses card expiry by hand. Before I change anything, which library should the checkout standardise on?',
      tools: [
        { name: 'Grep', input: { pattern: 'toLocaleDateString|getMonth', path: 'src' }, result: 'src/checkout/dates.ts:2:  return date.toLocaleDateString()\nsrc/checkout/dates.ts:6:  return `${date.getMonth() + 1}/…`' },
        { name: 'Read', input: { file_path: 'src/checkout/dates.ts' }, result: DATES_TS_BEFORE },
      ],
      ask: {
        questions: [
          {
            header: 'Library',
            question: 'Which date library should the checkout standardise on?',
            options: [
              { label: 'date-fns', description: 'Tree-shakeable functions; smallest bundle for our use' },
              { label: 'Luxon', description: 'Immutable, time-zone aware; about 20 KB more' },
            ],
          },
        ],
      },
      progress: 'mapped every date format and parse in checkout; waiting on the library choice',
      usage: { input: 22480, output: 1204 },
    },
  },
  {
    title: 'Document the new pricing API',
    turn: {
      reply: 'Wrote the pricing API reference: the two endpoints, the request and response fields, and an example for a discounted cart.',
      tools: [{ name: 'Read', input: { file_path: 'src/cart/total.ts' }, result: 'export function cartTotal(lines: CartLine[]): number {' }],
      files: {
        'docs/pricing-api.md': lines(
          '# Pricing API',
          '',
          'Prices are quoted in cents and rounded once, at the cart total.',
          '',
          '## `POST /api/price`',
          '',
          'Returns the price of one cart.',
          '',
          '| Field | Type | Meaning |',
          '| --- | --- | --- |',
          '| `lines` | `CartLine[]` | The products and quantities |',
          '| `coupon` | `string?` | A coupon code |',
          '',
          '## `GET /api/price/:sku`',
          '',
          'Returns the list price of one product.',
          '',
          '## Example',
          '',
          '```json',
          '{ "lines": [{ "sku": "lamp-01", "quantity": 2 }], "coupon": "AUTUMN10" }',
          '```',
        ),
      },
      progress: 'pricing API reference with an example',
      usage: { input: 18330, output: 2715 },
    },
  },
  {
    title: 'Fix broken links in the getting-started guide',
    turn: { fail: 'stream disconnected before completion: the connection to the model provider was reset' },
  },
  {
    title: 'Standardise date handling across checkout',
    turn: {
      text: 'Checkout formats dates three different ways. I will move every date through date-fns, then check the page itself.',
      tools: [
        { name: 'Grep', input: { pattern: 'toLocaleDateString|getMonth', path: 'src/checkout' }, result: 'src/checkout/dates.ts:2:  return date.toLocaleDateString()\nsrc/checkout/dates.ts:6:  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`' },
        { name: 'Read', input: { file_path: 'src/checkout/dates.ts' }, result: DATES_TS_BEFORE },
        { name: 'Edit', input: { file_path: 'src/checkout/dates.ts', old_string: DATES_TS_BEFORE, new_string: DATES_TS_AFTER }, result: 'The file src/checkout/dates.ts has been updated.' },
        { name: 'Bash', input: { command: 'npm test -- checkout' }, result: ' ✓ test/checkout/dates.test.ts (6 tests) 14ms\n ✓ test/checkout/summary.test.ts (4 tests) 22ms\n\n Tests  10 passed (10)' },
        { name: 'Screenshot', input: { name: 'checkout-summary.png' }, result: 'The order summary now reads 15 Sep 2026 for both the order and the delivery date.', image: 'checkout.png' },
      ],
      after: 'Both dates on the summary now match. Running the checkout end-to-end tests before I hand it over.',
      running: { name: 'Bash', input: { command: 'npm run test:e2e -- checkout' } },
      files: { 'src/checkout/dates.ts': DATES_TS_AFTER },
      hold: true,
      progress: 'checkout dates go through date-fns; unit tests green, e2e running',
    },
  },
  {
    title: 'Add rate limiting to the public API',
    turn: {
      reply: 'Adding a token bucket in front of the public routes.',
      tools: [
        { name: 'Bash', input: { command: 'rg -n "router.use" src/api' }, result: 'src/api/server.ts:12:router.use(json())' },
        { name: 'Bash', input: { command: 'npm test -- api' }, result: 'Tests  18 passed (18)' },
      ],
      files: {
        'src/api/rate-limit.ts': lines(
          "import type { Request, Response, NextFunction } from 'express'",
          '',
          'const CAPACITY = 60',
          'const REFILL_PER_SECOND = 1',
          'const buckets = new Map<string, { tokens: number; at: number }>()',
          '',
          'export function rateLimit(req: Request, res: Response, next: NextFunction): void {',
          "  const key = req.ip ?? 'unknown'",
          '  const now = Date.now()',
          '  const bucket = buckets.get(key) ?? { tokens: CAPACITY, at: now }',
          '  bucket.tokens = Math.min(CAPACITY, bucket.tokens + ((now - bucket.at) / 1000) * REFILL_PER_SECOND)',
          '  bucket.at = now',
          '  if (bucket.tokens < 1) {',
          "    res.status(429).set('Retry-After', '1').end()",
          '    return',
          '  }',
          '  bucket.tokens -= 1',
          '  buckets.set(key, bucket)',
          '  next()',
          '}',
        ),
      },
      refs: 'XEZ:PR=124',
      hold: true,
      progress: 'token-bucket middleware for the public API',
      usage: { input: 29877, output: 1655 },
    },
  },
  {
    title: 'Write the release notes for 1.5.0',
    turn: { text: 'Reading the pull requests merged since v1.4.0.', tools: [{ name: 'Bash', input: { command: 'git log --oneline v1.4.0..HEAD' }, result: 'c41e2a9 feat(auth): cookie sessions\n7b09d13 feat(cart): cart total' }], hold: true },
  },
  {
    title: 'Refresh the README screenshots',
    turn: { text: 'Starting the dev server to take the screenshots.', tools: [{ name: 'Bash', input: { command: 'npm run build' }, result: 'built in 3.2s' }], hold: true },
  },
  {
    title: 'Add a "Remember me" option to the login form',
    turn: {
      text: 'Adding the checkbox to the login form and a longer session when it is ticked.',
      tools: [
        { name: 'Read', input: { file_path: 'src/auth/session.ts' }, result: 'export function readSession(req: Request): Session | undefined {' },
        { name: 'Edit', input: { file_path: 'src/auth/login-form.ts', old_string: '  <button type="submit">Log in</button>', new_string: '  <label><input type="checkbox" name="remember"> Remember me</label>\n  <button type="submit">Log in</button>' }, result: 'The file src/auth/login-form.ts has been updated.' },
        { name: 'Bash', input: { command: 'npm test -- auth' }, result: 'Tests  9 passed (9)' },
      ],
      reply: 'Added a "Remember me" checkbox. When it is ticked the session lasts 30 days instead of 7. Auth tests pass.',
      files: {
        'src/auth/login-form.ts': lines(
          'export function renderLoginForm(): string {',
          '  return `<form method="post" action="/login">',
          '  <input name="email" type="email" required>',
          '  <input name="password" type="password" required>',
          '  <label><input type="checkbox" name="remember"> Remember me</label>',
          '  <button type="submit">Log in</button>',
          '</form>`',
          '}',
          '',
          'export const SESSION_DAYS = { default: 7, remembered: 30 }',
        ),
      },
      progress: 'Remember me checkbox; 30-day session when ticked; auth tests green',
      usage: { input: 31460, output: 2210 },
    },
    followups: [],
  },
]

/** The scenario whose title the prompt carries, or a plain generic turn. */
export function scenarioFor(text) {
  return SCENARIOS.find((scenario) => text.includes(scenario.title))
}

export function followupFor(scenario, text) {
  return scenario?.followups?.find((followup) => text.includes(followup.match))
}

export const GENERIC_TURN = { reply: 'Done.', usage: { input: 1200, output: 90 } }

/** `--capture-root <dir>`: where the harness left the screenshot assets. */
export function captureRoot(argv) {
  const index = argv.indexOf('--capture-root')
  return index >= 0 ? argv[index + 1] : undefined
}

export function readAsset(argv, name) {
  const root = captureRoot(argv)
  if (!root) return undefined
  const path = join(root, 'assets', name)
  return existsSync(path) ? readFileSync(path).toString('base64') : undefined
}

/** Write the turn's real edits into the task's working directory. */
export function applyEdits(turn) {
  try {
    for (const [file, content] of Object.entries(turn.files ?? {})) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    for (const [file, head] of turn.prepend ?? []) {
      if (existsSync(file)) writeFileSync(file, head + readFileSync(file, 'utf8'), 'utf8')
    }
    for (const [file, from, to] of turn.replace ?? []) {
      if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').replace(from, to), 'utf8')
    }
  } catch {
    // a read-only working tree: the turn still plays, just without a diff
  }
}

/** One line under the handoff's "## Progress log", the way an agent following the rules would. */
export function logProgress(turn) {
  const file = process.env.XEZ_HANDOFF_FILE
  if (!file || !turn.progress) return
  try {
    const text = readFileSync(file, 'utf8')
    const line = `- ${new Date().toISOString()} — ${turn.progress}\n`
    const marker = '## Progress log\n'
    const at = text.indexOf(marker)
    writeFileSync(
      file,
      at >= 0 ? `${text.slice(0, at + marker.length)}\n${line}${text.slice(at + marker.length).replace(/^\n+/, '')}` : text + line,
      'utf8',
    )
  } catch {
    // no handoff file to write: the turn still plays
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
