import { useId } from 'react'

import { useHealth } from '@/api/queries'
import { nativeFieldClass } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * The workspace settings a hosted cockpit may not change: the browse folder, the checkout folder,
 * the extra variables agents receive and the instance mode. The server refuses them with a 409 in
 * hosted mode, so these screens do not offer them as editable there (nor before health answers). Each shows its current value
 * in a read-only field (focusable and readable, never faded) with the reason on screen as the
 * field's description — not a tooltip, and no Save button.
 */
export const HOSTED_LOCKED_REASON = 'Changed on the machine that runs xezar — this cockpit runs in hosted mode.'

/** Whether these settings are editable here: `hosted` once health says so, `local` once it says
 *  otherwise (or cannot answer – the server still refuses a hosted change), and `pending` before
 *  it has answered, so no editable field flashes up on a hosted cockpit. */
export type HostedSettingsLock = 'hosted' | 'local' | 'pending'

export function useHostedSettingsLock(): HostedSettingsLock {
  const health = useHealth()
  if (health.data === undefined) return health.isError ? 'local' : 'pending'
  return health.data.capabilities?.localHandoff === false ? 'hosted' : 'local'
}

export function HostedLockedValue({
  label,
  value,
  slot,
  mono = true,
  pending = false,
}: {
  label: string
  value: string
  slot: string
  mono?: boolean
  /** Health has not answered yet: show the value read-only, without a reason it cannot vouch for. */
  pending?: boolean
}) {
  const reasonId = useId()
  return (
    <div data-slot={slot} className="flex flex-col gap-1">
      {/* A read-only textarea rather than an input: a long folder path WRAPS (anywhere, since a
          path has few spaces) instead of being cut off on a phone, and the whole value stays
          readable and focusable. `field-sizing-content` grows it to its text. */}
      <textarea
        readOnly
        rows={1}
        aria-label={label}
        aria-describedby={pending ? undefined : reasonId}
        data-slot={`${slot}-value`}
        value={value}
        className={cn(
          nativeFieldClass,
          'block h-auto max-w-sm cursor-default resize-none bg-muted/40 py-1.5 field-sizing-content',
          mono && 'font-mono break-all',
        )}
      />
      {pending ? null : (
        <p id={reasonId} data-slot={`${slot}-reason`} className="text-[11px] text-soft-foreground">
          {HOSTED_LOCKED_REASON}
        </p>
      )}
    </div>
  )
}
