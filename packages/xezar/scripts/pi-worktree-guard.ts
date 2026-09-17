/**
 * Xezar's zero-config guard for pi sessions running in a linked Git worktree (#537).
 *
 * The process cwd is necessary but insufficient: pi's edit/write tools accept absolute paths,
 * and Bash can select another checkout. This extension keeps the task worktree as the project
 * tool root. It is loaded only for isolated worktree runs, and it is not an operating-system
 * sandbox. Its two checks have deliberately different strength:
 *
 * - `write` and `edit` are the HARD control. The `path` argument is normalised exactly the way
 *   pi 0.85.1 resolves it before writing (`resolveToCwd` → `normalizePath`: Unicode spaces become
 *   plain spaces, one leading `@` is stripped, `~` expands, a `file://` URL is decoded), symlinks
 *   and letter case are resolved by the operating system's own realpath, and any spelling that
 *   cannot be normalised with confidence is refused.
 * - `bash` is BEST-EFFORT defence in depth, not containment. A shell command string can never be
 *   parsed completely. The guard refuses what it can recognise and prefers a false block to a
 *   missed one:
 *   - A directory-change operand – `cd`, `pushd`, `-C` (`git -C`, `env -C`), `--chdir`,
 *     `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=` – must be ONE literal path. A
 *     variable, a `$(…)` or backtick substitution, a glob or brace character (`*`, `?`, `[`, `{`)
 *     and `~` followed by anything but `/` (`~user`, `~+`) are refused, not guessed. A literal
 *     operand is followed one segment at a time the way `chdir` does, so a symlink is read before
 *     the `..` after it; a `..` that follows a symlink (logical and physical parents differ) is
 *     refused. The target must stay out of the primary checkout, and a relative one may not climb
 *     out of the worktree.
 *   - A `CDPATH` or `OLDPWD` word anywhere refuses the command, an inherited `CDPATH` that names a
 *     different existing directory refuses that `cd`, and after a `HOME` word `~` and a bare `cd`
 *     are refused.
 *   - Any other word is a path MENTION (an argument, a redirect target): it blocks when it names a
 *     path in the primary checkout outside the worktree – absolute, `~`, `$HOME` or another known
 *     variable, `..` from the directory the command has reached, physically through a symlink, or
 *     an absolute or `~` glob whose literal directory lies above or inside the primary checkout.
 *     `~user` blocks. An unknown variable in a mention passes: it is everywhere in ordinary commands.
 *   Quoted scripts (`sh -c "…"`) are read twice, once with the quotes honoured and once without.
 *
 *   What it still cannot see, by construction: scripts and programs that build a path internally
 *   (`node x.js`, `make`, a hook), aliases and functions, `eval` or `sh -c` of text computed at
 *   run time, variables assigned inside the command and then used in a mention, a relative glob in
 *   a mention (`p*` matching a symlink), and any other process that changes directory itself.
 *
 * Xezar passes the roots as flags: the task worktree, the primary checkout it protects, and the
 * folders the run was granted outside its worktree (its handoff folder and task temp folder, which
 * may sit under the primary checkout). Absolute temp and home paths outside the primary checkout
 * keep their historical behaviour.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

interface ExtensionContextLike {
  cwd: string;
}

interface ExtensionApiLike {
  registerFlag(name: string, options: { description?: string; type: 'string' }): void;
  getFlag(name: string): boolean | string | undefined;
  on(
    event: 'tool_call',
    handler: (event: ToolCall, context: ExtensionContextLike) => ToolGuardResult | undefined,
  ): void;
}

interface ToolGuardResult {
  block: true;
  reason: string;
}

interface Roots {
  worktree: string;
  primary: string;
  allowed: string[];
}

const ROOT_FLAG = 'xezar-worktree-root';
const PRIMARY_FLAG = 'xezar-primary-root';
const ALLOWED_FLAG = 'xezar-allowed-roots';
const BLOCK_REASON =
  'Blocked by Xezar: this isolated task must keep project writes and Git commands inside its worktree.';
const SHELL_REASON =
  `${BLOCK_REASON} The shell command names a path outside the worktree in the primary checkout, or a directory change it cannot verify.`;

/** The native realpath canonicalises letter case on case-insensitive file systems; the JS one does not. */
const realpath = realpathSync.native;

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Resolve a possibly-not-yet-created path through the nearest existing ancestor. */
function realPotential(path: string): string | undefined {
  const suffix: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  try {
    return resolve(realpath(cursor), ...suffix);
  } catch {
    return undefined;
  }
}

