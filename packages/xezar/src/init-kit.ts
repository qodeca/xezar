import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What `xezar init` writes: one example workflow and one example skill.
 *
 * These files land in ANY project — software, an advertising agency's campaign folder, a research
 * paper — so they start from the outcome and its evidence, never from a software toolchain (#466).
 * The verify step is honest about what the project can check: a check the project already has
 * becomes a real `command` step, and a project with none gets an agent step that reviews the result
 * against the task and reports what it could not verify. An `echo` that always exits 0 used to sit
 * there, which made every run look verified.
 */

/** The npm default `test` script: present, but a placeholder that fails. Not a check. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

/** A check this project already has, and where it was found. */
export interface DiscoveredCheck {
  command: string;
  source: string;
}

/**
 * The project's own check, if one is plainly declared: an `npm test` script or a Makefile `test` or
 * `check` target. Best effort and read-only — an unreadable file contributes nothing, and anything
 * less certain than these stays undiscovered rather than guessed.
 */
export function discoverProjectCheck(repoRoot: string): DiscoveredCheck | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const test = pkg.scripts?.['test'];
    if (typeof test === 'string' && test.trim() && !NPM_PLACEHOLDER_TEST.test(test)) {
      return { command: 'npm test', source: 'package.json' };
    }
  } catch {
    // no package.json, or not JSON — fine
  }
  try {
    const make = readFileSync(join(repoRoot, 'Makefile'), 'utf8');
    for (const target of ['test', 'check']) {
      if (new RegExp(`^${target}:(?!=)`, 'm').test(make)) return { command: `make ${target}`, source: 'Makefile' };
    }
  } catch {
    // no Makefile — fine
  }
  return undefined;
}

const DOMAIN_EXAMPLES = `# Examples of a check, by kind of project (none of them authorizes publishing or sending anything):
#   software:            run the existing relevant tests, e.g. command: "npm test" or "pytest"
#   advertising agency:  check the campaign draft's audience, budget and claims against the supplied brief
#   scientific research: check the revised section's citations, methods and stated limitations against the sources`;

/** The example workflow, built around the check this project has — or honestly without one. */
export function fixAndVerifyWorkflow(check: DiscoveredCheck | undefined): string {
  if (check) {
    return `name: fix-and-verify
description: Do the task, then run this project's own check (${check.command}); if it fails, the agent gets the failing output and tries again.
steps:
  - id: implement
    name: Do the task
    prompt: "{{task}}"
${DOMAIN_EXAMPLES.replace(/^/gm, '  ')}
  - id: verify
    name: Run the project's check
    command: ${JSON.stringify(check.command)}
    onFail:
      retry: implement
      max: 2
`;
  }
  return `name: fix-and-verify
description: Do the task, then review the result against what the task asked for. No verification command is configured for this project, so the review reports what it could not verify.
steps:
  - id: implement
    name: Do the task
    prompt: "{{task}}"
# No verification command is configured. To add an automatic check, replace this step's prompt
# with a command your project already runs, plus onFail (retry: implement, max: 2).
${DOMAIN_EXAMPLES}
  - id: verify
    name: Review the result
    prompt: |
      No verification command is configured for this project, so nothing was checked automatically.
      Review the result of the previous step for this task:

      {{task}}

      Inspect the deliverable itself against the criteria, sources and constraints the task supplied.
      Report each criterion as met, not met, or not verifiable, and name the evidence that is missing.
      Do not invent a command, and do not describe anything as verified that you did not check.
`;
}

export const PROJECT_CONVENTIONS_SKILL = `---
name: project-conventions
description: What good work looks like in this project — its goal, deliverables, constraints and how results are checked.
---

# Project conventions

Replace the notes below with what is true for this project. A workflow step uses this skill with \`skill: project-conventions\`.

## What the work is for
- The outcome the work serves, and who it is for.

## What a finished result looks like
- The deliverables (documents, files, changes) and where they belong.

## Constraints
- What the work must respect: sources, tone, formats, budget, tools, deadlines.

## How results are checked
- The evidence that shows a result is right, and who accepts it.
- If nothing can be checked automatically, say so: the agent then reviews the result against these notes and reports what it could not verify.

## Examples
- Software: "Fix the calculation in the pricing module and run the existing relevant tests."
- Advertising agency: "Draft the campaign brief from the client folder and check audience, budget and every claim against the supplied material."
- Scientific research: "Revise the methods section and check its citations, methods and stated limitations against the provided sources."

None of these examples authorizes publishing, sending or submitting anything.
`;
