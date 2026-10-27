import { afterEach, describe, expect, it } from 'vitest'

import { requireRootContainer } from '@/root-container'

// Gap R11 (docs/testing/coverage-gaps.md § 5): the boot refuses to render into nothing.
describe('requireRootContainer', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns the #root element', () => {
    document.body.innerHTML = '<div id="root"></div>'
    expect(requireRootContainer()).toBe(document.getElementById('root'))
  })

  it('throws a named error when index.html has no #root', () => {
    expect(() => requireRootContainer()).toThrow('xezar: #root container is missing from index.html')
  })
})