// ---- file tools: mirror pi 0.85.1 `normalizePath(path, { normalizeUnicodeSpaces, stripAtPrefix })`

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** pi's Git Bash / MSYS / Cygwin / WSL drive-path conversion, applied only on Windows. */
function windowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (!match?.[1]) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
}

/** The path pi's write/edit tools will use, or `undefined` when the spelling is not certain. */
function piToolPath(spelling: string): string | undefined {
  let value = spelling.replace(UNICODE_SPACES, ' ');
  if (value.startsWith('@')) value = value.slice(1);
  if (process.platform === 'win32') value = windowsShellPath(value);
  if (value === '~') return homedir();
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return join(homedir(), value.slice(2));
  }
  if (/^file:\/\//.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  // pi 0.85.1 reads these as literal relative names, but a later pi or a model expecting shell
  // semantics may not: `~user/…`, a second `@`, `file:` without `//`, a NUL byte. Refuse instead.
  if (/^(?:~|@|file:)/i.test(value) || value.includes('\0')) return undefined;
  return value;
}

function permitted(real: string, roots: Roots): boolean {
  return inside(roots.worktree, real) || roots.allowed.some((root) => inside(root, real));
}

function fileToolEscapes(spelling: string | undefined, roots: Roots): boolean {
  if (spelling === undefined || spelling.length === 0) return true;
  const normalized = piToolPath(spelling);
  if (normalized === undefined) return true;
  const absolute = isAbsolute(normalized);
  const lexical = absolute ? resolve(normalized) : resolve(roots.worktree, normalized);
  // A relative project path is always rooted in the worktree. `..` may not turn it into a
  // sibling, even when that sibling happens to be Xezar runtime state under the primary root.
  if (!absolute && !inside(roots.worktree, lexical)) return true;
  const real = realPotential(lexical);
  if (!real) return true;
  if (permitted(real, roots)) return false;
  // Absolute temp/home tool paths outside this repository retain their historical behavior.
  // Inside the primary checkout, however, the task worktree is the only permitted project tree.
  return !absolute || inside(roots.primary, real);
}

// ---- bash: best-effort recognition, see the header

const SEPARATOR = '\0';

