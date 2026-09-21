import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of DC-1 (#600, SP-2.1).
 *
 * Single-project mode's premortem failure is HALF-isolation: the mode is on,
 * the boot line says so, the four files are in the folder — and one forgotten
 * code path still joins `homedir()` with `.xezar` and reads the machine's
 * shared state. Two projects then quietly share settings, accounts or limits,
 * and nothing in the product says a word. Every other test in this feature
 * asserts that a path xezar was ASKED for resolves correctly; only this one can
 * say that no OTHER path exists.
 *
 * So it reads the source text of `packages/xezar/src` and fails on a direct
 * `homedir()` call or a `'.xezar'` path literal anywhere outside an allowlist
 * where every entry carries a written reason. It is a text scan on purpose: a
 * runtime assertion can only observe the call sites a test happens to drive,
 * and the call site that matters is by definition the one nobody thought of.
 *
 * ## Adding an entry
 *
 * Do not, unless the answer to "does this path move when the state does?" is
 * genuinely no. It is no for exactly three kinds of path, and they are the
 * three the allowlist below is grouped into: the resolver itself, the USER's
 * own host config (agent homes, global skill libraries, `~/Applications` —
 * BR-7/SP-2.3 leave these where they are), and the host-INSTALL records
 * FR-8.2 names. Anything that is xezar's own state belongs on a `StateLayout`.
 *
 * An entry is matched on the file AND the exact source line, so a call site
 * that changes shape has to be re-justified rather than inherited, and a stale
 * entry fails the test as loudly as a new call does.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** `homedir()` invoked, as code rather than as prose about it. */
const HOMEDIR_CALL = /\bhomedir\s*\(/;

/**
 * A string literal that IS a `.xezar` path — `'.xezar'`, `'.xezar/skills'` —
 * rather than the many harmless mentions of the word: help text, a
 * `mcp_servers.xezar` TOML key, `metadata?.xezar`, a package identifier. What
 * DC-1 is defending against is a path being BUILT, and a built path starts at
 * the first segment of its literal.
 */
const XEZAR_PATH_LITERAL = /(['"`])\.xezar(?:[/\\][^'"`]*)?\1/;

/**
 * The global layout named DIRECTLY, from outside the resolver (#600 SP-5.1).
 *
 * `globalStateLayout()` and `globalStateRoot()` answer `~/.xezar` whatever mode is in force — that
 * is their job inside the resolver, and it is exactly what makes a call from anywhere else a
 * half-isolation leak: the line reads like a resolution through `state-layout.ts`, so the two
 * rules above never see it, and in the mode it opens the home all the same. The one-time import
 * from the global setup is the deliberate exception, and it is on the allowlist below by name.
 */
const GLOBAL_LAYOUT_CALL = /\bglobalState(?:Layout|Root)\s*\(/;

/**
 * `homedir` imported under ANOTHER name (#644 Minor 3) — `import { homedir as __hd } from 'node:os'`.
 *
 * The call `__hd()` matches no rule above, so an aliased import is the one line that still
 * spells `homedir` and the one that says the call is being renamed away from it. A plain
 * `import { homedir } from 'node:os'` is deliberately NOT a finding: every call of it is caught
 * by `homedir()` above, and flagging the import would add an allowance per importer for no gain.
 */
const HOMEDIR_ALIAS_IMPORT = /\bhomedir\s+as\s+[\w$]+/;

/**
 * The per-user home read straight out of the environment (#644 Minor 3) — `process.env.HOME`,
 * `process.env.USERPROFILE`. It is a third spelling of the same path, and one the two rules
 * above never see because it never mentions `homedir` or builds a `'.xezar'` literal.
 *
 * An injected `NodeJS.ProcessEnv` (`env.HOME`) is deliberately NOT matched: that is how
 * `agentHomePaths` and `claudeStateFilePath` resolve the agent homes, which SP-2.3 keeps on the
 * host, and those call sites stay allowlisted below rather than banned here.
 */
const PROCESS_HOME_READ = /\bprocess\.env\.(?:HOME|USERPROFILE)\b/;

/**
 * A `.xezar` path built inside a TEMPLATE literal (#644 Minor 3) — `` `${root}/.xezar/skills` ``.
 *
 * `XEZAR_PATH_LITERAL` only fires when `.xezar` follows an opening quote, so it misses the
 * segment after an interpolation or after a leading separator. This rule fires on `.xezar`
 * preceded by a path separator that either follows a `${…}` or opens the template, which is
 * what "building a path" looks like there. It deliberately does NOT fire on prose that merely
 * mentions `~/.xezar/config.json` inside a template — a message is not a path.
 */
const TEMPLATE_XEZAR_PATH = /`(?:[^`]*\$\{[^}]*\})?[\\/]\.xezar/;

/**
 * `xezarHomeDir(` invoked (#644 Minor 4) — the wrapper around `globalStateRoot()`/`homedir()`.
 *
 * It answers the PER-USER home on purpose (FR-8.2, SP-2.5), so the call sites below are
 * legitimate — but a NEW caller of the wrapper is a state path just like a direct `homedir()`
 * and now needs a written reason. The declaration itself (`export function xezarHomeDir(`) is
 * not an invocation and is excluded by the lookbehind; an import of the name does not call it.
 */
const XEZAR_HOME_CALL = /(?<!function )\bxezarHomeDir\s*\(/;

/** The resolver itself, where the global layout is defined and legitimately composed. */
const RESOLVER_FILE = 'state-layout.ts';

interface Allowance {
  /** Repo-relative path, POSIX separators. */
  readonly file: string;
  /** The source line, trimmed, exactly as it appears after comments are removed. */
  readonly code: string;
  /** How many times that identical line legitimately appears in the file. */
  readonly count?: number;
  /** Why this path does NOT move with the state. Required, and read by humans. */
  readonly reason: string;
}

const ALLOWED: readonly Allowance[] = [
  // ---- 1. The resolver itself (DC-1). ------------------------------------------------
  {
    file: 'state-layout.ts',
    code: "return (env.XEZ_HOME || undefined) ?? join(homedir(), PROJECT_STATE_DIR);",
    reason:
      'globalStateRoot — THE one expression in the repository that joins the user home with .xezar. ' +
      'Every other state path in the product is derived from the StateLayout this module returns.',
  },
  {
    file: 'state-layout.ts',
    code: "export const PROJECT_STATE_DIR = '.xezar';",
    reason: 'The name of the state directory, declared once so no call site spells it again.',
  },
  {
    file: 'state-layout.ts',
    code: "return join(homedir(), '.cache', 'xez');",
    reason:
      'globalCacheRoot — the global layout\'s skills cache, byte for byte what skills-remote.ts ' +
      'hardcoded before this module existed. The project layout moves it (AC-5); this branch is what it moves FROM.',
  },
  {
    file: 'state-layout.ts',
    code: 'return real(dir) === real(homedir());',
    reason:
      'isUserHome — the rule that $HOME is never a single-project root. It must compare against the ' +
      'REAL home to refuse it, which is the opposite of resolving state there.',
  },

  {
    file: 'paths.ts',
    code: 'return globalStateRoot(env);',
    reason:
      'xezarHomeDir — the PER-USER home, which in the mode is still where the host-install records live ' +
      '(FR-8.2, SP-2.5). It answers "what is this machine configured with", never "where is my state".',
  },
  {
    file: 'workspace/import-global.ts',
    code: 'return globalStateLayout(env);',
    reason:
      'The one deliberate exception to BR-2 (#600 FR-4, SP-5.1): the first run of the mode reads the global ' +
      'setup ONCE, read-only, before the project files exist and only after the person answered yes, and ' +
      'never writes there. Named in BACKWARD_COMPATIBILITY.md; every read in that module goes through this line.',
  },
  {
    file: 'workspace/import-global.ts',
    code: 'const globalAccountsPath = globalStateLayout(env).accountsPath;',
    reason:
      'countImportableGlobalAccounts — the SECOND read of the global setup, granted by the owner ("Allow the ' +
      'count", 2026-09-21, #819 PR 9) so the cockpit can offer "Copy {n} accounts". Read-only, a NUMBER only ' +
      '(no id, label, provider or path leaves the function), fails to 0, project layout only. Its own ' +
      'BACKWARD_COMPATIBILITY.md entry; kept on its own line so it cannot hide behind the first-run exception.',
  },

  // ---- 2. The user's own host config: it stays on the host (BR-7, SP-2.3). -----------
  {
    file: 'paths.ts',
    code: "const realHome = join(homedir(), '.xezar');",
    reason:
      'assertXezarHomeWriteIsSandboxed — a REFUSAL, not a resolution. It has to name the developer\'s ' +
      'real ~/.xezar precisely in order to fail a test run that would write there.',
  },
  {
    file: 'paths.ts',
    code: "if (path === '~') return homedir();",
    reason: "expandTilde — expands a `~` the USER wrote into a stored browse/checkout root. Their home, their path.",
  },
  {
    file: 'paths.ts',
    code: "return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;",
    reason: 'expandTilde, same call. See above.',
  },
  {
    file: 'paths.ts',
    code: 'const home = env.HOME || env.USERPROFILE || homedir();',
    reason:
      'agentHomePaths — CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR and PI_CODING_AGENT_DIR resolve ' +
      'exactly as they do outside the mode (SP-2.3). An agent login is the machine\'s, not the project\'s; ' +
      'moving it would log the user out of a folder rather than isolate it.',
  },
  {
    file: 'paths.ts',
    code: "|| claudeHome !== join(env.HOME || env.USERPROFILE || homedir(), '.claude');",
    reason: "claudeStateFilePath — reads Claude Code's own state file beside its own home. Same rule as agentHomePaths.",
  },
  {
    file: 'skills.ts',
    code: "{ dir: join(homedir(), '.agents/skills'), source: 'global' },",
    reason:
      "The user's own global skill library, written by `npx skills` and not by xezar. Content on the host, " +
      'in the same category as the agent logins. What the mode DOES move is xezar\'s cache of team skills (xezCacheDir).',
  },
  {
    file: 'skills.ts',
    code: "{ dir: join(homedir(), '.claude/skills'), source: 'global' },",
    reason: 'The `npx skills` mirror in the Claude home. Same reason as ~/.agents/skills above.',
  },
  {
    file: 'skills-update.ts',
    code: 'this.home = options.homeDir ?? homedir();',
    reason:
      'Locates ~/.agents/.skill-lock.json, the global mirror this service updates, and the machine-wide lock ' +
      'taken beside it only while a global check or apply will really run (.xez-skills-update.lock). The PROJECT ' +
      "half's cross-process lock follows the layout (`cacheDir`); neither the mirror nor its machine-wide lock moves.",
  },
  {
    file: 'core/gate-lease.ts',
    code: "return join(homedir(), '.cache', 'xez', 'gate-slots');",
    reason:
      'gateLeaseDir — the gate lease is MACHINE-wide by definition (#672 Q6). It arbitrates one disk, one page ' +
      'cache and one pool of vitest workers, and the failures it exists to prevent were measured across ' +
      'checkouts, not inside one. Resolving it through xezCacheDir would give two single-project folders a set ' +
      'of slots each and they would not contend — the lease would render, test green and prevent nothing. Same ' +
      "category as skills-update.ts's machine-wide lock above: a host artifact that never moves with the state.",
  },
  {
    file: 'server/open-in-app.ts',
    code: "join(homedir(), 'Applications', `${name}.app`),",
    count: 2,
    reason: 'Per-user application discovery on macOS. Not xezar state; the editor a user installed is the host\'s.',
  },
  {
    file: 'workspace/projects.ts',
    code: 'const home = await normalizeRoot(homedir());',
    reason:
      'shouldRegisterProject — the rule that $HOME itself is never registered as a project. Like isUserHome ' +
      'above it must name the real home to REFUSE it.',
  },
  {
    file: 'mcp/tools/project-config.ts',
    code: 'const home = process.env.HOME;',
    reason:
      'scrubPaths — reads the home only to REPLACE it with `~` in error text a tool reports. A redaction, ' +
      'not a resolution: it removes the home path from what the leader sees and derives no state from it.',
  },

  // ---- 3. Host-install records: FR-8.2 keeps them on the machine (SP-2.5). ------------
  // A hosted install describes the HOST — its systemd unit, its nginx site, its launchd
  // plist, its ngrok policy. A cockpit serving a single-project root is still installed on
  // one machine, and putting a unit file inside a git repository would commit one host's
  // service definition to every clone of it.
  {
    file: 'paths.ts',
    code: "return join(xezarHomeDir(), 'server-instances');",
    reason:
      'serverInstancesDir — the per-domain server-install records. xezarHomeDir() is the PER-USER home for ' +
      'exactly these host-install files (FR-8.2, SP-2.5), never the project state root.',
  },
  {
    file: 'paths.ts',
    code: "if (instance === DEFAULT_SERVER_INSTANCE) return join(xezarHomeDir(), 'server.json');",
    reason:
      'serverStatePath\'s default instance — the legacy `~/.xezar/server.json` an existing host install ' +
      'upgrades in place. A host-install record, so it stays on the machine (FR-8.2).',
  },
  {
    file: 'paths.ts',
    code: "if (instance === DEFAULT_SERVER_INSTANCE) return join(xezarHomeDir(), 'server.install.lock');",
    reason:
      'serverLockPath\'s default instance — the host installer\'s single-writer lock, per instance and on ' +
      'the machine. A host-install record, not project state (FR-8.2).',
  },
  {
    file: 'server-install/platforms/macosx-ngrok.ts',
    code: "const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);",
    reason: 'launchd agent for the ngrok tunnel — a host service definition.',
  },
  {
    file: 'server-install/platforms/macosx-ngrok.ts',
    code: "const trafficPolicyPath = (): string => join(homedir(), 'Library', 'Application Support', 'xezar', 'ngrok-traffic-policy.json');",
    reason: 'The ngrok traffic policy the host launchd agent loads, beside it.',
  },
  {
    file: 'server-install/platforms/macosx-ngrok.ts',
    code: "mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });",
    count: 2,
    reason: 'Creates the launchd directory the two plists above live in.',
  },
  {
    file: 'server-install/platforms/macosx-ngrok.ts',
    code: "const xezarPlistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${XEZAR_PLIST_LABEL}.plist`);",
    reason: 'launchd agent for the cockpit itself — a host service definition.',
  },
  {
    file: 'server-install/platforms/ubuntu-vps.ts',
    code: "const base = process.env.npm_config_cache?.trim() || join(homedir(), '.npm');",
    reason: "npm's own cache on the host, probed during an install. Not xezar state at all.",
  },
  {
    file: 'server-install/platforms/ubuntu-vps.ts',
    code: "const unitPath = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);",
    reason: 'The user systemd unit for the installed cockpit — a host service definition.',
  },
  {
    file: 'server-install/platforms/ubuntu-vps.ts',
    code: "mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });",
    reason: 'Creates the directory that unit lives in.',
  },
  {
    file: 'server-install/platforms/ubuntu-vps.ts',
    code: "const userUnitExists = existsSync(join(homedir(), '.config', 'systemd', 'user', UNIT_NAME));",
    reason: 'Reads whether that unit is already installed.',
  },

  // ---- 4. `<repo>/.xezar` the KIT, which is not `~/.xezar` the state. ------------------
  // These are repo-RELATIVE and always were. They resolve against a repository root the
  // caller passes in, never against a home, so the mode does not move them — and in the
  // mode they land in the same directory as the state by design (project-kit-paths.ts).
  {
    file: 'project-kit-paths.ts',
    code: "export const PROJECT_KIT_DIR = '.xezar';",
    reason: 'The project kit directory: workflows, skills and the project config, repo-relative.',
  },
  {
    file: 'project-kit-paths.ts',
    code: 'if ([xezarHomeDir(), xezarHomeDir({})].some(home => resolve(home) === resolve(canonical))) {',
    reason:
      'projectKitDir\'s `~`-launch diversion — it names the per-user home only to COMPARE it with the repo ' +
      'root, so a home-directory launch never turns the user\'s workspace file into a kit.',
  },
  {
    file: 'skills.ts',
    code: "{ dir: '.xezar/skills', source: 'xezar' },",
    reason: 'Kit skills, discovered relative to a repo root.',
  },
  {
    file: 'workflows/load.ts',
    code: "export const WORKFLOWS_DIR = '.xezar/workflows';",
    reason: 'Kit workflows, loaded relative to a repo root.',
  },
];

/**
 * Blank out comments so prose about `homedir()` — of which this repository has
 * a great deal, including in this file's own neighbours — is never a finding,
 * while string literals are kept, because a path literal is exactly what the
 * scan is looking for.
 */
export function stripComments(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; i++; continue; }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; i++; continue; }
      if (char === "'" || char === '"' || char === '`') { state = char; out += char; continue; }
      out += char;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char; } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; i++; } else out += char === '\n' ? char : ' ';
      continue;
    }
    // Inside a string: copy through, honour escapes, close on the matching quote.
    out += char;
    if (char === '\\') { out += source[i + 1] ?? ''; i++; continue; }
    if (char === state) state = 'code';
  }
  return out;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  /** Which rules the line tripped — one line can trip both, and one allowance excuses it once. */
  readonly kinds: string;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...sourceFiles(path)); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Tests and test kits are not product code: a fixture legitimately builds a
    // fake home, and pinning the real one is how `home-safety.test.ts` proves
    // the product never touches it.
    if (/\.(test|testkit)\.tsx?$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

/**
 * Run the whole rule set over one file's source text.
 *
 * Exported so a probe can feed a synthetic spelling through the REAL scan rather than
 * re-testing a regex the scan might stop applying — a probe that exercises `findingsIn` fails
 * when the rule is dropped from the scan, not merely when the regex is deleted.
 */
export function findingsIn(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  stripComments(source).split('\n').forEach((raw, index) => {
    const code = raw.trim();
    const kinds: string[] = [];
    if (HOMEDIR_CALL.test(code)) kinds.push('homedir()');
    if (HOMEDIR_ALIAS_IMPORT.test(code)) kinds.push('aliased homedir import');
    if (PROCESS_HOME_READ.test(code)) kinds.push('process.env home');
    if (XEZAR_PATH_LITERAL.test(code)) kinds.push("'.xezar' path");
    if (TEMPLATE_XEZAR_PATH.test(code)) kinds.push('template .xezar path');
    if (XEZAR_HOME_CALL.test(code)) kinds.push('xezarHomeDir()');
    if (file !== RESOLVER_FILE && GLOBAL_LAYOUT_CALL.test(code)) kinds.push('global layout');
    if (kinds.length > 0) findings.push({ file, line: index + 1, code, kinds: kinds.join(' + ') });
  });
  return findings;
}

/** The finding kinds for a synthetic source, joined so a probe can assert on a substring. */
function kindsIn(source: string, file = 'probe.ts'): string {
  return findingsIn(file, source).map((f) => f.kinds).join(' | ');
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    findings.push(...findingsIn(file, readFileSync(path, 'utf8')));
  }
  return findings;
}

