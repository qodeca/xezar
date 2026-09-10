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

/**
 * The exact text the Tool Name cell shows — product name, plus a marker when the run's steps used
 * more than one backend.
 *
 * A function rather than JSX because two surfaces render it: the desktop cell and the phone card's
 * meta line, which is a plain `<span>` on a `font-mono` row and cannot host the cell component.
 * They HAD drifted once already; one rule is what keeps `Claude Code +1` identical on both.
 */
export function runnerLabel(runner: Runner, backends = 0): string {
  const extra = backends > 1 ? backends - 1 : 0
  return extra > 0 ? `${RUNNER_LABEL[runner]} +${extra}` : RUNNER_LABEL[runner]
}

/**
 * The model text, and whether it is a value or a stand-in.
 *
 * `''` counts as absent: the contract permits it (`model` has no `.min(1)`), and the composer's
 * own auto sentinel IS the empty string, so a blank cell would be the one case where "the backend
 * picked" rendered as nothing at all. `auto` is the word the task detail header already prints.
 */
export function modelLabel(model: string | undefined): { text: string; auto: boolean } {
  return model ? { text: model, auto: false } : { text: 'auto', auto: true }
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
 * The runner a task ran as, in order of how good the evidence is.
 *
 * 1. **`RunRecord.runner`.** Not "what the caller asked for" — `execute` writes the RESOLVED
 *    backend onto the record the moment a run starts (`workflows/run.ts`), so for any run that
 *    ever began this is a fact about what happened.
 * 2. **The last step that recorded a backend.** Steps stamp theirs at spawn, so a record written
 *    before run-level backend affinity existed still says what it used. Resolving one of those
 *    against today's `defaultRunner` could name a backend the run never touched.
 * 3. **The project's current default** — and ONLY then is the answer `inherited`. A run with no
 *    evidence at all has not started yet, so this is not history; it is what the task WOULD run
 *    as. That is exactly the claim the tables mute: a value nobody has chosen yet.
 *
 * The server applies the identical order when it builds the cross-project index, which carries no
 * `steps[]` and so must resolve it there. Keep the two the same.
 */
export function taskRunner(
  recorded: Runner | undefined,
  steps: readonly { backend?: Runner }[],
  projectDefault: Runner | undefined,
): { runner: Runner; inherited: boolean } {
  if (recorded) return { runner: recorded, inherited: false }
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const backend = steps[index]?.backend
    if (backend) return { runner: backend, inherited: false }
  }
  // 'claude' is the last resort only while the project's config is in flight — the same fallback
  // the run header uses, and the same default `config.defaultRunner` itself carries.
  return { runner: projectDefault ?? 'claude', inherited: true }
}
