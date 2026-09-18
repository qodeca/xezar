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
      'taken beside it in every layout (.xez-skills-update.lock). The PROJECT half\'s cross-process lock ' +
      'follows the layout (`cacheDir`); neither the mirror nor its machine-wide lock moves.',
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

  // ---- 3. Host-install records: FR-8.2 keeps them on the machine (SP-2.5). ------------
  // A hosted install describes the HOST — its systemd unit, its nginx site, its launchd
  // plist, its ngrok policy. A cockpit serving a single-project root is still installed on
  // one machine, and putting a unit file inside a git repository would commit one host's
  // service definition to every clone of it.
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

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    const lines = stripComments(readFileSync(path, 'utf8')).split('\n');
    lines.forEach((raw, index) => {
      const code = raw.trim();
      const kinds: string[] = [];
      if (HOMEDIR_CALL.test(code)) kinds.push('homedir()');
      if (XEZAR_PATH_LITERAL.test(code)) kinds.push("'.xezar' path");
      if (file !== RESOLVER_FILE && GLOBAL_LAYOUT_CALL.test(code)) kinds.push('global layout');
      if (kinds.length > 0) findings.push({ file, line: index + 1, code, kinds: kinds.join(' + ') });
    });
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
});
