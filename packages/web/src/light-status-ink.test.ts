import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * G-23, the status-ink half: `--success`, `--danger` and `--violet` colour 10–13px text
 * (`text-success`, `text-danger`, `text-violet`) as well as dots and fills. In the light theme each
 * must clear WCAG AA's 4.5:1 on every light surface it prints on – white, the card/sidebar tints,
 * `--muted` and its own 15% tint over white (`bg-success/15 text-success` and kin) – and the ink
 * printed on the fill must clear 4.5:1 on it too. The dark theme keeps its designed values.
 */

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles', 'index.css'), 'utf8')

/** The declarations of one selector block; none of the token blocks nests braces. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

function token(source: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, 'i').exec(source)?.[1]?.toLowerCase()
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** `color` at `alpha` composited over `ground`, as a Tailwind `/15` tint renders. */
function tint(color: string, alpha: number, ground: string): string {
  const c = channels(color)
  const g = channels(ground)
  return `#${c.map((v, i) => Math.round(v * alpha + g[i]! * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

const light = block('.light')
const dark = block(':root')

describe('status ink in the light theme (G-23)', () => {
  const surfaces = ['background', 'card', 'card-2', 'sidebar', 'muted'].map((name) => {
    const value = token(light, name)
    expect(value, `light --${name}`).toBeDefined()
    return [name, value!] as const
  })

  it.each(['success', 'danger', 'violet'])('--%s clears 4.5:1 on every light surface and its own tint', (name) => {
    const ink = token(light, name)
    expect(ink, `light --${name} override`).toBeDefined()
    for (const [surface, ground] of surfaces) {
      expect(contrast(ink!, ground), `--${name} on --${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(ink!, tint(ink!, 0.15, '#ffffff')), `--${name} on its 15% tint`).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['danger-ink', 'danger'],
    ['violet-foreground', 'violet'],
  ])('--%s reads on the light --%s fill', (ink, fill) => {
    const inkValue = token(light, ink)
    const fillValue = token(light, fill)
    expect(inkValue, `light --${ink}`).toBeDefined()
    expect(contrast(inkValue!, fillValue!)).toBeGreaterThanOrEqual(4.5)
  })

  it('the dark theme keeps its designed status values', () => {
    expect(token(dark, 'success')).toBe('#10b981')
    expect(token(dark, 'danger')).toBe('#ef4444')
    expect(token(dark, 'danger-ink')).toBe('#0d0d0d')
    expect(token(dark, 'violet')).toBe('#8f86e8')
    expect(token(dark, 'violet-foreground')).toBe('#0d0d0d')
  })
})
