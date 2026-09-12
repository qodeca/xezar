import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditOriginSchema } from '@qodeca/xezar-contract';

/**
 * #266 — WHICH AUDIT ORIGINS PRODUCTION ACTUALLY WRITES.
 *
 * `auditOriginSchema` offers four members and production opens one channel. That is a decided state
 * for 0.14.0 (D-06 § 10.6), not a defect — the defect was that four documents could quietly stop
 * describing it. Four surfaces say "only `mcp`": the schema's own comment
 * (`packages/contract/src/mcp-audit.ts`), the module comment of `audit-trail.ts`, and two sections
 * of `docs/features/mcp-server/mcp-api.md` ("The two meanings of `origin`", Findings 3). This file
 * is what makes those four sentences a checked claim instead of a remembered one.
 *
 * TWO NETS, BECAUSE ONE SPELLING IS NOT THE CLAIM. The claim is "production opens exactly one
 * channel and its origin is `mcp`", and a second door does not have to be spelled the way the first
 * one is.
 *
 *   Net 1 — WHO NAMES THE TYPES. A new origin can only be created by `trail.channel(origin)` or by
 *   `new AuditChannel(trail, origin)`. Either way the file must name `AuditTrail` or `AuditChannel`,
 *   because both come from this one module. So the set of production files that name either type at
 *   all is pinned. This net does not care how the call is spelled, which quote it uses, whether the
 *   origin is a variable, or whether `channel()` is reached through `.bind`.
 *
 *   Net 2 — WHICH ORIGIN IS STAMPED. Every `.channel(…)` call and every `new AuditChannel(…)` in
 *   production, with the origin read off the call. A call whose origin is not a plain literal is
 *   recorded as a non-literal marker rather than skipped, so the unreadable case fails loudly
 *   instead of passing quietly.
 *
 * WHY NOT A REGEX OVER RAW TEXT. The first version of this guard stripped block comments with a
 * single lazy regex from an opener to the next closer, which cannot tell a string from a comment: a
 * `/*` inside a route-path string such as `'/api/*'` opened a fake comment that ran to the next real
 * closer. That deleted about 28 % of `packages/xezar/src/server/server.ts` from the scanned text —
 * the exact file #364 names as the home of the `ui` door — so a canonical `.channel('ui')` written
 * there passed green. (This very paragraph tripped the same bug once: naming the old pattern in
 * prose put a closer inside the comment and ended it early.) QA of this
 * PR found it (B14). `withoutComments` below is a left-to-right scanner instead: it tracks strings,
 * template literals (including `${…}` nesting), regex literals and both comment forms in one pass,
 * so a delimiter inside a string is never read as a comment and an apostrophe inside a comment is
 * never read as a string. `scanner fixtures` below tests that scanner directly.
 *
 * TypeScript's own parser would be better still and is not available: `typescript` 7.0.2 in this
 * repo is the Go port and exports four names (`default`, `module.exports`, `version`,
 * `versionMajorMinor`) — no `createSourceFile`, no `forEachChild`. `@babel/parser` is present only
 * as a transitive dependency of the web toolchain, and promoting it to a declared devDependency is
 * not something a documentation change should do.
 *
 * WHAT THIS GUARD STILL CANNOT SEE. Read a green tick as exactly this much and no more:
 *
 *   1. It proves what production CONSTRUCTS, not what production WRITES. A door that opens a
 *      channel and never calls `record`/`run` passes. Nothing here counts entries.
 *   2. It does not check that the four prose surfaces agree with each other, or with reality. The
 *      failure message names them; that is a pointer, not an assertion.
 *   3. A door that writes `mcp-audit.ndjson` itself, without using `AuditTrail` at all, is invisible
 *      to both nets. Net 1 keys on the type names.
 *   4. It pins the FILE, not the line. The seven documents that cite `mcp/index.ts:254` stay
 *      correct only by hand; ten lines inserted above 254 break them with no test failing.
 *   5. A `.channel(` on an unrelated object anywhere under the scanned roots would be counted as an
 *      audit door. There is no such call today, and a type checker would be needed to tell them
 *      apart; the failure message says so rather than the scanner guessing.
 *   6. Regex-literal detection uses the usual previous-token heuristic. After `)` — as in
 *      `if (x) /re/.test(s)` — a regex is read as division. No such line exists in the scanned
 *      roots today, and the fixtures pin the shapes that do.
 *   7. It reads the four workspace `src` trees listed in `SCAN_ROOTS`. Generated code, `scripts/`,
 *      and anything outside those trees is not scanned. All three doors #364 names live inside
 *      `packages/xezar/src`.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Every workspace source tree. `packages/xezar/src` is the only one that can host a door —
 * `audit-trail.ts` imports `node:fs`, and the other three are Node-free by construction — so the
 * other roots are belt-and-braces against #364's B13 ("a door outside `packages/xezar/src`").
 */
const SCAN_ROOTS = [
  'packages/xezar/src',
  'packages/contract/src',
  'packages/api-client/src',
  'packages/web/src',
] as const;

