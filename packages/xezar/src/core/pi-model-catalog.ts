import { readFile as fsReadFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import type { ModelOption } from './runner-model-catalog.ts';

/**
 * Discover the models the host's own pi installation is configured with, by reading pi's own
 * files (#152).
 *
 * pi is the odd one out among the four backends: Claude, Codex and OpenCode are each ASKED
 * (a control request, a protocol call, `opencode models`), but pi's catalog is read from its
 * config. (pi did not ship a list command when this was written; current pi has
 * `pi --list-models`, which on 2026-09-21 printed exactly this file's models on a developer
 * machine. Switching to it would add a child process, so it stays a later decision, #819.) `~/.pi/agent/models.json` holds every provider the user has added and
 * the models each one serves; `~/.pi/agent/settings.json` names the pair pi runs by default.
 * Reading them is strictly less invasive than the three probes — no child process, no CLI, no
 * network — which also means it cannot hang or leak a process the way the spawn-based probes had
 * to be hardened against (#841, #858).
 *
 * **Only the fields named below are ever read.** `models.json` keeps each provider's `apiKey`
 * beside its model list, and `auth.json` sits in the same directory; neither is parsed into a
 * picker entry, logged, or carried in a failure message. A discovery reason names the file, never
 * its contents.
 */
export interface PiModelDiscoveryOptions {
  /** pi's per-user directory. Defaults to `agentHomePaths().pi`, which is the ONLY place that
   *  derivation lives — a call site re-deriving `homedir()` is what puts a test on a real home. */
  home?: string;
  /** Injected for tests; the real reader is `fs/promises.readFile`. */
  readFile?: (path: string) => Promise<string>;
}

/** Defensive cap on a config file we did not write (bytes of text). */
const MAX_CONFIG_CHARS = 2 * 1_024 * 1_024;
const MAX_MODELS = 500;

/** A pi model id is `provider/model`, and both halves come from the file, so both are checked
 *  before either reaches a picker entry. Deliberately strict for the same reason OpenCode's line
 *  regex is: a value we cannot read is not a model, and guessing recreates the defect. */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._:/-]*$/i;

/**
 * Read `<home>/models.json` and `<home>/settings.json` and turn them into picker options.
 *
 * Degradation is split on purpose, and the split is the honest one:
 *
 *   - **No `models.json`** — pi is installed but has no providers configured yet. That is a real
 *     answer of "no models", not a failure, so it returns `[]` and the picker shows `auto` alone.
 *   - **Unreadable or unparseable `models.json`** — a permission error, a directory, a truncated
 *     write. xezar cannot say what pi has, so it THROWS and `RunnerModelCatalog` reports
 *     `unavailable` with a reason. The picker still shows `auto`; the status line says the list
 *     could not be read rather than claiming the user has no models.
 *
 * Either way the route answers 200 and no page fails — the caller turns every throw here into a
 * cached or `unavailable` result.
 *
 * `settings.json` is best-effort in BOTH directions: it only decides ordering, so a missing or
 * broken one is swallowed and the file's own provider order stands.
 */
export async function discoverPiModels(
  options: PiModelDiscoveryOptions = {},
): Promise<ModelOption[]> {
  const home = options.home ?? agentHomePaths().pi;
  const read = options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));

  let raw: string;
  try {
    raw = await read(join(home, 'models.json'));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new Error('pi models.json could not be read');
  }
  if (raw.length > MAX_CONFIG_CHARS) throw new Error('pi models.json exceeded the size limit');

  // Ordering only. A settings file that is missing, unreadable or malformed leaves the models
  // exactly as `models.json` ordered them, which is never wrong — only less helpful.
  let settings = '';
  try {
    settings = await read(join(home, 'settings.json'));
  } catch {
    settings = '';
  }

  return parsePiModels(raw, settings);
}

/**
 * Turn pi's `models.json` (and optionally its `settings.json`) into picker options.
 *
 * Exported so the parse is table-testable without a filesystem, the way `parseOpencodeModels` is.
 * `settingsJson` may be empty, absent or garbage — it only floats pi's own default pair to the
 * top of the list so the picker's first real entry is the one pi would have chosen anyway.
 */
