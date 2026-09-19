import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentException, ContentRule } from '../pack-check.ts';

/**
 * The generic-instructions rule (#466), as data both guards read.
 *
 * Owner requirement: a released xezar never contains instructions specific to a particular
 * project, and every instruction suits any project — software, an advertising agency, scientific
 * research. Owner decision 2026-09-16: shipped help MAY name a client's own instruction file
 * ("Codex reads AGENTS.md"), and may never tell a user to adopt xezar's own files or process.
 *
 * This module is a `*.testkit.ts` on purpose: the build excludes it, so the list of names it bans
 * never ships inside the package it is guarding. Two readers:
 *   - `generic-instructions.test.ts` — every first-party instruction producer, in `npm test`;
 *   - `scripts/check-pack.mjs` — every text byte of a freshly packed archive, in `npm run build`.
 *
 * A word list cannot prove an instruction is generic; it proves the known project leaks stay out.
 */

/** This repository's own names, banned wherever xezar speaks to a user or an agent. */
export const PROJECT_SPECIFIC_RULES: readonly ContentRule[] = [
  { id: 'own-source-path', pattern: /packages\/(?:xezar|web|contract|api-client)\/src/, reason: "a path inside xezar's own source repository" },
  { id: 'own-kit-checks', pattern: /\.xezar\/checks/, reason: "xezar's own dogfooding kit scripts" },
  { id: 'own-gate-script', pattern: /repo-gates/, reason: "xezar's own quality-gate script" },
  { id: 'own-process-doc', pattern: /\b(?:SDLC|CODE_REVIEW)\.md\b/, reason: "xezar's own process documents" },
  { id: 'demo-project', pattern: /qodeca\/demo/, reason: 'an organisation project used as an example' },
  {
    id: 'own-repository',
    // Allowed forms: the package identifier (`@qodeca/xezar…`), the support and documentation URLs
    // on GitHub, and the default skills provider `qodeca/xezar-skills` (a product content source).
    pattern: /(?<!@)(?<!github\.com\/)(?<!githubusercontent\.com\/)qodeca\/xezar(?!-skills)/,
    reason: "xezar's own repository named as something to work in",
  },
  { id: 'owner-name', pattern: /patryk|lewczuk|marcin\s*obel|marcinobel/, reason: 'a named person from the project that develops xezar' },
  { id: 'own-build-command', pattern: /npm run (?:build|dev):web/, reason: "a build command of xezar's own repository" },
];

/**
 * A client's native instruction file. Allowed ONLY as a capability reference (what a client reads),
 * never as "adopt this process" — so every hit needs its own reviewed exception.
 */
export const NATIVE_INSTRUCTION_FILE_RULE: ContentRule = {
  id: 'native-instruction-file',
  pattern: /\b(?:AGENTS|CLAUDE)\.md\b/,
  reason: "a client's instruction file — allowed only as a capability reference, never as xezar's own process",
};

/**
 * Wording that frames EVERY project as software work (audit class 2): tasks as coding, isolation as
 * always-a-worktree, GitHub or quality gates as always there. Not banned words — Git and GitHub
 * tools may say so precisely — so each hit is a reviewed exception tied to the work package that
 * rewrites it, and anything new fails.
 */
export const SOFTWARE_ONLY_FRAMING_RULE: ContentRule = {
  id: 'software-only-framing',
  pattern: /coding[- ]agent tasks|in their own worktrees|Read GitHub facts|quality gates|tasks in your repo/,
  reason: 'frames every project as software work',
};

/** Workflow names of xezar's own kit that are ordinary words elsewhere, so they are not banned. */
const GENERIC_WORKFLOW_NAMES = new Set(['bug-fix', 'code-review', 'design', 'design-review', 'qa', 'research', 'integration', 'release', 'root-sync', 'business-analysis', 'testing-and-verification']);

