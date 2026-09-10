import { describe, expect, it, vi } from 'vitest';
import { CANCEL } from './types.ts';
import { createAutoUi, createClackUi, type PromptBackend } from './ui.ts';

const CANCEL_SYMBOL = Symbol('clack.cancel');

function fakeBackend(over: Partial<PromptBackend>): PromptBackend {
  const noop = () => undefined;
  return {
    intro: noop,
    outro: noop,
    note: noop,
    log: { info: noop, success: noop, warn: noop, error: noop, message: noop, step: noop } as never,
    select: vi.fn(),
    multiselect: vi.fn(),
    confirm: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    spinner: () => ({ start: noop, stop: noop, message: noop }) as never,
    isCancel: (v: unknown): v is symbol => v === CANCEL_SYMBOL,
    ...over,
  };
}

describe('createClackUi', () => {
  it('maps a cancelled prompt to the CANCEL sentinel, never throws', async () => {
    const ui = createClackUi(fakeBackend({ select: vi.fn().mockResolvedValue(CANCEL_SYMBOL) }));
    await expect(ui.select({ message: 'pick', options: [{ value: 'a', label: 'A' }] })).resolves.toBe(
      CANCEL,
    );
  });

  it('returns the value when the user answers', async () => {
    const ui = createClackUi(fakeBackend({ confirm: vi.fn().mockResolvedValue(true) }));
    await expect(ui.confirm({ message: 'ok?' })).resolves.toBe(true);
  });
});

describe('createClackUi non-TTY guard', () => {
  it('refuses a non-interactive terminal instead of hanging on a prompt', () => {
    // vitest runs without a TTY, so the real backend must throw the clean
    // preflight error (a piped/ssh run would otherwise hang holding the lock).
    expect(() => createClackUi()).toThrow(/not interactive.*--yes/s);
  });
});

describe('createAutoUi', () => {
  it('answers with initial values / first option and never blocks', async () => {
    const ui = createAutoUi();
    expect(await ui.confirm({ message: 'ok?', initialValue: false })).toBe(false);
    expect(await ui.select({ message: 'pick', options: [{ value: 'x', label: 'X' }] })).toBe('x');
    expect(await ui.multiselect({ message: 'many', options: [] })).toEqual([]);
  });

  it('never adopts a placeholder as an answer — it is a hint, not input', async () => {
    const ui = createAutoUi();
    expect(await ui.text({ message: 'name', placeholder: 'xezar.ngrok.app' })).toBe('');
    expect(await ui.text({ message: 'name', placeholder: 'def', initialValue: 'real' })).toBe('real');
  });

  it('strictValidate makes an invalid auto-answer abort instead of flowing on', async () => {
    const strict = createAutoUi({}, () => {}, { strictValidate: true });
    await expect(
      strict.text({ message: 'authtoken', validate: (v) => (v.trim() ? undefined : 'required') }),
    ).rejects.toThrow(/cannot auto-answer "authtoken".*required/s);
    await expect(
      strict.password({ message: 'pw', validate: (v) => (v.length >= 6 ? undefined : 'too short') }),
    ).rejects.toThrow(/too short/);
    // a valid answer (via overrides) passes
    const withAnswer = createAutoUi({ pw: 'longenough' }, () => {}, { strictValidate: true });
    expect(await withAnswer.password({ message: 'pw', validate: (v) => (v.length >= 6 ? undefined : 'too short') })).toBe('longenough');
    // lenient (dry-run) mode walks on with the placeholder-grade value
    const lenient = createAutoUi();
    expect(await lenient.password({ message: 'pw', validate: (v) => (v.length >= 6 ? undefined : 'too short') })).toBe('');
  });

  it('honors per-message answer overrides', async () => {
    const ui = createAutoUi({ 'pick tools': ['gh', 'codex'] });
    expect(await ui.multiselect({ message: 'pick tools', options: [] })).toEqual(['gh', 'codex']);
  });

  it('routes message() to the sink (plain output, no note box)', () => {
    const sink = vi.fn();
    const ui = createAutoUi({}, sink);
    ui.message('sudo bash -lc ...');
    expect(sink).toHaveBeenCalledWith('sudo bash -lc ...');
  });

  it('confirm defaults to yes when the prompt declares no initial value', async () => {
    expect(await createAutoUi().confirm({ message: 'ok?' })).toBe(true);
  });

  it('select has nothing to pick when a prompt offers no options and no initial value', async () => {
    expect(await createAutoUi().select({ message: 'pick', options: [] })).toBeUndefined();
  });

  it('spinner logs only the phases it is actually given a message for', () => {
    const sink = vi.fn();
    const spinner = createAutoUi({}, sink).spinner();
    // A headless spinner must stay silent when the caller passes nothing —
    // otherwise every start/stop pair prints a blank line into a CI log.
    spinner.start();
    spinner.stop();
    expect(sink).not.toHaveBeenCalled();
    spinner.start('installing');
    spinner.message('halfway');
    spinner.stop('done');
    expect(sink.mock.calls.map((call) => call[0])).toEqual(['installing', 'halfway', 'done']);
  });
});