/** The two type names a second door cannot avoid naming. */
const AUDIT_TYPES = /\b(AuditTrail|AuditChannel)\b/;

/**
 * Where the audit types legitimately appear in production source, and why.
 *
 * `audit-trail.ts` declares both classes; `mcp/index.ts` is the one door. Any third file here is
 * either a new door or a new reader, and both want the four surfaces revisited.
 */
const EXPECTED_TYPE_USERS = ['packages/xezar/src/mcp/audit-trail.ts', 'packages/xezar/src/mcp/index.ts'];

/** The one production door, and the origin it stamps. */
const EXPECTED_DOORS = [{ file: 'packages/xezar/src/mcp/index.ts', origin: 'mcp' }];

/**
 * `new AuditChannel(…)` is the constructor `channel()` itself calls. Exactly one production
 * occurrence is correct — inside `AuditTrail.channel`, which forwards its own `origin` parameter and
 * so reads as a non-literal by design. A second occurrence is a door that bypassed the method, which
 * is why this is pinned rather than excluded.
 */
const EXPECTED_DIRECT_CONSTRUCTIONS = [
  { file: 'packages/xezar/src/mcp/audit-trail.ts', origin: '<non-literal: origin>' },
];

const FIX_HINT =
  'The set of audit doors changed. Update every surface that says the trail is MCP-only: ' +
  'auditOriginSchema (packages/contract/src/mcp-audit.ts), the module comment of ' +
  'packages/xezar/src/mcp/audit-trail.ts, and mcp-api.md ("The two meanings of `origin`" and ' +
  'Findings 3) — then D-06 § 10.6 and #364. If this fired for an unrelated `.channel(` on some ' +
  'other object, say so here rather than widening the pattern.';

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

interface Site {
  readonly file: string;
  readonly origin: string;
}

/**
 * Read the origin argument at `from` (the index just after the opening paren).
 *
 * A plain literal in any of the three quote styles, optionally with an `as` assertion, yields its
 * value. Anything else — an identifier, a call, a template with a substitution — yields a marker, so
 * `expect(...).toEqual(EXPECTED_DOORS)` fails on it. Failing closed is the point: the shapes this
 * cannot read are exactly the shapes a reviewer most needs told about.
 */
