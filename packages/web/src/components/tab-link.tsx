import type { ReactNode } from 'react'

import { Link } from '@/lib/project-router'

import { cn } from '@/lib/utils'

/** One underline tab (mockup `.tab`) — the segment grammar the run header's
 *  Session | Changes | Files row uses, extracted (R5 1.7) so the repo view's
 *  Changes | Commits | Branches row is the same component rather than a fork.
 *  A real `<Link>` on purpose: every segment is a URL (spec §"Routing"). */
export function TabLink({
  to,
  active = false,
  onClick,
  children,
}: {
  to: string
  active?: boolean
  /** Fires alongside the navigation (e.g. persisting the choice, #417) — it does not
   *  intercept it; `<Link>` still navigates unless the handler itself prevents it. */
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        // `min-h-tap … md:min-h-0`: a 44 px phone target at every density (#453 Q24); `h-8` is
        // the desktop row.
        '-mb-px flex h-8 min-h-tap min-w-tap items-center justify-center rounded-t-md border-b-2 px-3 text-[13px] font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0 md:min-w-0',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}
