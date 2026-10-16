/**
 * What xezar reads from a person's Qwen Code settings (#1044). Read only: xezar never writes a
 * Qwen settings file the person owns (#1041 locked decision).
 *
 * Qwen Code keeps its models in `modelProviders` of `<QWEN_HOME>/settings.json` (default
 * `~/.qwen`), keyed by auth type: `{ "openai": [{ "id", "name", "baseUrl", "envKey", … }] }`. The
 * person's chosen model is `model.name` and the chosen auth type `security.auth.selectedType`.
 * Prices are optional: `modelPricing: { "<model id>": { inputPerMillionTokens,
 * outputPerMillionTokens } }`, the same table Qwen Code's own session statistics use.
 *
 * The file is JSONC (comments and trailing commas are allowed). An unreadable file is not an
 * empty one: `status` keeps the two apart, so a caller never says "you have no models" about a
 * file it could not parse.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsonComments } from '../agent-config/validate.ts';
import { agentHomePaths } from '../paths.ts';

/** The auth types `qwen --auth-type` accepts (Qwen Code 0.25.2 `--help`). */
export const QWEN_AUTH_TYPES = ['openai', 'openai-responses', 'anthropic', 'qwen-oauth', 'gemini', 'vertex-ai'] as const;
export type QwenAuthType = (typeof QWEN_AUTH_TYPES)[number];

export interface QwenModelEntry {
  /** The id `qwen -m` takes. May contain `/` (a router's catalog id). */
  readonly id: string;
  /** The display name, when the entry has one. */
  readonly name?: string;
  /** The `modelProviders` key the entry sits under. */
  readonly authType: QwenAuthType;
  /** The endpoint, when the entry names one. */
  readonly baseUrl?: string;
  /** The NAME of the env var holding the key — never its value. */
  readonly envKey?: string;
  /** True when `baseUrl` points at this machine or a private network: no metered cost. */
  readonly local: boolean;
}

export interface QwenPrice {
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

export interface QwenSettings {
  /** `absent`: no file. `unreadable`: a file that did not parse to an object. */
  readonly status: 'ok' | 'absent' | 'unreadable';
  /** The settings file this answer read. */
  readonly path: string;
  readonly models: readonly QwenModelEntry[];
  /** `model.name`, the model a run with no `--model` uses. */
  readonly defaultModel?: string;
  /** `security.auth.selectedType`. */
  readonly selectedAuthType?: QwenAuthType;
  readonly pricing: ReadonlyMap<string, QwenPrice>;
}

/**
 * The Qwen home for an environment: `QWEN_HOME`, else `~/.qwen`. `QWEN_HOME` is also how a
 * second Qwen account is selected (`PROFILE_ENV_VAR.qwen`).
 */
export function qwenHome(env: NodeJS.ProcessEnv = process.env): string {
  return agentHomePaths(env).qwen;
}

/** Read `<qwenHome>/settings.json`. Never throws. */
export function readQwenSettings(
  home: string = qwenHome(),
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): QwenSettings {
  const path = join(home, 'settings.json');
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const status = code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
    return { status, path, models: [], pricing: new Map() };
  }
  const parsed = parseJsonc(text);
  if (!parsed) return { status: 'unreadable', path, models: [], pricing: new Map() };
  return { status: 'ok', path, ...settingsFromObject(parsed) };
}

/** The pure part of {@link readQwenSettings}, over an already parsed settings object. */
export function settingsFromObject(value: Record<string, unknown>): Omit<QwenSettings, 'status' | 'path'> {
  const models: QwenModelEntry[] = [];
  const providers = asRecord(value.modelProviders) ?? {};
  for (const [authType, list] of Object.entries(providers)) {
    if (!isAuthType(authType) || !Array.isArray(list)) continue;
    for (const raw of list) {
      const entry = asRecord(raw);
      const id = str(entry?.id);
      if (!entry || id === undefined) continue;
      const baseUrl = str(entry.baseUrl);
      const model: QwenModelEntry = {
        id,
        authType,
        local: baseUrl !== undefined && isLocalEndpoint(baseUrl),
        ...(str(entry.name) !== undefined ? { name: str(entry.name) } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(str(entry.envKey) !== undefined ? { envKey: str(entry.envKey) } : {}),
      };
      models.push(model);
    }
  }
  const selected = str(asRecord(asRecord(value.security)?.auth)?.selectedType);
  const pricing = new Map<string, QwenPrice>();
  for (const [id, raw] of Object.entries(asRecord(value.modelPricing) ?? {})) {
    const price = asRecord(raw);
    const input = num(price?.inputPerMillionTokens);
    const output = num(price?.outputPerMillionTokens);
    if (input !== undefined && output !== undefined) pricing.set(id, { inputPerMillionTokens: input, outputPerMillionTokens: output });
  }
  const defaultModel = str(asRecord(value.model)?.name);
  return {
    models,
    pricing,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(selected !== undefined && isAuthType(selected) ? { selectedAuthType: selected } : {}),
  };
}

/**
 * The entry a run's model id selects, when the settings list it. Ids are not unique across auth
 * types, so the person's selected auth type wins a tie, then the first entry in file order.
 */
export function findQwenModel(settings: QwenSettings, id: string): QwenModelEntry | undefined {
  const matches = settings.models.filter((model) => model.id === id);
  return matches.find((model) => model.authType === settings.selectedAuthType) ?? matches[0];
}

/** The env var NAMES every listed model reads its key from — for `buildChildEnv`'s allowlist. */
export function qwenModelEnvKeys(settings: QwenSettings): string[] {
  return [...new Set(settings.models.map((model) => model.envKey).filter((key): key is string => key !== undefined))].sort();
}

/**
 * USD for one execution's usage, or `undefined` when nothing is known about the price.
 *
 * A local endpoint costs nothing (0). A metered model costs what its `modelPricing` row says,
 * with Qwen Code's own formula: input / 1e6 × input price + output / 1e6 × output price. A
 * metered model with no row has no price xezar could defend, so no cost is reported at all —
 * a guessed number is worse than none.
 */
export function qwenCostUsd(
  settings: QwenSettings,
  model: string | undefined,
  usage: { input: number; output: number },
): number | undefined {
  if (model === undefined) return undefined;
  const entry = findQwenModel(settings, model);
  if (entry?.local) return 0;
  const price = settings.pricing.get(model);
  if (!price) return undefined;
  return (usage.input / 1e6) * price.inputPerMillionTokens + (usage.output / 1e6) * price.outputPerMillionTokens;
}

/** Loopback, `.local`, and the private IPv4/IPv6 ranges: an endpoint no provider meters. */
export function isLocalEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return host.includes(':');
  const octets = host.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 0;
}

/** Parse a JSONC object: comments and trailing commas allowed. `undefined` for anything else. */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(stripTrailingCommas(stripJsonComments(text))));
  } catch {
    return undefined;
  }
}

/** Remove JSONC trailing commas without touching commas inside strings. */
function stripTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (/\s/.test(input[next] ?? '')) next++;
      if (input[next] === '}' || input[next] === ']') continue;
    }
    out += character;
  }
  return out;
}

function isAuthType(value: string): value is QwenAuthType {
  return (QWEN_AUTH_TYPES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
