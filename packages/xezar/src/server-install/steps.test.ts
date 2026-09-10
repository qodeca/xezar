import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoUi } from './ui.ts';
import {
  HOSTNAME_RE,
  aptInstallTool,
  brewInstallTool,
  brewRemoveHint,
  defaultRunner,
  depCheckStep,
  generatePassword,
  hasPasswordlessSudo,
  owned,
  shared,
  shquote,
  sudoStep,
  StepAborted,
  StepCancelled,
  StepSkipped,
  verifyCommand,
} from './steps.ts';
import { runInstall, runUninstall, type RunOptions } from './engine.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { BackendCheck } from '../core/backend-detect.ts';
import { CANCEL, type CommandResult, type InstallContext, type InstallStep, type PlatformStrategy, type Runner, type Ui } from './types.ts';

function makeCtx(over: {
  ui?: Ui;
  runner?: Partial<Runner>;
  dryRun?: boolean;
  assumeYes?: boolean;
  reconfigure?: Set<string>;
}): InstallContext {
  const runner: Runner = {
    capture: over.runner?.capture ?? (async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' })),
    interactive: over.runner?.interactive ?? (async () => 0),
  };
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: over.assumeYes ?? false,
    reconfigure: over.reconfigure ?? new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
    prefs: {},
  };
}

/** A Ui whose select/confirm answers come from queues, consumed in order. */
function scriptedUi(select: string[], confirm: boolean[]): Ui {
  const base = createAutoUi();
  const selects = [...select];
  const confirms = [...confirm];
  return {
    ...base,
    async select() {
      return selects.shift() as never;
    },
    async confirm() {
      return confirms.shift() ?? true;
    },
  };
}