export function parsePiModels(modelsJson: string, settingsJson = ''): ModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsJson);
  } catch {
    throw new Error('pi models.json is not valid JSON');
  }
  const providers = readRecord(readRecord(parsed)?.providers);
  // A file with no `providers` key at all is a shape we do not recognise, and reporting
  // "unavailable" is more honest than an empty catalog that reads as "you have no models" —
  // the same call `parseOpencodeModels` makes about unrecognized output.
  if (!providers) throw new Error('pi models.json has no providers');

  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const [providerId, value] of Object.entries(providers)) {
    if (!PROVIDER_ID_RE.test(providerId)) continue;
    const provider = readRecord(value);
    if (!provider) continue;
    // `provider.apiKey` is deliberately never touched. Only the display name is read beside the
    // model list, and only when it is a plain non-empty string.
    const label = typeof provider.name === 'string' && provider.name.trim() ? provider.name.trim() : providerId;
    // `baseUrl` is the one other provider field read, and only to decide `local`; it is never
    // copied into an answer.
    const locality = baseUrlLocality(provider.baseUrl);
    const list = Array.isArray(provider.models) ? provider.models : [];
    for (const entry of list) {
      const record = readRecord(entry);
      const modelId = record?.id;
      if (typeof modelId !== 'string' || !MODEL_ID_RE.test(modelId)) continue;
      const id = `${providerId}/${modelId}`;
      if (seen.has(id)) continue;
      if (models.length >= MAX_MODELS) throw new Error('pi models.json exceeded the size limit');
      seen.add(id);
      models.push({ id, label: id, description: `via ${label}`, ...locality, ...piVision(record?.input) });
    }
  }

  return promoteDefault(models, settingsJson);
}

/** Move pi's own `defaultProvider`/`defaultModel` pair to the front, when the file names one that
 *  the provider list actually contains. Purely cosmetic, and silent when it cannot be done. */
function promoteDefault(models: ModelOption[], settingsJson: string): ModelOption[] {
  if (models.length === 0 || !settingsJson) return models;
  let settings: Record<string, unknown> | undefined;
  try {
    settings = readRecord(JSON.parse(settingsJson));
  } catch {
    return models;
  }
  const provider = settings?.defaultProvider;
  const model = settings?.defaultModel;
  if (typeof provider !== 'string' || typeof model !== 'string') return models;
  const id = `${provider}/${model}`;
  const index = models.findIndex((option) => option.id === id);
  if (index <= 0) return models;
  const preferred = models[index] as ModelOption;
  return [preferred, ...models.filter((_, at) => at !== index)];
}

/**
 * `vision` from pi's own per-model `input` list (#819 item 4) — the same fact `pi --list-models`
 * prints in its `images` column. A list naming `image` proves it, a list without it proves its
 * absence, and no list proves nothing, so the key is omitted rather than guessed `false`.
 */
function piVision(input: unknown): { vision?: boolean } {
  if (!Array.isArray(input)) return {};
  return { vision: input.includes('image') };
}

/**
 * `local` from a provider's configured `baseUrl` (#819 item 4), decided on the PARSED host and
 * never on a string prefix: `http://127.evil.example` is a host name, not a loopback address.
 *
 *   - `localhost` (and `*.localhost`), a loopback or a private/link-local IP literal → `true`;
 *   - any other IP literal → `false`, a public address proves the model runs elsewhere;
 *   - any other host name, a missing or unparseable URL → unknown, so the key is omitted. A name
 *     could resolve anywhere, and resolving it here would be a network call discovery never makes.
 */
export function baseUrlLocality(baseUrl: unknown): { local?: boolean } {
  if (typeof baseUrl !== 'string') return {};
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return { local: true };
  const family = isIP(host);
  if (family === 4) return { local: isLocalIPv4(host) };
  if (family === 6) return { local: isLocalIPv6(host) };
  return {};
}

function isLocalIPv4(host: string): boolean {
  const [a = -1, b = -1] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isLocalIPv6(host: string): boolean {
  if (host === '::1') return true;
  // An IPv4-mapped address (`::ffff:127.0.0.1`, which URL normalises to `::ffff:7f00:1`) is the
  // IPv4 address it carries.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1] as string, 16);
    const low = Number.parseInt(mapped[2] as string, 16);
    return isLocalIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A missing file is "pi has no providers configured", not a failure — every other read error is. */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
