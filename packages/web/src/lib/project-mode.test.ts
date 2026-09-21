import { describe, expect, it } from 'vitest'

import {
  inSingleProjectRoot,
  linksOutToOtherProjects,
  projectsLocked,
} from '@/lib/project-mode'

/**
 * Three predicates, three questions, and the whole point of this file is that they stay three
 * (#467, PR 4).
 *
 * The named break is `BREAK-467-PROJECTSLOCKED-WIDENED`: folding `instanceMode === 'project'` into
 * `projectsLocked`. It is the tempting refactor — all three are "this cockpit is narrower than the
 * default" — and it silently turns `project` mode into `XEZ_SINGLE_PROJECT`, which
 * `BACKWARD_COMPATIBILITY.md` § Instance mode calls a BREAK: the Add project menu disappears, the
 * palette's Projects group disappears, and every other registered project goes with them.
 */

describe('projectsLocked — can this workspace hold a second project?', () => {
  it.each([
    ['nothing known yet', undefined, false],
    ['a plain multi-project cockpit', {}, false],
    ['XEZ_SINGLE_PROJECT=1', { singleProject: true }, true],
    ['single-project root mode', { singleProjectRoot: true }, true],
    ['both narrowings', { singleProject: true, singleProjectRoot: true }, true],
  ])('%s → %s', (_name, capabilities, expected) => {
    expect(projectsLocked(capabilities)).toBe(expected)
  })

  /**
   * The break, stated as the assertion it fails: `project` mode keeps add, clone and remove, so
   * this predicate must keep answering `false` for it. `app-shell-container.test.tsx` pins the
   * same fact through the rendered Add project control.
   */
  it('stays FALSE in --instance project, whose projects are all still manageable', () => {
    expect(projectsLocked({ instanceMode: 'project' })).toBe(false)
    expect(projectsLocked({ instanceMode: 'workspace' })).toBe(false)
  })

  it('still answers true when a narrowing and project mode are both in force', () => {
    // A narrowed cockpit never sends `instanceMode` at all (the server's own rule), but a client
    // must not depend on that to stay narrow.
    expect(projectsLocked({ singleProject: true, instanceMode: 'project' })).toBe(true)
  })
})

describe('inSingleProjectRoot — does this folder own its state?', () => {
  it.each([
    ['unknown', undefined, false],
    ['root mode', { singleProjectRoot: true }, true],
    ['the other narrowing', { singleProject: true }, false],
    ['project mode', { instanceMode: 'project' as const }, false],
  ])('%s → %s', (_name, capabilities, expected) => {
    expect(inSingleProjectRoot(capabilities)).toBe(expected)
  })
})

describe('linksOutToOtherProjects — does a row for another project link out?', () => {
  it.each([
    ['project mode', { instanceMode: 'project' as const }, true],
    ['an explicit workspace', { instanceMode: 'workspace' as const }, false],
    // Absent is the default and is what every xezar before 0.17.0 sent: never guessed into a
    // link-out, because a guessed absolute url would point at a port nothing answers.
    ['the key absent', {}, false],
    ['health not in yet', undefined, false],
    ['null', null, false],
  ])('%s → %s', (_name, capabilities, expected) => {
    expect(linksOutToOtherProjects(capabilities)).toBe(expected)
  })

  it('is not a spelling of either narrowing', () => {
    expect(linksOutToOtherProjects({ singleProject: true })).toBe(false)
    expect(linksOutToOtherProjects({ singleProjectRoot: true })).toBe(false)
  })
})
