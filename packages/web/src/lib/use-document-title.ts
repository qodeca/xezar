import { useEffect } from 'react'

/** The inputs of the browser-tab title. */
export interface DocumentTitleParts {
  /** The project on screen; null on pages that belong to no project. */
  projectName: string | null
  /** The page (or the open task's title); null when the page has no label of its own. */
  pageLabel: string | null
  /**
   * Tasks that need you across every project (workspace attention model). A positive count
   * leads the title as `(n) `, so a pinned or background tab shows that work is waiting without
   * being opened. Absent, null or 0 leaves the title unchanged.
   */
  attentionCount?: number | null
}

function titlePart(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * The browser-tab grammar, kept pure so loading and fallback states are exhaustive in tests.
 *
 * @param parts - Project name, page label and the optional attention count.
 * @returns The title, e.g. `"(2) web-app — Tasks · xezar"`.
 *
 * @example
 * ```ts
 * documentTitleOf({ projectName: 'web-app', pageLabel: 'Tasks' })                    // "web-app — Tasks · xezar"
 * documentTitleOf({ projectName: 'web-app', pageLabel: 'Tasks', attentionCount: 2 }) // "(2) web-app — Tasks · xezar"
 * ```
 */
export function documentTitleOf({ projectName, pageLabel, attentionCount }: DocumentTitleParts): string {
  const project = titlePart(projectName)
  const page = titlePart(pageLabel)

  let title = 'xezar'
  if (project && page) title = `${project} — ${page} · xezar`
  else if (project) title = `${project} · xezar`
  else if (page) title = `${page} · xezar`
  // The `(n)` prefix is the common browser-tab convention for "unread"; it comes first because a
  // narrow tab truncates from the end.
  return attentionCount && attentionCount > 0 ? `(${attentionCount}) ${title}` : title
}

/**
 * The cockpit's single runtime document-title writer.
 *
 * @param parts - See {@link DocumentTitleParts}.
 */
export function useDocumentTitle(parts: DocumentTitleParts): void {
  const title = documentTitleOf(parts)
  useEffect(() => {
    document.title = title
  }, [title])
}
