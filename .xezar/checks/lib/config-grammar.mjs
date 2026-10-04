// The grammar of the list keys the kit's guarded workflows read from
// `.xezar/pipeline/config.json`, and one function that judges a config against it.
//
// Why a grammar at all. `pipeline_config_list` answers an absent key, a misspelt key, an object
// where a list belongs and an honest `[]` with the same empty list — deliberately, because for a
// list of CI job names "none stated" is a fact. For these keys it is not: an empty list means
// "this project has no deploy", and the workflow refuses on it. A typo must never look like that.
// So a guarded workflow asks here first, and gets one of four answers it can tell apart.
//
// The values become arguments to `gh`, so they are validated, never sanitised: a value that is not
// the shape it claims to be is a refusal.

export const GRAMMAR = {
  "deploy.environments": {
    element: /^[a-z0-9][a-z0-9-]*=[A-Za-z0-9._-]+\.ya?ml$/,
    shape: "<environment>=<workflow file>, e.g. staging=deploy.yml — a file name, never a path",
  },
  "deploy.rollback": {
    element: /^[a-z0-9][a-z0-9-]*=[A-Za-z0-9._-]+\.ya?ml$/,
    shape: "<environment>=<workflow file>, e.g. staging=rollback.yml — a file name, never a path",
  },
  "performance.budgets": {
    element: /^[a-z0-9][a-z0-9-]*=p(50|75|90|95|99)<[0-9]+(\.[0-9]+)?@n=([5-9]|[1-9][0-9]+)$/,
    shape: "<metric>=p<percentile><<limit>@n=<runs>, e.g. cold-start-ms=p95<400@n=20 — a percentile and at least five runs, because one sample is not a measurement",
  },
  "localisation.locales": {
    element: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    shape: "a locale tag, e.g. pl or pt-BR",
  },
};

/**
 * Judge one key. Returns { status, detail, values }, status one of:
 *   ok         the list is there, non-empty, every element is the right shape
 *   empty      the key is there and is `[]` — the owner's honest "this project has none"
 *   absent     the key is not there at all
 *   malformed  anything else: unknown sibling key, not a list, an element of the wrong shape
 * `empty` and `absent` are both a refusal, and they are different sentences on purpose.
 */
export function judge(config, key) {
  const rule = GRAMMAR[key];
  if (!rule) return { status: "malformed", detail: `"${key}" is not a key this kit reads`, values: [] };
  const [group, leaf] = key.split(".");
  const node = config?.[group];
  if (node !== undefined && (node === null || typeof node !== "object" || Array.isArray(node))) {
    return { status: "malformed", detail: `"${group}" must be an object`, values: [] };
  }
  const value = node?.[leaf];
  if (value === undefined) {
    // The key is missing. A sibling the kit does not know is then the typo this whole file exists
    // for. Only then: when the key IS present there is nothing it could be a typo of, and refusing
    // on an unknown neighbour would break every installed copy of this grammar the day a later
    // release adds a key beside these.
    for (const sibling of Object.keys(node ?? {})) {
      if (!GRAMMAR[`${group}.${sibling}`]) {
        return { status: "malformed", detail: `"${key}" is not set, and "${group}.${sibling}" is not a key this kit reads — a misspelt key must not read as "none configured"`, values: [] };
      }
    }
    return { status: "absent", detail: `"${key}" is not set`, values: [] };
  }
  if (!Array.isArray(value)) return { status: "malformed", detail: `"${key}" must be a list of strings`, values: [] };
  if (value.length === 0) return { status: "empty", detail: `"${key}" is []`, values: [] };
  for (const element of value) {
    if (typeof element !== "string" || !rule.element.test(element)) {
      return { status: "malformed", detail: `"${key}" holds ${JSON.stringify(element)}, which is not ${rule.shape}`, values: [] };
    }
  }
  const names = value.map((element) => element.split("=")[0]);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) {
    return { status: "malformed", detail: `"${key}" names "${twice}" twice`, values: [] };
  }
  // A rollback for an environment nobody can deploy to is a list somebody half edited.
  if (key === "deploy.rollback") {
    const deployable = (Array.isArray(node?.environments) ? node.environments : [])
      .filter((element) => typeof element === "string")
      .map((element) => element.split("=")[0]);
    const orphan = names.find((name) => !deployable.includes(name));
    if (orphan !== undefined) {
      return { status: "malformed", detail: `"deploy.rollback" names "${orphan}", which "deploy.environments" does not list`, values: [] };
    }
  }
  return { status: "ok", detail: `${value.length} entr${value.length === 1 ? "y" : "ies"}`, values: value };
}

