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
  /** The card label for each choice, index-aligned with `options`. pi's RPC contract puts
   *  no limit on a choice; the ask card caps a label at `LABEL_MAX` characters, so a
   *  longer choice is shown shortened with an ellipsis. The WIRE value is never
   *  shortened: `answerPiDialog` maps the label back to `options[i]` by index. */
  readonly labels: readonly string[];
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
   *  `select` outside the 2–4 option window, or one whose choices would render as the
   *  same label so a click could not say which was meant): answer it at once, never
   *  leave it pending and never show a card that cannot answer. */
  | { kind: 'unsupported'; id: string; method: string; title: string }
  | { kind: 'dialog'; dialog: PiDialog };

/** One `extension_ui_response` frame, ready for `JSON.stringify`. */
export type PiDialogResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

const DIALOG_METHODS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor']);
const CONFIRM_OPTIONS = ['Yes', 'No'] as const;
/** The ask card's option-label cap (`askRequestSchema`, `ask.ts`). */
const LABEL_MAX = 60;
const ELLIPSIS = '…';
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
    // A choice that is blank once trimmed has no label to click, so it is left off the
    // card together with its value — the two lists stay index-aligned.
    const options = (
      method === 'confirm'
        ? [...CONFIRM_OPTIONS]
        : Array.isArray(value.options)
          ? value.options.filter((option): option is string => typeof option === 'string')
          : []
    ).filter((option) => option.trim().length > 0);
    const labels = options.map(cardLabel);
    const message = method === 'confirm' ? string(value.message)?.trim() : undefined;
    const question = askQuestion(title, message, labels);
    if (question) return { kind: 'dialog', dialog: { id, method, title, options, labels, question } };
  }
  return { kind: 'unsupported', id, method, title };
}

/** The card label for one of pi's choices: verbatim up to the cap, else cut and marked. */
function cardLabel(option: string): string {
  const trimmed = option.trim();
  return trimmed.length <= LABEL_MAX ? trimmed : `${trimmed.slice(0, LABEL_MAX - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * The ask-card question for a dialog, or null when the card cannot carry it. Two choices
 * that render as one label (pi sent the same choice twice, or two long ones that differ
 * only past the cut) fail the schema's unique-label rule here, so the dialog is reported
 * unsupported and cancelled instead of shown as a card whose click could not be mapped
 * back to one value.
 */
function askQuestion(title: string, message: string | undefined, labels: readonly string[]): AskQuestion | null {
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
 * (`ask-card.tsx`); the label is mapped back to pi's choice by index, so a label the card
 * had to shorten still answers with the full value. The exact label is matched first,
 * case-sensitively: pi's `options` may hold choices that differ only by case (`Allow`,
 * `allow`), and the card shows those as distinct labels, so a click must reach the choice
 * it named and never its case-twin. A free-form reply is matched as a whole, against the
 * label or the value, case-insensitively — but only when that identifies ONE choice; a
 * reply that folds onto two is ambiguous and is treated as naming none. The question is
 * single-select, so the reply is one label and is never split on a comma — `Allow, once`
 * is one choice. A reply that names none of pi's options CANCELS the dialog rather than
 * guessing: pi then hands the extension `undefined`, which pi-mcp-adapter treats as a
 * refusal (`tool-approval.ts`, 2.32.1).
 */
export function answerPiDialog(dialog: PiDialog, text: string): { response: PiDialogResponse; matched: string | null } {
  const index = choiceIndex(dialog, replyText(dialog.question.header, text));
  const matched = index >= 0 ? (dialog.options[index] ?? null) : null;
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

/**
 * The index of the choice a reply names, or -1. Exact label first (the card sends the
 * label it showed, index-keyed), then exact value; then the case-folded reply, accepted
 * only when it identifies exactly one choice across labels and values.
 */
function choiceIndex(dialog: PiDialog, reply: string): number {
  const byLabel = dialog.labels.indexOf(reply);
  if (byLabel >= 0) return byLabel;
  const byValue = dialog.options.findIndex((option) => option.trim() === reply);
  if (byValue >= 0) return byValue;
  const folded = reply.toLowerCase();
  const candidates = new Set<number>();
  dialog.labels.forEach((label, i) => {
    if (label.toLowerCase() === folded) candidates.add(i);
  });
  dialog.options.forEach((option, i) => {
    if (option.trim().toLowerCase() === folded) candidates.add(i);
  });
  return candidates.size === 1 ? [...candidates][0]! : -1;
}

/** The reply's label: the text after `<header>:` on the card's line, else the whole text. */
function replyText(header: string, text: string): string {
  const prefix = `${header}:`;
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return (line ? line.slice(prefix.length) : text).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
