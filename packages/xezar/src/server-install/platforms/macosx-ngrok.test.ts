import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xezarLaunchdPlist, launchdPlist, macosxNgrok } from './macosx-ngrok.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import { CANCEL, type Runner } from '../types.ts';
import { StepAborted, StepCancelled } from '../steps.ts';

const fixtureHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => {
    if (!fixtureHome.path) throw new Error('test home is not initialized');
    return fixtureHome.path;
  },
}));

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

describe('macosx-ngrok', () => {
  let home: string;
  const original = process.env.XEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-mac-'));
    fixtureHome.path = home;
    process.env.XEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside ubuntu-vps', () => {
    expect(getStrategy('macosx-ngrok')?.id).toBe('macosx-ngrok');
    expect(availablePlatformIds()).toEqual(['ubuntu-vps', 'macosx-ngrok']);
  });

  it('launchdPlist embeds the port, basic-auth and reserved domain', () => {
    const p = launchdPlist(4321, 'ops:hunter2', 'xezar.ngrok.app');
    expect(p).toContain('<string>http</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>ops:hunter2</string>');
    expect(p).toContain('<string>xezar.ngrok.app</string>');
    expect(p).toContain('<key>KeepAlive</key>');
  });

  it('xezarLaunchdPlist embeds the argv, port, workdir and env', () => {
    const p = xezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/app/dist/index.js</string>');
    expect(p).toContain('<string>serve</string>');
    expect(p).toContain('<string>--no-open</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>/repo</string>');
    expect(p).toContain('<key>XEZ_REMOTE</key>');
    expect(p).toContain('<string>ai.xezar.cockpit</string>');
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    // Leave the reserved domain blank to exercise the ephemeral-URL path.
    const ui = { ...createAutoUi(), text: async (o: { message: string; placeholder?: string }) => (o.message.includes('Reserved') ? '' : o.placeholder ?? 'ops') };
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui,
      runner: okRunner,
    };
    const res = await runInstall(macosxNgrok, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-ngrok');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.ngrok?.status).toBe('done');
    expect(state.ephemeral).toBe(true); // no domain given → ephemeral URL
    const ngrokArtifacts = state.steps.ngrok?.created?.artifacts ?? [];
    expect(ngrokArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');
    expect(ngrokArtifacts.find((a) => a.type === 'ngrok-config')?.kind).toBe('shared');
    const autostartArtifacts = state.steps.autostart?.created?.artifacts ?? [];
    expect(autostartArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');

    const undone = await runUninstall(macosxNgrok, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });
});

describe('macosx-ngrok review fixes (PR #423)', () => {
  let home: string;
  const original = process.env.XEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-mac-fix-'));
    fixtureHome.path = home;
    process.env.XEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  function ngrokStepOf() {
    const s = macosxNgrok.steps({} as never).find((x) => x.id === 'ngrok');
    if (!s) throw new Error('no ngrok step');
    return s;
  }

  function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
    return {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
      ui: {
        ...createAutoUi(),
        password: async (o: { message: string }) => (o.message.includes('authtoken') ? 'SECRET-TOKEN' : 'longenough'),
        text: async (o: { message: string }) => (o.message.includes('domain') ? '' : 'ops'),
      },
      runner,
      save: async () => {},
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      prefs: {},
      ...over,
    } as never;
  }

  it('never puts the authtoken in argv — it travels via NGROK_AUTHTOKEN env', async () => {
    const interactiveCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        // launchctl print reports loaded; command -v finds ngrok
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args, o) => {
        interactiveCalls.push({ args, env: (o as { env?: Record<string, string> } | undefined)?.env });
        return 0;
      },
    };
    await ngrokStepOf().run(ctxFor(runner));
    const tokenCall = interactiveCalls.find((c) => c.args.join(' ').includes('add-authtoken'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.args.join(' ')).not.toContain('SECRET-TOKEN');
    expect(tokenCall?.args.join(' ')).toContain('$NGROK_AUTHTOKEN');
    expect(tokenCall?.env?.NGROK_AUTHTOKEN).toBe('SECRET-TOKEN');
  });

  it('writes the credential-bearing plist 0600', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    await ngrokStepOf().run(ctxFor(runner));
    const p = join(home, 'Library', 'LaunchAgents', 'ai.xezar.ngrok.plist');
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toContain('ops:longenough'); // creds live here → hence 0600
  });

  it('a failed launchctl bootstrap fails the step instead of recording done', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        if (args[0] === 'print') return { code: 113, stdout: '', stderr: '' }; // not loaded
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args) => (args[0] === 'bootstrap' ? 5 : 0),
    };
    await expect(ngrokStepOf().run(ctxFor(runner))).rejects.toThrow(/launchctl could not load/);
  });

  it('undo removes the agent from static label/path even with created:null', async () => {
    const commands: string[][] = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        commands.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    await ngrokStepOf().undo(ctxFor(runner), null);
    expect(commands.some((c) => c[0] === 'bootout' && (c[1] ?? '').includes('ai.xezar.ngrok'))).toBe(true);
  });

  it('rejects a scheme-carrying domain (bare hostname only)', async () => {
    let domainValidate: ((v: string) => string | undefined) | undefined;
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, {
      ui: {
        ...createAutoUi(),
        password: async () => 'longenough',
        text: async (o: { message: string; validate?: (v: string) => string | undefined }) => {
          if (o.message.includes('domain')) {
            domainValidate = o.validate;
            return '';
          }
          return 'ops';
        },
      },
    });
    await ngrokStepOf().run(ctx);
    expect(domainValidate).toBeDefined();
    expect(domainValidate?.('https://xezar.ngrok.app')).toBeDefined();
    expect(domainValidate?.('xezar.ngrok.app')).toBeUndefined();
    expect(domainValidate?.('')).toBeUndefined(); // blank = ephemeral, allowed
  });
  it.each(['authtoken', 'domain', 'username', 'password'])('cancelling %s stops before installing an agent', async (cancelAt) => {
    const interactive = vi.fn<Runner['interactive']>(async () => 0);
    const answer = (message: string) => {
      const field = message.includes('authtoken') ? 'authtoken' : message.includes('domain') ? 'domain' : message.includes('username') ? 'username' : 'password';
      return field === cancelAt ? CANCEL : field === 'domain' ? '' : 'longenough';
    };
    const ctx = ctxFor({ ...okRunner, interactive }, {
      ui: { ...createAutoUi(), text: async (o: { message: string }) => answer(o.message), password: async (o: { message: string }) => answer(o.message) },
    });
    await expect(ngrokStepOf().run(ctx)).rejects.toBeInstanceOf(StepCancelled);
    expect(interactive.mock.calls.every(([program]) => program !== 'launchctl')).toBe(true);
    expect(() => statSync(join(home, 'Library', 'LaunchAgents'))).toThrow();
  });

  it('refuses rejected tokens before asking for domain or writing credentials', async () => {
    const text = vi.fn();
    await expect(ngrokStepOf().run(ctxFor({ ...okRunner, interactive: async () => 1 }, {
      ui: { ...createAutoUi(), password: async () => 'bad-token', text },
    }))).rejects.toBeInstanceOf(StepAborted);
    expect(text).not.toHaveBeenCalled();
    expect(() => statSync(join(home, 'Library', 'LaunchAgents'))).toThrow();
  });

  it('refuses a short basic-auth password before writing the agent', async () => {
    await expect(ngrokStepOf().run(ctxFor(okRunner, {
      ui: { ...createAutoUi(), text: async () => '', password: async (o: { message: string }) => o.message.includes('authtoken') ? 'token' : 'tiny' },
    }))).rejects.toThrow(/password/);
    expect(() => statSync(join(home, 'Library', 'LaunchAgents'))).toThrow();
  });

  it.each(['Linux', 'Darwin', 'dry-run'])('preflight checks host compatibility: %s', async (platform) => {
    const capture = vi.fn(async () => ({ code: 0, stdout: platform, stderr: '' }));
    const ctx = ctxFor({ ...okRunner, capture }, { dryRun: platform === 'dry-run' });
    if (platform === 'Linux') await expect(macosxNgrok.preflight(ctx)).rejects.toThrow(/requires macOS/);
    else await expect(macosxNgrok.preflight(ctx)).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(platform === 'dry-run' ? 0 : 1);
  });

});

