import { describe, expect, it } from 'vitest';

import { answerPiDialog, denyPiDialog, readPiDialog } from './pi-dialog.js';

/** The frame pi-mcp-adapter 2.32.1 emits for an `approveTools` gate — wire-faithful to the
 *  A-01 transcript that found #369 (title from `tool-approval.ts`, no `timeout`). */
const APPROVAL = {
  type: 'extension_ui_request',
  id: 'a3c1e8f0-1',
  method: 'select',
  title: 'MCP: xezar wants to run health\n\nArguments:\n{}',
  options: ['Allow once', 'Allow for session', 'Deny'],
};

describe('pi extension dialogs (#369)', () => {
  it('reads an approval select as one ask-card question carrying pi’s own options', () => {
    const frame = readPiDialog(APPROVAL);
    expect(frame.kind).toBe('dialog');
    if (frame.kind !== 'dialog') return;
    expect(frame.dialog.id).toBe('a3c1e8f0-1');
    expect(frame.dialog.question.header).toBe('Approval');
    expect(frame.dialog.question.options.map((o) => o.label)).toEqual(['Allow once', 'Allow for session', 'Deny']);
    expect(frame.dialog.question.question).toContain('xezar wants to run health');
  });

  it('answers with the option the cockpit card named, correlated by pi’s request id', () => {
    const frame = readPiDialog(APPROVAL);
    if (frame.kind !== 'dialog') throw new Error('expected a dialog');
    expect(answerPiDialog(frame.dialog, 'Approval: Deny')).toEqual({
      matched: 'Deny',
      response: { type: 'extension_ui_response', id: 'a3c1e8f0-1', value: 'Deny' },
    });
    // A free-form reply is matched whole, case-insensitively.
    expect(answerPiDialog(frame.dialog, 'allow once').response).toEqual({
      type: 'extension_ui_response',
      id: 'a3c1e8f0-1',
      value: 'Allow once',
    });
  });

  it('dismisses the dialog rather than guessing when the reply names no option', () => {
    const frame = readPiDialog(APPROVAL);
    if (frame.kind !== 'dialog') throw new Error('expected a dialog');
    expect(answerPiDialog(frame.dialog, 'go ahead please')).toEqual({
      matched: null,
      response: { type: 'extension_ui_response', id: 'a3c1e8f0-1', cancelled: true },
    });
  });

  it('refuses explicitly: the adapter’s Deny, a confirm’s false, and cancel when no refusal exists', () => {
    const approval = readPiDialog(APPROVAL);
    if (approval.kind !== 'dialog') throw new Error('expected a dialog');
    expect(denyPiDialog(approval.dialog)).toEqual({
      answer: 'Deny',
      response: { type: 'extension_ui_response', id: 'a3c1e8f0-1', value: 'Deny' },
    });
    const confirm = readPiDialog({ type: 'extension_ui_request', id: 'c-1', method: 'confirm', title: 'Clear session?' });
    if (confirm.kind !== 'dialog') throw new Error('expected a dialog');
    expect(denyPiDialog(confirm.dialog).response).toEqual({ type: 'extension_ui_response', id: 'c-1', confirmed: false });
    const pick = readPiDialog({ type: 'extension_ui_request', id: 's-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
    if (pick.kind !== 'dialog') throw new Error('expected a dialog');
    expect(denyPiDialog(pick.dialog).response).toEqual({ type: 'extension_ui_response', id: 's-1', cancelled: true });
  });

  it('GUARD: fire-and-forget methods and non-dialog frames are never dialogs — pi expects no response', () => {
    // `notify` is the one fire-and-forget frame worth a transcript line (the adapter's connection notice).
    expect(readPiDialog({ type: 'extension_ui_request', id: 'n-1', method: 'notify', message: 'MCP: xezar connected', notifyType: 'info' })).toEqual({
      kind: 'notice',
      message: 'MCP: xezar connected',
      level: 'info',
    });
    expect(readPiDialog({ type: 'extension_ui_request', id: 'n-2', method: 'notify', message: 'MCP: xezar refused', notifyType: 'error' })).toMatchObject({ level: 'error' });
    expect(readPiDialog({ type: 'extension_ui_request', id: 'n-3', method: 'notify' })).toEqual({ kind: 'ignore' });
    expect(readPiDialog({ type: 'extension_ui_request', id: 'w-1', method: 'setWidget', widgetLines: [] })).toEqual({ kind: 'ignore' });
    expect(readPiDialog({ type: 'agent_settled' })).toEqual({ kind: 'ignore' });
    expect(readPiDialog({ type: 'extension_ui_request', method: 'select', options: ['A', 'B'] })).toEqual({ kind: 'ignore' }); // no id
    expect(readPiDialog(null)).toEqual({ kind: 'ignore' });
  });

  it('marks a dialog the card cannot carry as unsupported, so the runner can dismiss it at once', () => {
    expect(readPiDialog({ type: 'extension_ui_request', id: 'i-1', method: 'input', title: 'Enter a value' })).toEqual({
      kind: 'unsupported',
      id: 'i-1',
      method: 'input',
      title: 'Enter a value',
    });
    const five = readPiDialog({ type: 'extension_ui_request', id: 's-5', method: 'select', title: 'Pick', options: ['1', '2', '3', '4', '5'] });
    expect(five.kind).toBe('unsupported');
    const one = readPiDialog({ type: 'extension_ui_request', id: 's-0', method: 'select', title: 'Pick', options: ['only'] });
    expect(one.kind).toBe('unsupported');
  });
});
