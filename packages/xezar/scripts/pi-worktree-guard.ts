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
 *   - Any other word is a path MENTION (an argument, a redirect target): it is followed from the
 *     directory the command has reached, relative or not, and blocks when it names a path in the
 *     primary checkout outside the worktree – absolute, `~`, `$HOME` or another known variable,
 *     relative after a `cd` above the primary checkout, physically through a symlink, or a glob
 *     whose literal directory lies above or inside the primary checkout. A mention after a
 *     directory change the guard lost track of (`popd` of an empty stack, `pushd +1`) blocks.
 *     `~user` blocks. An unknown variable in a mention passes: it is everywhere in ordinary commands.
 *   Quoted text is read as a command only where the shell itself runs it as one: the script
 *   operand of a shell interpreter (`sh -c "…"`, `bash -lc "…"`, `bash -o pipefail -c "…"`)
 *   and `eval`'s argument. Everywhere else a quoted word is ONE argument — a commit message, a
 *   printf argument, a pasted listing — so a `cd` or `..` inside it is text, not a directory
 *   change. A `..`-only word is a path mention like any other whether or not it is quoted; the
 *   one deliberate loosening is a quoted `..` handed to a pure text emitter (`echo`, `printf`),
 *   whose argument is a string it prints rather than a directory it operates on.
 *
 *   What it still cannot see, by construction: scripts and programs that build a path internally
 *   (`node x.js`, `make`, a hook), a primary-checkout path spelled inside a quoted string that
 *   is not a shell script (`perl -e 'unlink "/p/x"'` — one argument, so the guard never reads
 *   it as a command), aliases and functions, `eval` or `sh -c` of text computed at
 *   run time, variables assigned inside the command and then used in a mention, a relative glob in
 *   a mention (`p*` matching a symlink), and any other process that changes directory itself.
 *
 * Xezar passes the roots as flags: the task worktree, the primary checkout it protects, and the
 * folders the run was granted outside its worktree (its handoff folder and task temp folder, which
 * may sit under the primary checkout). Absolute temp and home paths outside the primary checkout
 * keep their historical behaviour.
 *
 * The same extension carries a step's `bashAllowlist`, but its policy is shared in
 * `core/read-only-lock.ts` (#863). pi has no native command-prefix rule or denial transport, so
 * this adapter keeps only the flag registration/parsing and pi's `{ block, reason }` response.
 * The shared policy accepts one simple command matching an entry and refuses shell composition,
 * expansion, redirection, grouping/functions, leading assignments, trailing backslashes, unnamed
 * command-running wrappers and the audited risky argument forms. Its sole compound exception is
 * the verdict roles' two-part pipe into the exact packet writer. The separate worktree check above
 * remains pi-specific because it validates pi tool paths and roots, not command policy.
 *
 * Xezar passes the flag whenever it loads this extension: `null` for a step without a
 * `bashAllowlist`, which keeps an unrestricted `bash`, and the list otherwise. `[]` (and a list of
 * blanks, the same list) refuses every shell command – xezar also removes `bash` from `--tools` for
 * it. A MISSING flag refuses the shell rather than reading as "no allowlist". When the run has no
 * worktree the extension is loaded only for a step with the key, and the worktree flags are absent.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This extension ships as TypeScript under `scripts/`, while package source does not ship. In a
// checkout it imports the source module for tests and development; in the npm package it imports
// the same module's tsc output under `dist/`. The policy remains one authored implementation.
const readOnlyLockSource = new URL('../src/core/read-only-lock.ts', import.meta.url);
const readOnlyLockBuilt = new URL('../dist/core/read-only-lock.js', import.meta.url);
const readOnlyLock = (await import(
  existsSync(readOnlyLockSource) ? readOnlyLockSource.href : readOnlyLockBuilt.href
)) as typeof import('../src/core/read-only-lock.ts');
const { decideReadOnlyCommand, normalizeBashAllowlist } = readOnlyLock;

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

/** A shell word, and whether any of it came from inside quotes. A quoted word is ONE argument
 *  the program receives; it is never a command line to read (see `scriptEscapes`). */
interface ShellWord {
  text: string;
  quoted: boolean;
}

/** Split a command into words; shell operators become SEPARATOR. Quotes are honoured. */
function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let word: string | undefined;
  let quoted = false;
  let quote: '"' | "'" | undefined;
  const end = () => {
    if (word !== undefined) words.push({ text: word, quoted });
    word = undefined;
    quoted = false;
  };
  const separator = () => {
    end();
    words.push({ text: SEPARATOR, quoted: false });
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
      quoted = true;
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else if (/\s/.test(char)) {
      end();
      if (char === '\n') words.push({ text: SEPARATOR, quoted: false });
    } else if (char === '`') {
      // Keep the backtick on the word it ends, so `cd \`…\`` has an operand that reads as a
      // substitution (like `$(`), not an absent one.
      word = (word ?? '') + char;
      separator();
    } else if (';&|()<>'.includes(char)) {
      separator();
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

/** A path spelled only with `.` and `..` segments names a directory, never a file. */
const PARENT_ONLY = /^\.{1,2}(?:[\\/]\.{1,2})*[\\/]?$/;

/** A command whose arguments are text it PRINTS, never a filesystem target. It is the one kind of
 *  command a quoted `..` word may be handed to, because the argument is a string, not a path. */
const TEXT_EMITTER = /^(?:echo|printf)$/;

/**
 * Does this path mention, read from where the command has reached, name the primary checkout?
 *
 * The exemption here is deliberately narrow, and it is NOT "the word was quoted". The shell
 * treats `'..'` and `..` identically, so keying on quoting alone exempted `rm -rf '..'`,
 * `mv notes.md '..'`, `cp -r . '../..'`, `rsync -a . '../'`, `find '..' -delete` and
 * `chmod -R 777 '..'` — every one of which operates on the directory itself, and this worktree's
 * `..` is every peer run. A quoted `..`-only WORD is refused in `wordsEscape` before it reaches
 * here unless its command word is a text emitter; what this exemption still covers is a `..` that
 * `mentionParts` split out of an option VALUE (`--format=".."`), which is a string the option
 * receives. The directory options that really do take a path (`--git-dir=`, `--work-tree=`,
 * `--chdir=`, `GIT_DIR=`, `GIT_WORK_TREE=`) are checked as directory changes, separately.
 */
function mentionEscapes(spelling: string, state: ShellState, roots: Roots, quoted: boolean): boolean {
  if (/^~[^\\/]/.test(spelling)) return true;
  if (state.homeChanged && /^~|\$\{?HOME\b/.test(spelling)) return true;
  if (quoted && PARENT_ONLY.test(spelling)) return false;
  const expanded = expandWord(spelling);
  if (expanded === undefined) return false;
  const absolute = isAbsolute(expanded);
  const segments = expanded.split(SEGMENTS);
  const pattern = segments.findIndex((segment) => PATTERN.test(segment));
  // Every word is followed from the directory the command has reached, relative ones included:
  // after `cd ~/Projects`, `xezar/tracked.md` names the primary checkout without any `..`, and in
  // the worktree an existing symlink can lead there too. An unknown directory refuses the command.
  if (pattern >= 0) {
    // Pathname or brace expansion can reach anything below the literal directory before the
    // pattern. A quoted regex looks like a relative pattern; from the worktree its base stays there.
    const base = segments.slice(0, pattern);
    const place = walk(state.cwd, base.join('/') || (absolute ? sep : '.'));
    if (place === undefined) return true;
    return inside(place.path, roots.primary) || (inside(roots.primary, place.path) && !permitted(place.path, roots));
  }
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

function wordsEscape(words: ShellWord[], roots: Roots): boolean {
  const state: ShellState = { cwd: { path: roots.worktree, linked: false }, previous: undefined, stack: [], homeChanged: false };
  const operandAt = (index: number): ShellWord | undefined => {
    const next = words[index];
    return next === undefined || next.text === SEPARATOR ? undefined : next;
  };
  // The command word of the segment being read: the first word after a separator. It decides
  // whether a quoted `..` word is a string a text emitter prints or a directory operand.
  let commandWord: ShellWord | undefined;

  for (let i = 0; i < words.length; i++) {
    const word = words[i] as ShellWord;
    if (word.text === SEPARATOR) {
      commandWord = undefined;
      continue;
    }
    commandWord ??= word;
    // A search path or an old directory changes what a later `cd` means; the guard cannot follow it.
    if (/^(?:CDPATH|OLDPWD)(?:\+?=|$)/.test(word.text)) return true;
    if (/^HOME(?:\+?=|$)/.test(word.text)) state.homeChanged = true;
    // A `..`-only word is a directory operand, and quoting does not make it less of one: the
    // shell treats `'..'` and `..` identically, so `rm -rf '..'`, `mv notes.md '..'`,
    // `cp -r . '../..'`, `rsync -a . '../'`, `find '..' -delete` and `chmod -R 777 '..'` all
    // name this worktree's parent — which is every peer run's worktree. The one command that may
    // keep it is a pure text emitter, whose argument is a string it prints (`printf '%s\n' '..'`,
    // `echo '..'`). Every directory change (`cd '..'`, `git -C '..'`) and every UNQUOTED `..`
    // argument (`rm -rf ..`) refuses for its own reason, before and after this.
    if (word.quoted && PARENT_ONLY.test(word.text) && !TEXT_EMITTER.test(commandWord.text)) return true;
    if (mentionParts(word.text).some((part) => mentionEscapes(part, state, roots, word.quoted))) return true;

    if (word.text === 'cd' || word.text === 'pushd') {
      let j = i + 1;
      while (/^-[LPe@]+$/.test(words[j]?.text ?? '')) j++;
      if (words[j]?.text === '--') j++;
      const operand = operandAt(j);
      let target: Place | undefined;
      if (operand === undefined) {
        target = state.homeChanged ? undefined : directoryTarget(homedir(), state, roots, false);
        if (target === undefined) return true;
      } else if (operand.text === '-' && word.text === 'cd') {
        target = state.previous;
        if (target === undefined) return true;
      } else if (word.text === 'pushd' && /^[+-]\d+$/.test(operand.text)) {
        target = undefined; // a stack rotation: one of the verified entries, but not known which
      } else {
        target = directoryTarget(operand.text, state, roots, true);
        if (target === undefined) return true;
      }
      if (word.text === 'pushd') state.stack.push(state.cwd);
      state.previous = state.cwd;
      state.cwd = target;
      // The operand was checked against the directory it was resolved from; skip it now that
      // `cwd` has moved, or `cd ..` would be re-read from the new directory.
      if (operand !== undefined) i = j;
      continue;
    }
    if (word.text === 'popd') {
      state.previous = state.cwd;
      state.cwd = /^[+-]\d+$/.test(operandAt(i + 1)?.text ?? '') ? undefined : state.stack.pop();
      continue;
    }
    const inline = /^(?:--git-dir|--work-tree|--chdir|GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(word.text);
    if (inline && !directoryTarget(inline[1] as string, state, roots, false)) return true;
    if (word.text === '-C' || word.text === '--git-dir' || word.text === '--work-tree' || word.text === '--chdir') {
      const operand = operandAt(i + 1);
      if (operand !== undefined && !directoryTarget(operand.text, state, roots, false)) return true;
    } else if (/^-C./.test(word.text) && !directoryTarget(word.text.slice(2), state, roots, false)) {
      return true; // `env -Cdir`
    }
  }
  return false;
}

/** A shell that runs its `-c` operand as a script rather than passing it to a program. */
const SHELL_INTERPRETER = /(?:^|\/)(?:sh|bash|zsh|dash|ksh|ash|mksh|fish)$/;
/** A short-flag cluster that asks for a command string: `-c`, `-lc`, `-xc`. */
const COMMAND_FLAG = /^-[a-z]*c[a-z]*$/;
/**
 * A flag whose ARGUMENT is the NEXT WORD, so that word is a mode name or a file name and is never
 * the script — quoted or not. `-o`/`+o` (set options) exist in every shell here; `-O`/`+O` (shopt)
 * and `--rcfile`/`--init-file` are bash's; `--emulate` is zsh's. A combined cluster ending in one
 * of those letters takes the argument too (`-euo pipefail`, and `-co pipefail`, which asks for a
 * command string AND consumes a word). An `=`-attached argument (`--rcfile=x`) consumes no word,
 * so it is deliberately not matched here.
 */
const FLAG_TAKES_ARGUMENT = /^(?:--rcfile|--init-file|--emulate)$|^[-+][a-zA-Z]*[oO]$/;
/** How deep a script inside a script is read before the guard gives up and refuses. Nothing
 *  ordinary nests past two; the bound is here so a pathological command cannot turn the
 *  recursion into a thrown error, which would be a missed block rather than a false one. */
const MAX_SCRIPT_DEPTH = 8;

/**
 * The one place a quoted string is a COMMAND line rather than one argument: the script operand
 * of a shell interpreter or of `eval`. Everything else quoted — a commit message, a printf
 * argument, a pasted listing — is a word the program receives, and reading it as a command line
 * is what made `echo "cd .."` and a pasted `..` look like directory changes.
 *
 * WHICH word is the script is the whole difficulty, because a shell's flag list is not a list of
 * dash-words: several flags take their ARGUMENT as a SEPARATE word. `bash -o pipefail -c
 * '<script>'` passes `pipefail`, `bash --rcfile x -c '<script>'` passes `x`. Two spellings of the
 * same mistake have already shipped from this one function, and the rule below is what closes
 * BOTH, so neither half may be dropped:
 *
 *   - Stopping at the first word not beginning with `-` stops BEFORE the `-c` and reads the flag's
 *     own argument as the operand — unquoted, so the script was never read at all and
 *     `bash -euo pipefail -c '<script>'` was ALLOWED where `main` refused it.
 *   - Taking the first QUOTED word anywhere in the segment instead reads a flag argument that
 *     happens to be quoted — `bash --rcfile 'x' -c '<script>'` — as the script, and the real `-c`
 *     operand is never read. A live shell runs the `-c` operand regardless of `--rcfile`.
 *
 * So the operand is ANCHORED at the command flag: the scan walks the segment once, steps over each
 * argument-taking flag's own word (`FLAG_TAKES_ARGUMENT`), notes WHERE the command flag is, and
 * looks for the script only AT OR AFTER that flag. A word quoted before it is that earlier flag's
 * argument and is never eligible. Past the anchor, every quoted word that is not a known flag's
 * argument is read, because a cluster such as `-co pipefail '<script>'` asks for a command string
 * and consumes a word in the same breath. A segment that runs a script but has no readable quoted
 * word is one the guard cannot read, and it refuses it. `--` gets no special case: option parsing
 * really does end there, but refusing the segment anyway is the safe direction.
 */
function scriptEscapes(words: ShellWord[], roots: Roots, depth: number): boolean {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as ShellWord;
    if (word.text === SEPARATOR) continue;
    const isEval = word.text === 'eval';
    if (!isEval && !SHELL_INTERPRETER.test(word.text)) continue;
    // `eval` has no flag to anchor on: its operand is the first quoted word after it.
    let from = i + 1;
    if (!isEval) {
      let anchored = false;
      for (let j = i + 1; words[j] !== undefined && words[j]?.text !== SEPARATOR; j++) {
        const text = words[j]?.text ?? '';
        if (COMMAND_FLAG.test(text)) {
          from = FLAG_TAKES_ARGUMENT.test(text) ? j + 2 : j + 1;
          anchored = true;
          break;
        }
        if (FLAG_TAKES_ARGUMENT.test(text)) j++;
      }
      if (!anchored) continue;
    }
    let read = false;
    for (let j = from; words[j] !== undefined && words[j]?.text !== SEPARATOR; j++) {
      const candidate = words[j] as ShellWord;
      if (FLAG_TAKES_ARGUMENT.test(candidate.text)) {
        j++;
        continue;
      }
      if (!candidate.quoted) continue;
      read = true;
      if (bashEscapes(candidate.text, roots, depth + 1)) return true;
    }
    if (!read) return true;
  }
  return false;
}

function bashEscapes(command: string, roots: Roots, depth = 0): boolean {
  if (depth > MAX_SCRIPT_DEPTH) return true;
  const words = shellWords(command);
  return wordsEscape(words, roots) || scriptEscapes(words, roots, depth);
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

// ---- bash allowlist (#856): a strict command-prefix rule, see the header

const ALLOWLIST_FLAG = 'xezar-bash-allowlist';
const ALLOWLIST_REASON = 'Blocked by Xezar: this step allows only the shell commands in its bashAllowlist.';

function allowlistRefusal(event: ToolCall, entries: string[]): ToolGuardResult | undefined {
  if (event.toolName !== 'bash') return undefined;
  const command = typeof event.input.command === 'string' ? event.input.command : undefined;
  if (command === undefined) return { block: true, reason: `${ALLOWLIST_REASON} The bash call has no command.` };
  const decision = decideReadOnlyCommand(command, entries);
  return decision.allowed ? undefined : { block: true, reason: `${ALLOWLIST_REASON} ${decision.reason}` };
}

/**
 * The step's allowlist: `null` – the flag's JSON `null` – when the step has none, its usable
 * entries otherwise (`[]` and a blanks-only list are the same list: no entry), `'absent'` when the
 * flag is missing, and `undefined` when it cannot be read. Xezar always passes the flag when it
 * loads this extension, so a missing one is not read as "no allowlist".
 */
function bashAllowlist(flag: boolean | string | undefined): string[] | null | 'absent' | undefined {
  if (flag === undefined) return 'absent';
  if (typeof flag !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(flag);
    if (parsed === null) return null;
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) return undefined;
    return normalizeBashAllowlist(parsed as string[]);
  } catch {
    return undefined;
  }
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
  pi.registerFlag(ALLOWLIST_FLAG, { type: 'string', description: 'JSON list of the shell command prefixes this Xezar step may run.' });
  pi.on('tool_call', (event, context) => {
    const configured = pi.getFlag(ROOT_FLAG);
    const primary = pi.getFlag(PRIMARY_FLAG);
    const entries = bashAllowlist(pi.getFlag(ALLOWLIST_FLAG));
    if (entries === undefined) return { block: true, reason: `${ALLOWLIST_REASON} The bashAllowlist flag is not null or a JSON list of strings.` };
    if (entries === 'absent' && event.toolName === 'bash') {
      return { block: true, reason: `${ALLOWLIST_REASON} The bashAllowlist flag is missing, so the shell is refused rather than left unrestricted.` };
    }
    if (entries !== null && entries !== 'absent') {
      const refusal = allowlistRefusal(event, entries);
      if (refusal) return refusal;
      // Loaded for the allowlist alone: a run with no worktree passes neither root flag. Either one
      // present means a worktree run, and a missing partner still fails closed below.
      if (configured === undefined && primary === undefined) return undefined;
    }
    const allowed = allowedRoots(pi.getFlag(ALLOWED_FLAG));
    if (typeof configured !== 'string' || configured.length === 0 || typeof primary !== 'string' || primary.length === 0) {
      return { block: true, reason: `${BLOCK_REASON} The configured worktree or primary checkout root is missing.` };
    }
    if (!allowed) return { block: true, reason: `${BLOCK_REASON} The granted folder list is not valid.` };
    return guardToolCall(configured, context.cwd, event, primary, allowed);
  });
}

export const __internals = { guardToolCall, allowlistRefusal };
