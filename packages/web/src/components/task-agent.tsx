import type { Runner } from '@qodeca/xezar-api-client'
import { modelLabel, runnerLabel } from '@/lib/runner-label'
import { cn } from '@/lib/utils'

/**
 * "What ran this, and what model?" — the two cells the per-project and the cross-project tables
 * share, so the answer reads the same on both.
 *
 * The TEXT rules live in `lib/runner-label.ts`, not here: the phone card renders the same two
 * facts as plain spans on its `font-mono` meta line and cannot host these components. Keeping the
 * rules in one pure module is what stops `Claude Code +1` and `auto` from drifting between them.
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
  const text = runnerLabel(runner, backends)
  const mixed = backends > 1
  return (
    <span
      data-slot="task-tool"
      data-runner={runner}
      data-inherited={inherited || undefined}
      data-mixed={mixed || undefined}
      // Only when it ADDS something. A tooltip that repeats the visible text on every row is
      // noise, and the inherited wording deliberately does not say "the project default": the
      // per-project table resolves that from a `GET /config` that may still be in flight, and a
      // claim about the project is not one this cell may make before the project has answered.
      title={
        mixed
          ? `${text} — this run's steps used ${backends} different backends`
          : inherited
            ? `${text} — inherited; this task did not choose a runner`
            : undefined
      }
      className={cn('block truncate text-[12.5px]', inherited ? 'text-soft-foreground' : 'text-muted-foreground')}
    >
      {text}
    </span>
  )
}

/** The model string the run actually used — verbatim, or a muted `auto` when none was recorded. */
export function ModelNameCell({ model }: { model?: string }) {
  const { text, auto } = modelLabel(model)
  return (
    <span
      data-slot="task-model"
      data-inherited={auto || undefined}
      // Always set: a model id is the one value in these tables long enough to truncate, so the
      // full string has to stay recoverable.
      title={auto ? 'auto — no model was recorded; the backend picked one' : text}
      className={cn('block truncate font-mono text-[11.5px]', auto ? 'text-soft-foreground' : 'text-muted-foreground')}
    >
      {text}
    </span>
  )
}
