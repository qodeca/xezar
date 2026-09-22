/**
 * Shared policy for a step that resolves to read-only (#863).
 *
 * pi calls this module before a bash tool call. Codex calls it from its PreToolUse hook adapter.
 * Claude Code consumes the same read-only signal and normalized entries, but its own
 * `Bash(<entry>:*)` matcher makes the run-time decision today. Consequently the splitter and
 * `COMMAND_RUNNING_ARGUMENTS` do not protect Claude until that hook exists; read-only workflow
 * lists must omit entries whose safety depends on either check.
 */

const ALLOWLIST_RULE = 'prefix.entry';

export interface ReadOnlyCommandRefusal {
  allowed: false;
  rule: string;
  reason: string;
}

export interface ReadOnlyCommandAllowed {
  allowed: true;
}

export type ReadOnlyCommandDecision = ReadOnlyCommandAllowed | ReadOnlyCommandRefusal;

export interface ReadOnlyShellCall {
  readonly toolName: unknown;
  readonly command: unknown;
}

export interface CommandArgumentPolicy {
  readonly program: string;
  readonly enforcement: 'checked' | 'argument-safe' | 'accepted-write' | 'never-named';
  readonly rule: string;
  readonly argumentShapes: readonly string[];
  readonly reason: string;
}

const FIND_ACTIONS = [
  '-exec',
  '-execdir',
  '-delete',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
] as const;

/**
 * Programs whose prefix alone needs no extra argument refusal still have a row. That makes the
 * audit decision explicit instead of making an absent row indistinguishable from an unreviewed
 * program. Matching code below implements the risky rows by their stable rule id.
 */
export const COMMAND_RUNNING_ARGUMENTS = [
  { program: 'git', enforcement: 'checked', rule: 'command.git-reviewed', argumentShapes: ['-c', '--config-env', '--exec-path', 'fetch --upload-pack|--exec', 'diff|show|log --output|-o', 'checkout ... -- <path>'], reason: 'git has reviewed arguments that can execute a command or write a file' },
  { program: 'find', enforcement: 'checked', rule: 'command.find-action', argumentShapes: [...FIND_ACTIONS], reason: 'find actions can execute another command, delete a path or write a file' },
  { program: 'rg', enforcement: 'checked', rule: 'command.rg-pre', argumentShapes: ['--pre=<command>', '--pre <command>'], reason: 'rg --pre executes a command for every searched file' },
  { program: 'npm', enforcement: 'checked', rule: 'command.npm-prefix', argumentShapes: ['--prefix=<directory>', '--prefix <directory>'], reason: 'npm --prefix can select a different project and therefore a different script' },
  { program: 'bash', enforcement: 'argument-safe', rule: 'command.argument-safe', argumentShapes: [], reason: 'each shipped bash entry fixes the script path before any caller arguments' },
  { program: 'sed', enforcement: 'never-named', rule: 'command.never-named', argumentShapes: [], reason: 'sed programs can write files or execute commands and cannot be safely classified as shell words' },
  { program: 'awk', enforcement: 'never-named', rule: 'command.never-named', argumentShapes: [], reason: 'awk programs can execute commands and cannot be safely classified as shell words' },
  { program: 'grep', enforcement: 'argument-safe', rule: 'command.argument-safe', argumentShapes: [], reason: 'grep has no reviewed argument that executes another command or writes a file' },
  { program: 'jq', enforcement: 'argument-safe', rule: 'command.argument-safe', argumentShapes: [], reason: 'jq reads its program as data and has no reviewed command-running argument' },
  { program: 'gh', enforcement: 'argument-safe', rule: 'command.argument-safe', argumentShapes: [], reason: 'the shipped gh entries use API operations and templates without local command execution' },
  { program: 'node', enforcement: 'argument-safe', rule: 'command.argument-safe', argumentShapes: [], reason: 'each shipped node entry fixes the script path before any caller arguments' },
  { program: 'sh', enforcement: 'argument-safe', rule: 'command.argument-safe', argumentShapes: [], reason: 'each shipped sh entry fixes the script path before any caller arguments' },
  { program: 'agent-browser', enforcement: 'accepted-write', rule: 'command.accepted-write', argumentShapes: ['screenshot --full <path>'], reason: 'QA and design-review roles intentionally allow browser artifacts, including screenshots at caller-chosen paths' },
  ...['pwd', 'ls', 'cat', 'echo', 'printf', 'wc', 'head', 'tail', 'diff', 'sha256sum', 'shasum'].map((program) => ({ program, enforcement: 'argument-safe' as const, rule: 'command.argument-safe', argumentShapes: [], reason: `${program} has no reviewed argument that executes another command` })),
] as const satisfies readonly CommandArgumentPolicy[];

