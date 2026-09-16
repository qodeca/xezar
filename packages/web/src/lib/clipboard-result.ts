/**
 * Copy text and say honestly whether it worked (#453 G-16).
 *
 * Several surfaces copy a command or a path and then toast about it, and each wrote its own
 * `navigator.clipboard.writeText(…).then(…).catch(…)`. The part that must never drift is the
 * answer: a copy that did not happen is reported as not having happened — a denied permission, a
 * page served over plain http, or a browser with no clipboard API at all — so the caller can show
 * the text itself instead of a "copied" toast over an empty clipboard.
 *
 * This module decides nothing about wording or toasts. It only answers, and it never throws:
 * callers branch on `ok`.
 */

export type ClipboardResult = { ok: true } | { ok: false; reason: string }

/** The one thing this helper needs from the browser, so a test can pass its own. */
export interface ClipboardWriter {
  writeText: (text: string) => Promise<void>
}

function browserClipboard(): ClipboardWriter | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard
}

export async function copyText(
  text: string,
  clipboard: ClipboardWriter | undefined = browserClipboard(),
): Promise<ClipboardResult> {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return { ok: false, reason: 'This browser does not allow copying here' }
  }
  try {
    await clipboard.writeText(text)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message ? error.message : 'The browser refused to copy',
    }
  }
}
