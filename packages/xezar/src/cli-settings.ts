/**
 * The `xez` command line's own settings — port, presentation, colour, diagnostic level
 * and quiet (#467, PR 2; analysis § 6(e), `designs/cli-terminal/multi-instance.md` § 3–4).
 *
 * This module is PURE: it takes the flags, the environment and what the registry already
 * holds, and answers one settings object. It opens no file, binds no port and prints
 * nothing — which is exactly what lets `src/index.ts` validate an invocation *before* it
 * touches the registry, claims the project writer or binds a listener
 * (`designs/cli-terminal/multi-instance.md` § 9, "Order of checks at start").
 *
 * Two failure modes, deliberately different:
 *
 * - An **explicit** value — a flag, or an `XEZ_*` variable someone typed — that is not a
 *   legal value is a REFUSAL: `CliSettingsError`, the accepted values named, exit 1, before
 *   anything is claimed (`error-cases.txt` A9).
 * - A **stored** value in `~/.xezar/config.json` degrades to absent with ONE warning
 *   (`error-cases.txt` A10). A file someone's editor mangled must never stop the cockpit —
 *   the same house rule the workspace schema's per-key `.catch` already follows.
 *
 * The renderer, the rich/lines output and the stderr activity lines are PR 3. This module
 * only resolves the values that PR 3 will consume.
 */

/** How `serve` presents its activity. `auto` decides from the transport at render time (PR 3). */
export const OUTPUT_MODES = ['auto', 'lines', 'rich'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** Colour policy. `auto` = colour when the transport is safe for it. */
export const COLOR_MODES = ['auto', 'always', 'never'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** Diagnostic threshold, least to most severe — the array order IS the ranking. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Which projects one xezar process serves (#467, PR 1). `workspace` — the DEFAULT, and
 * today's behaviour byte for byte — opens every registered project; `project` is the opt-in
 * mode where the cockpit serves the project it started in and the others become links to
 * their own cockpit (owner decision 2026-09-20).
 *
 * PR 1 resolves the value and nothing else: no capability, no route, no boot line, no help
 * entry. This module answers what was REQUESTED; what is actually IN FORCE is a different
 * question, because `XEZ_SINGLE_PROJECT=1` and a folder that owns its xezar state already
 * narrow the registry and win over it — and that question belongs beside the one narrowing
 * predicate, in `workspace/projects.ts` (`instanceModeInForce`), not here, so this module
 * stays pure.
 */
export const INSTANCE_MODES = ['project', 'workspace'] as const;
export type InstanceMode = (typeof INSTANCE_MODES)[number];

/** The lowest port a start may ask for, and the highest the range may ever reach. */
export const PORT_MIN = 0;
export const PORT_MAX = 65535;
/** The port a project with nothing stored and nothing asked for starts from. */
export const DEFAULT_PORT = 4321;

/** Where the resolved start port came from — the rows of the precedence table. */
export type PortSource = 'flag' | 'project' | 'env' | 'memory' | 'default';

/**
 * A refused invocation. `message` is the whole human line (`error-cases.txt` A9 wording);
 * `src/index.ts` prints it and exits 1 without a stack trace.
 */
export class CliSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliSettingsError';
  }
}

/** The raw flag layer, straight from `parseArgs`. `undefined` = the flag was not given. */
export interface CliFlags {
  port?: string;
  output?: string;
  color?: string;
  logLevel?: string;
  quiet?: boolean;
  instance?: string;
}

/** What the flags and the environment together settled, before the registry is read. */
export interface CliInvocation {
  /** An explicit `--port`. Wins over every stored and remembered value. */
  flagPort?: number;
  /** A `XEZ_PORT` that parsed. Loses to `P.cli.port`, wins over the remembered port. */
  envPort?: number;
  flagOutput?: OutputMode;
  envOutput?: OutputMode;
  flagColor?: ColorMode;
  envColor?: ColorMode;
  /** A non-empty `NO_COLOR` — the accessibility override, ranked above every stored value. */
  noColor: boolean;
  flagLogLevel?: LogLevel;
  envLogLevel?: LogLevel;
  quiet: boolean;
  flagInstance?: InstanceMode;
  /** A `XEZ_INSTANCE` that parsed. Loses to `W.cli.instance`, beats the default. */
  envInstance?: InstanceMode;
}

/** The stored layer: the workspace `cli` object and this project's own keys. */
export interface StoredCliSettings {
  /** `W.cli.*` — workspace-wide presentation defaults. */
  workspace?: { output?: unknown; color?: unknown; logLevel?: unknown; instance?: unknown };
  /** `P.cli.port` — the port a person chose for THIS project. A preference. */
  projectPort?: unknown;
  /** `P.lastListen.port` — the port this project's cockpit last really held. A hint. */
  rememberedPort?: unknown;
}

export interface ResolvedPort {
  /** The port the first bind attempt asks for. */
  value: number;
  source: PortSource;
  /** True for an explicit `--port`: the fall-forward never skips another project's ports. */
  explicit: boolean;
  /** `--port 0` — an OS-chosen port. Ignores memory and is never remembered (Q-4). */
  ephemeral: boolean;
}

export interface ResolvedCliSettings {
  port: ResolvedPort;
  output: OutputMode;
  color: ColorMode;
  /** `color` collapsed against the transport — what PR 3 actually paints with. */
  colorEnabled: boolean;
  logLevel: LogLevel;
  quiet: boolean;
  /**
   * `logLevel` and `quiet` combined with the MORE RESTRICTIVE threshold (analysis § 6(e)).
   * `--quiet` never lowers a level someone raised: `--quiet --log-level error` stays `error`.
   */
  effectiveLogLevel: LogLevel;
  /** The instance mode this invocation REQUESTED. What is in force also depends on the two
   *  registry narrowings — ask `instanceModeInForce` for that (#467, spec § 2.3–2.4). */
  instance: InstanceMode;
  /**
   * Did anyone actually ASK for that mode — a flag, a stored key that parsed, or the variable —
   * or is it simply the default?
   *
   * The boot line is the only reader and it needs the difference (#467, spec § 2.5): a narrowed
   * cockpit says nothing about the DEFAULT `workspace`, because nobody asked for anything, and
   * says one line about an explicit one, because that is a request it is not honouring. A
   * STORED value that degraded is not explicit — it is absent by then, with its own warning.
   */
  instanceExplicit: boolean;
  /** One line per degraded stored value (`error-cases.txt` A10). Never a refusal. */
  warnings: string[];
}

/** How a person may spell "yes" in `XEZ_QUIET`. Everything else — including `0` — is no. */
function envFlagOn(value: string | undefined): boolean {
  return value?.trim() === '1';
}

/**
 * A port, parsed strictly. Rejects NaN, fractions, signs, whitespace-only and out-of-range,
 * because `Number('')` is 0 and `Number('43a1')` is NaN, and both used to reach `listen()`.
 * Returns `null` for a value that is not a port at all — the callers decide whether that is
 * a refusal (explicit) or a warning (stored).
 */
export function parsePortValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= PORT_MIN && raw <= PORT_MAX ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  // `^\d+$` and nothing else: no `+1`, no `1.0`, no `0x10`, no `1e3`, no empty string.
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= PORT_MIN && value <= PORT_MAX ? value : null;
}

