import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import {
  applyAppearance,
  normalizeAppearance,
  readStoredAppearance,
  writeStoredAppearance,
  type Accent,
  type Appearance,
  type Density,
  type Width,
} from '@/lib/appearance'

type AppearanceContextValue = {
  accent: Accent
  density: Density
  width: Width
  setAccent: (accent: Accent) => void
  setDensity: (density: Density) => void
  setWidth: (width: Width) => void
}

const AppearanceContext = React.createContext<AppearanceContextValue | null>(null)

/** Owns the accent + density preference (Settings → Appearance, R6 Step 1.3).
 *
 *  Boot order, mirroring the theme's no-flash contract:
 *   1. the pre-paint script in index.html stamped `data-accent`/`data-density` from the
 *      localStorage mirror before the bundle loaded;
 *   2. this provider seeds from the same mirror, so mounting never repaints;
 *   3. when `GET /api/workspace/ui-state` answers, the server value is authoritative — it is
 *      applied and mirrored, so the next cold load pre-paints the truth.
 *
 *  The store is the GLOBAL one (`~/.xezar/ui-state.json`) since the multi-project split
 *  (step 3.5, spec §"Settings split"): accent and density describe the person at the keyboard,
 *  not a repo, and this provider sits ABOVE the router — it has no project scope to write to
 *  in the first place. Migration 001 copied the pre-existing per-repo value up, so upgrading
 *  keeps whatever the boot project had; the per-repo key is left alone and simply ignored.
 *
 *  Writes go through `PUT /api/workspace/ui-state` with the FULL `appearance` object every
 *  time: the server merges ui-state shallowly (top-level keys), so a partial `{ accent }`
 *  would drop the stored density. On a failed write the last SERVER-CONFIRMED appearance is put
 *  back (control, root attribute and mirror) and the server truth is re-fetched — the control
 *  must not claim a persistence the file never got. The restore cannot be left to the refetch:
 *  an unchanged GET answer keeps the same `data` reference, so the "server wins" effect never
 *  re-runs (an older server refusing `roomy` is exactly that case). The value from before the
 *  click is not enough: with two saves in flight it is the first, equally unsaved choice.
 */
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const [appearance, setAppearanceState] = React.useState<Appearance>(readStoredAppearance)
  // Counts saves so a slow failure never undoes a newer click the user made meanwhile.
  const latestSave = React.useRef(0)
  // What a refused save falls back to: the server's last answer, or the boot mirror until one lands.
  const bootAppearance = React.useRef(appearance)

  // The server's word wins over the mirror — including "no appearance key" meaning defaults,
  // so wiping ui-state.json honestly resets every browser that visits.
  const serverAppearance = uiState.data
  React.useEffect(() => {
    if (serverAppearance === undefined) return
    const next = normalizeAppearance(serverAppearance.appearance)
    setAppearanceState(next)
    writeStoredAppearance(next)
  }, [serverAppearance])

  // Layout effect, not effect: the attributes must land before the browser paints the tree.
  React.useLayoutEffect(() => {
    applyAppearance(document.documentElement, appearance)
  }, [appearance])

  const save = React.useCallback(
    (next: Appearance) => {
      const saveId = ++latestSave.current
      setAppearanceState(next)
      writeStoredAppearance(next)
      putWorkspaceUiState({ appearance: next })
        .then((merged) => queryClient.setQueryData(workspaceQueryKeys.uiState, merged))
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          // Stop painting the unsaved choice, then fall back to the server's truth.
          if (saveId === latestSave.current) {
            const confirmed = queryClient.getQueryData<{ appearance?: unknown }>(workspaceQueryKeys.uiState)
            const restored = confirmed === undefined ? bootAppearance.current : normalizeAppearance(confirmed.appearance)
            setAppearanceState(restored)
            writeStoredAppearance(restored)
          }
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        })
    },
    [queryClient],
  )

  const setAccent = React.useCallback(
    (accent: Accent) => save({ ...appearance, accent }),
    [save, appearance],
  )
  const setDensity = React.useCallback(
    (density: Density) => save({ ...appearance, density }),
    [save, appearance],
  )
  const setWidth = React.useCallback(
    (width: Width) => save({ ...appearance, width }),
    [save, appearance],
  )

  const value = React.useMemo<AppearanceContextValue>(
    () => ({
      accent: appearance.accent,
      density: appearance.density,
      width: appearance.width,
      setAccent,
      setDensity,
      setWidth,
    }),
    [appearance, setAccent, setDensity, setWidth],
  )

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

export function useAppearance(): AppearanceContextValue {
  const context = React.useContext(AppearanceContext)
  if (!context) throw new Error('xezar: useAppearance() must be called inside <AppearanceProvider>')
  return context
}
