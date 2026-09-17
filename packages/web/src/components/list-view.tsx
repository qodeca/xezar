import * as React from 'react'
import type { ReactNode } from 'react'

import type { ListView } from '@/lib/task-groups'

/**
 * The Active/Archived filter, shared by the per-project Tasks table and the global Tasks page.
 *
 * The two pages are different routes, so a `useState` in either would reset the filter every time
 * the user walks from one to the other — two answers to one question. Context above the routes
 * keeps it one value. (The sidebar quick-list was the first reader of this state; the sidebar has
 * listed no tasks since #546.)
 *
 * In-memory, not persisted: the legacy filter reset to Active on every reload, and a filter that
 * silently survives a restart hides runs the user does not know are hidden.
 */
const ListViewContext = React.createContext<[ListView, (view: ListView) => void] | null>(null)

export function ListViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = React.useState<ListView>('active')
  // The tuple is memoized so a re-render of the provider (which sits high in the tree) does not
  // invalidate the context for every consumer below it.
  const value = React.useMemo(() => [view, setView] as [ListView, (view: ListView) => void], [view])
  return <ListViewContext.Provider value={value}>{children}</ListViewContext.Provider>
}

/** Throws without a provider, on purpose: a default would let a consumer mount outside the shell
 *  and quietly keep its own private filter — the exact desync this context exists to prevent. */
export function useListView(): [ListView, (view: ListView) => void] {
  const value = React.useContext(ListViewContext)
  if (!value) throw new Error('useListView must be used inside a <ListViewProvider>')
  return value
}
