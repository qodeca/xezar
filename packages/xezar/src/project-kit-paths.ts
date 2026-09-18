import { join, resolve } from 'node:path';
import { xezarHomeDir } from './paths.ts';

export const PROJECT_KIT_DIR = '.xezar';

/**
 * One whole directory supplies project configuration, workflows and skills, for
 * both reads and writes: `<repo>/.xezar`. Discovery is read-only and creates
 * nothing; an absent kit simply leaves every default in place.
 *
 * This helper never resolves the per-user `~/.xezar` directory. That used to be
 * the whole story — the kit and the per-user state could not meet, because one
 * is `<repo>/.xezar` and the other is in the home. Single-project mode (#600)
 * ends that separation: in the mode `<project>/.xezar` holds BOTH, and the
 * collision is designed rather than avoided —
 *
 *   - `<project>/.xezar/config.json` is the SAME file in both readings. It is
 *     the project config the kit already owns, keeping today's meaning exactly
 *     (FR-2.2); the mode's layout names it so a first run can create it, and
 *     gives it no second meaning. Nothing here changes.
 *   - The mode's own three files take names the kit has never used —
 *     `workspace.json`, `workspace-ui.json`, `agent-accounts.json` — so a kit
 *     asset and a state file can never be the same path.
 *   - `workflows/` and `skills/` stay pure kit; the mode writes nothing into
 *     them.
 *
 * So `projectKitDir` keeps answering `<repo>/.xezar` in the mode, deliberately:
 * diverting it would split the project config in two, which is the one thing
 * FR-2.2 forbids. The `~`-launch diversion below is unrelated and still
 * applies, and in the mode it cannot fire at all — `$HOME` is never a
 * single-project root (`isUserHome` in `state-layout.ts`).
 */
export function projectKitDir(repoRoot: string): string {
  const canonical = join(repoRoot, PROJECT_KIT_DIR);
  // A home-directory launch is not a project registration. In particular, init
  // and PUT /config there must never turn the user's workspace file into a kit,
  // so the kit moves into that launch's own local state instead.
  if ([xezarHomeDir(), xezarHomeDir({})].some(home => resolve(home) === resolve(canonical))) {
    return join(repoRoot, '.local/xezar/kit');
  }
  return canonical;
}