/** Split a command into words; shell operators become SEPARATOR. Quotes are honoured unless flattened. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: '"' | "'" | undefined;
  const end = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word = (word ?? '') + command[++i];
      else word = (word ?? '') + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else if (/\s/.test(char)) {
      end();
      if (char === '\n') words.push(SEPARATOR);
    } else if (char === '`') {
      // Keep the backtick on the word it ends, so `cd \`…\`` has an operand that reads as a
      // substitution (like `$(`), not an absent one.
      word = (word ?? '') + char;
      end();
      words.push(SEPARATOR);
    } else if (';&|()<>'.includes(char)) {
      end();
      words.push(SEPARATOR);
    } else {
      word = (word ?? '') + char;
    }
  }
  end();
  return words;
}

/** Expand `~`, `$NAME` and `${NAME}` from this process's environment; anything else dynamic is unknown. */
function expandWord(word: string): string | undefined {
  let value = word;
  if (value === '~' || value.startsWith('~/')) value = homedir() + value.slice(1);
  let unknown = false;
  value = value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_all, braced, bare) => {
    const name = (braced ?? bare) as string;
    const known = name === 'HOME' ? homedir() : process.env[name];
    if (known === undefined) unknown = true;
    return known ?? '';
  });
  if (unknown || /[$`]/.test(value)) return undefined;
  return value;
}

const SEGMENTS = process.platform === 'win32' ? /[\\/]/ : /\//;
const PATTERN = /[*?[{]/;

/** A directory the command has reached, physically; `linked` once a symlink was followed on the way. */
interface Place {
  path: string;
  linked: boolean;
}

interface ShellState {
  cwd: Place | undefined;
  previous: Place | undefined;
  stack: Array<Place | undefined>;
  homeChanged: boolean;
}

/**
 * Follow `spelling` from `from` one segment at a time, reading each symlink before the next
 * segment, the way `chdir` and `open` do. `undefined` when the start is unknown or a `..` follows
 * a symlink: `cd -L` would take the logical parent and `cd -P`/`git -C` the physical one.
 */
function walk(from: Place | undefined, spelling: string): Place | undefined {
  let place: Place;
  if (isAbsolute(spelling)) place = { path: parse(resolve(spelling)).root, linked: false };
  else if (from) place = { ...from };
  else return undefined;
  for (const segment of spelling.split(SEGMENTS)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (place.linked) return undefined;
      place.path = dirname(place.path);
      continue;
    }
    const next = join(place.path, segment);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      // Not there yet: the rest of the path is lexical.
    }
    if (link) {
      const target = realPotential(next);
      if (target === undefined) return undefined;
      place = { path: target, linked: true };
    } else {
      place.path = next;
    }
  }
  const real = realPotential(place.path);
  if (real === undefined) return undefined;
  return { path: real, linked: place.linked || real !== place.path };
}

/** A directory-change operand as the one literal path the shell will use, or `undefined`. */
function literalDirectory(word: string, state: ShellState): string | undefined {
  if (/[$`*?[\]{}]/.test(word)) return undefined;
  if (word === '~' || word.startsWith('~/')) return state.homeChanged ? undefined : homedir() + word.slice(1);
  if (word.startsWith('~')) return undefined;
  return word;
}

/** An inherited `CDPATH` makes bash try its entries before the current directory. */
function cdpathRedirects(literal: string, cwd: Place | undefined): boolean {
  const cdpath = process.env.CDPATH;
  if (!cdpath || isAbsolute(literal) || /^\.\.?(?:[\\/]|$)/.test(literal)) return false;
  const local = cwd ? realPotential(resolve(cwd.path, literal)) : undefined;
  return cdpath.split(':').some((entry) => {
    const base = isAbsolute(entry) ? entry : cwd ? resolve(cwd.path, entry) : undefined;
    if (base === undefined) return true;
    const candidate = resolve(base, literal);
    return existsSync(candidate) && realPotential(candidate) !== local;
  });
}

/** The verified target of a directory change, or `undefined` when it must be refused. */
function directoryTarget(operand: string, state: ShellState, roots: Roots, searchesCdpath: boolean): Place | undefined {
  const literal = literalDirectory(operand, state);
  if (literal === undefined || (searchesCdpath && cdpathRedirects(literal, state.cwd))) return undefined;
  const place = walk(state.cwd, literal);
  if (place === undefined) return undefined;
  if (permitted(place.path, roots)) return place;
  const absolute = isAbsolute(literal);
  const lexical = absolute ? resolve(literal) : resolve((state.cwd as Place).path, literal);
  const lexicallyInWorktree = inside(roots.worktree, lexical);
  if (inside(roots.primary, place.path) || (inside(roots.primary, lexical) && !lexicallyInWorktree)) return undefined;
  // A relative directory change that climbs out of the worktree is refused even outside the
  // primary checkout; one that stays in it and follows a symlink elsewhere is not a primary write.
  if (!absolute && inside(roots.worktree, (state.cwd as Place).path) && !lexicallyInWorktree) return undefined;
  return place;
}

