import { z } from 'zod';

/**
 * The error body every route answers a refusal with: `{ error }`, the human sentence the cockpit
 * shows verbatim, plus an optional machine `code` for the few refusals a client must recognise
 * and act on. A client matches the CODE, never the sentence: the sentence may be reworded, the
 * code is a stable name. Routes add their own extra keys (`command`, `manual`, `exists`, a
 * stale-version payload) beside these two.
 */
export const API_ERROR_CODES = [
  /**
   * `POST /runs/:id/continue` (409): the engine has not yet released the run. It is transitional
   * right after a session closes on its idle timer, so a client may retry it on a short, bounded
   * schedule; every other 409 is a final answer.
   */
  'run_still_active',
  /** A terminal handoff (409): the task's folder path cannot be passed safely to cmd.exe. */
  'terminal_folder_unsafe',
  /** A terminal handoff (409): the session's account folder cannot be put in a terminal command. */
  'terminal_account_unsafe',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const RUN_STILL_ACTIVE_CODE = 'run_still_active' satisfies ApiErrorCode;
export const TERMINAL_FOLDER_UNSAFE_CODE = 'terminal_folder_unsafe' satisfies ApiErrorCode;
export const TERMINAL_ACCOUNT_UNSAFE_CODE = 'terminal_account_unsafe' satisfies ApiErrorCode;

export const apiErrorBodySchema = z.object({
  error: z.string(),
  code: apiErrorCodeSchema.optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** The `code` of an untrusted error body, or undefined when it carries none this contract names. */
export function apiErrorCode(body: unknown): ApiErrorCode | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const parsed = apiErrorCodeSchema.safeParse((body as { code?: unknown }).code);
  return parsed.success ? parsed.data : undefined;
}
