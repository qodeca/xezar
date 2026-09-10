import type { Runner } from '@qodeca/xezar-api-client'
import { RUNNER_LABEL } from '@/lib/runner-label'
import { cn } from '@/lib/utils'

/**
 * "What ran this, and what model?" — the two cells the per-project and the cross-project tables
 * share, so the answer reads the same on both.
 *
 * Two presentation rules, and both are about honesty rather than decoration:
 *
 * 1. **Inherited reads muted.** A run record holds only what the caller ASKED for. No `runner`
 *    means nobody chose one and the project's `defaultRunner` applied; no `model` means the
 *    backend picked. Those resolve to a real value — hiding it would be less useful, not more —
 *    but they wear the soft foreground so a scan tells chosen from inherited without opening a row.
 * 2. **A model id is printed VERBATIM.** No catalog, no friendly name. Somebody running OpenCode
 *    against a model on their own hardware has to see exactly the string that run used.
 */
export function ToolNameCell({
  runner,
  inherited,
  backends = 0,
}: {
  runner: Runner
  /** No `runner` on the record — the project default applied and nobody chose this. */
  inherited: boolean
  /** Distinct backends the run's recorded STEPS used; >1 means the chain was mixed. */
  backends?: number
}) {
  const label = RUNNER_LABEL[runner]
  // A workflow can name a backend per step. When more than one actually ran, the task-level
  // runner alone would be a half-truth, so the extras are counted rather than listed: the cell is
  // ~120px, and "Claude Code, Codex, OpenCode" is not something anyone reads in a table.
  const extra = backends > 1 ? backends - 1 : 0
  const text = extra > 0 ? `${label} +${extra}` : label
  return (
    <span
      data-slot="task-tool"
      data-runner={runner}
      data-inherited={inherited || undefined}
      data-mixed={extra > 0 || undefined}
      title={
        extra > 0
          ? `${label} — this run's steps used ${backends} different backends`
          : inherited
            ? `${label} — the project default; this task did not choose one`
            : label
      }
      className={cn('block truncate text-[12.5px]', inherited ? 'text-soft-foreground' : 'text-muted-foreground')}
    >
      {text}
    </span>
  )
}

/** The model string the run actually used — verbatim, or a muted `auto` when none was recorded. */
export function ModelNameCell({ model }: { model?: string }) {
  const auto = model === undefined || model === ''
  const text = auto ? 'auto' : model
  return (
    <span
      data-slot="task-model"
      data-inherited={auto || undefined}
      title={auto ? 'auto — no model was recorded; the backend picked one' : text}
      className={cn('block truncate font-mono text-[11.5px]', auto ? 'text-soft-foreground' : 'text-muted-foreground')}
    >
      {text}
    </span>
  )
}