describe('no state path is derived outside the resolver (#600 DC-1)', () => {
  it('finds nothing in packages/xezar/src that the allowlist does not explain', () => {
    const budget = new Map<string, number>();
    for (const entry of ALLOWED) {
      const key = `${entry.file} ${entry.code}`;
      budget.set(key, (budget.get(key) ?? 0) + (entry.count ?? 1));
    }

    const unexplained: Finding[] = [];
    for (const finding of scan()) {
      const key = `${finding.file} ${finding.code}`;
      const left = budget.get(key) ?? 0;
      if (left > 0) budget.set(key, left - 1);
      else unexplained.push(finding);
    }

    expect(
      unexplained.map((f) => `packages/xezar/src/${f.file}:${f.line}  ${f.kinds}  ${f.code}`),
      'A state path is being derived outside state-layout.ts. Resolve it through activeStateLayout() ' +
        '(or xezCacheDir()/agentHomePaths() where those are the right answer). If the path genuinely does ' +
        'not move with the state, add it to ALLOWED in this file WITH a reason.',
    ).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const remaining = new Map<string, number>();
    for (const entry of ALLOWED) {
      const key = `${entry.file} ${entry.code}`;
      remaining.set(key, (remaining.get(key) ?? 0) + (entry.count ?? 1));
    }
    for (const finding of scan()) {
      const key = `${finding.file} ${finding.code}`;
      const left = remaining.get(key);
      if (left) remaining.set(key, left - 1);
    }
    // A leftover allowance is an exception that has outlived the call site it
    // excused. Left in place it silently pre-approves the next line that happens
    // to match it, which is how an allowlist stops being one.
    expect(
      [...remaining].filter(([, left]) => left > 0).map(([key, left]) => `${key.replace(' ', ': ')}  (${left} unused)`),
      'An allowlist entry matches nothing any more — delete it.',
    ).toEqual([]);
  });

  it('every allowlist entry carries a written reason', () => {
    for (const entry of ALLOWED) {
      expect(entry.reason.trim().length, `${entry.file}: ${entry.code}`).toBeGreaterThan(30);
    }
  });

  it('reads code and not prose — a comment mentioning homedir() is not a finding', () => {
    const stripped = stripComments(
      ['// do not call homedir() here', '/* homedir() is wrong */', "const a = '.xezar';", 'const b = 1;'].join('\n'),
    ).split('\n');
    expect(HOMEDIR_CALL.test(stripped[0]!)).toBe(false);
    expect(HOMEDIR_CALL.test(stripped[1]!)).toBe(false);
    expect(XEZAR_PATH_LITERAL.test(stripped[2]!)).toBe(true);
  });

  it('names the global layout only as a call — an import or a mention is not a finding', () => {
    expect(GLOBAL_LAYOUT_CALL.test('const global = globalStateLayout(env);')).toBe(true);
    expect(GLOBAL_LAYOUT_CALL.test('return globalStateRoot();')).toBe(true);
    expect(GLOBAL_LAYOUT_CALL.test("import { activeStateLayout, globalStateRoot } from './state-layout.ts';")).toBe(false);
    expect(GLOBAL_LAYOUT_CALL.test('const layout = activeStateLayout();')).toBe(false);
  });

  it('reads a path literal and not the word — `metadata.xezar` and help text are not findings', () => {
    expect(XEZAR_PATH_LITERAL.test('const marker = asMarker(part?.metadata?.xezar);')).toBe(false);
    expect(XEZAR_PATH_LITERAL.test("snippet: ['[mcp_servers.xezar]'].join('');")).toBe(false);
    expect(XEZAR_PATH_LITERAL.test('`and the registry live in .xezar/, working files in`')).toBe(false);
    expect(XEZAR_PATH_LITERAL.test("join(home, '.xezar', 'scratch')")).toBe(true);
    expect(XEZAR_PATH_LITERAL.test("join(home, '.xezar/skills')")).toBe(true);
  });

  // ---- The three spellings the first scan missed (Minor 3, #644). ---------------------
  //
  // Each probe feeds a synthetic SOURCE through `findingsIn` — the real rule set — so it fails
  // when a rule is dropped from the scan, not merely when a regex constant changes. Each was
  // RED before the rule below was added; the red output is recorded in the task's evidence.

  it('flags a home path read from process.env (Minor 3)', () => {
    expect(kindsIn('const home = process.env.HOME;\n')).toContain('process.env home');
    expect(kindsIn('const home = process.env.USERPROFILE;\n')).toContain('process.env home');
    // The `env.HOME` an injected `NodeJS.ProcessEnv` carries is NOT this: it is how the agent
    // homes resolve on purpose (SP-2.3), and it stays allowlisted rather than banned.
    expect(kindsIn("const home = env.HOME || env.USERPROFILE || homedir();\n")).not.toContain('process.env home');
  });

  it('flags a `homedir` import aliased to another name (Minor 3)', () => {
    const source = [
      "import { homedir as __hd } from 'node:os';",
      "const cache = join(__hd(), '.cache', 'xez', 'skills');",
    ].join('\n');
    // `__hd()` matches no call rule — the import specifier is the only line that still spells
    // `homedir`, and the one that says the call is being renamed away from it.
    expect(kindsIn(source)).toContain('aliased homedir import');
    // A plain import is not a finding: every call of it is, by `homedir()` above.
    expect(kindsIn("import { homedir } from 'node:os';\n")).not.toContain('aliased homedir import');
  });

  it('flags a .xezar path built inside a template literal (Minor 3)', () => {
    expect(kindsIn('const dir = `${root}/.xezar/skills`;\n')).toContain('template .xezar path');
    // The spelling the issue names: an interpolated home AND a template-built path.
    expect(kindsIn('const scratch = `${process.env.HOME}/.xezar/scratch`;\n')).toContain('template .xezar path');
  });

  it('still reads prose about ~/.xezar inside a template literal as prose (control)', () => {
    // Passes both ways: this pins the behaviour the template rule must NOT change. A help line
    // that mentions the word is not a path being built, and the scan must keep saying so.
    expect(kindsIn('const line = `${n} projects are registered in ~/.xezar/config.json.`;\n')).toBe('');
    expect(kindsIn('const line = `the registry lives in .xezar/, working files elsewhere`;\n')).toBe('');
  });

  it('flags xezarHomeDir( — the wrapper is a state path like any other (Minor 4)', () => {
    expect(kindsIn("const dir = join(xezarHomeDir(), 'server.json');\n")).toContain('xezarHomeDir()');
  });

  it('does not flag the wrapper declaration or an import of it (Minor 4)', () => {
    expect(kindsIn('export function xezarHomeDir(env: NodeJS.ProcessEnv = process.env): string {\n')).toBe('');
    expect(kindsIn("import { xezarHomeDir } from './paths.ts';\n")).toBe('');
  });
});
