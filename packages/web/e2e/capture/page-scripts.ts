/**
 * Page-side scripts the harness evaluates right before every capture.
 *
 * `freezeJs` stops motion: pulsing status dots, spinners and shimmer would otherwise land on a
 * different frame each run, and the empty-state backdrops draw random lines on every mount. It also
 * hides the three overlays that only ever cover content: toasts, backdrops and the thread's jump pill.
 *
 * `normalizeJs` rewrites the few texts that are different on every run — relative ages,
 * durations, clock times, run ids, `xez/<id8>` branch suffixes, the throwaway workspace path —
 * to one fixed spelling each. That is the "timestamps you blank" half of the determinism promise:
 * it changes what a value SAYS, never which elements exist, so the layout is the real one.
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

export function normalizeJs(workspaceRoot: string, home: string): string {
  const variants = (path: string) => [path, path.replace(/^\/private/, '')]
  // The sandboxed HOME reads as `~`, and the fixture projects as if they lived in `~/code`.
  const pairs = [...variants(home).map((p) => [p, '~']), ...variants(workspaceRoot).map((p) => [p, '~/code'])]
  return `(() => {
  const pairs = ${JSON.stringify(pairs)}
  const rules = [
    [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '5f3a9c1e-2b7d-4e8a-9c6f-1d2e3f4a5b6c'],
    [/xez\\/[0-9a-f]{8}/g, 'xez/5f3a9c1e'],
    [/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z/g, '2026-09-15T09:30:00.000Z'],
    // One spelling for every age: a seeded task can read 59s in one run and 1m in the next.
    [/^\\d+(s|m|h|d)( ago)?$/, (_m, _unit, ago) => '4m' + (ago ?? '')],
    [/^(about |in )?(a few seconds|less than a minute|a minute|\\d+ (second|minute|hour|day)s?)( ago)?$/, '4 minutes ago'],
    [/^\\d+m \\d+s$/, '1m 12s'],
    [/^\\d+h \\d+m$/, '1h 4m'],
    [/\\b\\d{1,2}:\\d{2}(:\\d{2})?(\\s?[AP]M)?\\b/g, '09:30'],
  ]
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    let text = node.nodeValue ?? ''
    const before = text
    for (const [from, to] of pairs) text = text.split(from).join(to)
    const trimmed = text.trim()
    for (const [pattern, replacement] of rules) {
      if (pattern.global) {
        text = text.replace(pattern, replacement)
      } else if (pattern.test(trimmed)) {
        text = text.replace(trimmed, trimmed.replace(pattern, replacement))
      }
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
