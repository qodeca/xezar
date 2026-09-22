import { parseArgs } from 'node:util';

import { STATE_NAMES_PAYLOAD } from './local-xezar-top-level-names.ts';

/**
 * `xezar state-names` (#852) — the one door through which a project's own checks can READ the
 * top-level names this engine writes into `.local/xezar/`, instead of keeping a hand-copied list
 * that goes stale on every release.
 *
 * Two properties are the whole point of the command and both are load-bearing:
 *
 *   - **The JSON is generated from `STATE_NAMES_PAYLOAD`, never read from a file.** The committed
 *     fixture beside that module is the byte contract, and `local-xezar-top-level-names.test.ts`
 *     already fails when the module drifts from it — but the fixture is test material and is not
 *     emitted into the package, so an installed copy has the module and nothing else. Reading a
 *     file here would ship a command that cannot answer.
 *   - **Standard output carries the payload and nothing else.** A caller pipes it into a JSON
 *     parser, so a banner, a mode line or a first-run notice on that stream is a parse error rather
 *     than noise. The command is therefore answered before the invocation resolves a project at
 *     all: it reads no repository, opens no state folder and writes no file, in any layout.
 */

/** The one usage line, printed to stderr on every refusal. */
export const STATE_NAMES_USAGE = 'usage: xezar state-names [--json]';

/**
 * Refused when the command word is not the first thing on the command line. It takes no global
 * flag — there is no project to point it at — and saying so is better than accepting a flag that
 * would change nothing.
 */
export const STATE_NAMES_ALONE =
  'xezar state-names: this command takes no other option. Run it on its own.';

/** The exact bytes `--json` prints: the published payload, two-space indented, one trailing newline. */
export function stateNamesJson(): string {
  return `${JSON.stringify(STATE_NAMES_PAYLOAD, null, 2)}\n`;
}

/** The dash a table cell uses for a name the engine may write without any option being switched on. */
const ALWAYS = '-';

/**
 * The human listing: one row per name, plus the line that says what it is NOT. A person reading a
 * failed check wants to see the names; a program must read `--json`, whose bytes are pinned, and
 * the closing line says so rather than leaving a reader to guess which of the two is safe to parse.
 */
export function stateNamesTable(): string {
  const rows = STATE_NAMES_PAYLOAD.names.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    feature: entry.feature ?? ALWAYS,
  }));
  const header = { name: 'name', kind: 'kind', feature: 'written when' };
  const width = (key: keyof typeof header) =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length));
  const nameWidth = width('name');
  const kindWidth = width('kind');
  const line = (row: typeof header) =>
    `${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.feature}`.trimEnd();
  const directories = rows.filter((row) => row.kind === 'directory').length;
  return [
    line(header),
    line({ name: '-'.repeat(nameWidth), kind: '-'.repeat(kindWidth), feature: '-'.repeat(width('feature')) }),
    ...rows.map(line),
    '',
    `${rows.length} names: ${directories} directories, ${rows.length - directories} files. ` +
      `"${ALWAYS}" means the engine may write it with nothing switched on.`,
    'This listing is for reading, not for parsing. Use --json for the published form, whose bytes are the contract.',
    '',
  ].join('\n');
}

/** Where the command writes; injected so a case can read both streams without touching the process. */
export interface StateNamesIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const processIo: StateNamesIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(`${text}\n`),
};

/**
 * Runs the command over its OWN argument tail — everything after the command word — with a strict
 * `parseArgs` of its own, the way `lease` reads its tail from `process.argv`. `--json` is this
 * command's flag rather than a global one, so no other subcommand has to accept it and an unknown
 * flag here is answered by this command's usage instead of the shared parser's message.
 *
 * Exit codes: 0 when it printed, 2 for a usage error — an unknown option, or an extra word.
 */
export function runStateNamesCommand(tail: readonly string[], io: StateNamesIo = processIo): number {
  let json = false;
  let positionals: string[] = [];
  try {
    const parsed = parseArgs({
      args: [...tail],
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: true,
    });
    json = Boolean(parsed.values.json);
    positionals = parsed.positionals;
  } catch (err) {
    io.err(`xezar state-names: ${err instanceof Error ? err.message : String(err)}`);
    io.err(STATE_NAMES_USAGE);
    return 2;
  }
  if (positionals.length > 0) {
    io.err(`xezar state-names: unexpected argument "${positionals[0]}"`);
    io.err(STATE_NAMES_USAGE);
    return 2;
  }
  io.out(json ? stateNamesJson() : stateNamesTable());
  return 0;
}
