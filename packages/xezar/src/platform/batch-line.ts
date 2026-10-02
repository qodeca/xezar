/**
 * The strict rules for anything that reaches cmd.exe (#963). Windows only; pure.
 *
 * cmd.exe reads its command line with its own rules: `&`, `|`, `<`, `>`, `^` and parentheses
 * act, `%NAME%` and `!NAME!` expand, `,`, `;` and `=` separate arguments, and a quote cannot be
 * escaped. No quoting scheme survives all of that (BatBadBut), so nothing is quoted here: a value
 * is either made only of characters cmd.exe treats as plain text, or it is refused before any
 * process starts. A refusal names the file and the position, never the value, which may be a
 * secret.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */

/** cmd.exe's longest command line. */
export const CMD_LINE_MAX = 8191;

/**
 * A drive path (a batch file, a `cd` target, a terminal's folder) with nothing cmd.exe acts on.
 * xezar always hands it to cmd.exe inside double quotes, so besides letters and digits it may
 * hold what cmd.exe reads literally there (verified against cmd.exe and `start`, #963 Q-04):
 * - letters, marks and digits of any script (`\p{L}\p{M}\p{N}`): cmd.exe reads its line as
 *   UTF-16. Punctuation and symbols outside ASCII stay out – a full-width `＂` or `％` can be
 *   mapped to `"` or `%` by a program that reads its line in an ANSI code page. So do the few
 *   letters and marks Windows maps the same way (best fit): the clicks U+01C0–U+01C3 (`|`, `!`),
 *   the spacing modifier letters U+02B0–U+02FF (U+02BA to `"`, U+02BC to `'`) and the combining
 *   marks U+0300–U+036F (U+0302 to `^`, U+0308 and U+030E to `"`) – verified with
 *   WideCharToMultiByte in common code pages (#963 C-03). Today's chains read UTF-16 throughout;
 *   this keeps the rule true for one that does not.
 * - space, `_ . - \ ( ) + @ # ~`, as before;
 * - `'`: special only inside `for /f`, which never reads these lines;
 * - `,`: a separator only OUTSIDE quotes, and `start` passes the rest of its line on verbatim, so
 *   it neither splits the folder nor the batch file's own arguments.
 * Still refused: `" % ! ^ & | < >` (they act even inside quotes, or end them), `;` (Windows
 * Terminal splits its command line there) and `=`.
 */
const CMD_PATH = /^(?![^]*[ǀ-ǃʰ-ͯ])[A-Za-z]:\\[\p{L}\p{M}\p{N} _.\-\\()+@#~',]+$/u;
/** `"PATH"` as one element of a cmd.exe line. */
const QUOTED_PATH = /^"([^"]*)"$/;
/** One argument: no space, quote, `%`, `!`, `^`, `&`, `|`, `<`, `>`, parenthesis, `,`, `;` or
 *  `=` (the last three split arguments, SEC-8). */
const CMD_TOKEN = /^[A-Za-z0-9_.:\\/@+~-]+$/;
/** A web address `start` may open. */
const CMD_URL = /^https?:\/\/[A-Za-z0-9.\-:/_~?#=]+$/;
/** `set "NAME=VALUE" && `, as `renderEnvPrefix` writes it: VALUE without a quote, `%`, `!`, `^`,
 *  `&`, `|`, `<`, `>` or a control character. */
const SET_ASSIGNMENT = /^set "[A-Za-z_]\w*=[^"%!^&|<>\u0000-\u001f\u007f-\u009f]*" && /;
/** `cd /d "PATH" && `, the opening of a command run in a chosen folder; PATH is checked below. */
const CD_PREFIX = /^cd \/d "([^"]*)" && /;
/** One command token: `"…"` or a run without spaces and quotes. */
const COMMAND_TOKEN = /^(?:"([^"]*)"|([^ "]+))/;

/** A drive path cmd.exe reads as plain text. */
export function cmdPathSafe(path: string): boolean {
  return CMD_PATH.test(path);
}

/**
 * `"PATH"` – one quoted `cmdPathSafe` path as a whole element of a cmd.exe line, such as Windows
 * Terminal's starting folder. Never ending in `\`, which would escape the closing quote for the
 * program that receives it.
 */