/** Does this path mention, read from where the command has reached, name the primary checkout? */
function mentionEscapes(spelling: string, state: ShellState, roots: Roots): boolean {
  if (/^~[^\\/]/.test(spelling)) return true;
  if (state.homeChanged && /^~|\$\{?HOME\b/.test(spelling)) return true;
  const expanded = expandWord(spelling);
  if (expanded === undefined) return false;
  const absolute = isAbsolute(expanded);
  const segments = expanded.split(SEGMENTS);
  const pattern = segments.findIndex((segment) => PATTERN.test(segment));
  if (pattern >= 0) {
    // Pathname or brace expansion can reach anything below the literal directory before the
    // pattern. Relative patterns are left alone: quoted regexes look exactly like them.
    const base = segments.slice(0, pattern);
    if (!absolute && !base.includes('..')) return false;
    const place = walk(state.cwd, base.join('/') || (absolute ? sep : '.'));
    if (place === undefined) return true;
    return inside(place.path, roots.primary) || (inside(roots.primary, place.path) && !permitted(place.path, roots));
  }
  if (!absolute && !segments.includes('..')) return false;
  const place = walk(state.cwd, expanded);
  if (place === undefined) return true;
  if (permitted(place.path, roots)) return false;
  const lexical = absolute ? resolve(expanded) : resolve((state.cwd as Place).path, expanded);
  return inside(roots.primary, place.path) || (inside(roots.primary, lexical) && !inside(roots.worktree, lexical));
}

/** Split `--git-dir=/x`, `A=/x:/y` and similar words into the path-like parts worth checking. */
function mentionParts(word: string): string[] {
  const parts = [word];
  const eq = word.indexOf('=');
  if (eq >= 0) parts.push(word.slice(eq + 1));
  return parts.flatMap((part) => [part, ...(part.includes(':') ? part.split(':') : [])]).filter(Boolean);
}

function wordsEscape(words: string[], roots: Roots): boolean {
  const state: ShellState = { cwd: { path: roots.worktree, linked: false }, previous: undefined, stack: [], homeChanged: false };
  const operandAt = (index: number) => (words[index] === SEPARATOR ? undefined : words[index]);

  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    if (word === SEPARATOR) continue;
    // A search path or an old directory changes what a later `cd` means; the guard cannot follow it.
    if (/^(?:CDPATH|OLDPWD)(?:\+?=|$)/.test(word)) return true;
    if (/^HOME(?:\+?=|$)/.test(word)) state.homeChanged = true;
    if (mentionParts(word).some((part) => mentionEscapes(part, state, roots))) return true;

    if (word === 'cd' || word === 'pushd') {
      let j = i + 1;
      while (/^-[LPe@]+$/.test(words[j] ?? '')) j++;
      if (words[j] === '--') j++;
      const operand = operandAt(j);
      let target: Place | undefined;
      if (operand === undefined) {
        target = state.homeChanged ? undefined : directoryTarget(homedir(), state, roots, false);
        if (target === undefined) return true;
      } else if (operand === '-' && word === 'cd') {
        target = state.previous;
        if (target === undefined) return true;
      } else if (word === 'pushd' && /^[+-]\d+$/.test(operand)) {
        target = undefined; // a stack rotation: one of the verified entries, but not known which
      } else {
        target = directoryTarget(operand, state, roots, true);
        if (target === undefined) return true;
      }
      if (word === 'pushd') state.stack.push(state.cwd);
      state.previous = state.cwd;
      state.cwd = target;
      // The operand was checked against the directory it was resolved from; skip it now that
      // `cwd` has moved, or `cd ..` would be re-read from the new directory.
      if (operand !== undefined) i = j;
      continue;
    }
    if (word === 'popd') {
      state.previous = state.cwd;
      state.cwd = /^[+-]\d+$/.test(operandAt(i + 1) ?? '') ? undefined : state.stack.pop();
      continue;
    }
    const inline = /^(?:--git-dir|--work-tree|--chdir|GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(word);
    if (inline && !directoryTarget(inline[1] as string, state, roots, false)) return true;
    if (word === '-C' || word === '--git-dir' || word === '--work-tree' || word === '--chdir') {
      const operand = operandAt(i + 1);
      if (operand !== undefined && !directoryTarget(operand, state, roots, false)) return true;
    } else if (/^-C./.test(word) && !directoryTarget(word.slice(2), state, roots, false)) {
      return true; // `env -Cdir`
    }
  }
  return false;
}

function bashEscapes(command: string, roots: Roots): boolean {
  return (
    wordsEscape(shellWords(command), roots) ||
    wordsEscape(shellWords(command.replace(/["'`]/g, ' ')), roots)
  );
}

function guardToolCall(
  configuredRoot: string,
  contextCwd: string,
  event: ToolCall,
  configuredPrimary: string | undefined,
  configuredAllowed: string[] = [],
): ToolGuardResult | undefined {
  if (!['write', 'edit', 'bash'].includes(event.toolName)) return undefined;

  let roots: Roots;
  let cwd: string;
  try {
    if (!configuredPrimary) throw new Error('no primary checkout');
    roots = {
      worktree: realpath(configuredRoot),
      primary: realpath(configuredPrimary),
      allowed: configuredAllowed.map(realPotential).filter((root): root is string => root !== undefined),
    };
    cwd = realpath(contextCwd);
  } catch {
    return { block: true, reason: `${BLOCK_REASON} The worktree or primary checkout root could not be resolved.` };
  }
  if (cwd !== roots.worktree) {
    return { block: true, reason: `${BLOCK_REASON} The active tool root could not be verified.` };
  }

  if (event.toolName === 'write' || event.toolName === 'edit') {
    const path = typeof event.input.path === 'string' ? event.input.path : undefined;
    return fileToolEscapes(path, roots) ? { block: true, reason: BLOCK_REASON } : undefined;
  }

  const command = typeof event.input.command === 'string' ? event.input.command : undefined;
  if (command === undefined) return { block: true, reason: BLOCK_REASON };
  return bashEscapes(command, roots) ? { block: true, reason: SHELL_REASON } : undefined;
}

function allowedRoots(flag: boolean | string | undefined): string[] | undefined {
  if (flag === undefined) return [];
  if (typeof flag !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(flag);
    return Array.isArray(parsed) && parsed.every((root) => typeof root === 'string' && root.length > 0)
      ? (parsed as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

export default function piWorktreeGuard(pi: ExtensionApiLike): void {
  pi.registerFlag(ROOT_FLAG, { type: 'string', description: 'Pin Xezar task tools to this isolated working copy.' });
  pi.registerFlag(PRIMARY_FLAG, { type: 'string', description: 'The primary checkout Xezar task tools must not write to.' });
  pi.registerFlag(ALLOWED_FLAG, { type: 'string', description: 'JSON list of folders the Xezar task was granted outside its working copy.' });
  pi.on('tool_call', (event, context) => {
    const configured = pi.getFlag(ROOT_FLAG);
    const primary = pi.getFlag(PRIMARY_FLAG);
    const allowed = allowedRoots(pi.getFlag(ALLOWED_FLAG));
    if (typeof configured !== 'string' || configured.length === 0 || typeof primary !== 'string' || primary.length === 0) {
      return { block: true, reason: `${BLOCK_REASON} The configured worktree or primary checkout root is missing.` };
    }
    if (!allowed) return { block: true, reason: `${BLOCK_REASON} The granted folder list is not valid.` };
    return guardToolCall(configured, context.cwd, event, primary, allowed);
  });
}

export const __internals = { guardToolCall };
