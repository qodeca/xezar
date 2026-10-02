/**
 * The note a run's process sweep leaves in the task (#943): which programs it stopped, and
 * which it could not stop and why – each named by pid and command line.
 *
 * A command line can carry a credential (`--token=…`, `https://user:pass@host`, `Bearer …`), so
 * every command is redacted IN FULL first and only then cut to `REPORT_COMMAND_MAX` characters:
 * cutting first could leave a token's head too short for any pattern to recognise. The store
 * redacts the note again when it appends it; this pass is the one that knows it is looking at a
 * command line.
 */
import { REDACTED, SECRET_NAME_RE, redactSecrets } from '../core/secret-redaction.ts';

/** Characters of one command line in the note, after redaction. */
export const REPORT_COMMAND_MAX = 200;
/** Programs named per list; the rest are counted. */
export const REPORT_LIST_MAX = 50;

export type UnstoppableReason = 'access-denied' | 'still-running';

export interface ReportedProcess {
  pid: number;
  /** Already redacted and cut; absent when it could not be read. */
  command?: string;
}

export interface SweepOutcome {
  stopped: readonly ReportedProcess[];
  unstoppable: ReadonlyArray<ReportedProcess & { reason: UnstoppableReason }>;
}

/** One token: a run of quoted strings and other non-space characters. */
const TOKEN_RE = /(?:"[^"]*"?|'[^']*'?|[^\s"']+)+/g;
/** Control characters, a newline among them, flattened so one note line stays one line. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[^\s"']+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g;

/** `--api-key`, `api.key`, `"PASSWORD"` → a name `SECRET_NAME_RE` can judge. */
function isSecretName(raw: string): boolean {
  const name = raw.replace(/["']/g, '').replace(/^-+/, '').replace(/[-.]/g, '_');
  return name.length > 0 && SECRET_NAME_RE.test(name);
}

/** A bare `--name` / `-name` whose value is the next token. */
function isSecretFlag(token: string): boolean {
  return /^-{1,2}[A-Za-z]/.test(token) && !token.includes('=') && isSecretName(token);
}

/** Mask the value of every `NAME=v`, `--flag=v` and `--flag v` whose name looks like a secret. */
function maskNamedValues(text: string): string {
  const tokens = [...text.matchAll(TOKEN_RE)];
  let out = '';
  let last = 0;
  let maskNext = false;
  for (const match of tokens) {
    const token = match[0];
    const at = match.index;
    out += text.slice(last, at);
    last = at + token.length;
    if (maskNext) {
      out += REDACTED;
      maskNext = false;
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 0 && isSecretName(token.slice(0, equals))) {
      out += `${token.slice(0, equals + 1)}${REDACTED}`;
      continue;
    }
    maskNext = isSecretFlag(token);
    out += token;
  }
  return out + text.slice(last);
}

/** At most `max` characters, never splitting a character in two. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * A command line fit for the note: control characters flattened, then redacted in full – the
 * host's own secret values and known token shapes (`redactSecrets`), the value of any
 * `NAME=v`, `--flag=v` or `--flag v` whose name matches `SECRET_NAME_RE`, URL userinfo,
 * `Bearer`/`Basic` credentials and `eyJ…` JWTs – and only then cut to `REPORT_COMMAND_MAX`.
 */
export function redactCommandLine(command: string, secretValues: readonly string[]): string {
  let text = command.replace(CONTROL_RE, ' ').trim();
  text = redactSecrets(text, secretValues);
  text = maskNamedValues(text);
  text = text.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  text = text.replace(AUTH_SCHEME_RE, `$1 ${REDACTED}`);
  text = text.replace(JWT_RE, REDACTED);
  return cut(text, REPORT_COMMAND_MAX);
}

const REASON_TEXT: Record<UnstoppableReason, string> = {
  'access-denied': 'access denied',
  'still-running': 'still running',
};

function programs(count: number): string {
  return count === 1 ? '1 program' : `${count} programs`;
}

function list<T extends ReportedProcess>(items: readonly T[], describe: (item: T) => string): string {
  const named = items.slice(0, REPORT_LIST_MAX).map(describe);
  const rest = items.length - named.length;
  return rest > 0 ? `${named.join('; ')}; and ${rest} more` : named.join('; ');
}

function describeProcess({ pid, command }: ReportedProcess): string {
  return command === undefined || command.length === 0 ? String(pid) : `${pid} ${command}`;
}

/**
 * The note left when the ledger cannot confirm the run's agent process (its start time is not the
 * spawn's): from then on nothing is recorded for it, so a stop of the run finds nothing to sweep.
 */
export function rootNotConfirmedNote(pid: number): string {
  return (
    `Could not confirm process ${pid} as this task's agent: its start time does not match when it was started. ` +
    'Programs it starts are not tracked, so they will not be stopped if the task is paused, cancelled or times out.'
  );
}

/**
 * The note's text, or null when the sweep found nothing to say. For example: `Stopped 2 programs
 * this task started: 4121 node server.js; 4133 esbuild --watch. Could not stop 1: 5000 python3
 * -m http.server (still running).` The commands must already be `redactCommandLine` output.
 */
export function buildSweepReport(outcome: SweepOutcome): string | null {
  const { stopped, unstoppable } = outcome;
  const parts: string[] = [];
  if (stopped.length > 0) {
    parts.push(`Stopped ${programs(stopped.length)} this task started: ${list(stopped, describeProcess)}.`);
  }
  if (unstoppable.length > 0) {
    const what = stopped.length > 0 ? String(unstoppable.length) : `${programs(unstoppable.length)} this task started`;
    const named = list(unstoppable, (item) => `${describeProcess(item)} (${REASON_TEXT[item.reason]})`);
    parts.push(`Could not stop ${what}: ${named}.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
