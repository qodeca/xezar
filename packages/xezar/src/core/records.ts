/**
 * Plain-object checks for parsed JSON and agent protocol messages, shared across the core modules.
 *
 * Two modules keep a local copy on purpose: `qwen-tool-policy.ts` is bundled into the standalone
 * Qwen tool-policy hook, whose bytes must not change for a refactor, and `tool-display.ts` is mirrored
 * byte for byte by the api-client protocol copy.
 */

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a plain object, or undefined when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