function parseEnumValue<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return (allowed as readonly string[]).includes(text) ? (text as T) : null;
}

/**
 * One stored or environment `instance` value, parsed — `null` for absent, empty or a word this
 * vocabulary does not know (#467, PR 5).
 *
 * Exported because the settings ROUTE needs the same answer `resolveCliSettings` gives, without
 * the flags, the ports and the transport: `GET /api/v1/workspace/config` reports the stored value
 * and what stored-plus-environment resolves to, and re-deriving "is this a legal mode" beside a
 * second copy of the vocabulary is how two readers of one setting drift apart.
 */
export function parseInstanceModeValue(raw: unknown): InstanceMode | null {
  return parseEnumValue(raw, INSTANCE_MODES);
}

function refusePort(label: string, raw: string): never {
  throw new CliSettingsError(
    `${label} must be a whole number from ${PORT_MIN} to ${PORT_MAX} — got “${raw}”.`,
  );
}

function refuseEnum(label: string, raw: string, allowed: readonly string[]): never {
  throw new CliSettingsError(`${label} must be one of ${allowed.join(', ')} — got “${raw}”.`);
}

/**
 * Validate the flags and the environment. Throws `CliSettingsError` on the first illegal
 * EXPLICIT value — which is the whole point of running this before the registry is read:
 * `xez --port 43a1` must refuse without having claimed anything (`error-cases.txt` A9).
 *
 * An environment variable counts as explicit. `XEZ_PORT=99999` is a typo in someone's
 * shell, and silently ignoring it would start a cockpit on a port they did not ask for.
 */
