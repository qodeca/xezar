import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The source scanner the audit guards share (#266, #306) — `audit-origin-wiring.test.ts` (which
 * origins production stamps) and `audit-redaction-seam.test.ts` (that every writer goes through the
 * redaction seam). It is a testkit rather than a helper inside one of them because importing a
 * `.test.ts` file would run its suite twice.
 *
 * WHY NOT A REGEX OVER RAW TEXT: `withoutComments` is a left-to-right scanner, not a lazy
 * comment regex, because a `/*` inside a route-path string once opened a fake comment that blanked
 * about 28 % of `server.ts` — the file a door was expected to live in — and the guard passed green
 * (#364 B14). Its own tests are the `scanner fixtures` suite in `audit-origin-wiring.test.ts`.
 */

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Every workspace source tree. `packages/xezar/src` is the only one that can host a door —
 * `audit-trail.ts` imports `node:fs`, and the other three are Node-free by construction — so the
 * other roots are belt-and-braces against #364's B13 ("a door outside `packages/xezar/src`").
 */
export const SCAN_ROOTS = [
  'packages/xezar/src',
  'packages/contract/src',
  'packages/api-client/src',
  'packages/web/src',
] as const;

/** A `/` starts a regex literal unless the previous token could have ended an expression. */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

function regexMayStart(emitted: string): boolean {
  const trimmed = emitted.replace(/\s+$/, '');
  if (trimmed === '') return true;
  const last = trimmed[trimmed.length - 1]!;
  if (!/[A-Za-z0-9_$)\]]/.test(last)) return true;
  const word = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed);
  return word !== null && KEYWORDS_BEFORE_REGEX.has(word[1]!);
}

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

/**
 * Replace both comment forms with spaces, preserving length and line structure, and leave every
 * string, template and regex literal byte-for-byte intact.
 *
 * One left-to-right pass with an explicit mode, because "am I in a comment" and "am I in a string"
 * are the same question asked from two sides — answering either one with an independent regex is
 * what produced B14. Template literals push back into code mode at `${` so a nested string or
 * comment inside a substitution is handled by the same loop.
 */
export function withoutComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let mode: 'code' | 'template' = 'code';
  const templateBrace: number[] = [];
  let braceDepth = 0;

  while (i < n) {
    const c = text[i]!;

    if (mode === 'template') {
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        out += c;
        i += 1;
        mode = 'code';
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        out += '${';
        i += 2;
        mode = 'code';
        templateBrace.push(braceDepth);
        braceDepth += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    const d = text[i + 1];

    if (c === '/' && d === '/') {
      const nl = text.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        const q = text[j]!;
        if (q === '\\') {
          j += 2;
          continue;
        }
        if (q === c) {
          j += 1;
          break;
        }
        // An unterminated quote stops at the newline so one stray apostrophe cannot eat the file.
        if (q === '\n') break;
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (c === '`') {
      out += c;
      i += 1;
      mode = 'template';
      continue;
    }

    if (c === '/' && regexMayStart(out)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const q = text[j]!;
        if (q === '\\') {
          j += 2;
          continue;
        }
        if (q === '\n') break;
        if (q === '[') inClass = true;
        else if (q === ']') inClass = false;
        else if (q === '/' && !inClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(text[j]!)) j += 1;
        out += text.slice(i, j);
        i = j;
        continue;
      }
      // Not a regex after all — fall through and emit the slash as ordinary code.
    }

    if (c === '{') braceDepth += 1;
    else if (c === '}') {
      const top = templateBrace[templateBrace.length - 1];
      if (top !== undefined && braceDepth - 1 === top) {
        templateBrace.pop();
        braceDepth -= 1;
        out += c;
        i += 1;
        mode = 'template';
        continue;
      }
      braceDepth -= 1;
    }

    out += c;
    i += 1;
  }

  return out;
}

export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|testkit)\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(join(REPO_ROOT, root));
  return out;
}