/** Names that identify xezar's dogfooding kit even when a file is renamed. Always present. */
const KIT_FALLBACK_NAMES = ['xezar-implementation', 'xezar-handoff-draft-pr', 'worktree-preflight', 'worktree-setup', 'resume-complete', 'integration-preflight', 'root-sync-preflight', 'merge-recovery', 'verify-evidence', 'feature-implementation', 'address-review-findings'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The kit's own role names, read from the repository's `.xezar/` when it is there (it is, in every
 * checkout that builds a release) and a fixed fallback otherwise, so the rule is never empty.
 */
export function kitNames(repoRoot: string): string[] {
  const names = new Set(KIT_FALLBACK_NAMES);
  const read = (dir: string, ext: RegExp) => {
    const path = join(repoRoot, '.xezar', dir);
    if (!existsSync(path)) return;
    for (const file of readdirSync(path)) if (ext.test(file)) names.add(file.replace(ext, ''));
  };
  read('skills', /\.md$/);
  read('checks', /\.(?:sh|mjs)$/);
  read('workflows', /\.ya?ml$/);
  return [...names].filter((n) => n.includes('-') && !GENERIC_WORKFLOW_NAMES.has(n) && !['catalog-check', 'changelog-check', 'gate-parallel.test', 'xezar-contract.test', 'infra-tests', 'repository-checks', 'worktree-git', 'bootstrap'].includes(n)).sort();
}

/** The archive-only rules: the project rules plus the kit's names and its local evidence paths. */
export function releaseArchiveRules(repoRoot: string): ContentRule[] {
  const names = kitNames(repoRoot);
  return [
    ...PROJECT_SPECIFIC_RULES,
    { id: 'own-kit-name', pattern: new RegExp(`(?<![\\w-])(?:${names.map(escape).join('|')})(?![\\w-])`), reason: "a workflow, skill or check of xezar's own dogfooding kit" },
    // Both spellings of the kit's evidence root. `.local/xezar-tasks` is frozen history and
    // `.local/xezar/tasks` is where new evidence goes; during that window either string in a
    // packed file is the same leak, and matching only one would let the other ship unnoticed.
    // Narrow on purpose: `.local/xezar/` alone is the SHIPPED engine's own state directory
    // (worktrees, tmp, cache), which the published CLI names legitimately.
    { id: 'own-local-path', pattern: /\.local\/(?:xezar-(?:tasks|kit|campaigns)|xezar\/tasks|erfana|qa\/|coverage\/|plans\/)/, reason: "a scratch or evidence path of xezar's own repository" },
  ];
}

/**
 * Reviewed exceptions for the packed archive. Shrinking only: `check:pack` fails on an exception
 * that no longer matches, and on more exceptions than the ceiling.
 */
export const RELEASE_ARCHIVE_EXCEPTIONS: readonly ContentException[] = [];

/** The most exceptions the archive may carry. Lower it when one is removed; never raise it. */
export const RELEASE_ARCHIVE_EXCEPTION_CEILING = 0;

/**
 * Source text with its comments blanked out and everything else — code, strings, template text,
 * JSX text — kept, line numbers preserved. Comments are notes to xezar's developers and are
 * stripped from the build (`removeComments`); what remains is what can reach a user or an agent.
 *
 * A small lexer, not a parser: it knows quotes, template literals with `${}` nesting and regex
 * literals well enough for this repository's code. A string or regex never spans a newline
 * outside a template, so a misread apostrophe in JSX text ends at its line.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const templateDepth: number[] = [];
  let braceDepth = 0;
  let lastSignificant = '';
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]|^$/;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if (ch === '`' || (ch === '}' && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braceDepth)) {
      if (ch === '}') templateDepth.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
      if (source[j] === '$') {
        templateDepth.push(braceDepth);
        out += source.slice(i, j + 2);
        i = j + 2;
      } else {
        out += source.slice(i, j + 1);
        i = j + 1;
      }
      lastSignificant = '`';
      continue;
    }
    if (ch === '/' && (regexAllowedAfter.test(lastSignificant) || /(?:return|typeof|case|in|of)\s*$/.test(out.slice(-12)))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (!/\s/.test(ch)) lastSignificant = ch;
    out += ch;
    i++;
  }
  return out;
}