// --- security.trustBoundaries -----------------------------------------------------------------
//
// A project's own trust-boundary paths, added to the kit's list in `security-scan.mjs`. Each
// element is `{ "pattern": "<glob>", "why": "<one line>" }`. Absent or `[]` means no project
// entries; the kit's list applies either way and can never be removed or weakened from here.
//
// The patterns are contributor-controlled input, so they are never turned into a regular
// expression. They are parsed into tokens and matched by a hand-written simulation whose cost is
// bounded by path length times pattern length — no backtracking, no glob library. The grammar is
// deliberately small: literals, `?` (one character other than `/`), `*` (any run of characters
// other than `/`) and `**` (a whole segment: any run of characters, `/` included; a leading or
// inner `**/` also matches zero folders). Anything with a second meaning in some glob dialect —
// `!`, braces, extglobs, character classes, regex characters — is refused rather than guessed at.

export const TRUST_BOUNDARY_LIMITS = { entries: 64, length: 256 };

// `!` negation, `{}` braces, `()` extglobs, `[]` character classes, and the regex characters
// that are not ordinary in a path (`.` is: it is a literal here, as in every file name).
const TRUST_PATTERN_REFUSED = /[!{}()[\]^$|\\+]/;

/**
 * Parse one pattern into tokens. Returns { tokens } or { error }.
 * Token kinds: "lit" (one character), "any1" (`?`), "star" (`*`), "globstar" (`**` as the last
 * segment), "globdir" (`**\/` — zero or more whole folders).
 */
export function parseTrustPattern(pattern) {
  if (typeof pattern !== "string" || pattern === "") return { error: "the pattern must be a non-empty string" };
  if (pattern.length > TRUST_BOUNDARY_LIMITS.length) return { error: `the pattern is longer than ${TRUST_BOUNDARY_LIMITS.length} characters` };
  const refused = TRUST_PATTERN_REFUSED.exec(pattern);
  if (refused) return { error: `"${refused[0]}" is not allowed; a pattern holds literals, ?, * and ** only (no negation, braces, extglobs, character classes or regex characters)` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return { error: "the pattern holds a control character" };
  if (pattern.startsWith("/")) return { error: "the pattern must be relative to the repository root, with no leading /" };
  if (pattern.endsWith("/")) return { error: "the pattern ends with /; write <folder>/** for everything under a folder" };
  const segments = pattern.split("/");
  if (segments.some((s) => s === "")) return { error: "the pattern holds an empty segment (//)" };
  if (segments.some((s) => s === "." || s === "..")) return { error: "the pattern holds a . or .. segment" };
  const tokens = [];
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      tokens.push({ kind: last ? "globstar" : "globdir" });
      return;
    }
    if (segment.includes("**")) { tokens.error = `"${segment}": ** must be a whole segment`; return; }
    for (const ch of segment) tokens.push(ch === "*" ? { kind: "star" } : ch === "?" ? { kind: "any1" } : { kind: "lit", ch });
    if (!last) tokens.push({ kind: "lit", ch: "/" });
  });
  if (tokens.error) return { error: tokens.error };
  return { tokens };
}

/**
 * Does `path` match the parsed `tokens`, whole path, anchored at both ends. A set-of-positions
 * simulation: every step advances each live position by one path character, so the cost is at
 * most path length × token count, whatever the pattern.
 */
