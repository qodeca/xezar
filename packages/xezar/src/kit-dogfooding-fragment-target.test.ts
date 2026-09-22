import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #721: the integration `report` step wrote `.xezar/docs/dogfooding.d/c16ae8a0.md` into the PRIMARY
 * checkout. The project `systemPrompt` told EVERY agent step to "Record observations from real work
 * as a fragment in `.xezar/docs/dogfooding.d/<runId8>.md`", and a read-only or merge-only workflow
 * (`integration`, `code-review`, `qa`, `design-review`, `research`, `business-analysis`,
 * `issue-triage`, a `quick-task` skill) has no step that commits, so the fragment had nowhere
 * legitimate to go and landed in the primary.
 *
 * The instruction now names the evidence dir for exactly those runs. This guard reads the one place
 * that decides — the config `systemPrompt` — and every skill reachable from a workflow with no
 * committing handoff step, and fails if any of them still sends a fragment to the repository
 * without the evidence-dir alternative. A skill is Markdown, so nothing else would notice the day
 * the sentence was reverted and the same stray file came back.
 *
 * `KIT_GUARD_ROOT` is a test-only escape hatch so the named break
 * (`BREAK-721-PROMPT-REVERTED`, second case below) can be reproduced against a scratch copy of the
 * kit from the command line; it is never set in a normal run, and the default is this repository.
 */

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const KIT_ROOT = resolve(process.env.KIT_GUARD_ROOT ?? DEFAULT_ROOT);

/**
 * Skills reachable from a workflow whose steps contain no `handoff` step, plus the two skills the
 * built-in `quick-task` launches. `xezar-ux-design.md` is shared with the writing `design`
 * workflow, so it must carry the CONDITIONAL sentence rather than drop the fragment branch.
 */
const READ_ONLY_SKILLS = [
  'xezar-integration.md', // integration (merge-only), root-sync
  'xezar-code-review.md', // code-review
  'xezar-architecture-review.md', // architecture-review
  'xezar-qa.md', // qa
  'xezar-ux-design.md', // design-review (review mode)
  'xezar-research.md', // research
  'xezar-business-analysis.md', // business-analysis
  'xezar-issue-triage.md', // issue-triage (no handoff step)
  'xezar-quality-gates.md', // quick-task
  'xezar-issue-create.md', // quick-task
] as const;

/** The sentences this guard exists to keep from coming back, verbatim (#721). */
const CONFIG_NEW =
  'Record observations from real work as a fragment in .xezar/docs/dogfooding.d/<runId8>.md when your workflow has a handoff step that commits; otherwise write them to your evidence dir .local/xezar/tasks/<runId>/dogfooding.md, never a repository path.';
const CONFIG_OLD = 'Record observations from real work as a fragment in .xezar/docs/dogfooding.d/<runId8>.md;';
const SKILL_NEW =
  'Record relevant dogfooding observations as a fragment in `.xezar/docs/dogfooding.d/<runId8>.md` when your workflow has a handoff step that commits; otherwise write them to your evidence dir `.local/xezar/tasks/<runId>/dogfooding.md`, never a repository path. The release role folds fragments into `.xezar/docs/dogfooding.md`.';
const SKILL_OLD =
  'Record relevant dogfooding observations as a fragment in `.xezar/docs/dogfooding.d/<runId8>.md`; the release role folds fragments into `.xezar/docs/dogfooding.md`.';

const FRAGMENT_DIR = /\.xezar\/docs\/dogfooding\.d\//;
const EVIDENCE_FILE = /\.local\/xezar\/tasks\/<runId>\/dogfooding\.md/;
const COMMIT_CONDITION = /handoff step that commits/;

/** Every place the read-only instruction is wrong, as a line a reader can act on. */
function fragmentTargetViolations(root: string): string[] {
  const found: string[] = [];
  const config = JSON.parse(readFileSync(join(root, '.xezar/config.json'), 'utf8')) as { systemPrompt?: string };
  const prompt = config.systemPrompt ?? '';
  if (!COMMIT_CONDITION.test(prompt)) {
    found.push('.xezar/config.json systemPrompt does not make the fragment conditional on a committing handoff step');
  }
  if (!EVIDENCE_FILE.test(prompt)) {
    found.push('.xezar/config.json systemPrompt names no evidence-dir fallback for a non-committing workflow');
  }
  if (FRAGMENT_DIR.test(prompt) && !EVIDENCE_FILE.test(prompt)) {
    found.push('.xezar/config.json systemPrompt directs a fragment into .xezar/docs/dogfooding.d/ with no evidence-dir alternative');
  }
  for (const skill of READ_ONLY_SKILLS) {
    const text = readFileSync(join(root, '.xezar/skills', skill), 'utf8');
    if (FRAGMENT_DIR.test(text) && !EVIDENCE_FILE.test(text)) {
      found.push(`.xezar/skills/${skill} directs a dogfooding fragment into .xezar/docs/dogfooding.d/ with no evidence-dir alternative`);
    }
    if (!EVIDENCE_FILE.test(text)) {
      found.push(`.xezar/skills/${skill} names no evidence dir for a non-committing workflow`);
    }
  }
  return found;
}

/** A scratch kit: the real config and read-only skills, copied so a revert cannot touch this repo. */
function scratchKit(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'xez-721-'));
  mkdirSync(join(scratch, '.xezar/skills'), { recursive: true });
  copyFileSync(join(KIT_ROOT, '.xezar/config.json'), join(scratch, '.xezar/config.json'));
  for (const skill of READ_ONLY_SKILLS) {
    copyFileSync(join(KIT_ROOT, '.xezar/skills', skill), join(scratch, '.xezar/skills', skill));
  }
  return scratch;
}

describe('the dogfooding fragment instruction names a path a non-committing workflow can write (#721)', () => {
  it('no read-only skill and not the project systemPrompt sends a fragment into the repository', () => {
    expect(fragmentTargetViolations(KIT_ROOT)).toEqual([]);
  });

  it('BREAK-721-PROMPT-REVERTED: restoring the old unconditional sentence turns the guard red on a scratch copy', () => {
    const scratch = scratchKit();
    try {
      const configPath = join(scratch, '.xezar/config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { systemPrompt: string };
      const revertedPrompt = config.systemPrompt.replace(CONFIG_NEW, CONFIG_OLD);
      writeFileSync(configPath, `${JSON.stringify({ ...config, systemPrompt: revertedPrompt }, null, 2)}\n`);

      const skillPath = join(scratch, '.xezar/skills/xezar-integration.md');
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace(SKILL_NEW, SKILL_OLD));

      const violations = fragmentTargetViolations(scratch);
      expect(violations.join('\n')).toMatch(/config\.json systemPrompt directs a fragment/);
      expect(violations.join('\n')).toMatch(/skills\/xezar-integration\.md directs a dogfooding fragment/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
