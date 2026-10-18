import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { projectKitDir } from '../project-kit-paths.ts';

/**
 * The committed install record the onboarding writes: `.xezar/onboarding.json`.
 *
 * A project set up by running `xez-onboard-opinionated` directly — not through the cockpit's
 * "Set up this project" — has no engine check record under `.local/xezar/`, and without this read
 * the cockpit called it "Not set up yet". The onboarding skill writes this file as the last step
 * of a finished setup (its `version`, `skill`, `date` and the installed files' digests), so its
 * presence is the project's own evidence that setup finished.
 *
 * Only the fields this engine relies on are checked; the rest belongs to the skill and passes
 * through untouched. `version` (the setup collection release that wrote the record) is read but
 * never required: an absent or non-string value reads as `null` and the record still counts, so
 * an older record without it keeps reading as a finished setup. A missing, unreadable or malformed file reads as absent — never an error, and
 * never a warning: the file is the project's, and one that is not a setup record simply says
 * nothing about setup.
 */

/** The skill that writes the record. */
export const INSTALL_RECORD_SKILL = 'xez-onboard-opinionated';

const installRecordSchema = z
  .object({
    skill: z.literal(INSTALL_RECORD_SKILL),
    date: z.string().min(1),
  })
  .passthrough();

export interface InstallRecord {
  skill: string;
  /** When the onboarding wrote the record, as the skill stamped it. */
  date: string;
  /** The setup collection release that wrote the record, verbatim (for example `3.1.0`), or `null`
   *  when the record carries no string `version`. `status.ts` decides whether it is too old. */
  version: string | null;
}

export function installRecordPath(repoRoot: string): string {
  return join(projectKitDir(repoRoot), 'onboarding.json');
}

/** Read the record. Never throws, never writes. `null` = absent or not a setup record. */
export async function readInstallRecord(repoRoot: string): Promise<InstallRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(installRecordPath(repoRoot), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = installRecordSchema.safeParse(parsed);
  if (!result.success) return null;
  const version = (result.data as { version?: unknown }).version;
  return {
    skill: result.data.skill,
    date: result.data.date,
    version: typeof version === 'string' && version.length > 0 ? version : null,
  };
}