function readOrigin(code: string, from: number): string {
  const rest = code.slice(from);
  const literal = /^\s*(['"`])([^'"`\\]*)\1\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?,?\s*\)/.exec(rest);
  if (literal) return literal[2]!;
  // Trimmed to the first token so the marker is stable under reformatting, but still says what it saw.
  const excerpt = rest.slice(0, 40).trim().split(/[\s,;)]/)[0] || rest.slice(0, 20).trim();
  return `<non-literal: ${excerpt}>`;
}

function scanFile(file: string, code: string): { doors: Site[]; constructions: Site[] } {
  const doors: Site[] = [];
  const constructions: Site[] = [];
  const rel = relative(REPO_ROOT, file).split('\\').join('/');

  for (const m of code.matchAll(/\.channel\b/g)) {
    const after = m.index + m[0].length;
    const open = /^\s*\(/.exec(code.slice(after));
    if (!open) {
      // `.channel` reached without calling it — `.bind`, a destructure, a handed-out reference.
      doors.push({ file: rel, origin: '<bare reference, not a call>' });
      continue;
    }
    doors.push({ file: rel, origin: readOrigin(code, after + open[0].length) });
  }

  for (const m of code.matchAll(/\bnew\s+AuditChannel\s*\(/g)) {
    const argsAt = m.index + m[0].length;
    const comma = code.indexOf(',', argsAt);
    const origin = comma === -1 ? '<no second argument>' : readOrigin(code, comma + 1);
    constructions.push({ file: rel, origin });
  }

  return { doors, constructions };
}

function sourceFiles(root: string): string[] {
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

interface Scan {
  readonly files: number;
  readonly doors: Site[];
  readonly constructions: Site[];
  readonly typeUsers: string[];
}

function scanAll(roots: readonly string[]): Scan {
  const doors: Site[] = [];
  const constructions: Site[] = [];
  const typeUsers: string[] = [];
  let files = 0;

  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      files += 1;
      const code = withoutComments(readFileSync(file, 'utf8'));
      const found = scanFile(file, code);
      doors.push(...found.doors);
      constructions.push(...found.constructions);
      if (AUDIT_TYPES.test(code)) typeUsers.push(relative(REPO_ROOT, file).split('\\').join('/'));
    }
  }

  const by = (a: Site, b: Site): number => a.file.localeCompare(b.file) || a.origin.localeCompare(b.origin);
  return { files, doors: [...doors].sort(by), constructions: [...constructions].sort(by), typeUsers: typeUsers.sort() };
}

describe('audit origins that production actually writes (#266)', () => {
  const scan = scanAll(SCAN_ROOTS);

  it('scanned a populated tree — the control that proves an empty scan cannot pass', () => {
    // If this reads 0, every assertion below is vacuous and says nothing about the code.
    expect(scan.files).toBeGreaterThan(300);
    expect(scan.typeUsers).toContain('packages/xezar/src/mcp/audit-trail.ts');
    expect(scan.doors).toContainEqual({ file: 'packages/xezar/src/mcp/index.ts', origin: 'mcp' });
  });

  it('net 1 — only the definition and the one door name AuditTrail or AuditChannel', () => {
    expect(scan.typeUsers, FIX_HINT).toEqual(EXPECTED_TYPE_USERS);
  });

  it('net 2 — writes `mcp` and nothing else; `ui`, `automation` and `cli` stay reserved', () => {
    expect(scan.doors, FIX_HINT).toEqual(EXPECTED_DOORS);
  });

  it('net 2 — `new AuditChannel(…)` happens only inside `AuditTrail.channel`', () => {
    expect(scan.constructions, FIX_HINT).toEqual(EXPECTED_DIRECT_CONSTRUCTIONS);
  });

  it('keeps the reserved members in the enum — narrowing it would be a contract break', () => {
    expect(auditOriginSchema.options).toEqual(['ui', 'mcp', 'automation', 'cli']);
  });
});

/**
 * The scanner's own tests. These pin `withoutComments` and the origin reader against the shapes QA
 * enumerated; they pass whatever the production source says, which is the point — they are what
 * makes the four assertions above mean something. `route path holding a comment opener` is B14, the
 * blocking finding, reduced to nine lines.
 */
describe('scanner fixtures', () => {
  const doorsIn = (src: string): Site[] => scanFile(join(REPO_ROOT, 'f.ts'), withoutComments(src)).doors;

  it('B14 — a `/*` inside a route-path string does not blank the code after it', () => {
    const src = ["app.use('/api/*', mw);", "const later = '/automations/*';", "trail.channel('ui');"].join('\n');
    expect(withoutComments(src)).toContain("'/api/*'");
    expect(doorsIn(src)).toEqual([{ file: 'f.ts', origin: 'ui' }]);
  });

  it('B11 — a glob string with both delimiters does not swallow a following door', () => {
    expect(doorsIn(["const g = '**/*.ts';", "trail.channel('automation');"].join('\n'))).toEqual([
      { file: 'f.ts', origin: 'automation' },
    ]);
  });

  it('B12 — a door on a line beginning with `*` is still seen', () => {
    expect(doorsIn('class X {\n  *gen() { return trail.channel("cli"); }\n}')).toEqual([{ file: 'f.ts', origin: 'cli' }]);
  });

  it('B4/B5/B10 — double quotes, template literal and an `as const` assertion all read', () => {
    expect(doorsIn('trail.channel("ui");')).toEqual([{ file: 'f.ts', origin: 'ui' }]);
    expect(doorsIn('trail.channel(`automation`);')).toEqual([{ file: 'f.ts', origin: 'automation' }]);
    expect(doorsIn("trail.channel('cli' as const);")).toEqual([{ file: 'f.ts', origin: 'cli' }]);
  });

  it('B7 — a line break inside the call reads', () => {
    expect(doorsIn("trail.channel(\n  'ui',\n);")).toEqual([{ file: 'f.ts', origin: 'ui' }]);
  });

  it('B6 — a non-literal origin is recorded, not skipped, so it fails loudly', () => {
    const [site] = doorsIn('trail.channel(ORIGIN);');
    expect(site?.origin).toMatch(/^<non-literal: ORIGIN/);
  });

  it('B9 — `.channel` without a call is recorded as a bare reference', () => {
    expect(doorsIn('const open = trail.channel.bind(trail);')).toEqual([
      { file: 'f.ts', origin: '<bare reference, not a call>' },
    ]);
  });

  it('B8 — `new AuditChannel(trail, origin)` is recorded separately', () => {
    const { constructions } = scanFile(join(REPO_ROOT, 'f.ts'), withoutComments("new AuditChannel(trail, 'automation');"));
    expect(constructions).toEqual([{ file: 'f.ts', origin: 'automation' }]);
  });

  it('still removes real comments, so a documented call is not a door', () => {
    expect(doorsIn("/* trail.channel('ui') */\n// trail.channel('cli')\ntrail.channel('mcp');")).toEqual([
      { file: 'f.ts', origin: 'mcp' },
    ]);
  });

  it("an apostrophe inside a comment does not open a string", () => {
    expect(doorsIn("// don't let this open a string\ntrail.channel('mcp');")).toEqual([{ file: 'f.ts', origin: 'mcp' }]);
  });

  it('a template substitution is still scanned as code', () => {
    expect(doorsIn('const s = `a${trail.channel("ui")}b`;')).toEqual([{ file: 'f.ts', origin: 'ui' }]);
  });

  it('a regex literal containing quotes does not open a string', () => {
    expect(doorsIn("const re = /['\"]/g;\ntrail.channel('mcp');")).toEqual([{ file: 'f.ts', origin: 'mcp' }]);
  });

  it('division is not mistaken for a regex literal', () => {
    expect(withoutComments("const r = a / b; const s = 'kept';")).toContain("'kept'");
  });
});
