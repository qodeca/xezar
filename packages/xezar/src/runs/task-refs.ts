/**
 * PR/issue-number extraction from a task prompt (spec 2026-07-17-task-auto-naming,
 * step 0): the always-available programmatic layer under the LLM namer. Pure and
 * synchronous — it runs inline at `startRun` and its result both prefixes the
 * heuristic title and cross-checks the namer's structured output (the regex wins
 * every disagreement).
 */

export interface TaskRefs {
  prNumber?: number;
  issueNumber?: number;
  /** A number present in the task whose kind (PR vs issue) is not determinable —
   *  a bare `469` argument or a plain `#469`. Still usable as a title prefix. */
  ambiguousNumber?: number;
}

export const MAX_REF = 10_000_000; // sanity bound — GitHub numbers are far below this

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < MAX_REF ? n : undefined;
}

/** How much of the first line counts as the task's opener (#18). */
export const OPENER_WINDOW = 120;

/**
 * The opener is where a task names its subject: the first non-empty line,
 * capped at `OPENER_WINDOW` characters (the cap slides to the next whitespace
 * so a number is never split in half), with parenthesised asides removed —
 * "(issue #6)" is context about someone else's work, not this task's subject.
 */
function opener(text: string): string {
  const firstLine = text.replace(/^\s+/, '').split(/\r?\n/, 1)[0] ?? '';
  let window = firstLine;
  if (firstLine.length > OPENER_WINDOW) {
    const cut = firstLine.slice(OPENER_WINDOW).search(/\s/);
    window = cut === -1 ? firstLine : firstLine.slice(0, OPENER_WINDOW + cut);
  }
  return window.replace(/\([^()]*\)/g, ' ');
}

/**
 * GitHub's closing keywords (close/fix/resolve and their -s/-d forms) followed
 * by `#N` or `owner/repo#N` — an explicit intent wherever it sits in the body.
 */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/i;

/**
 * First match wins per kind. Only EXPLICIT references bind (#18): a GitHub URL
 * or a closing keyword anywhere, a worded reference or `#N` in the opener. A
 * passing "another task (issue #6) is editing it" deep in the brief is context,
 * and binding on it mislabels the task list, the title prefix and the header link.
 */
export function extractTaskRefs(task: string): TaskRefs {
  const refs: TaskRefs = {};
  const text = task ?? '';
  const head = opener(text);

  // 1. Explicit URLs anywhere — the strongest signal.
  const prUrl = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i.exec(text);
  if (prUrl) refs.prNumber = num(prUrl[1]);
  const issueUrl = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/i.exec(text);
  if (issueUrl) refs.issueNumber = num(issueUrl[1]);

  // 2. Worded references in the opener — covers the GitHub-tab templates
  //    verbatim ("Address GitHub pull request #N", "Fix GitHub issue #N") and
  //    free text ("pr 437", "PR#437", "review pull request 437", "issue #12").
  if (refs.prNumber === undefined) {
    const pr = /\b(?:pull\s+request|pr)\s*#?\s*(\d+)/i.exec(head);
    if (pr) refs.prNumber = num(pr[1]);
  }
  if (refs.issueNumber === undefined) {
    const issue = /\bissue\s*#?\s*(\d+)/i.exec(head);
    if (issue) refs.issueNumber = num(issue[1]);
  }

  // 3. A closing keyword anywhere ("Closes #14", "Fixes #14", "Resolves #14")
  //    names the issue this task exists to close.
  if (refs.issueNumber === undefined) {
    const closing = CLOSING_KEYWORD.exec(text);
    if (closing) refs.issueNumber = num(closing[1]);
  }

  // 4. A task that IS a number — the argument-only skill invocation (`469`).
  if (refs.prNumber === undefined && refs.issueNumber === undefined) {
    const bare = /^\s*#?(\d+)\s*$/.exec(text);
    if (bare) refs.ambiguousNumber = num(bare[1]);
    else {
      // 5. Last resort: the first `#N` in the opener — never one buried in the body.
      const hash = /#(\d+)\b/.exec(head);
      if (hash) refs.ambiguousNumber = num(hash[1]);
    }
  }
  return refs;
}

/** The single number worth prefixing a title with, strongest kind first. */
export function titleRefNumber(refs: TaskRefs): number | undefined {
  return refs.prNumber ?? refs.issueNumber ?? refs.ambiguousNumber;
}

/**
 * Skill-aware disambiguation for a bare number: `469` handed to a *-review-pr
 * skill is a PR; handed to a *-fix-issue skill it is an issue. Only upgrades
 * `ambiguousNumber` — explicit URL/worded matches are never overridden.
 */
export function refineTaskRefs(refs: TaskRefs, skillName?: string): TaskRefs {
  if (refs.ambiguousNumber === undefined || !skillName) return refs;
  const name = skillName.toLowerCase();
  if (/(^|\W)pr(\W|$)|pull-?request/.test(name)) {
    return { ...refs, prNumber: refs.prNumber ?? refs.ambiguousNumber, ambiguousNumber: undefined };
  }
  if (name.includes('issue')) {
    return { ...refs, issueNumber: refs.issueNumber ?? refs.ambiguousNumber, ambiguousNumber: undefined };
  }
  return refs;
}
