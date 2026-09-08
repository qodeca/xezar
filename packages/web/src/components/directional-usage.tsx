import { compactTokens } from '@/lib/format'
import { cn } from '@/lib/utils'

interface DirectionalUsageProps {
  inputTokens?: number
  outputTokens?: number
  /** The legacy combined counter (`RunRecord.tokensUsed`). Runs recorded before the split
   *  counters landed (#737) carry only this, and BACKWARD_COMPATIBILITY.md keeps them valid:
   *  show the total they do know rather than a `— / —` that reads as "nothing was spent". */
  totalTokens?: number
  /** Compact prose (`IN … · OUT …`) or the desktop table's denser (`… / …`) form. */
  variant?: 'compact' | 'table'
  /** Historical compact surfaces disappear when neither direction was persisted. */
  omitWhenUnknown?: boolean
  /** Whether a total-only value spells its unit out. Defaults to the variant: prose carries
   *  `3.6k tokens`, a dense cell or subtitle carries the bare `3.6k` its column already names. */
  totalUnit?: boolean
  className?: string
}

function exactTokens(value: number | undefined): string {
  return value === undefined ? 'unknown' : new Intl.NumberFormat().format(value)
}

export function directionalUsageLabel(inputTokens?: number, outputTokens?: number): string {
  return `Input tokens: ${exactTokens(inputTokens)}; output tokens: ${exactTokens(outputTokens)}`
}

/**
 * The one rendering for a run that knows its TOTAL and nothing more — every run recorded
 * before #737 split the counter. Deliberately not routed through the directional form: an
 * `IN 3.6k · OUT —` would claim the whole total was input, which the record never said.
 */
export function totalUsageText(totalTokens: number, withUnit: boolean): string {
  const value = compactTokens(totalTokens)
  return withUnit ? `${value} tokens` : value
}

export function totalUsageLabel(totalTokens: number): string {
  return `Total tokens: ${exactTokens(totalTokens)}; input/output split not recorded`
}

export function directionalUsageText(
  inputTokens?: number,
  outputTokens?: number,
  variant: 'compact' | 'table' = 'compact',
): string {
  const input = inputTokens === undefined ? '—' : compactTokens(inputTokens)
  const output = outputTokens === undefined ? '—' : compactTokens(outputTokens)
  return variant === 'table' ? `${input} / ${output}` : `IN ${input} · OUT ${output}`
}

/** One honest input/output rendering shared by header, table, cards, quick lists, and variants. */
export function DirectionalUsage({
  inputTokens,
  outputTokens,
  totalTokens,
  variant = 'compact',
  omitWhenUnknown = true,
  totalUnit,
  className,
}: DirectionalUsageProps) {
  const directionless = inputTokens === undefined && outputTokens === undefined
  if (directionless && totalTokens !== undefined) {
    return (
      <span
        data-slot="directional-usage"
        data-usage="total"
        aria-label={totalUsageLabel(totalTokens)}
        className={cn('font-mono tabular-nums', className)}
      >
        {totalUsageText(totalTokens, totalUnit ?? variant === 'compact')}
      </span>
    )
  }
  if (omitWhenUnknown && directionless) return null

  return (
    <span
      data-slot="directional-usage"
      aria-label={directionalUsageLabel(inputTokens, outputTokens)}
      className={cn('font-mono tabular-nums', className)}
    >
      {directionalUsageText(inputTokens, outputTokens, variant)}
    </span>
  )
}
