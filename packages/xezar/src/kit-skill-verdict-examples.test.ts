import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TASK_VERDICT_FINDINGS_MAX, taskVerdictPacketSchema } from '@qodeca/xezar-contract';

/**
 * The three reviewing kit skills show the reporting agent ONE verdict packet, and that example is
 * the whole specification it works from (#673). A skill is Markdown, so nothing else in this
 * repository would notice the day the example stopped matching the schema the engine parses it
 * with — and the failure that produces is silent in the worst way: the reviewer writes the packet
 * the skill showed it, the engine refuses it, and the leader learns there is no verdict at all.
 *
 * So the example is parsed here, through the shipped schema, exactly as the engine parses the real
 * thing. The `<…>` values are the skill's own placeholders for what the reviewer fills in at write
 * time; they are substituted with a conforming stand-in per key, and nothing else is touched. The
 * `findings` block carries REAL values in all three skills and is parsed as written.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** What a reviewer substitutes at write time, by the key the skill's placeholder sits under. */
const PLACEHOLDER: Readonly<Record<string, string>> = {
  taskId: '2027093c-c801-45f0-91e3-fdae5605d712',
  stepId: 'review',
  reviewedHeadSha: '0123456789abcdef0123456789abcdef01234567',
  summary: 'the headline the reviewer wrote',
  recordedAt: '2026-09-20T12:00:00.000Z',
  evidenceUrl: 'https://example.invalid/pr/1#issuecomment-1',
};

/** A `"<…>"` value is the skill telling the reviewer to fill it in; every other value is real. */
function fillPlaceholders(value: unknown, key?: string): unknown {
  if (typeof value === 'string' && /^<.*>$/.test(value)) {
    const filled = key === undefined ? undefined : PLACEHOLDER[key];
    if (filled === undefined) throw new Error(`the skill example has an unexplained placeholder at "${key ?? '(root)'}"`);
    return filled;
  }
  if (Array.isArray(value)) return value.map((entry) => fillPlaceholders(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, fillPlaceholders(entry, name)]));
  }
  return value;
}

/** The first fenced JSON block of a skill — the one packet example each of them carries. */
function packetExample(skill: string): unknown {
  const text = readFileSync(join(repoRoot, '.xezar/skills', skill), 'utf8');
  const fenced = /```json\n([\s\S]*?)\n```/.exec(text);
  expect(fenced, `${skill} carries a fenced JSON packet example`).not.toBeNull();
  return fillPlaceholders(JSON.parse(fenced?.[1] ?? ''));
}

const SKILLS: ReadonlyArray<readonly [string, string]> = [
  ['xezar-code-review.md', 'code-review'],
  ['xezar-qa.md', 'qa'],
  ['xezar-ux-design.md', 'design-review'],
];

describe('the kit skills’ verdict packet examples', () => {
  for (const [skill, role] of SKILLS) {
    it(`${skill} shows a packet the engine accepts, for its own role`, () => {
      const parsed = taskVerdictPacketSchema.safeParse(packetExample(skill));
      expect(parsed.error?.issues ?? [], skill).toEqual([]);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.role).toBe(role);
    });

    it(`${skill} shows the findings pair, within the bounds the engine enforces`, () => {
      const example = packetExample(skill) as { findings?: unknown[]; findingsOmitted?: number };
      // A skill that stopped showing `findings` would leave the reporting agent with no example of
      // the one field this whole mechanism exists for, which no schema parse would catch.
      expect(example.findings, skill).toBeInstanceOf(Array);
      expect((example.findings ?? []).length, skill).toBeGreaterThan(0);
      expect((example.findings ?? []).length, skill).toBeLessThanOrEqual(TASK_VERDICT_FINDINGS_MAX);
      expect(example.findingsOmitted, skill).toBe(0);
    });

    it(`${skill} states the truncation sentence and forbids the two wrong ways to produce findings`, () => {
      const text = readFileSync(join(repoRoot, '.xezar/skills', skill), 'utf8');
      // AC-24: the exact sentence the comment carries when the packet is short.
      expect(text, skill).toContain('N findings are in this comment and not in the machine-readable packet');
      // AC-25: written from the working list — never re-read out of the comment, never a second file.
      expect(text, skill).toContain('never by parsing your own comment back, and never into a second file');
      // AC-27: the order the packet's own honesty rests on is unchanged.
      expect(text, skill).toContain('post the comment, then attempt the labels, then write the packet');
    });
  }
});
