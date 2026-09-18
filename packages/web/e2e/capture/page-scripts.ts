/**
 * Page-side scripts the harness evaluates right before every capture.
 *
 * `freezeJs` stops motion: pulsing status dots, spinners and shimmer would otherwise land on a
 * different frame each run, and the empty-state backdrops draw random lines on every mount. It also
 * hides the three overlays that only ever cover content: toasts, backdrops and the thread's jump pill.
 *
 * `normalizeJs` rewrites the texts that differ on every run to fixed values — relative ages,
 * clock times, ISO timestamps, run ids, `xez/<id8>` branch suffixes, the throwaway workspace path —
 * and the few identifiers that only exist because the forge runs in dry-run mode (its fake
 * `mock/repo`, its author `mock`, its fake PR URL and its `mock (…)` agent version). Given a
 * `VersionRewrite`, it also pins the footer's version chip to the docs version instead of the
 * pre-release build's own. It changes what a value SAYS, never which elements exist, so the
 * layout is the real one.
 *
 * Per-task values stay per task: each seeded run has its own branch suffix and age (`looks`), so a
 * list of tasks never reads as clones.
 */

export const freezeJs = `(() => {
  let style = document.getElementById('xezar-capture-freeze')
  if (!style) {
    style = document.createElement('style')
    style.id = 'xezar-capture-freeze'
    document.head.appendChild(style)
  }
  style.textContent = [
    '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
    '[data-slot="ghost-code-backdrop"], [data-slot="twinkle-backdrop"], [data-slot="toaster"] { visibility: hidden !important; }',
    // The thread's floating "Jump to latest" pill appears whenever a shot scrolls to something
    // above the newest item, and then covers the content the shot scrolled to.
    '[data-slot="jump-to-latest"] { visibility: hidden !important; }',
    '::-webkit-scrollbar { display: none !important; }',
  ].join('\\n')
  return true
})()`

export interface RunLook {
  /** The fixed `xez/<id8>` suffix and id prefix this run shows. */
  id8: string
  /** The fixed compact age this run shows (`9m`). */
  age: string
}

/** GitHub handles for the dry-run forge's fixed catalog, by issue or PR number. */
const AUTHORS: Record<string, string> = {
  '142': 'dana-okafor',
  '139': 'lee-park',
  '135': 'sam-rivera',
  '128': 'ada-lovelace',
  '124': 'noor-haddad',
}

export interface VersionRewrite {
  /** The version the running build actually reports (`package.json`'s `version`). */
  build: string
  /** The version these docs describe — the chip is pinned to this instead. */
  docs: string
}