export function matchTrustPattern(tokens, path) {
  const n = tokens.length;
  // State `i` is "about to match token i". A globdir (`**/`) has a second state, `n + 1 + i`,
  // "inside it": entered by consuming a character, and left only through a `/`. Only the first
  // may be skipped without consuming anything (zero folders); a folder begun must be finished.
  const inside = (i) => n + 1 + i;
  const skippable = (i) => i < n && (tokens[i].kind === "star" || tokens[i].kind === "globstar" || tokens[i].kind === "globdir");
  const close = (set) => {
    const stack = [...set];
    while (stack.length) {
      const i = stack.pop();
      if (skippable(i) && !set.has(i + 1)) {
        set.add(i + 1);
        stack.push(i + 1);
      }
    }
    return set;
  };
  let live = close(new Set([0]));
  for (const ch of path) {
    const next = new Set();
    for (const s of live) {
      if (s > n) {
        // inside a globdir: any character keeps it open, a `/` may also close it
        next.add(s);
        if (ch === "/") next.add(s - n);
        continue;
      }
      if (s === n) continue;
      const t = tokens[s];
      if (t.kind === "lit") { if (t.ch === ch) next.add(s + 1); }
      else if (t.kind === "any1") { if (ch !== "/") next.add(s + 1); }
      else if (t.kind === "star") { if (ch !== "/") next.add(s); }
      else if (t.kind === "globstar") next.add(s);
      else if (t.kind === "globdir") { if (ch !== "/") next.add(inside(s)); }
    }
    if (next.size === 0) return false;
    live = close(next);
  }
  return live.has(n);
}

/**
 * Judge `security.trustBoundaries`. Returns { status, detail, entries }, status one of:
 *   ok         a non-empty list, every element valid; `entries` carry their parsed tokens
 *   empty      the key is `[]` — no project entries
 *   absent     the key (or the whole `security` object) is not there — no project entries
 *   malformed  anything else. The scan routes a malformed list to review; it never reads it as
 *              "no project entries", and it never applies part of it.
 */
export function judgeTrustBoundaries(config) {
  const key = "security.trustBoundaries";
  const node = config?.security;
  if (node !== undefined && (node === null || typeof node !== "object" || Array.isArray(node))) {
    return { status: "malformed", detail: `"security" must be an object`, entries: [] };
  }
  const value = node?.trustBoundaries;
  if (value === undefined) return { status: "absent", detail: `"${key}" is not set`, entries: [] };
  if (!Array.isArray(value)) return { status: "malformed", detail: `"${key}" must be a list of { pattern, why }`, entries: [] };
  if (value.length === 0) return { status: "empty", detail: `"${key}" is []`, entries: [] };
  if (value.length > TRUST_BOUNDARY_LIMITS.entries) {
    return { status: "malformed", detail: `"${key}" has ${value.length} entries; at most ${TRUST_BOUNDARY_LIMITS.entries} are read`, entries: [] };
  }
  const entries = [];
  for (const [index, element] of value.entries()) {
    const at = `"${key}"[${index}]`;
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      return { status: "malformed", detail: `${at} must be an object { pattern, why }`, entries: [] };
    }
    const extra = Object.keys(element).find((k) => k !== "pattern" && k !== "why");
    if (extra !== undefined) return { status: "malformed", detail: `${at} has "${extra}", which is not a field this kit reads (pattern, why)`, entries: [] };
    const parsed = parseTrustPattern(element.pattern);
    if (parsed.error) return { status: "malformed", detail: `${at} pattern ${JSON.stringify(element.pattern)}: ${parsed.error}`, entries: [] };
    const why = element.why;
    // eslint-disable-next-line no-control-regex
    if (typeof why !== "string" || why.trim() === "" || why.length > TRUST_BOUNDARY_LIMITS.length || /[\u0000-\u001f\u007f]/.test(why)) {
      return { status: "malformed", detail: `${at} needs a "why": one line of at most ${TRUST_BOUNDARY_LIMITS.length} characters saying what the path decides`, entries: [] };
    }
    entries.push({ pattern: element.pattern, why: why.trim(), tokens: parsed.tokens });
  }
  return { status: "ok", detail: `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`, entries };
}