/**
 * The clack adapter is a thin passthrough, and "thin passthrough" is exactly
 * the shape that rots silently: a surface wired to the wrong backend method
 * (or to no backend at all) still type-checks and still returns. These cases
 * pin each surface to the backend call it must make.
 */
describe('createClackUi — every surface reaches the backend it claims', () => {
  it('routes intro, outro, note and each log level to clack', () => {
    const calls: string[] = [];
    const record =
      (tag: string) =>
      (message: unknown, title?: unknown) => {
        calls.push(title === undefined ? `${tag}:${String(message)}` : `${tag}:${String(message)}|${String(title)}`);
      };
    const ui = createClackUi(
      fakeBackend({
        intro: record('intro') as never,
        outro: record('outro') as never,
        note: record('note') as never,
        log: {
          info: record('info'),
          success: record('success'),
          warn: record('warn'),
          error: record('error'),
          message: record('message'),
          step: record('step'),
        } as never,
      }),
    );
    ui.intro('xezar server-install');
    ui.outro('done');
    ui.note('body', 'Authorize gh');
    ui.info('i');
    ui.success('s');
    ui.warn('w');
    ui.error('e');
    expect(calls).toEqual([
      'intro:xezar server-install',
      'outro:done',
      'note:body|Authorize gh',
      'info:i',
      'success:s',
      'warn:w',
      'error:e',
    ]);
  });

  it('message() bypasses the note box and writes the raw line to stdout', () => {
    // clack's note() draws a border that mangles a wrapped shell command, and a
    // mangled command is one the operator cannot copy-paste. This surface must
    // stay a plain stdout write.
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      createClackUi(fakeBackend({})).message("sudo bash -lc 'apt-get install -y nginx'");
      expect(write).toHaveBeenCalledWith("\nsudo bash -lc 'apt-get install -y nginx'\n");
    } finally {
      write.mockRestore();
    }
  });

  it('multiselect returns the picked list and defaults `required` to false', () => {
    const multiselect = vi.fn().mockResolvedValue(['gh', 'codex']);
    const ui = createClackUi(fakeBackend({ multiselect }));
    return (async () => {
      await expect(
        ui.multiselect({ message: 'tools', options: [{ value: 'gh', label: 'gh' }] }),
      ).resolves.toEqual(['gh', 'codex']);
      // Not required: "install nothing" is a legitimate answer to the dependency
      // picker, and a required multiselect would trap the operator in it.
      expect((multiselect.mock.calls[0]?.[0] as { required?: boolean }).required).toBe(false);
      await ui.multiselect({ message: 'tools', options: [], required: true });
      expect((multiselect.mock.calls[1]?.[0] as { required?: boolean }).required).toBe(true);
    })();
  });

  it('maps a cancelled multiselect, text and password to CANCEL, never a throw', async () => {
    const cancelled = vi.fn().mockResolvedValue(CANCEL_SYMBOL);
    const ui = createClackUi(
      fakeBackend({ multiselect: cancelled, text: cancelled, password: cancelled }),
    );
    await expect(ui.multiselect({ message: 'm', options: [] })).resolves.toBe(CANCEL);
    await expect(ui.text({ message: 't' })).resolves.toBe(CANCEL);
    await expect(ui.password({ message: 'p' })).resolves.toBe(CANCEL);
  });

  it('wraps validate so an untouched prompt is validated as "" and never as undefined', async () => {
    // clack hands validate() `undefined` while nothing has been typed. Every
    // validator in this codebase takes a string, so an unwrapped call would
    // throw inside the prompt loop instead of showing "required".
    const seen: Array<string | undefined> = [];
    const answerAfterValidating = (value: string) =>
      vi.fn(async (opts: { validate?: (v: string | undefined) => string | undefined }) => {
        seen.push(opts.validate?.(undefined));
        return value;
      });
    const ui = createClackUi(
      fakeBackend({
        text: answerAfterValidating('shop.example.com') as never,
        password: answerAfterValidating('hunter22') as never,
      }),
    );
    const required = (v: string) => (v.length > 0 ? undefined : 'required');
    await expect(ui.text({ message: 'domain', validate: required })).resolves.toBe('shop.example.com');
    await expect(ui.password({ message: 'password', validate: required })).resolves.toBe('hunter22');
    expect(seen).toEqual(['required', 'required']);
  });

  it('passes no validator through when the prompt declares none', async () => {
    const text = vi.fn(async (opts: { validate?: unknown }) => String(opts.validate));
    const ui = createClackUi(fakeBackend({ text: text as never }));
    await expect(ui.text({ message: 'domain' })).resolves.toBe('undefined');
  });

  it('spinner delegates start, message and stop to the backend handle', () => {
    const handle = { start: vi.fn(), message: vi.fn(), stop: vi.fn() };
    const ui = createClackUi(fakeBackend({ spinner: (() => handle) as never }));
    const spinner = ui.spinner();
    spinner.start('installing');
    spinner.message('halfway');
    spinner.stop('done');
    expect(handle.start).toHaveBeenCalledWith('installing');
    expect(handle.message).toHaveBeenCalledWith('halfway');
    expect(handle.stop).toHaveBeenCalledWith('done');
  });
});
