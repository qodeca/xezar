import { useId } from 'react'

import { useHealth } from '@/api/queries'
import { nativeFieldClass } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * The workspace settings a hosted cockpit may not change: the browse folder, the checkout folder,
 * the extra variables agents receive and the instance mode. The server refuses them with a 409 in
 * hosted mode, so these screens do not offer them as editable there. Each shows its current value
 * in a read-only field (focusable and readable, never faded) with the reason on screen as the
 * field's description — not a tooltip, and no Save button.
 */
export const HOSTED_LOCKED_REASON = 'Set on the machine that runs xezar – remote changes are turned off.'

/** True only when health says this cockpit runs in hosted mode. Unknown reads as local: the
 *  server still refuses a hosted change, so the brief window before health answers costs nothing. */
export function useHostedSettingsLocked(): boolean {
  return useHealth().data?.capabilities?.localHandoff === false
}

export function HostedLockedValue({
  label,
  value,
  slot,
  mono = true,
}: {
  label: string
  value: string
  slot: string
  mono?: boolean
}) {
  const reasonId = useId()
  return (
    <div data-slot={slot} className="flex flex-col gap-1">
      <input
        type="text"
        readOnly
        aria-label={label}
        aria-describedby={reasonId}
        data-slot={`${slot}-value`}
        value={value}
        className={cn(nativeFieldClass, 'block max-w-sm cursor-default bg-muted/40', mono && 'font-mono')}
      />
      <p id={reasonId} data-slot={`${slot}-reason`} className="text-[11px] text-soft-foreground">
        {HOSTED_LOCKED_REASON}
      </p>
    </div>
  )
}