/**
 * The three steps and the redeploy path that the install-flow tests above reach only in dry run.
 * Everything here drives a fake `Runner`, so no `launchctl`, `brew`, `ngrok` or `curl` is ever
 * executed — but the argv each one WOULD receive is asserted, because that argv is the whole
 * behaviour: a wrong label boots out someone else's agent, and a missing `-k` restarts nothing.
 */
describe('macosx-ngrok steps in a real (non-dry) run', () => {
  let home: string;
  const original = process.env.XEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-mac-steps-'));
    fixtureHome.path = home;
    process.env.XEZ_HOME = home;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  const stepOf = (id: string) => {
    const step = macosxNgrok.steps({} as never).find((s) => s.id === id);
    if (!step) throw new Error(`no ${id} step`);
    return step;
  };

  /** Records every command, and lets a test decide what a given argv answers. */
  function recordingRunner(answer: (program: string, args: string[]) => { code: number; stdout: string } | undefined) {
    const captured: Array<[string, string[]]> = [];
    const interactive: Array<[string, string[]]> = [];
    const runner: Runner = {
      capture: async (program, args) => {
        captured.push([program, args]);
        const reply = answer(program, args);
        return { code: reply?.code ?? 0, stdout: reply?.stdout ?? '', stderr: '' };
      },
      interactive: async (program, args) => {
        interactive.push([program, args]);
        return answer(program, args)?.code ?? 0;
      },
    };
    return { runner, captured, interactive };
  }

  function baseCtx(runner: Runner, over: Record<string, unknown> = {}) {
    return {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
      ui: {
        ...createAutoUi(),
        password: async (o: { message: string }) => (o.message.includes('authtoken') ? 'SECRET' : 'longenough'),
        text: async (o: { message: string }) => (o.message.includes('domain') ? '' : 'ops'),
      },
      runner,
      save: async () => {},
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      prefs: {},
      ...over,
    } as never;
  }

  /** A host where every probe succeeds and `launchctl print` reports the job loaded. */
  const healthyHost = () =>
    recordingRunner((program, args) => {
      if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/ngrok' };
      if (program === 'launchctl' && args[0] === 'print') return { code: 0, stdout: 'state = running' };
      if (program === 'curl') return { code: 0, stdout: '{"tunnels":[{"public_url":"https://x.ngrok.app"}]}' };
      return undefined;
    });

  describe('the check() probes', () => {
    it('never probes the host in a dry run — nothing is installed to find', async () => {
      const { runner, captured } = healthyHost();

      expect(await stepOf('ngrok').check(baseCtx(runner, { dryRun: true }))).toBe(false);
      expect(await stepOf('autostart').check(baseCtx(runner, { dryRun: true }))).toBe(false);
      expect(captured).toEqual([]);
    });

    it('reports a step already satisfied when its plist is on disk', async () => {
      const seen: string[][] = [];
      const runner: Runner = {
        capture: async (_program, args) => {
          seen.push(args);
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async () => 0,
      };

      expect(await stepOf('ngrok').check(baseCtx(runner))).toBe(true);
      expect(await stepOf('autostart').check(baseCtx(runner))).toBe(true);
      // `test -f <plist>` under the operator's OWN home — the mocked homedir proves the path is
      // not hardcoded to the developer's.
      expect(seen[0]).toEqual(['-f', join(home, 'Library', 'LaunchAgents', 'ai.xezar.ngrok.plist')]);
      expect(seen[1]).toEqual(['-f', join(home, 'Library', 'LaunchAgents', 'ai.xezar.cockpit.plist')]);
    });

    it('reports it unsatisfied when the probe fails', async () => {
      const { runner } = recordingRunner(() => ({ code: 1, stdout: '' }));

      expect(await stepOf('ngrok').check(baseCtx(runner))).toBe(false);
    });
  });

  describe('the ngrok step', () => {
    it('installs ngrok through brew when the host does not have it', async () => {
      const { runner, interactive } = recordingRunner((program, args) => {
        if (program === 'ngrok' && args[0] === 'version') return { code: 1, stdout: '' };
        if (program === 'launchctl' && args[0] === 'print') return { code: 0, stdout: 'running' };
        return undefined;
      });

      await stepOf('ngrok').run(baseCtx(runner));

      expect(interactive).toContainEqual(['brew', ['install', 'ngrok/ngrok/ngrok']]);
    });

    it('skips the brew install when ngrok already answers', async () => {
      const { runner, interactive } = healthyHost();

      await stepOf('ngrok').run(baseCtx(runner));

      expect(interactive.some(([program]) => program === 'brew')).toBe(false);
    });

    it('records a reserved domain as a stable public URL', async () => {
      const { runner } = healthyHost();
      const ctx = baseCtx(runner, {
        ui: {
          ...createAutoUi(),
          password: async () => 'longenough',
          text: async (o: { message: string }) => (o.message.includes('domain') ? 'xezar.ngrok.app' : 'ops'),
        },
      }) as unknown as { state: { publicUrl?: string; ephemeral?: boolean } };

      await stepOf('ngrok').run(ctx as never);

      // The scheme is added HERE, which is why the prompt refuses one in the answer.
      expect(ctx.state.publicUrl).toBe('https://xezar.ngrok.app')
      expect(ctx.state.ephemeral).toBe(false)
    });

    it('marks a blank domain as an ephemeral URL and records no public URL', async () => {
      const { runner } = healthyHost();
      const ctx = baseCtx(runner) as unknown as { state: { publicUrl?: string; ephemeral?: boolean } };

      await stepOf('ngrok').run(ctx as never);

      expect(ctx.state.ephemeral).toBe(true)
      expect(ctx.state.publicUrl).toBeUndefined()
    });

    it('writes the ngrok binary the HOST actually has into the plist', async () => {
      // Resolved rather than assumed, because Homebrew installs to /opt/homebrew on Apple Silicon
      // and /usr/local on Intel. Hardcoding either one breaks the other half of the Macs silently:
      // launchd simply never loads the job, and nothing in the cockpit says why.
      const { runner } = recordingRunner((program, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok' };
        if (program === 'launchctl' && args[0] === 'print') return { code: 0, stdout: 'running' };
        return undefined;
      });

      await stepOf('ngrok').run(baseCtx(runner));

      const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.xezar.ngrok.plist'), 'utf8');
      expect(plist).toContain('<string>/usr/local/bin/ngrok</string>');
      expect(plist).not.toContain('/opt/homebrew/bin/ngrok');
    });

    it('falls back to the Apple Silicon path only when the host cannot resolve one', async () => {
      const { runner } = recordingRunner((program, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '' };
        if (program === 'launchctl' && args[0] === 'print') return { code: 0, stdout: 'running' };
        return undefined;
      });

      await stepOf('ngrok').run(baseCtx(runner));

      const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.xezar.ngrok.plist'), 'utf8');
      expect(plist).toContain('<string>/opt/homebrew/bin/ngrok</string>');
    });

    it('boots out any prior agent before bootstrapping the new one', async () => {
      const { runner, captured, interactive } = healthyHost();

      const result = await stepOf('ngrok').run(baseCtx(runner));

      // Re-installs must not collide with the agent already loaded under this label.
      const bootout = captured.find(([program, args]) => program === 'launchctl' && args[0] === 'bootout');
      expect(bootout?.[1]?.[1]).toMatch(/^gui\/\d+\/ai\.xezar\.ngrok$/);
      expect(interactive.some(([program, args]) => program === 'launchctl' && args[0] === 'bootstrap')).toBe(true);
      expect(result!.artifacts.map((a) => a.type).sort()).toEqual(['launchd', 'ngrok-config']);
    });
  });

  describe('the autostart step', () => {
    it('writes the cockpit agent 0600 and bootstraps it under its own label', async () => {
      const { runner, captured, interactive } = healthyHost();

      const result = (await stepOf('autostart').run(baseCtx(runner)))!;

      const path = join(home, 'Library', 'LaunchAgents', 'ai.xezar.cockpit.plist');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const plist = readFileSync(path, 'utf8');
      expect(plist).toContain('<string>ai.xezar.cockpit</string>');
      expect(plist).toContain('<string>serve</string>');
      expect(plist).toContain('<string>4321</string>');
      expect(plist).toContain('<string>/repo</string>');
      expect(captured.some(([p, a]) => p === 'launchctl' && a[0] === 'bootout' && (a[1] ?? '').includes('ai.xezar.cockpit'))).toBe(true);
      expect(interactive.some(([p, a]) => p === 'launchctl' && a[0] === 'bootstrap')).toBe(true);
      expect(result!.artifacts).toEqual([
        expect.objectContaining({ type: 'launchd', name: 'ai.xezar.cockpit', path }),
      ]);
    });

    it('writes nothing at all in a dry run', async () => {
      const { runner, captured, interactive } = healthyHost();

      const result = (await stepOf('autostart').run(baseCtx(runner, { dryRun: true })))!;

      expect(() => statSync(join(home, 'Library', 'LaunchAgents'))).toThrow();
      expect(captured.some(([p]) => p === 'launchctl')).toBe(false);
      expect(interactive).toEqual([]);
      // The artifact is still recorded, so `server-uninstall` knows what a real run would leave.
      expect(result!.artifacts[0]).toMatchObject({ type: 'launchd', name: 'ai.xezar.cockpit' });
    });

    it('undoes from the static label and path even when nothing was recorded', async () => {
      const { runner, captured } = healthyHost();

      await stepOf('autostart').undo(baseCtx(runner), null);

      // A step satisfied via check() records `created: null`; the agent must still go.
      expect(captured).toContainEqual([
        'launchctl',
        ['bootout', expect.stringMatching(/^gui\/\d+\/ai\.xezar\.cockpit$/) as unknown as string],
      ]);
    });

    it('touches nothing when undone in a dry run', async () => {
      const { runner, captured } = healthyHost();

      await stepOf('autostart').undo(baseCtx(runner, { dryRun: true }), null);

      expect(captured).toEqual([]);
    });
  });

  describe('the identity check', () => {
    it('is never considered already satisfied — it verifies, it does not install', async () => {
      const { runner } = healthyHost();

      expect(await stepOf('identity').check(baseCtx(runner))).toBe(false);
      expect(await stepOf('identity').check(baseCtx(runner, { dryRun: true }))).toBe(false);
    });

    it('asks the ngrok local API whether a tunnel is actually up', async () => {
      const { runner, captured } = healthyHost();

      const result = (await stepOf('identity').run(baseCtx(runner)))!;

      expect(captured).toContainEqual(['curl', ['-s', 'http://localhost:4040/api/tunnels']]);
      // A verification step creates nothing, so it has nothing to undo.
      expect(result!.artifacts).toEqual([]);
      await expect(stepOf('identity').undo(baseCtx(runner), null)).resolves.toBeUndefined();
    });

    it('gives ngrok five tries before warning — it needs a moment to bind :4040', async () => {
      vi.useFakeTimers();
      const { runner, captured } = recordingRunner((program) =>
        program === 'curl' ? { code: 0, stdout: 'no tunnels here' } : undefined,
      );

      const running = stepOf('identity').run(baseCtx(runner));
      // Four gaps of 1.5s between the five attempts.
      await vi.advanceTimersByTimeAsync(1_500 * 5);
      await running;

      // A warning, not a thrown step: the tunnel not being up yet is not a failed install.
      expect(captured.filter(([program]) => program === 'curl')).toHaveLength(5);
    });

    it('probes nothing in a dry run', async () => {
      const { runner, captured } = healthyHost();

      await stepOf('identity').run(baseCtx(runner, { dryRun: true }));

      expect(captured).toEqual([]);
    });
  });

  describe('redeploy', () => {
    it('kickstarts both agents and re-verifies the tunnel', async () => {
      const { runner, interactive, captured } = healthyHost();

      await macosxNgrok.redeploy!(baseCtx(runner));

      const kickstarts = interactive.filter(([program, args]) => program === 'launchctl' && args[0] === 'kickstart');
      // `-k` is what makes it a RESTART rather than a start-if-stopped.
      expect(kickstarts.map(([, args]) => args[1])).toEqual(['-k', '-k']);
      expect(kickstarts.map(([, args]) => args[2])).toEqual([
        expect.stringContaining('ai.xezar.cockpit'),
        expect.stringContaining('ai.xezar.ngrok'),
      ]);
      // …and the identity check runs afterwards, so a redeploy that broke the tunnel says so.
      expect(captured).toContainEqual(['curl', ['-s', 'http://localhost:4040/api/tunnels']]);
    });

    it('warns instead of throwing when a kickstart returns non-zero', async () => {
      const warnings: string[] = [];
      const { runner } = recordingRunner((program, args) => {
        if (program === 'launchctl' && args[0] === 'kickstart') return { code: 3, stdout: '' };
        if (program === 'curl') return { code: 0, stdout: 'public_url' };
        return undefined;
      });
      const ctx = baseCtx(runner, {
        ui: { ...createAutoUi(), warn: (message: string) => warnings.push(message) },
      });

      await expect(macosxNgrok.redeploy!(ctx)).resolves.toBeUndefined();

      expect(warnings.filter((w) => w.includes('kickstart returned non-zero'))).toHaveLength(2);
      expect(warnings.some((w) => w.includes('ai.xezar.cockpit'))).toBe(true);
      expect(warnings.some((w) => w.includes('ai.xezar.ngrok'))).toBe(true);
    });

    it('restarts nothing in a dry run', async () => {
      const { runner, interactive, captured } = healthyHost();

      await macosxNgrok.redeploy!(baseCtx(runner, { dryRun: true }));

      expect(interactive).toEqual([]);
      expect(captured).toEqual([]);
    });
  });
});