export function parseCliInvocation(
  flags: CliFlags,
  env: NodeJS.ProcessEnv = process.env,
): CliInvocation {
  const invocation: CliInvocation = { noColor: false, quiet: false };

  if (flags.port !== undefined) {
    const port = parsePortValue(flags.port);
    if (port === null) refusePort('--port', flags.port);
    invocation.flagPort = port;
  }
  if (env.XEZ_PORT !== undefined && env.XEZ_PORT.trim() !== '') {
    const port = parsePortValue(env.XEZ_PORT);
    if (port === null) refusePort('XEZ_PORT', env.XEZ_PORT);
    invocation.envPort = port;
  }

  if (flags.output !== undefined) {
    const output = parseEnumValue(flags.output, OUTPUT_MODES);
    if (output === null) refuseEnum('--output', flags.output, OUTPUT_MODES);
    invocation.flagOutput = output;
  }
  if (env.XEZ_OUTPUT !== undefined && env.XEZ_OUTPUT.trim() !== '') {
    const output = parseEnumValue(env.XEZ_OUTPUT, OUTPUT_MODES);
    if (output === null) refuseEnum('XEZ_OUTPUT', env.XEZ_OUTPUT, OUTPUT_MODES);
    invocation.envOutput = output;
  }

  if (flags.color !== undefined) {
    const color = parseEnumValue(flags.color, COLOR_MODES);
    if (color === null) refuseEnum('--color', flags.color, COLOR_MODES);
    invocation.flagColor = color;
  }
  if (env.XEZ_COLOR !== undefined && env.XEZ_COLOR.trim() !== '') {
    const color = parseEnumValue(env.XEZ_COLOR, COLOR_MODES);
    if (color === null) refuseEnum('XEZ_COLOR', env.XEZ_COLOR, COLOR_MODES);
    invocation.envColor = color;
  }
  // The published NO_COLOR rule: PRESENCE with any non-empty value disables colour. It is
  // never validated as an enum, because it has no vocabulary to get wrong.
  invocation.noColor = (env.NO_COLOR ?? '') !== '';

  if (flags.logLevel !== undefined) {
    const level = parseEnumValue(flags.logLevel, LOG_LEVELS);
    if (level === null) refuseEnum('--log-level', flags.logLevel, LOG_LEVELS);
    invocation.flagLogLevel = level;
  }
  if (env.XEZ_LOG_LEVEL !== undefined && env.XEZ_LOG_LEVEL.trim() !== '') {
    const level = parseEnumValue(env.XEZ_LOG_LEVEL, LOG_LEVELS);
    if (level === null) refuseEnum('XEZ_LOG_LEVEL', env.XEZ_LOG_LEVEL, LOG_LEVELS);
    invocation.envLogLevel = level;
  }

  if (flags.instance !== undefined) {
    const instance = parseEnumValue(flags.instance, INSTANCE_MODES);
    if (instance === null) refuseEnum('--instance', flags.instance, INSTANCE_MODES);
    invocation.flagInstance = instance;
  }
  if (env.XEZ_INSTANCE !== undefined && env.XEZ_INSTANCE.trim() !== '') {
    const instance = parseEnumValue(env.XEZ_INSTANCE, INSTANCE_MODES);
    if (instance === null) refuseEnum('XEZ_INSTANCE', env.XEZ_INSTANCE, INSTANCE_MODES);
    invocation.envInstance = instance;
  }

  invocation.quiet = flags.quiet === true || envFlagOn(env.XEZ_QUIET);
  return invocation;
}

/** One degraded stored key, in the `error-cases.txt` A10 shape. */
function storedWarning(key: string, raw: unknown): string {
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return `[xez] workspace config: ${key} is “${shown}” — ignored, fix or remove it`;
}

/**
 * Read one stored enum, degrading a bad value to absent plus a warning.
 * A stored key that is simply MISSING is silent — absence is not a defect.
 */
function storedEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  key: string,
  warnings: string[],
): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = parseEnumValue(raw, allowed);
  if (parsed === null) {
    warnings.push(storedWarning(key, raw));
    return undefined;
  }
  return parsed;
}

function storedPort(raw: unknown, key: string, warnings: string[]): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = parsePortValue(raw);
  if (parsed === null) {
    warnings.push(storedWarning(key, raw));
    return undefined;
  }
  return parsed;
}

export interface TransportFacts {
  /** Whether the stream the activity goes to is a terminal. Non-TTY forces plain output. */
  isTty?: boolean;
  /** A transport that must stay byte-exact — `xez mcp`'s JSON-RPC stdout. Forces no colour. */
  plainTransport?: boolean;
}

