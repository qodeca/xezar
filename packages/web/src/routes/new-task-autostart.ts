/**
 * Bookmarklet deep links (spec 011) — the `/new?skill=&ref=&auto=&key=` grammar a saved
 * bookmarklet opens, protected by the backward-compatibility promise: every link that ever
 * landed keeps landing, with no error.
 *
 * Owner decision 2026-10-19: a link FILLS the form and never starts a task by itself. The user
 * reviews and presses Start. `auto=1` and `key` are still accepted and then ignored, so a
 * bookmarklet saved with "One-click launch" before this change behaves like any other link.
 *
 * Semantics:
 *  - no `ref` (nor the `task` alias) → nothing to do beyond a plain composer;
 *  - a `ref` → prefill + a toast saying Start is needed, whatever `auto` and `key` say;
 *  - the skill name is NOT validated client-side — an unknown skill falls back to quick-task
 *    with the intent in the text, exactly as the legacy page did.
 */

/** The one toast a deep link shows (legacy `alertBar` had exactly one line too).
 *
 * @param unknownSkill - the skill param when it matches nothing installed here, else `''` —
 *   the honest case legacy papered over by embedding the name in the task text.
 * @returns the toast line and its tone; `danger` only for the unknown-skill case.
 *
 * @example
 * ```ts
 * deepLinkToast('') // { message: 'The link filled in the form — press Start to begin', tone: 'default' }
 * ```
 */
export function deepLinkToast(unknownSkill: string): { message: string; tone: 'default' | 'danger' } {
  if (unknownSkill !== '') {
    return {
      message: `Unknown skill "${unknownSkill}" — the link filled in the form for quick-task; press Start to begin`,
      tone: 'danger',
    }
  }
  return { message: 'The link filled in the form — press Start to begin', tone: 'default' }
}

/** Legacy's prefill for a skill the picker cannot select: the intent goes into the task text
 *  verbatim (`initFromQuery` wrote exactly this string) and quick-task resolves it from prose. */
export function unknownSkillPrefillText(skill: string, ref: string): string {
  return `Use the "${skill}" skill on: ${ref}`
}