const WRAPPER_COMMANDS = new Set([
  'env',
  'timeout',
  'xargs',
  'nohup',
  'exec',
  'eval',
  'command',
  'bash',
  'sh',
  'zsh',
  'nice',
  'caffeinate',
]);

/** The one signal every runner uses. An unresolved list is a writing step; `[]` is read-only. */
export function isReadOnlyStep(allowedTools: readonly string[] | undefined): boolean {
  return allowedTools !== undefined && !allowedTools.includes('Edit') && !allowedTools.includes('Write');
}

/** Trim once for every adapter; blank entries never become an empty prefix that matches all. */
export function normalizeBashAllowlist(entries: readonly string[]): string[] {
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

/** Claude Code's `Bash(<entry>:*)`: the entry itself, or the entry followed by a literal space. */
export function matchesBashAllowlistEntry(command: string, entry: string): boolean {
  return command === entry || (command.startsWith(entry) && command[entry.length] === ' ');
}

/** The exact list shape passed to Claude Code; Claude remains the run-time matcher. */
export function claudeBashRules(entries: readonly string[]): string[] {
  return normalizeBashAllowlist(entries).map((entry) => `Bash(${entry}:*)`);
}

export interface ReadOnlyShellWord {
  text: string;
  raw: string;
}

export interface SimpleReadOnlyCommand {
  command: string;
  words: ReadOnlyShellWord[];
}

function refuse(rule: string, explanation: string): ReadOnlyCommandRefusal {
  return { allowed: false, rule, reason: `Rule ${rule} refused the command: ${explanation}.` };
}

/**
 * Read exactly one simple shell command. Shell composition is refused instead of interpreted:
 * this is intentionally smaller than a shell grammar and fails closed on anything ambiguous.
 */
export function splitReadOnlyCommand(command: string): SimpleReadOnlyCommand | ReadOnlyCommandRefusal {
  const words: ReadOnlyShellWord[] = [];
  let text = '';
  let raw = '';
  let quote: "'" | '"' | undefined;
  let started = false;
  const push = () => {
    if (started) words.push({ text, raw });
    text = '';
    raw = '';
    started = false;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    const next = command[i + 1];
    if (quote === "'") {
      raw += char;
      if (char === "'") quote = undefined;
      else text += char;
      continue;
    }
    if (quote === '"') {
      raw += char;
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === '\\') {
        if (next === undefined || next === '\n') return refuse('syntax.backslash-line', 'a trailing or line-ending backslash changes what the shell receives');
        raw += next;
        text += next;
        i++;
        continue;
      }
      if (char === '`' || char === '$') return refuse('syntax.expansion', 'a word the shell still expands cannot be checked safely');
      text += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      raw += char;
      started = true;
      continue;
    }
    if (char === '\\') {
      if (next === undefined || next === '\n') return refuse('syntax.backslash-line', 'a trailing or line-ending backslash changes what the shell receives');
      raw += char + next;
      text += next;
      started = true;
      i++;
      continue;
    }
    if (char === '`' || char === '$' || char === '~' || char === '*' || char === '?' || char === '[' || char === '{' || char === '}') {
      return refuse('syntax.expansion', 'a word the shell still expands cannot be checked safely');
    }
    if ((char === '&' && next === '>') || char === '>' || char === '<') return refuse('syntax.redirection', `redirection beginning with "${char}${char === '&' ? '>' : ''}" can read from or write to a path`);
    if (char === ';' || char === '&' || char === '|' || char === '\n') return refuse('syntax.compound', `the shell operator ${JSON.stringify(char)} would run more than one simple command`);
    if (char === '(' || char === ')') return refuse('syntax.grouping', `the unquoted token "${char}" can group commands or define a function`);
    if (char === '#' && !started) {
      const newline = command.indexOf('\n', i + 1);
      if (newline >= 0 && command.slice(newline + 1).trim() !== '') return refuse('syntax.compound', 'a command after a shell comment would run as another simple command');
      break;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    raw += char;
    text += char;
    started = true;
  }
  if (quote) return refuse('syntax.unclosed-quote', 'an unclosed quote cannot be checked safely');
  push();
  if (words.length === 0) return refuse('syntax.empty', 'the command is empty');
  return { command: command.trim(), words };
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

function isLongOptionPrefix(argument: string, option: string): boolean {
  const name = argument.split('=', 1)[0] ?? '';
  return name.startsWith('--') && name.length > 2 && option.startsWith(name);
}

const GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
]);

function gitSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}

function gitRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const args = words.slice(1).map((word) => word.text);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '-c' || (arg.startsWith('-c') && arg.length > 2) || arg === '--config-env' || arg.startsWith('--config-env=')) {
      return refuse('command.git-config-execution', `${JSON.stringify(arg)} can change Git configuration under a read-only prefix`);
    }
    if (isLongOptionPrefix(arg, '--exec-path')) {
      return refuse('command.git-exec-path', `${JSON.stringify(arg)} can select executable git subcommands`);
    }
  }

  const subcommandIndex = gitSubcommandIndex(args);
  const subcommand = subcommandIndex < 0 ? undefined : args[subcommandIndex];
  const tail = subcommandIndex < 0 ? [] : args.slice(subcommandIndex + 1);
  if (subcommand === 'fetch') {
    for (const argument of tail) {
      if (isLongOptionPrefix(argument, '--upload-pack') || isLongOptionPrefix(argument, '--exec')) {
        return refuse('command.git-fetch-upload-pack', `${JSON.stringify(argument)} supplies a command for git fetch to execute`);
      }
    }
  }
  if (subcommand === 'diff' || subcommand === 'show' || subcommand === 'log') {
    for (let i = 0; i < tail.length; i++) {
      const arg = tail[i] as string;
      if (arg === '--output' || arg.startsWith('--output=') || arg === '-o' || (/^-o.+/.test(arg) && arg !== '--')) {
        return refuse('command.git-output', `${JSON.stringify(arg)} makes git ${subcommand} write to a file`);
      }
    }
  }
  if (subcommand === 'checkout') {
    const separator = tail.indexOf('--');
    if (separator >= 0 && separator < tail.length - 1) {
      return refuse('command.git-checkout-path', 'git checkout with paths writes the working tree');
    }
  }
  return undefined;
}

function findRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const action = words.slice(1).map((word) => word.text).find((arg) => FIND_ACTIONS.some((name) => arg === name || arg.startsWith(`${name}=`)));
  return action ? refuse('command.find-action', `${JSON.stringify(action)} can execute a command, delete a path or write a file`) : undefined;
}

function rgRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const pre = words.slice(1).map((word) => word.text).find((arg) => arg === '--pre' || arg.startsWith('--pre='));
  return pre ? refuse('command.rg-pre', `${JSON.stringify(pre)} supplies a command for rg to execute`) : undefined;
}

function npmRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const prefix = words.slice(1).map((word) => word.text).find((arg) => arg === '--prefix' || arg.startsWith('--prefix='));
  return prefix ? refuse('command.npm-prefix', `${JSON.stringify(prefix)} selects a different npm project`) : undefined;
}

const CHECKED_ARGUMENT_DISPATCHERS = { git: gitRefusal, find: findRefusal, rg: rgRefusal, npm: npmRefusal } as const;
export const IMPLEMENTED_ARGUMENT_POLICY_PROGRAMS = Object.freeze(COMMAND_RUNNING_ARGUMENTS.map((row) => row.program));

function commandArgumentRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const program = basename(words[0]?.text ?? '');
  const policy = COMMAND_RUNNING_ARGUMENTS.find((row) => row.program === program);
  if (policy?.enforcement === 'never-named') return refuse('command.never-named', `${program} programs cannot be safely named by a read-only allowlist`);
  if (policy?.enforcement !== 'checked') return undefined;
  return CHECKED_ARGUMENT_DISPATCHERS[program as keyof typeof CHECKED_ARGUMENT_DISPATCHERS](words);
}

/** Decide one shell call under a read-only step's normalized `bashAllowlist`. */
export function decideReadOnlyCommand(command: string, entries: readonly string[]): ReadOnlyCommandDecision {
  const normalized = normalizeBashAllowlist(entries);
  if (normalized.length === 0) return refuse(ALLOWLIST_RULE, 'the bashAllowlist has no usable entry');
  const scriptPipe = splitAllowlistedScriptPipe(command, normalized);
  if (scriptPipe) {
    const left = decideReadOnlyCommand(scriptPipe.left, normalized);
    if (!left.allowed) return left;
    return { allowed: true };
  }
  const parsed = splitReadOnlyCommand(command);
  if ('allowed' in parsed) return parsed;
  const [programWord] = parsed.words;
  const program = basename(programWord?.text ?? '');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(programWord?.text ?? '')) {
    return refuse('syntax.leading-assignment', 'a leading environment assignment can alter the command that follows');
  }
  if (WRAPPER_COMMANDS.has(program)) {
    const wrapperNamed = normalized.some((entry) => basename(entry.split(/\s+/, 1)[0] ?? '') === program);
    if (!wrapperNamed) return refuse('syntax.wrapper-command', `${program} can run another command and no entry names that wrapper`);
  }
  const argumentRefusal = commandArgumentRefusal(parsed.words);
  if (argumentRefusal) return argumentRefusal;
  if (!normalized.some((entry) => matchesBashAllowlistEntry(parsed.command, entry))) {
    return refuse(ALLOWLIST_RULE, `${JSON.stringify(parsed.command)} does not match an entry exactly or followed by a literal space`);
  }
  return { allowed: true };
}

/**
 * Decide an adapter-neutral shell-tool payload. Runners only extract their vendor fields; this
 * module owns both malformed-input refusal and command policy so no adapter grows a second lock.
 */
export function decideReadOnlyShellCall(
  call: ReadOnlyShellCall,
  entries: readonly string[],
): ReadOnlyCommandDecision {
  if (call.toolName !== 'Bash') {
    return refuse('payload.tool-name', 'the hook payload does not name the Bash shell tool');
  }
  if (typeof call.command !== 'string') {
    return refuse('payload.command', 'the Bash hook payload has no string command');
  }
  return decideReadOnlyCommand(call.command, entries);
}

/**
 * The sole compound shape retained for a read-only role: one pipe whose right side is an exact,
 * explicitly allowlisted, argument-free `bash <path>` or `sh <path>` command. Bare interpreters
 * remain excluded because they would execute the piped standard input as a program.
 */
function splitAllowlistedScriptPipe(command: string, entries: readonly string[]): { left: string; right: string } | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let pipe = -1;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '|') {
      if (pipe >= 0 || command[i - 1] === '|' || command[i + 1] === '|') return undefined;
      pipe = i;
    }
  }
  if (pipe < 0) return undefined;
  const left = command.slice(0, pipe).trim();
  const right = command.slice(pipe + 1).trim();
  if (left === '' || !entries.includes(right)) return undefined;
  const parsedRight = splitReadOnlyCommand(right);
  if ('allowed' in parsedRight || parsedRight.words.length !== 2) return undefined;
  const [program, script] = parsedRight.words.map((word) => word.text);
  if ((program !== 'bash' && program !== 'sh') || script === undefined || script.startsWith('-')) return undefined;
  return { left, right };
}