/**
 * Resolve every setting, in the exact precedence the analysis table names.
 *
 * Port:    explicit CLI > P.cli.port > XEZ_PORT > remembered P.lastListen.port > 4321
 * Output:  CLI > W.cli.output   > XEZ_OUTPUT     > auto
 * Level:   CLI > W.cli.logLevel > XEZ_LOG_LEVEL  > info
 * Colour:  transport safety > --color > NO_COLOR > W.cli.color > XEZ_COLOR > auto
 * Quiet:   --quiet > XEZ_QUIET > false
 * Instance: CLI > W.cli.instance > XEZ_INSTANCE > workspace
 *
 * Two rows in that list look like mistakes and are not. **Stored beats environment** for
 * output and log level, following `followups` / `agentEnvPassthrough` (AGENTS.md § Workspace
 * registry): a `XEZ_OUTPUT` exported once in a shell profile must not outrank a preference
 * someone deliberately saved. And **`P.cli.port` beats `XEZ_PORT`** for the same reason,
 * sharpened by one instance per project — an exported `XEZ_PORT` would otherwise pull every
 * project to the same start port. A flag always wins over both.
 */
export function resolveCliSettings(
  invocation: CliInvocation,
  stored: StoredCliSettings = {},
  transport: TransportFacts = {},
): ResolvedCliSettings {
  const warnings: string[] = [];

  const projectPort = storedPort(stored.projectPort, 'projects[].cli.port', warnings);
  const rememberedPort = storedPort(stored.rememberedPort, 'projects[].lastListen.port', warnings);
  const storedOutput = storedEnum(stored.workspace?.output, OUTPUT_MODES, 'cli.output', warnings);
  const storedColor = storedEnum(stored.workspace?.color, COLOR_MODES, 'cli.color', warnings);
  const storedLevel = storedEnum(stored.workspace?.logLevel, LOG_LEVELS, 'cli.logLevel', warnings);
  const storedInstance = storedEnum(
    stored.workspace?.instance,
    INSTANCE_MODES,
    'cli.instance',
    warnings,
  );

  const port = resolvePort(invocation, projectPort, rememberedPort);

  const output = invocation.flagOutput ?? storedOutput ?? invocation.envOutput ?? 'auto';
  const logLevel = invocation.flagLogLevel ?? storedLevel ?? invocation.envLogLevel ?? 'info';
  const requestedInstance = invocation.flagInstance ?? storedInstance ?? invocation.envInstance;
  const instance = requestedInstance ?? 'workspace';
  // NO_COLOR sits ABOVE the stored keys and below `--color`: it is an accessibility override
  // a person sets for the whole machine, not another preference to be overruled by a file.
  const color =
    invocation.flagColor ?? (invocation.noColor ? 'never' : (storedColor ?? invocation.envColor ?? 'auto'));

  const quiet = invocation.quiet;
  return {
    port,
    output,
    color,
    colorEnabled: resolveColorEnabled(color, transport),
    logLevel,
    quiet,
    effectiveLogLevel: quiet ? moreRestrictive(logLevel, 'warn') : logLevel,
    instance,
    instanceExplicit: requestedInstance !== undefined,
    warnings,
  };
}

function resolvePort(
  invocation: CliInvocation,
  projectPort: number | undefined,
  rememberedPort: number | undefined,
): ResolvedPort {
  if (invocation.flagPort !== undefined) {
    // `--port 0` is an ephemeral request — "any free port". It ignores memory for this
    // launch and is never written back (`open-questions.md` Q-4): remembering an OS-chosen
    // 53122 would turn the next plain `xez` into a start at a random high port.
    return {
      value: invocation.flagPort,
      source: 'flag',
      explicit: true,
      ephemeral: invocation.flagPort === 0,
    };
  }
  if (projectPort !== undefined) {
    return { value: projectPort, source: 'project', explicit: true, ephemeral: projectPort === 0 };
  }
  if (invocation.envPort !== undefined) {
    return {
      value: invocation.envPort,
      source: 'env',
      explicit: true,
      ephemeral: invocation.envPort === 0,
    };
  }
  if (rememberedPort !== undefined && rememberedPort !== 0) {
    return { value: rememberedPort, source: 'memory', explicit: false, ephemeral: false };
  }
  return { value: DEFAULT_PORT, source: 'default', explicit: false, ephemeral: false };
}

/**
 * Colour, collapsed against the transport. `always` is the one value that beats the
 * transport check — someone piping into `less -R` asked for it on purpose — while
 * `plainTransport` (the MCP's JSON-RPC stdout) beats everything, because a colour code
 * there is a protocol break, not a decoration.
 */
function resolveColorEnabled(color: ColorMode, transport: TransportFacts): boolean {
  if (transport.plainTransport) return false;
  if (color === 'never') return false;
  if (color === 'always') return true;
  return transport.isTty === true;
}

function moreRestrictive(a: LogLevel, b: LogLevel): LogLevel {
  return LOG_LEVELS.indexOf(a) >= LOG_LEVELS.indexOf(b) ? a : b;
}
