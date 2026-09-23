import { cn } from '@/lib/utils'

/**
 * A 6 px usage bar (#867, designs/agent-quota OD-4): the step rail's `bg-muted` progress track,
 * grown so a fill is readable. Decorative — `aria-hidden`, and never alone: the number it draws is
 * always printed beside it, so the bar only lets an eye run down a column of them.
 *
 * Neutral fill; `pending` from 80 % and `danger` at 100 %. Those two tokens appear ONLY as fills
 * here, never as text (G-23).
 */
export function UsageBar({ usedPercent, className }: { usedPercent: number; className?: string }) {
  const clamped = Math.min(100, Math.max(0, usedPercent))
  const tone = usedPercent >= 100 ? 'danger' : usedPercent >= 80 ? 'pending' : 'neutral'
  return (
    <span
      data-slot="usage-bar"
      data-tone={tone}
      aria-hidden="true"
      className={cn('relative block h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      <span
        className={cn(
          'block h-full rounded-full',
          tone === 'danger' ? 'bg-danger' : tone === 'pending' ? 'bg-pending' : 'bg-muted-foreground',
        )}
        style={{ width: `${clamped}%` }}
      />
    </span>
  )
}