describe('sudoStep', () => {
  it('dry-run performs no exec and no verify', async () => {
    const interactive = vi.fn(async () => 0);
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const verify = vi.fn(async () => true);
    const ctx = makeCtx({ dryRun: true, runner: { interactive, capture } });
    await sudoStep(ctx, { description: 'x', command: 'apt-get install -y nginx', verify });
    expect(interactive).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('run-via-sudo then verify-fail loops to redo until verify passes', async () => {
    const interactive = vi.fn(async () => 0);
    const verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ui = scriptedUi(['sudo', 'sudo'], [true]); // 2 sudo runs, 1 redo=yes
    const ctx = makeCtx({ ui, runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await sudoStep(ctx, { description: 'install nginx', command: 'apt-get install -y nginx', verify });
    expect(interactive).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('delegate path does not shell out to sudo but still verifies', async () => {
    const interactive = vi.fn(async () => 0);
    const verify = vi.fn(async () => true);
    const ui = scriptedUi(['delegate'], [true]); // choose delegate, confirm done
    const ctx = makeCtx({ ui, runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await sudoStep(ctx, { description: 'write vhost', command: 'tee /etc/nginx/x', verify });
    expect(interactive).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('--yes aborts when verification fails (never loops forever)', async () => {
    const verify = vi.fn(async () => false);
    // passwordless sudo available so it runs non-interactively
    const ctx = makeCtx({
      assumeYes: true,
      runner: { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 },
    });
    await expect(sudoStep(ctx, { description: 'x', command: 'true', verify })).rejects.toBeInstanceOf(
      StepAborted,
    );
  });

  it('defaults the mode prompt to delegate and reuses the choice for later steps', async () => {
    const select = vi.fn(async (_o: { initialValue?: string }) => 'delegate' as never);
    const verify = vi.fn(async () => true);
    const ui = { ...createAutoUi(), select, confirm: async () => true } as Ui;
    const ctx = makeCtx({ ui });
    await sudoStep(ctx, { description: 'a', command: 'true', verify });
    await sudoStep(ctx, { description: 'b', command: 'true', verify });
    expect(select).toHaveBeenCalledTimes(1); // asked once, remembered after (issue #6)
    expect(select.mock.calls[0]?.[0]?.initialValue).toBe('delegate'); // issue #1
    expect(ctx.prefs.sudoMode).toBe('delegate');
  });

  it('skippable step offers Skip on repeated failure and throws StepSkipped', async () => {
    const verify = vi.fn(async () => false);
    const ui = scriptedUi(['delegate', 'skip'], [true]); // pick delegate, confirm run, then skip
    const ctx = makeCtx({ ui, runner: { interactive: async () => 0, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await expect(
      sudoStep(ctx, { description: 'ssl', command: 'certbot ...', skippable: true, skipHint: 'later', verify }),
    ).rejects.toBeInstanceOf(StepSkipped);
  });

  it('--yes on a skippable step skips (not aborts) when verification fails', async () => {
    const verify = vi.fn(async () => false);
    const ctx = makeCtx({
      assumeYes: true,
      runner: { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 },
    });
    await expect(
      sudoStep(ctx, { description: 'ssl', command: 'certbot', skippable: true, verify }),
    ).rejects.toBeInstanceOf(StepSkipped);
  });
});

describe('generatePassword', () => {
  it('is strong: default length, every character class, and crypto-varied', () => {
    const p = generatePassword();
    expect(p.length).toBe(16);
    expect(/[a-z]/.test(p)).toBe(true);
    expect(/[A-Z]/.test(p)).toBe(true);
    expect(/[0-9]/.test(p)).toBe(true);
    expect(/[!@#$%^&*\-_=+]/.test(p)).toBe(true);
    expect(generatePassword()).not.toBe(generatePassword());
  });

  it('never drops below 8 characters even when asked for fewer', () => {
    expect(generatePassword(4).length).toBe(8);
  });
});

describe('verifyCommand', () => {
  it('returns false in dry-run without running anything', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const ctx = makeCtx({ dryRun: true, runner: { capture } });
    expect(await verifyCommand(ctx, 'gh', ['--version'])).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('applies the matcher to captured output', async () => {
    const ctx = makeCtx({ runner: { capture: async () => ({ code: 0, stdout: 'nginx/1.24', stderr: '' }) } });
    expect(await verifyCommand(ctx, 'nginx', ['-v'], (r) => r.stdout.includes('nginx/'))).toBe(true);
  });
});

describe('sudoStep secret channel (stdin, never argv)', () => {
  it('sudo mode pipes `input` to stdin and keeps it out of the command argv', async () => {
    const interactive = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => 0);
    const ctx = makeCtx({
      assumeYes: true,
      runner: {
        interactive,
        capture: async () => ({ code: 0, stdout: '', stderr: '' }), // passwordless sudo
      },
    });
    await sudoStep(ctx, {
      description: 'write credentials',
      command: 'cat > /etc/xezar/htpasswd && chmod 0640 /etc/xezar/htpasswd',
      input: 'ops:$apr1$secret-hash\n',
      inputLabel: 'credential line',
      verify: async () => true,
    });
    expect(interactive).toHaveBeenCalledWith(
      'sudo',
      ['bash', '-lc', 'cat > /etc/xezar/htpasswd && chmod 0640 /etc/xezar/htpasswd'],
      { input: 'ops:$apr1$secret-hash\n' },
    );
    const argv = interactive.mock.calls[0]?.[1] ?? [];
    expect(argv.join(' ')).not.toContain('secret-hash'); // the leak the review flagged
  });

  it('delegate mode shows the payload on screen (not argv) for a paste + Ctrl-D', async () => {
    const shown: string[] = [];
    const ui: Ui = {
      ...scriptedUi(['delegate'], [true]),
      message: (m) => shown.push(m),
      info: (m) => shown.push(m),
    };
    const ctx = makeCtx({ ui });
    await sudoStep(ctx, {
      description: 'write credentials',
      command: 'cat > /etc/xezar/htpasswd',
      input: 'ops:$apr1$secret-hash\n',
      inputLabel: 'credential line',
      verify: async () => true,
    });
    expect(shown.some((m) => m.includes('Ctrl-D'))).toBe(true);
    expect(shown.some((m) => m.includes('ops:$apr1$secret-hash'))).toBe(true);
    // the displayed command itself must not embed the payload
    const displayed = shown.find((m) => m.startsWith('sudo bash -lc'));
    expect(displayed).toBeDefined();
    expect(displayed).not.toContain('secret-hash');
  });
});

/**
 * The "at least one agent CLI" gate (#387 review). `BackendCheck['name']` mixes agent CLIs with
 * the non-agent tools (`gh`, `git`), so the gate must filter — and the literal `['claude',
 * 'codex', 'opencode']` it used to filter with was a runtime string array typecheck could not
 * guard, so a pi-only host reported "no agent CLI" while pi sat right there in the checks.
 * These cases pin the gate to RUNNER_IDS: every runner satisfies it alone, no non-runner does.
 */
describe('depCheckStep — the agent-CLI gate', () => {
  const check = (name: BackendCheck['name'], available: boolean): BackendCheck => ({ name, available });

  const runGate = (checks: BackendCheck[]) =>
    depCheckStep({ detect: async () => checks }).check!(makeCtx({}));

  it.each(RUNNER_IDS)('is satisfied by %s alone — no runner is second-class', async (runner) => {
    await expect(runGate([check(runner, true), check('gh', false), check('git', true)])).resolves.toBe(true);
  });

  it('is NOT satisfied when every agent CLI is missing, however many other tools are present', async () => {
    const checks: BackendCheck[] = [
      ...RUNNER_IDS.map((r) => check(r, false)),
      check('gh', true),
      check('git', true),
    ];
    await expect(runGate(checks)).resolves.toBe(false);
  });

  it('never counts a non-agent tool as an agent CLI', async () => {
    await expect(runGate([check('gh', true), check('git', true)])).resolves.toBe(false);
  });

  it('stays unsatisfied in dry-run — the step must still be offered', async () => {
    const step = depCheckStep({ detect: async () => [check('claude', true)] });
    await expect(step.check!(makeCtx({ dryRun: true }))).resolves.toBe(false);
  });
});

/** Capture everything a step said, in order, so ordering can be asserted. */
function recordingUi(over: Partial<Ui> = {}): { ui: Ui; lines: string[]; notes: Array<[string, string | undefined]>; warns: string[] } {
  const lines: string[] = [];
  const notes: Array<[string, string | undefined]> = [];
  const warns: string[] = [];
  const ui: Ui = {
    ...createAutoUi(),
    info: (m) => lines.push(m),
    message: (m) => lines.push(m),
    success: (m) => lines.push(m),
    error: (m) => lines.push(m),
    warn: (m) => {
      warns.push(m);
      lines.push(m);
    },
    note: (m, t) => notes.push([m, t]),
    ...over,
  };
  return { ui, lines, notes, warns };
}

/**
 * `defaultRunner` is the only place in the installer that touches
 * `child_process`, and every fake in this file is written against its contract.
 * If the real implementation drifts from that contract — throws on a missing
 * program, loses stderr, ignores `input` — every other test here keeps passing
 * while the installer breaks on a real host. These cases run real (local,
 * offline, port-free) children to pin it.
 */
describe('defaultRunner — the real child_process seam', () => {
  it('captures stdout, stderr and the exit code without throwing on failure', async () => {
    const result = await defaultRunner.capture(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
    ]);
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('feeds `input` through stdin, so a secret never has to ride in argv', async () => {
    const result = await defaultRunner.capture(
      process.execPath,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d));'],
      { input: 'ops:$apr1$secret-hash\n' },
    );
    expect(result).toEqual({ code: 0, stdout: 'ops:$apr1$secret-hash\n', stderr: '' });
  });

  it('reports a program that does not exist as code 127 instead of rejecting', async () => {
    // A missing tool is the normal case on a fresh box: `capture` is the probe
    // `verifyCommand` runs, so it has to answer "no" rather than crash the CLI.
    const result = await defaultRunner.capture('xezar-no-such-program-56', ['--version']);
    expect(result.code).toBe(127);
  });

  it('interactive resolves with the child exit code', async () => {
    expect(await defaultRunner.interactive(process.execPath, ['-e', 'process.exit(7)'])).toBe(7);
  });

  it('interactive reports a missing program as 127 instead of rejecting', async () => {
    expect(await defaultRunner.interactive('xezar-no-such-program-56', [])).toBe(127);
  });

  it('interactive pipes `input` to stdin and merges `env` for in-child expansion', async () => {
    // The two secret channels that keep credentials out of `ps` output: stdin,
    // and an env var the privileged command expands itself.
    const code = await defaultRunner.interactive(
      process.execPath,
      [
        '-e',
        'let d = ""; process.stdin.on("data", (c) => { d += c; }); process.stdin.on("end", () => process.exit(d.trim() === process.env.XEZ_TEST_SECRET ? 0 : 1));',
      ],
      { input: 'pa55word\n', env: { XEZ_TEST_SECRET: 'pa55word' } },
    );
    expect(code).toBe(0);
  });
});

describe('hasPasswordlessSudo', () => {
  it('is false in dry-run and probes nothing at all', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    expect(await hasPasswordlessSudo(makeCtx({ dryRun: true, runner: { capture } }))).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('asks `sudo -n true` and answers with its exit code', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    expect(await hasPasswordlessSudo(makeCtx({ runner: { capture } }))).toBe(true);
    expect(capture).toHaveBeenCalledWith('sudo', ['-n', 'true']);
    const denied = makeCtx({ runner: { capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    expect(await hasPasswordlessSudo(denied)).toBe(false);
  });
});

describe('HOSTNAME_RE', () => {
  it('accepts a bare DNS name', () => {
    for (const host of ['example.com', 'shop.example.com', 'a-b.example.co.uk', 'XEZAR.Example.COM']) {
      expect(HOSTNAME_RE.test(host)).toBe(true);
    }
  });

  it('rejects a scheme, a path, a port, a bare label and anything a shell or nginx would read', () => {
    // This regexp is what stops a --domain value reaching an nginx server_name
    // or a shell command as something other than a hostname.
    for (const host of [
      'https://example.com',
      'example.com/path',
      'example.com:8080',
      'example',
      'exa mple.com',
      'example.com;rm -rf /',
      '-bad.example.com',
      'example.com$(id)',
      '',
    ]) {
      expect(HOSTNAME_RE.test(host)).toBe(false);
    }
  });
});

describe('shquote', () => {
  it('quotes a plain command so it survives a copy-paste unchanged', () => {
    expect(shquote('apt-get install -y nginx')).toBe("'apt-get install -y nginx'");
  });

  it('escapes an embedded single quote instead of ending the quoted string early', async () => {
    // Proved through a real shell, not a hand-written escape sequence: the
    // point of shquote is that `sudo bash -lc <quoted>` runs the exact string,
    // and only a shell can testify to that.
    const command = `printf %s 'it'\\''s here' > /tmp/x`;
    const echoed = await defaultRunner.capture('sh', ['-c', `printf %s ${shquote(command)}`]);
    expect(echoed.code).toBe(0);
    expect(echoed.stdout).toBe(command);
  });
});

describe('artifact helpers', () => {
  it('owned() tags something uninstall must remove', () => {
    expect(owned('file', { path: '/etc/nginx/sites-available/xezar' })).toEqual({
      kind: 'owned',
      type: 'file',
      path: '/etc/nginx/sites-available/xezar',
    });
  });

  it('shared() tags something uninstall must only list', () => {
    expect(shared('package', { name: 'gh', removeHint: 'sudo apt-get remove -y gh' })).toEqual({
      kind: 'shared',
      type: 'package',
      name: 'gh',
      removeHint: 'sudo apt-get remove -y gh',
    });
  });
});

describe('sudoStep — what the operator is shown and asked', () => {
  it('dry-run with a secret names the payload without ever printing it', async () => {
    const { ui, lines } = recordingUi();
    await sudoStep(makeCtx({ dryRun: true, ui }), {
      description: 'write credentials',
      command: 'cat > /etc/xezar/htpasswd',
      input: 'ops:$apr1$secret-hash\n',
      inputLabel: 'credential line',
      verify: async () => true,
    });
    const shown = lines.join('\n');
    expect(shown).toContain('DRY RUN');
    expect(shown).toContain('credential line');
    expect(shown).not.toContain('secret-hash');
  });

  it('prints the optional note above the raw command', async () => {
    const { ui, lines } = recordingUi({ select: async () => 'delegate' as never, confirm: async () => true });
    await sudoStep(makeCtx({ ui }), {
      description: 'write the vhost',
      note: 'server {\n  listen 80;\n}',
      command: 'tee /etc/nginx/sites-available/xezar',
      verify: async () => true,
    });
    const noteAt = lines.indexOf('server {\n  listen 80;\n}');
    const commandAt = lines.findIndex((m) => m.startsWith('sudo bash -lc'));
    expect(noteAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeLessThan(commandAt);
  });

  it('warns about a non-zero sudo exit but still lets verify() have the last word', async () => {
    // Some privileged commands exit non-zero and still leave the box correct
    // (a service already enabled, an idempotent apt call). The verification
    // probe, not the exit code, decides whether the step advanced.
    const { ui, warns } = recordingUi({ select: async () => 'sudo' as never });
    const ctx = makeCtx({ ui, runner: { interactive: async () => 2 } });
    await sudoStep(ctx, { description: 'x', command: 'systemctl enable xezar', verify: async () => true });
    expect(warns.some((m) => m.includes('code 2'))).toBe(true);
  });

  it('cancelling the sudo-vs-delegate prompt throws StepCancelled', async () => {
    const { ui } = recordingUi({ select: async () => CANCEL as never });
    await expect(
      sudoStep(makeCtx({ ui }), { description: 'x', command: 'true', verify: async () => true }),
    ).rejects.toBeInstanceOf(StepCancelled);
  });

  it('cancelling the "have you run it as root?" confirm throws StepCancelled', async () => {
    const { ui } = recordingUi({
      select: async () => 'delegate' as never,
      confirm: async () => CANCEL as never,
    });
    await expect(
      sudoStep(makeCtx({ ui }), { description: 'x', command: 'true', verify: async () => true }),
    ).rejects.toBeInstanceOf(StepCancelled);
  });

  it('--yes without passwordless sudo delegates, and never blocks on a hidden prompt', async () => {
    const interactive = vi.fn(async () => 0);
    const select = vi.fn(async () => 'sudo' as never);
    const confirm = vi.fn(async () => true);
    const { ui } = recordingUi({ select, confirm });
    const ctx = makeCtx({
      assumeYes: true,
      ui,
      // `sudo -n true` fails ⇒ sudo would prompt for a password we do not have.
      runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) },
    });
    await sudoStep(ctx, { description: 'x', command: 'true', verify: async () => true });
    expect(interactive).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('declining the redo prompt aborts the step', async () => {
    const ui = scriptedUi(['delegate'], [true, false]); // run it; then "Try again?" = no
    await expect(
      sudoStep(makeCtx({ ui }), { description: 'x', command: 'true', verify: async () => false }),
    ).rejects.toBeInstanceOf(StepAborted);
  });

  it('cancelling the retry-or-skip prompt on a skippable step throws StepCancelled', async () => {
    const answers: Array<string | typeof CANCEL> = ['delegate', CANCEL];
    const { ui } = recordingUi({ select: async () => answers.shift() as never, confirm: async () => true });
    await expect(
      sudoStep(makeCtx({ ui }), { description: 'ssl', command: 'certbot', skippable: true, verify: async () => false }),
    ).rejects.toBeInstanceOf(StepCancelled);
  });
});

describe('depCheckStep — installing, authorizing and rolling back', () => {
  const check = (name: BackendCheck['name'], available: boolean, hint?: string): BackendCheck =>
    hint === undefined ? { name, available } : { name, available, hint };

  it('installs nothing and asks nothing when every dependency is already present', async () => {
    const multiselect = vi.fn();
    const { ui } = recordingUi({ multiselect });
    const installTool = vi.fn(async () => {});
    const step = depCheckStep({ detect: async () => [check('claude', true), check('gh', true)], installTool });
    await expect(step.run(makeCtx({ ui }))).resolves.toEqual({ artifacts: [] });
    expect(installTool).not.toHaveBeenCalled();
    expect(multiselect).not.toHaveBeenCalled();
  });

  it('offers only the missing tools, never git, and installs exactly what was picked', async () => {
    // `git` is the host's own prerequisite, not something the wizard installs —
    // offering it invites an operator to "fix" a box that is already fine.
    const multiselect = vi.fn(
      async (_opts: { options: Array<{ value: unknown; label: string }> }) =>
        ['gh', 'claude', 'opencode'] as never,
    );
    const { ui, notes } = recordingUi({ multiselect: multiselect as Ui['multiselect'] });
    const installTool = vi.fn(async () => {});
    const step = depCheckStep({
      detect: async () => [
        check('codex', true),
        check('claude', false, 'run `claude login`'),
        check('gh', false, 'run `gh auth login`'),
        check('opencode', false),
        check('git', false),
      ],
      installTool,
    });
    const created = await step.run(makeCtx({ ui }));
    const offered = (multiselect.mock.calls[0]?.[0].options ?? []).map((o) => String(o.value));
    expect(offered).toEqual(['claude', 'gh', 'opencode']);
    expect(installTool.mock.calls.map((c) => (c as unknown as [InstallContext, string])[1])).toEqual([
      'gh',
      'claude',
      'opencode',
    ]);
    // Every installed tool is recorded as `shared` with its own removal hint —
    // uninstall lists these instead of yanking a tool the operator now uses.
    expect(created?.artifacts).toEqual([
      { kind: 'shared', type: 'package', name: 'gh', removeHint: 'sudo apt-get remove -y gh' },
      { kind: 'shared', type: 'package', name: 'claude', removeHint: 'npm rm -g @anthropic-ai/claude-code' },
      { kind: 'shared', type: 'package', name: 'opencode', removeHint: '# remove opencode manually' },
    ]);
    // The authorization instruction is shown only for tools that carry one.
    expect(notes).toEqual([
      ['run `gh auth login`', 'Authorize gh'],
      ['run `claude login`', 'Authorize claude'],
    ]);
  });

  it('cancelling the tool picker throws StepCancelled and installs nothing', async () => {
    const installTool = vi.fn(async () => {});
    const { ui } = recordingUi({ multiselect: async () => CANCEL as never });
    const step = depCheckStep({ detect: async () => [check('gh', false)], installTool });
    await expect(step.run(makeCtx({ ui }))).rejects.toBeInstanceOf(StepCancelled);
    expect(installTool).not.toHaveBeenCalled();
  });

  it('a platform-specific removeHint reaches the recorded artifact', async () => {
    const { ui } = recordingUi({ multiselect: async () => ['gh'] as never });
    const step = depCheckStep({
      detect: async () => [check('gh', false)],
      installTool: async () => {},
      removeHint: brewRemoveHint,
    });
    const created = await step.run(makeCtx({ ui }));
    expect(created?.artifacts).toEqual([
      { kind: 'shared', type: 'package', name: 'gh', removeHint: 'brew uninstall gh' },
    ]);
  });

  it('undo lists the shared tools with their removal commands — it never removes them', async () => {
    const { ui, notes } = recordingUi();
    const step = depCheckStep();
    await step.undo(makeCtx({ ui }), {
      artifacts: [
        shared('package', { name: 'gh', removeHint: 'sudo apt-get remove -y gh' }),
        shared('package', { name: 'opencode' }),
      ],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[0]).toBe('sudo apt-get remove -y gh\nopencode');
    expect(notes[0]?.[1]).toMatch(/remove manually/);
  });

  it('undo says nothing when it installed nothing, and tolerates a null ledger', async () => {
    const { ui, notes } = recordingUi();
    const step = depCheckStep();
    await step.undo(makeCtx({ ui }), { artifacts: [] });
    await step.undo(makeCtx({ ui }), null);
    expect(notes).toEqual([]);
  });
});

describe('aptInstallTool (Ubuntu) — apt for gh, sudo npm for the agent CLIs', () => {
  /** `--yes` + passwordless sudo, so every sudoStep runs straight through. */
  const yesCtx = (over: { ui?: Ui; interactive?: Runner['interactive'] } = {}) =>
    makeCtx({
      assumeYes: true,
      ui: over.ui,
      runner: {
        interactive: over.interactive ?? (async () => 0),
        capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      },
    });

  it('installs gh through apt as a privileged step', async () => {
    const interactive = vi.fn(async () => 0);
    await aptInstallTool(yesCtx({ interactive }), 'gh');
    expect(interactive).toHaveBeenCalledWith(
      'sudo',
      ['bash', '-lc', 'apt-get update && apt-get install -y gh'],
      undefined,
    );
  });

  it('installs an agent CLI globally with npm, under sudo (system node)', async () => {
    const interactive = vi.fn(async () => 0);
    await aptInstallTool(yesCtx({ interactive }), 'claude');
    expect(interactive).toHaveBeenCalledWith(
      'sudo',
      ['bash', '-lc', 'npm install -g @anthropic-ai/claude-code'],
      undefined,
    );
  });

  it('points at the website for opencode rather than pretending to install it', async () => {
    const { ui, notes } = recordingUi();
    const interactive = vi.fn(async () => 0);
    await aptInstallTool(yesCtx({ ui, interactive }), 'opencode');
    expect(notes[0]?.[0]).toContain('opencode.ai');
    expect(interactive).not.toHaveBeenCalled();
  });

  it('warns instead of guessing when it has no installer for a tool', async () => {
    const { ui, warns } = recordingUi();
    const interactive = vi.fn(async () => 0);
    await aptInstallTool(yesCtx({ ui, interactive }), 'some-future-cli');
    expect(warns.join('\n')).toContain('no known installer for some-future-cli');
    expect(interactive).not.toHaveBeenCalled();
  });
});

describe('brewInstallTool (macOS) — brew for gh, plain npm for the agent CLIs', () => {
  it('installs gh with brew and never escalates to sudo', async () => {
    const interactive = vi.fn(async () => 0);
    await brewInstallTool(makeCtx({ runner: { interactive } }), 'gh');
    expect(interactive).toHaveBeenCalledWith('brew', ['install', 'gh']);
  });

  it('installs an agent CLI with plain `npm install -g` — macOS needs no sudo here', async () => {
    const interactive = vi.fn(async () => 0);
    await brewInstallTool(makeCtx({ runner: { interactive } }), 'codex');
    expect(interactive).toHaveBeenCalledWith('npm', ['install', '-g', '@openai/codex']);
  });

  it('dry-run prints both commands and runs neither', async () => {
    const interactive = vi.fn(async () => 0);
    const { ui, lines } = recordingUi();
    const ctx = makeCtx({ dryRun: true, ui, runner: { interactive } });
    await brewInstallTool(ctx, 'gh');
    await brewInstallTool(ctx, 'codex');
    expect(lines).toEqual([
      'DRY RUN — would run: brew install gh',
      'DRY RUN — would run: npm install -g @openai/codex',
    ]);
    expect(interactive).not.toHaveBeenCalled();
  });
});

describe('brewRemoveHint', () => {
  it('uses brew for gh, npm for the agent CLIs, and a manual note for anything else', () => {
    expect(brewRemoveHint('gh')).toBe('brew uninstall gh');
    expect(brewRemoveHint('claude')).toBe('npm rm -g @anthropic-ai/claude-code');
    expect(brewRemoveHint('codex')).toBe('npm rm -g @openai/codex');
    expect(brewRemoveHint('opencode')).toBe('# remove opencode manually');
  });
});

/**
 * Rollback scope. `engine.test.ts` already pins that a failing required step
 * stops the run and that install-then-uninstall reverses each step in reverse
 * order. The other half of that contract has no case: a step the run never
 * reached must NOT be undone. An over-eager undo runs a removal against a host
 * where nothing was created — deleting a file, a service or a cert that
 * belonged to something else.
 */
describe('rollback scope — a step that never ran is never undone', () => {
  let home: string;
  const original = process.env.XEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-steps-rollback-'));
    process.env.XEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  const runOpts = (over: Partial<RunOptions> = {}): RunOptions => ({
    dryRun: false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-09-10T00:00:00.000Z',
    ui: createAutoUi(),
    runner: { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 },
    ...over,
  });

  const fakeStep = (id: string, over: Partial<InstallStep> = {}): InstallStep => ({
    id,
    title: id,
    check: vi.fn(async () => false),
    run: vi.fn(async () => ({ artifacts: [{ kind: 'owned' as const, type: 'file', path: `/etc/${id}` }] })),
    undo: vi.fn(async () => {}),
    ...over,
  });

  const strategyOf = (steps: InstallStep[]): PlatformStrategy => ({
    id: 'ubuntu-vps',
    label: 'Ubuntu VPS',
    preflight: async () => {},
    steps: () => steps,
    redeploy: async () => {},
  });

  it('undoes the failed step and everything before it, and leaves the untouched steps alone', async () => {
    const first = fakeStep('first');
    const failing = fakeStep('failing', {
      run: vi.fn(async () => {
        throw new StepAborted('verification failed');
      }),
    });
    const never = fakeStep('never');
    const install = await runInstall(strategyOf([first, failing, never]), runOpts());
    expect(install.status).toBe('failed');
    expect(never.run).not.toHaveBeenCalled();

    const firstUndo = fakeStep('first');
    const failingUndo = fakeStep('failing');
    const neverUndo = fakeStep('never');
    const result = await runUninstall(strategyOf([firstUndo, failingUndo, neverUndo]), runOpts());
    expect(result.status).toBe('complete');
    // The step that never ran has no record, so it has nothing to reverse.
    expect(neverUndo.undo).not.toHaveBeenCalled();
    // The step that failed mid-run IS reversed — it may have created artifacts
    // before it failed, which is exactly the half-configured host this guards.
    expect(failingUndo.undo).toHaveBeenCalledOnce();
    expect(firstUndo.undo).toHaveBeenCalledWith(expect.anything(), {
      artifacts: [{ kind: 'owned', type: 'file', path: '/etc/first' }],
    });
  });
});
