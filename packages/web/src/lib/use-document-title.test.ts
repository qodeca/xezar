import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  documentTitleOf,
  type DocumentTitleParts,
  useDocumentTitle,
} from './use-document-title'

describe('documentTitleOf', () => {
  it.each([
    {
      name: 'project and page',
      projectName: 'Storefront',
      pageLabel: 'Tasks',
      expected: 'Storefront — Tasks · xezar',
    },
    {
      name: 'project only',
      projectName: 'Storefront',
      pageLabel: null,
      expected: 'Storefront · xezar',
    },
    {
      name: 'page only',
      projectName: null,
      pageLabel: 'Settings',
      expected: 'Settings · xezar',
    },
    { name: 'neither part', projectName: null, pageLabel: null, expected: 'xezar' },
    { name: 'empty project', projectName: '', pageLabel: 'Tasks', expected: 'Tasks · xezar' },
    { name: 'blank parts', projectName: '  ', pageLabel: '\t', expected: 'xezar' },
  ])('formats $name', ({ projectName, pageLabel, expected }) => {
    expect(documentTitleOf({ projectName, pageLabel })).toBe(expected)
  })
})

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'xezar'
  })

  it('updates the existing writer when its truthful inputs change', () => {
    const initialProps: DocumentTitleParts = {
      projectName: 'Storefront',
      pageLabel: 'Tasks',
    }
    const { rerender } = renderHook(
      (parts: DocumentTitleParts) => useDocumentTitle(parts),
      { initialProps },
    )

    expect(document.title).toBe('Storefront — Tasks · xezar')
    rerender({ projectName: 'Back office', pageLabel: null })
    expect(document.title).toBe('Back office · xezar')
  })
})
