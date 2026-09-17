import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #532 G12 — the inventory assertion the audit itself asks for: every gap group in issue #532's
 * checklist (G1–G12) must have at least one automated test that names it, so a group that quietly
 * loses its only covering test — a rename, a deleted `it.each`, a moved file — fails THIS suite
 * instead of vanishing unnoticed. `scanGapGroupMentions` and `missingGapGroups` are the whole
 * mechanism, kept as two small pure functions so the negative control below needs no file mutation
 * and no named-break cycle of its own: it proves the mechanism goes red directly.
 */

const GAP_GROUPS: Readonly<Record<string, string>> = {
  G1: 'production event kinds through every adapter',
  G2: 'causal rejection/outcome matrix',
  G3: 'decision token invariants and the action table',
  G4: 'per-client MCP lifecycle and owner-switch interleavings',
  G5: 'ack and journal boundary table at the MCP wire',
  G6: 'restart/epoch/compaction recovery through every transport',
  G7: '#524 completion marker incident reaches the leader once',
  G8: '#520 continue after a failed check preserves the remaining workflow',
  G9: 'quota failure and recovery, advisory events and origin',
  G10: 'structured refusal and uncertain-effect receipt truth table',
  G11: 'the opt-in real-client acceptance sequence',
  G12: 'executable completeness, mutation evidence and focused branch holes',
};
const GAP_GROUP_IDS = Object.keys(GAP_GROUPS);

// A token, not a substring: "G1" must not match inside "G12", and neither may match a stray "CONFIG".
const MENTION_PATTERN = /(?<![A-Za-z0-9])G(1[0-2]|[1-9])(?![A-Za-z0-9])/g;

interface Mention {
  readonly file: string;
  readonly line: number;
}

/** Every `G<n>` token found in `files` (path -> content), grouped by the normalized `G<n>` id. */
export function scanGapGroupMentions(files: ReadonlyMap<string, string>): Map<string, Mention[]> {
  const found = new Map<string, Mention[]>();
  for (const [file, content] of files) {
    content.split('\n').forEach((lineText, index) => {
      for (const match of lineText.matchAll(MENTION_PATTERN)) {
        const id = `G${match[1]}`;
        const list = found.get(id) ?? [];
        list.push({ file, line: index + 1 });
        found.set(id, list);
      }
    });
  }
  return found;
}

/** The ids in `ids` that `mentions` has no entry for at all — the inventory's own red condition. */
export function missingGapGroups(ids: readonly string[], mentions: ReadonlyMap<string, Mention[]>): string[] {
  return ids.filter((id) => (mentions.get(id)?.length ?? 0) === 0);
}

const MCP_ROOT = import.meta.dirname;
const EXTRA_FILES = [resolve(import.meta.dirname, '../../test/integration/mcp-real-model.test.ts')];
// This file's own name: GAP_GROUPS necessarily spells every "G<n>" as an object key, which would
// otherwise satisfy every group regardless of whether a real covering test exists anywhere else —
// the inventory manifest is not itself a covering test.
const SELF = 'gap-group-inventory.test.ts';

/** Every `*.test.ts` file under `dir`, recursively, other than this inventory file itself. */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith('.test.ts') && entry !== SELF) out.push(join(dir, entry));
  }
  return out;
}

function readAll(paths: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of paths) files.set(path, readFileSync(path, 'utf8'));
  return files;
}

describe('#532 G12 — gap-group inventory assertion', () => {
  it('every gap group in the #532 audit has at least one automated test that names it', () => {
    // RED against: a gap group added to GAP_GROUPS with no covering test, or an existing covering
    // test whose title/comment stops saying "G<n>" — the negative control below proves this exact
    // check goes red for exactly that case, with no file on disk touched.
    const paths = [...collectTestFiles(MCP_ROOT), ...EXTRA_FILES];
    const mentions = scanGapGroupMentions(readAll(paths));
    const missing = missingGapGroups(GAP_GROUP_IDS, mentions);
    expect(missing, `${missing.join(', ')} has no test naming it — checked ${paths.length} files`).toEqual([]);
    // Every id this scan actually found is one the inventory declares — a stray "G13" typo in a
    // comment is a finding here, never a silent no-op.
    for (const id of mentions.keys()) expect(GAP_GROUP_IDS, `${id} is mentioned in the tests but is not in GAP_GROUPS`).toContain(id);
  });

  it('negative control: the same check fails when one group’s only covering test disappears', () => {
    // Proof that the assertion above is not vacuously green: remove one group's real mentions (as a
    // deleted `it.each` or a renamed title would) and confirm `missingGapGroups` reports exactly it.
    const paths = [...collectTestFiles(MCP_ROOT), ...EXTRA_FILES];
    const mentions = scanGapGroupMentions(readAll(paths));
    for (const id of GAP_GROUP_IDS) expect(mentions.get(id)?.length ?? 0, `fixture assumption: ${id} already has real coverage`).toBeGreaterThan(0);
    const reduced = new Map(mentions);
    reduced.delete('G7');
    expect(missingGapGroups(GAP_GROUP_IDS, reduced)).toEqual(['G7']);
    // The reduction is a local copy only — the real scan two lines up is untouched.
    expect(missingGapGroups(GAP_GROUP_IDS, mentions)).toEqual([]);
  });
});
