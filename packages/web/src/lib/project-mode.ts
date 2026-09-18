import type { Capabilities } from '@qodeca/xezar-api-client'

/**
 * The two capability keys that narrow the cockpit to one project (#600), and the ONE place their
 * meaning for the UI is decided.
 *
 * - `singleProject` is `XEZ_SINGLE_PROJECT=1`: one project, no project management, global state.
 * - `singleProjectRoot` is single-project mode: the folder owns its state (`<project>/.xezar`).
 *   Optional on the wire — a 0.15.0 server never sends it, and absent reads as `false`.
 *
 * Either one means the workspace cannot hold a second project, so every "switch or add a project"
 * affordance is absent. That answer must never be inferred from the registry's LENGTH: "the
 * registry happens to hold one row" and "this xezar cannot have a second project" agree most of
 * the time, which is exactly how one of them survives a refactor.
 */
export type ProjectModeCapabilities = Pick<Capabilities, 'singleProject' | 'singleProjectRoot'>

/** `true` when this cockpit serves one project and offers no way to add or switch to another. */
export function projectsLocked(capabilities: Partial<ProjectModeCapabilities> | null | undefined): boolean {
  return capabilities?.singleProject === true || capabilities?.singleProjectRoot === true
}

/**
 * `true` only on a definite answer that this cockpit serves a single-project root. `undefined`
 * (health not in yet, or an older server) is `false`: the mode badge must never guess.
 */
export function inSingleProjectRoot(capabilities: Partial<ProjectModeCapabilities> | null | undefined): boolean {
  return capabilities?.singleProjectRoot === true
}
