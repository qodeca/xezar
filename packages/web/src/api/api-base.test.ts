import { afterEach, describe, expect, it } from 'vitest'

import { resolveApiBase } from '@/api/api-base'

// Gap R11 (docs/testing/coverage-gaps.md § 5): the run-time meta tag over the build-time value,
// over same origin. This decides which service a separately hosted cockpit talks to.
describe('resolveApiBase', () => {
  afterEach(() => {
    document.head.querySelectorAll('meta[name="xez-api-base"]').forEach((node) => node.remove())
  })

  function setMeta(content: string | null) {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'xez-api-base')
    if (content !== null) meta.setAttribute('content', content)
    document.head.append(meta)
  }

  it('prefers the meta tag over the build-time value, trimmed', () => {
    setMeta('  https://run-time.example  ')
    expect(resolveApiBase(document, 'https://build-time.example')).toBe('https://run-time.example')
  })

  it('falls back to the build-time value when there is no meta tag', () => {
    expect(resolveApiBase(document, 'https://build-time.example')).toBe('https://build-time.example')
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['content-less', null],
  ])('treats an %s meta tag as absent', (_label, content) => {
    setMeta(content)
    expect(resolveApiBase(document, 'https://build-time.example')).toBe('https://build-time.example')
  })

  it('answers same origin (empty) when neither is set', () => {
    expect(resolveApiBase(document, undefined)).toBe('')
    expect(resolveApiBase(document, '')).toBe('')
  })

  it('reads the live document by default', () => {
    setMeta('https://default-document.example')
    expect(resolveApiBase()).toBe('https://default-document.example')
  })
})
