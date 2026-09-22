/**
 * Shared policy for a step that resolves to read-only (#863).
 *
 * pi calls this module before a bash tool call. Codex will call it from its hook adapter in the
 * next slice. Claude Code consumes the same read-only signal and normalized entries, but its own
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

export interface CommandArgumentPolicy {
  readonly program: string;
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
  { program: 'git', rule: 'command.git-fetch-upload-pack', argumentShapes: ['fetch --upload-pack=<command>', 'fetch --upload-pack <command>', 'fetch --exec[=] <command>', 'fetch -u[=] <command>'], reason: 'git fetch can execute an upload-pack command supplied by an argument' },
  { program: 'git', rule: 'command.git-config-execution', argumentShapes: ['-c core.sshCommand=', '-c core.pager=', '-c alias.', '-c core.fsmonitor='], reason: 'git configuration arguments can install shell commands, executable aliases, pagers or fsmonitor hooks' },
  { program: 'git', rule: 'command.git-exec-path', argumentShapes: ['--exec-path=<directory>', '--exec-path <directory>'], reason: 'git --exec-path can select a directory containing executable git subcommands' },
  { program: 'git', rule: 'command.git-output', argumentShapes: ['diff|show|log --output=<file>', 'diff|show|log --output <file>', 'diff|show|log -o <file>'], reason: 'git diff, show and log can write their output to a file named by an argument' },
  { program: 'find', rule: 'command.find-action', argumentShapes: [...FIND_ACTIONS], reason: 'find actions can execute another command, delete a path or write a file' },
  { program: 'rg', rule: 'command.rg-pre', argumentShapes: ['--pre=<command>', '--pre <command>'], reason: 'rg --pre executes a command for every searched file' },
  { program: 'grep', rule: 'command.grep-reviewed', argumentShapes: [], reason: 'grep has no reviewed argument that executes another command or writes a file' },
  { program: 'sed', rule: 'command.sed-write', argumentShapes: ['-i[SUFFIX]', '--in-place[=SUFFIX]', 'w <file>', 'W <file>'], reason: 'sed -i and sed w/W commands write files' },
  { program: 'jq', rule: 'command.jq-reviewed', argumentShapes: [], reason: 'jq has no reviewed argument that executes another command or writes a file' },
  { program: 'gh', rule: 'command.gh-template-reviewed', argumentShapes: [], reason: 'gh --template evaluates a Go template and does not execute a shell command' },
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
      if (char === '`' || (char === '$' && next === '(')) return refuse('syntax.substitution', 'command substitution can run another command');
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
    if (char === '`' || (char === '$' && next === '(')) return refuse('syntax.substitution', 'command substitution can run another command');
    if ((char === '&' && next === '>') || char === '>' || char === '<') return refuse('syntax.redirection', `redirection beginning with "${char}${char === '&' ? '>' : ''}" can read from or write to a path`);
    if (char === ';' || char === '&' || char === '|' || char === '\n') return refuse('syntax.compound', `the shell operator ${JSON.stringify(char)} would run more than one simple command`);
    if (char === '(' || char === ')' || char === '{' || char === '}') return refuse('syntax.grouping', `the unquoted token "${char}" can group commands or define a function`);
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

function optionValue(words: readonly ReadOnlyShellWord[], index: number, names: readonly string[]): boolean {
  const word = words[index]?.text;
  if (word === undefined) return false;
  return names.some((name) => word === name || word.startsWith(`${name}=`));
}

function gitRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const args = words.slice(1).map((word) => word.text);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '-c') {
      const config = args[i + 1] ?? '';
      if (/^(?:core\.(?:sshCommand|pager|fsmonitor)|alias\.)/i.test(config)) {
        return refuse('command.git-config-execution', `git -c ${JSON.stringify(config)} can execute a command`);
      }
      i++;
      continue;
    }
    if (/^-c(?:core\.(?:sshCommand|pager|fsmonitor)|alias\.)/i.test(arg)) {
      return refuse('command.git-config-execution', `${JSON.stringify(arg)} can execute a command`);
    }
    if (arg === '--exec-path' || arg.startsWith('--exec-path=')) {
      return refuse('command.git-exec-path', `${JSON.stringify(arg)} can select executable git subcommands`);
    }
  }

  const guardedSubcommands = new Set(['fetch', 'diff', 'show', 'log']);
  const subcommandIndex = args.findIndex((arg) => guardedSubcommands.has(arg));
  const subcommand = subcommandIndex < 0 ? undefined : args[subcommandIndex];
  const tail = subcommandIndex < 0 ? [] : args.slice(subcommandIndex + 1);
  if (subcommand === 'fetch') {
    for (let i = 0; i < tail.length; i++) {
      if (optionValue(tail.map((text) => ({ text, raw: text })), i, ['--upload-pack', '--exec', '-u'])) {
        return refuse('command.git-fetch-upload-pack', `${JSON.stringify(tail[i])} supplies a command for git fetch to execute`);
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
  return undefined;
}

function commandArgumentRefusal(words: readonly ReadOnlyShellWord[]): ReadOnlyCommandRefusal | undefined {
  const program = basename(words[0]?.text ?? '');
  const args = words.slice(1).map((word) => word.text);
  if (program === 'git') return gitRefusal(words);
  if (program === 'find') {
    const action = args.find((arg) => FIND_ACTIONS.some((name) => arg === name || arg.startsWith(`${name}=`)));
    if (action) return refuse('command.find-action', `${JSON.stringify(action)} can execute a command, delete a path or write a file`);
  }
  if (program === 'rg') {
    const pre = args.find((arg) => arg === '--pre' || arg.startsWith('--pre='));
    if (pre) return refuse('command.rg-pre', `${JSON.stringify(pre)} supplies a command for rg to execute`);
  }
  if (program === 'sed') {
    const write = args.find((arg) => /^-(?:[A-Za-z]*i|i.+)$/.test(arg) || arg === '--in-place' || arg.startsWith('--in-place=') || /(?:^|[;}\s])[wW](?:\s|$)/.test(arg));
    if (write) return refuse('command.sed-write', `${JSON.stringify(write)} makes sed write a file`);
  }
  return undefined;
}

/** Decide one shell call under a read-only step's normalized `bashAllowlist`. */
export function decideReadOnlyCommand(command: string, entries: readonly string[]): ReadOnlyCommandDecision {
  const normalized = normalizeBashAllowlist(entries);
  if (normalized.length === 0) return refuse(ALLOWLIST_RULE, 'the bashAllowlist has no usable entry');
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
