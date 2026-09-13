/**
 * pi's extension-UI dialogs, read off the RPC wire and answered on it (#369).
 *
 * Contract: pi `docs/rpc.md` § Extension UI Protocol (pi 0.85.1). A dialog method
 * (`select`, `confirm`, `input`, `editor`) is an `extension_ui_request` that BLOCKS pi
 * until the client writes an `extension_ui_response` carrying the request's own `id`;
 * only a request that carries `timeout` ever resolves on its own. pi-mcp-adapter's
 * `approveTools` gate is one such `select` with no `timeout`, so a runner that never
 * answers leaves the turn open for ever — measured at 109 s, ended only by closing
 * stdin. Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
 * `set_editor_text`) expect NO response, and must not get one.
 *
 * Pure: frame in, classification out; answer text in, response frame out. The runner
 * owns the pending-dialog state and the write, the way the codex runner owns its
 * `requestUserInput` bridge.
 */
import { parseAskRequest, type AskQuestion } from './ask.ts';

/** A dialog the cockpit can render as an ask card: `select` and `confirm`. */
export interface PiDialog {
  readonly id: string;
  readonly method: 'select' | 'confirm';
  readonly title: string;
  /** The choices pi offered, verbatim — a `select` answer must be one of them. */
  readonly options: readonly string[];
  /** The ask-card question built from the dialog (`parseAskRequest`-valid). */
  readonly question: AskQuestion;
}

export type PiDialogFrame =
  /** Not a dialog: a fire-and-forget method, a non-dialog frame, or no usable `id`. */
  | { kind: 'ignore' }
  /** A `notify` — fire-and-forget, so no response, but worth a transcript line: it is how
   *  pi-mcp-adapter says an MCP entry connected or was refused. */
  | { kind: 'notice'; message: string; level: 'info' | 'warning' | 'error' }
  /** A dialog pi is blocked on that the ask card cannot carry (`input`, `editor`, a
   *  `select` outside the 2–4 option window): answer it at once, never leave it pending. */
  | { kind: 'unsupported'; id: string; method: string; title: string }
  | { kind: 'dialog'; dialog: PiDialog };

/** One `extension_ui_response` frame, ready for `JSON.stringify`. */
export type PiDialogResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

const DIALOG_METHODS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor']);
const CONFIRM_OPTIONS = ['Yes', 'No'] as const;
/** The refusal an autonomous session picks from a `select`, first match wins. */
const DENY_OPTION_RE = /^(deny|block|reject|refuse|cancel|no|never)\b/i;
const APPROVAL_TITLE_RE = /wants to run|approv|allow|permission/i;

export function readPiDialog(value: unknown): PiDialogFrame {
  if (!isRecord(value) || value.type !== 'extension_ui_request') return { kind: 'ignore' };
  const id = string(value.id);
  const method = string(value.method);
  if (method === 'notify') {
    const message = string(value.message)?.trim();
    if (!message) return { kind: 'ignore' };
    const level = string(value.notifyType);
    return { kind: 'notice', message, level: level === 'warning' || level === 'error' ? level : 'info' };
  }
  if (!id || !method || !DIALOG_METHODS.has(method)) return { kind: 'ignore' };
  const title = string(value.title)?.trim() || `pi ${method} dialog`;
  if (method === 'select' || method === 'confirm') {
    const options =
      method === 'confirm'
        ? [...CONFIRM_OPTIONS]
        : Array.isArray(value.options)
          ? value.options.filter((option): option is string => typeof option === 'string')
          : [];
    const message = method === 'confirm' ? string(value.message)?.trim() : undefined;
    const question = askQuestion(title, message, options);
    if (question) return { kind: 'dialog', dialog: { id, method, title, options, question } };
  }
  return { kind: 'unsupported', id, method, title };
}

/** The ask-card question for a dialog, or null when the card cannot carry it. */
function askQuestion(title: string, message: string | undefined, options: readonly string[]): AskQuestion | null {
  const labels = options.map((option) => option.trim().slice(0, 60)).filter((label) => label.length > 0);
  const text = message ? `${title}\n\n${message}` : title;
  const parsed = parseAskRequest({
    questions: [
      {
        header: APPROVAL_TITLE_RE.test(title) ? 'Approval' : 'pi dialog',
        question: text.slice(0, 400),
        options: labels.map((label) => ({ label })),
        multiSelect: false,
      },
    ],
  });
  return parsed?.questions[0] ?? null;
}

/**
 * The response for a user's reply. The cockpit's ask card sends `<header>: <label>`
 * (`ask-card.tsx`); a free-form reply is matched as a whole. A reply that names none of
 * pi's options CANCELS the dialog rather than guessing: pi then hands the extension
 * `undefined`, which pi-mcp-adapter treats as a refusal (`tool-approval.ts`, 2.32.1).
 */
export function answerPiDialog(dialog: PiDialog, text: string): { response: PiDialogResponse; matched: string | null } {
  const reply = replyText(dialog.question.header, text);
  const matched = dialog.options.find((option) => option.trim().toLowerCase() === reply.toLowerCase()) ?? null;
  if (matched === null) return { response: cancelPiDialog(dialog.id), matched };
  if (dialog.method === 'confirm') {
    return { response: { type: 'extension_ui_response', id: dialog.id, confirmed: matched === CONFIRM_OPTIONS[0] }, matched };
  }
  return { response: { type: 'extension_ui_response', id: dialog.id, value: matched }, matched };
}

/**
 * The explicit refusal an autonomous session sends the moment a dialog arrives: nobody
 * is watching, so nothing may wait for them. `Deny` on pi-mcp-adapter's gate is the
 * answer #369 measured (`approval_denied`, turn ends); a `select` with no refusal
 * option, and every `confirm`, is refused through the documented shape for it.
 */
export function denyPiDialog(dialog: PiDialog): { response: PiDialogResponse; answer: string } {
  if (dialog.method === 'confirm') {
    return { response: { type: 'extension_ui_response', id: dialog.id, confirmed: false }, answer: CONFIRM_OPTIONS[1] };
  }
  const deny = dialog.options.find((option) => DENY_OPTION_RE.test(option.trim()));
  if (deny === undefined) return { response: cancelPiDialog(dialog.id), answer: 'cancelled' };
  return { response: { type: 'extension_ui_response', id: dialog.id, value: deny }, answer: deny };
}

export function cancelPiDialog(id: string): PiDialogResponse {
  return { type: 'extension_ui_response', id, cancelled: true };
}

function replyText(header: string, text: string): string {
  const prefix = `${header}:`;
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  const raw = line ? line.slice(prefix.length) : text;
  return raw.split(',')[0]?.trim() ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