export function cmdQuotedPathSafe(element: string): boolean {
  const path = QUOTED_PATH.exec(element)?.[1];
  return path !== undefined && cmdPathSafe(path) && !path.endsWith('\\');
}

/** One argument cmd.exe reads as plain text; never empty, never ending in `\`, which would
 *  escape a closing quote for the program that receives it. */
export function cmdTokenSafe(token: string): boolean {
  return CMD_TOKEN.test(token) && !token.endsWith('\\');
}

/** An http(s) address with nothing cmd.exe acts on. */
export function cmdUrlSafe(url: string): boolean {
  return CMD_URL.test(url);
}

/** `TOKEN( TOKEN)*`: each token `cmdTokenSafe`, or a `cmdPathSafe` path inside quotes. */
function commandSafe(command: string): boolean {
  let rest = command;
  for (;;) {
    const match = COMMAND_TOKEN.exec(rest);
    if (!match) return false;
    const safe = match[1] !== undefined ? cmdPathSafe(match[1]) : cmdTokenSafe(match[2]!);
    if (!safe) return false;
    rest = rest.slice(match[0].length);
    if (rest === '') return true;
    if (!rest.startsWith(' ')) return false;
    rest = rest.slice(1);
  }
}

/**
 * The one command a `cmd /K` window may run: `(cd /d "PATH" && )?(set "NAME=VALUE" && )*
 * TOKEN( TOKEN)*` – an optional folder, the environment prefix `renderEnvPrefix` writes, then
 * one command whose tokens pass `cmdTokenSafe` or are a quoted `cmdPathSafe` path. Anything else
 * – another `&&`, a pipe, a redirection, a variable – is refused.
 */
export function cmdPayloadSafe(payload: string): boolean {
  let rest = payload;
  const cd = CD_PREFIX.exec(rest);
  if (cd) {
    if (!cmdPathSafe(cd[1]!)) return false;
    rest = rest.slice(cd[0].length);
  }
  for (let set = SET_ASSIGNMENT.exec(rest); set; set = SET_ASSIGNMENT.exec(rest)) {
    rest = rest.slice(set[0].length);
  }
  return commandSafe(rest);
}

export type BatchRefusalCode = 'XEZ_CMD_UNSAFE_PATH' | 'XEZ_CMD_UNSAFE_ARG' | 'XEZ_CMD_TOO_LONG';

export interface BatchRefusal {
  refused: BatchRefusalCode;
  /** 1-based argument position, for `XEZ_CMD_UNSAFE_ARG`. */
  position?: number;
}

export interface BatchInvocation {
  file: string;
  args: string[];
}

/** The length of the line Windows builds from `file` and verbatim `args`. */
export function verbatimLineLength(file: string, args: readonly string[]): number {
  const program = file.includes(' ') ? `"${file}"` : file;
  return [program, ...args].join(' ').length;
}

/**
 * `cmd.exe /d /v:off /s /c ""<batch>" <args>"`, to be started with `windowsVerbatimArguments`,
 * or the reason it may not start. `/d` skips AutoRun, `/v:off` turns `!` expansion off, and `/s`
 * strips exactly the outer quotes, so cmd.exe sees `"<batch>" <args>`.
 */
export function batchInvocation(
  batchPath: string,
  args: readonly string[],
  cmdExe: string,
): BatchInvocation | BatchRefusal {
  if (!cmdPathSafe(batchPath)) return { refused: 'XEZ_CMD_UNSAFE_PATH' };
  const unsafe = args.findIndex((arg) => !cmdTokenSafe(arg));
  if (unsafe !== -1) return { refused: 'XEZ_CMD_UNSAFE_ARG', position: unsafe + 1 };
  const line = args.length === 0 ? `""${batchPath}""` : `""${batchPath}" ${args.join(' ')}"`;
  const invocation = { file: cmdExe, args: ['/d', '/v:off', '/s', '/c', line] };
  if (verbatimLineLength(invocation.file, invocation.args) > CMD_LINE_MAX) return { refused: 'XEZ_CMD_TOO_LONG' };
  return invocation;
}
