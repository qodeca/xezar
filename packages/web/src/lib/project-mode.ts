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
export type ProjectModeCapabilities = Pick<
  Capabilities,
  'singleProject' | 'singleProjectRoot' | 'instanceMode'
>

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

/**
 * `true` when this cockpit serves the project it started in and the other registered projects are
 * reachable only through their OWN cockpit — `--instance project` (#467, PR 4).
 *
 * A THIRD predicate, deliberately not folded into `projectsLocked`, and the comment above says
 * why in general: two questions must not share one answer. Here they are concretely different —
 * `projectsLocked` asks "can this workspace hold a second project?" and the answer in this mode is
 * YES. Every registered project stays listed and stays manageable (add, clone, remove all keep
 * working), which is the whole difference between this mode and `XEZ_SINGLE_PROJECT`, and
 * `BACKWARD_COMPATIBILITY.md` § Instance mode calls hiding one or refusing project management a
 * BREAK. What this predicate asks instead is "does a row for another project LINK OUT, or open in
 * place?" — and only the link-out surfaces (the sidebar's Other projects group, the palette's
 * Projects group, the global Tasks note) ever ask it.
 *
 * `undefined` reads as `workspace`, which is both the default and what every xezar before 0.17.0
 * did: the key is optional on the wire and is sent ONLY for `project` (`contract/src/health.ts`),
 * so an absent answer must never be guessed into a link-out.
 */
export function linksOutToOtherProjects(
  capabilities: Partial<ProjectModeCapabilities> | null | undefined,
): boolean {
  return capabilities?.instanceMode === 'project'
}