export function normalizeJs(
  workspaceRoot: string,
  home: string,
  looks: Record<string, RunLook> = {},
  version?: VersionRewrite,
): string {
  const variants = (path: string) => [path, path.replace(/^\/private/, '')]
  // The sandboxed HOME reads as `~`, and the fixture projects as if they lived in `~/code`.
  const pairs = [
    ...variants(home).map((p) => [p, '~']),
    ...variants(workspaceRoot).map((p) => [p, '~/code']),
    // The dry-run forge's stand-ins, as the fixture repository's own GitHub remote would read.
    // The URL matches `createDraftPr`'s own dry-run stand-in (packages/xezar/src/server/forge/github.ts).
    ['https://github.com/example-org/example-project/pull/777', 'https://github.com/acme/demo-shop/pull/152'],
    [' (dry run — no real PR)', ''],
    ['mock/repo', 'acme/demo-shop'],
    // The footer's version chip: pinned to the docs version, not the pre-release build's own.
    // The bare number, not `v${…}` — `v{version}` is two JSX children, so React renders it as
    // two separate text nodes ("v" and "0.15.0"), and a `pairs` entry only ever sees one node.
    ...(version ? [[version.build, version.docs]] : []),
  ]
  return `(() => {
  const pairs = ${JSON.stringify(pairs)}
  const looks = ${JSON.stringify(looks)}
  const authors = ${JSON.stringify(AUTHORS)}
  const LONG = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }
  const longAge = (age) => {
    const [, n, unit] = /^(\\d+)([smhd])$/.exec(age) ?? [, '4', 'm']
    return n + ' ' + (n === '1' ? LONG[unit].slice(0, -1) : LONG[unit]) + ' ago'
  }
  const byId8 = Object.fromEntries(Object.entries(looks).map(([id, look]) => [id.slice(0, 8), look]))
  const lookFor = (node) => {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const id = el.getAttribute('data-run-id') ?? /\\/(?:tasks|runs)\\/([0-9a-f-]{36})/.exec(el.getAttribute('href') ?? '')?.[1]
      if (id && looks[id]) return looks[id]
    }
    const fromUrl = /\\/tasks\\/([0-9a-f-]{36})/.exec(location.pathname)?.[1]
    return fromUrl ? looks[fromUrl] : undefined
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)

  // ISO timestamps keep their order but not their value: the i-th distinct instant on the page
  // reads 08:40 plus i × 3 minutes.
  const ISO = /\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z/g
  const instants = [...new Set(nodes.flatMap((node) => (node.nodeValue ?? '').match(ISO) ?? []))].sort()
  const isoFor = (iso) => new Date(Date.UTC(2026, 8, 15, 8, 40) + instants.indexOf(iso) * 180000).toISOString().replace('.000Z', 'Z')

  for (const node of nodes) {
    let text = node.nodeValue ?? ''
    const before = text
    for (const [from, to] of pairs) text = text.split(from).join(to)
    text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => (looks[id]?.id8 ?? lookFor(node)?.id8 ?? '5f3a9c1e') + '-2b7d-4e8a-9c6f-1d2e3f4a5b6c')
    text = text.replace(/xez\\/([0-9a-f]{8})/g, (_m, id8) => 'xez/' + (byId8[id8]?.id8 ?? lookFor(node)?.id8 ?? '5f3a9c1e'))
    text = text.replace(ISO, isoFor)
    // A clock time on its own, never the time inside an ISO timestamp.
    text = text.replace(/(?<![T\\d:.])\\b\\d{1,2}:\\d{2}(:\\d{2})?(\\s?[AP]M)?\\b/g, '09:30')
    const trimmed = text.trim()
    if (/^\\d+(s|m|h|d)( ago)?$/.test(trimmed)) {
      const age = lookFor(node)?.age ?? '4m'
      text = text.replace(trimmed, trimmed.endsWith(' ago') ? age + ' ago' : age)
    } else if (/^(about |in )?(a few seconds|less than a minute|a minute|\\d+ (second|minute|hour|day)s?)( ago)?$/.test(trimmed)) {
      text = text.replace(trimmed, longAge(lookFor(node)?.age ?? '4m'))
    } else if (/^\\d+m \\d+s$/.test(trimmed)) {
      text = text.replace(trimmed, '1m 12s')
    } else if (/^\\d+h \\d+m$/.test(trimmed)) {
      text = text.replace(trimmed, '1h 4m')
    } else if (trimmed === '#777') {
      text = text.replace(trimmed, '#152')
    } else if (trimmed === 'mock') {
      // The dry-run forge's author, as the person who opened that issue or pull request.
      const row = node.parentElement?.closest('[data-number]')?.getAttribute('data-number')
      const open = /\\/(?:issues|pulls?|prs)\\/(\\d+)/.exec(location.pathname)?.[1]
      text = text.replace(trimmed, authors[row ?? open ?? ''] ?? 'ada-lovelace')
    }
    // The version backend detection reports for a mocked agent: \`mock (<the dry-run flag>=1)\`.
    if (/mock \\(XEZ_\\w+=1\\)/.test(text)) {
      const provider = node.parentElement?.closest('[data-provider]')?.getAttribute('data-provider') ?? ''
      text = text.replace(/mock \\(XEZ_\\w+=1\\)/, provider === 'pi' ? '0.72.1' : '2.1.148 (Claude Code)')
    }
    if (text !== before) node.nodeValue = text
  }
  for (const time of document.querySelectorAll('time')) time.textContent = 'Sep 15, 09:30'
  for (const cell of document.querySelectorAll('td[data-usage]')) cell.textContent = '—'
  for (const input of document.querySelectorAll('input, textarea')) {
    for (const [from, to] of pairs) {
      if (input.value.includes(from)) input.value = input.value.split(from).join(to)
    }
  }
  return true
})()`
}
