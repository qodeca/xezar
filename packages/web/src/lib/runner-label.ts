import type { Runner } from '@qodeca/xezar-api-client'

/**
 * The product name behind each backend id — ONE definition for the whole cockpit.
 *
 * Typed `Record<Runner, string>` against the contract's runner enum rather than a loose string
 * record on purpose: a fifth backend added to `runnerSchema` is then a compile error here instead
 * of a surface that quietly prints nothing. That is the whole reason this file exists — the same
 * four pairs had been copied into five components, and a new backend would have had to be
 * remembered in all five.
 *
 * The composer's runner pill deliberately does NOT use this: it shows the raw id because the id is
 * what the user is choosing and what the run record will store.
 */
export const RUNNER_LABEL: Record<Runner, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'pi',
}

/** The product name for one runner id. */
export function runnerLabel(runner: Runner): string {
  return RUNNER_LABEL[runner]
}

/**
 * How many DISTINCT backends a run's recorded steps used.
 *
 * A workflow may name a different backend per step, so the task-level `runner` is not the whole
 * truth. Steps that never ran recorded no backend and are simply not counted — an absent backend
 * is "nothing happened here", never a second one.
 *
 * The server derives the same number for the cross-project index (`RunIndexEntry.stepBackends`),
 * which carries no `steps[]` by design; keep the two rules identical.
 */
export function stepBackendCount(steps: readonly { backend?: Runner }[]): number {
  const seen = new Set<Runner>()
  for (const step of steps) if (step.backend) seen.add(step.backend)
  return seen.size
}

/**
 * The runner a task actually ran as, and whether anybody chose it.
 *
 * Mirrors the server's own resolution (`input.runner ?? config.defaultRunner`, `workflows/run.ts`)
 * and the run header's `AgentBadge`. `inherited` is the interesting half: the record holds only
 * what the caller ASKED for, so an absent `runner` means the task simply followed the project —
 * which the tables show muted rather than as a choice somebody made.
 */
export function taskRunner(
  recorded: Runner | undefined,
  projectDefault: Runner | undefined,
): { runner: Runner; inherited: boolean } {
  if (recorded) return { runner: recorded, inherited: false }
  // 'claude' is the last resort only while the project's config is in flight — the same fallback
  // the run header uses, and the same default `config.defaultRunner` itself carries.
  return { runner: projectDefault ?? 'claude', inherited: true }
}
