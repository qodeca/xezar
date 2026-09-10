import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isNpxExecStart,
  nginxVhost,
  portListener,
  refreshNpxCacheForRedeploy,
  serviceExecStart,
  systemdUnit,
  ubuntuVps,
  upstreamHost,
} from './ubuntu-vps.ts';
import { StepAborted, StepCancelled } from '../steps.ts';
import { createAutoUi } from '../ui.ts';
import { CANCEL, type InstallContext, type InstallStep, type Runner, type Ui } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function ctxWith(over: {
  ui?: Ui;
  runner?: Runner;
  dryRun?: boolean;
  state?: Partial<InstallContext['state']>;
}): InstallContext {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, ...over.state },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
    prefs: {},
  };
}

function stepById(id: string): InstallStep {
  const s = ubuntuVps.steps(ctxWith({})).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe('ubuntu-vps ssl step', () => {
  let home: string;
  const original = process.env.XEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-ssl-'));
    process.env.XEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('orders the steps and only SSL is optional (the service must run)', () => {
    const ids = ubuntuVps.steps(ctxWith({})).map((s) => s.id);
    expect(ids).toEqual(['deps', 'nginx-proxy', 'ssl', 'autostart', 'identity']);
    expect(stepById('ssl').optional).toBe(true);
    // The service step is required now — after install xezar must actually run.
    expect(stepById('autostart').optional).toBeFalsy();
    expect(stepById('identity').optional).toBeFalsy();
  });

  it('--external-proxy drops our nginx + SSL steps (an existing front owns :80/:443)', () => {
    const ids = ubuntuVps.steps(ctxWith({ state: { externalProxy: true } })).map((s) => s.id);
    expect(ids).toEqual(['deps', 'autostart', 'identity']);
    expect(ids).not.toContain('nginx-proxy');
    expect(ids).not.toContain('ssl');
  });

  it('external-proxy verify passes when xezar answers on the bound host', async () => {
    const seen: string[] = [];
    const runner: Runner = {
      capture: async (program, args) => {
        if (program === 'curl') seen.push(args.join(' '));
        return { code: 0, stdout: program === 'curl' ? '200' : '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxWith({ runner, state: { externalProxy: true, bindHost: '172.17.0.1' } });
    await expect(stepById('identity').run(ctx)).resolves.toBeTruthy();
    // It must probe the bind host, not loopback — a container proxy can't use 127.0.0.1.
    expect(seen.some((a) => a.includes('http://172.17.0.1:4321/'))).toBe(true);
  });

  it('external-proxy verify aborts when nothing is listening', async () => {
    const runner: Runner = {
      // curl "000" = no connection; `sleep` between polls returns 0.
      capture: async (program) => ({ code: 0, stdout: program === 'curl' ? '000' : '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxWith({ runner, state: { externalProxy: true, bindHost: '172.17.0.1' } });
    await expect(stepById('identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  it('dry-run records the cert as a shared artifact and sets publicUrl', async () => {
    const ui = { ...createAutoUi(), text: async (o: { message: string }) => (o.message.includes('Domain') ? 'xezar.example.com' : 'you@example.com') } as Ui;
    const ctx = ctxWith({ dryRun: true, ui });
    const created = await stepById('ssl').run(ctx);
    const cert = created?.artifacts.find((a) => a.type === 'cert');
    expect(cert?.kind).toBe('shared');
    expect(cert?.name).toBe('xezar.example.com');
    expect(ctx.state.publicUrl).toBe('https://xezar.example.com');
  });

  it('undo does NOT remove the cert — it only lists it', async () => {
    const note = vi.fn();
    const ui = { ...createAutoUi(), note } as Ui;
    const ctx = ctxWith({ ui });
    await stepById('ssl').undo(ctx, { artifacts: [{ kind: 'shared', type: 'cert', name: 'x.example.com', removeHint: 'sudo certbot delete --cert-name x.example.com' }] });
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0]?.[0]).toContain('certbot delete');
  });
});

describe('ubuntu-vps nginx-proxy security', () => {
  function secCtx(password: string, capture: Runner['capture']) {
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string }) => (o.message.toLowerCase().includes('username') ? 'ops' : ''),
      password: async () => password,
    } as Ui;
    return { ...ctxWith({ ui }), assumeYes: true, runner: { capture, interactive: async () => 0 } } as InstallContext;
  }

  it('feeds the password to openssl via stdin, never as an argv (H2)', async () => {
    const capture = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => ({ code: 0, stdout: 'hash', stderr: '' }));
    await stepById('nginx-proxy').run(secCtx('hunter2', capture));
    const openssl = capture.mock.calls.find((c) => c[0] === 'openssl');
    expect(openssl?.[1]).toEqual(['passwd', '-apr1', '-stdin']);
    expect(openssl?.[2]).toEqual({ input: 'hunter2\n' });
    // the plaintext is never passed as a command argument
    expect(capture.mock.calls.some((c) => c[1].includes('hunter2'))).toBe(false);
  });

  it('refuses an empty/too-short password instead of creating an open cockpit (H1)', async () => {
    const capture = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => ({ code: 0, stdout: '', stderr: '' }));
    await expect(stepById('nginx-proxy').run(secCtx('', capture))).rejects.toBeInstanceOf(StepAborted);
  });
});

describe('nginxVhost', () => {
  it('defaults to a catch-all server_name and can target a domain', () => {
    expect(nginxVhost(4321)).toContain('server_name _;');
    // The SSL step rewrites server_name to the domain so certbot --nginx can find it.
    expect(nginxVhost(4321, 'xezar.example.com')).toContain('server_name xezar.example.com;');
  });

  it('enables HTTP/2 so long-lived SSE streams do not exhaust the browser connection pool', () => {
    expect(nginxVhost(4321)).toContain('http2 on;');
  });

  it('defaults to the legacy htpasswd path but accepts an instance-scoped one', () => {
    expect(nginxVhost(4321)).toContain('auth_basic_user_file /etc/xezar/htpasswd;');
    expect(nginxVhost(4322, 'shop.example.com', '/etc/xezar/htpasswd-shop-example-com')).toContain(
      'auth_basic_user_file /etc/xezar/htpasswd-shop-example-com;',
    );
  });
});

describe('ubuntu-vps multi-instance artifact paths', () => {
  /** ctx for a named instance whose domain is known up front. */
  function namedCtx(): InstallContext {
    const c = ctxWith({ dryRun: true });
    c.instance = 'shop-example-com';
    c.state.domain = 'shop.example.com';
    c.state.primaryPort = 4322;
    return c;
  }

  it('the default instance records the legacy un-suffixed nginx/htpasswd paths', async () => {
    const ui = { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui;
    const ctx = { ...ctxWith({ ui, dryRun: true }), assumeYes: true } as InstallContext;
    const created = await stepById('nginx-proxy').run(ctx);
    const paths = (created?.artifacts ?? []).map((a) => a.path).filter(Boolean);
    expect(paths).toContain('/etc/nginx/sites-available/xezar');
    expect(paths).toContain('/etc/nginx/sites-enabled/xezar');
    expect(paths).toContain('/etc/xezar/htpasswd');
  });

  it('a named instance suffixes the nginx site + htpasswd with its slug', async () => {
    const ctx = namedCtx();
    (ctx as { assumeYes: boolean }).assumeYes = true;
    ctx.ui = { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui;
    const created = await stepById('nginx-proxy').run(ctx);
    const paths = (created?.artifacts ?? []).map((a) => a.path).filter(Boolean);
    expect(paths).toContain('/etc/nginx/sites-available/xezar-shop-example-com');
    expect(paths).toContain('/etc/nginx/sites-enabled/xezar-shop-example-com');
    expect(paths).toContain('/etc/xezar/htpasswd-shop-example-com');
  });

  it("a named instance's systemd unit is xezar-<slug>.service", async () => {
    const created = await stepById('autostart').run(namedCtx());
    const svc = created?.artifacts.find((a) => a.type === 'service');
    expect(svc?.name).toBe('xezar-shop-example-com.service');
  });
});

describe('ubuntu-vps nginx-proxy identity (interactive, dry-run)', () => {
  it('suggests the current OS user and can auto-generate the cockpit password', async () => {
    const notes: string[] = [];
    const password = vi.fn(async () => 'should-not-be-asked');
    const ui = {
      ...createAutoUi(),
      // username: echo back the suggested (initialValue) default
      text: async (o: { initialValue?: string }) => o.initialValue ?? 'x',
      // credential prompt: pick the first option ("Generate a strong password for me")
      select: async (o: { options: Array<{ value: string }> }) => o.options[0]?.value,
      password,
      note: (m: string) => { notes.push(m); },
    } as unknown as Ui;
    // Interactive path (assumeYes:false) is where the generate/manual menu lives.
    const ctx = { ...ctxWith({ dryRun: true, ui }), assumeYes: false } as InstallContext;
    const created = await stepById('nginx-proxy').run(ctx);

    expect(password).not.toHaveBeenCalled(); // generated, not typed (issue #3)
    expect(notes.some((m) => m.includes('Password:'))).toBe(true); // shown once so it can be saved
    const htp = created?.artifacts.find((a) => a.type === 'htpasswd');
    expect(htp?.kind).toBe('owned');
    expect(htp?.name).toBeTruthy(); // the suggested current-user default (issue #2)
  });
});

describe('systemdUnit', () => {
  it('runs xezar serve loopback with XEZ_REMOTE=1 and the port', () => {
    const unit = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/xezar');
    expect(unit).toContain('Environment=XEZ_REMOTE=1');
    expect(unit).toContain('ExecStart=/usr/local/bin/xezar serve --no-open --port 4321');
    expect(unit).toContain('WorkingDirectory=/srv/app');
    expect(unit).toContain('WantedBy=default.target');
  });
  it('system scope pins User= and multi-user.target', () => {
    const unit = systemdUnit('/srv/app', 5000, 'system', '/usr/local/bin/xezar');
    expect(unit).toContain('User=');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('takes an absolute "<node> <entry.js>" ExecStart verbatim (no bare name → no 203/EXEC)', () => {
    const unit = systemdUnit('/srv/app', 4321, 'system', '/usr/bin/node /srv/app/dist/index.js');
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/app/dist/index.js serve --no-open --port 4321');
  });

  it('passes --bind-host when an external-proxy install needs a reachable interface', () => {
    const unit = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/xezar', '172.17.0.1');
    expect(unit).toContain('ExecStart=/usr/local/bin/xezar serve --no-open --port 4321 --bind-host 172.17.0.1');
  });

  it('stays flag-free for loopback so existing units are unchanged', () => {
    const plain = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/xezar');
    expect(systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/xezar', '127.0.0.1')).toBe(plain);
    expect(plain).not.toContain('--bind-host');
  });
});

describe('serviceExecStart', () => {
  const base = { node: '/n/node', entry: '/pkg/dist/index.js', npxPath: '/n/npx' };

  it('runs the built entry for a stable checkout/global install', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/pkg', entryExists: true })).toBe('/n/node /pkg/dist/index.js');
  });

  it('uses the official npx alias when launched from the ephemeral _npx cache', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/home/u/.npm/_npx/abcd/node_modules/@qodeca/xezar', entryExists: false }))
      .toBe('/n/npx --yes @qodeca/xezar');
  });

  it('falls back to a resolved global bin when the entry is missing', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/pkg', entryExists: false, globalBin: '/usr/bin/xezar' }))
      .toBe('/n/node /usr/bin/xezar');
  });
});

describe('isNpxExecStart (#696)', () => {
  it('is true for the unpinned npx launch form', () => {
    expect(isNpxExecStart('/home/u/.nvm/versions/node/v24/bin/npx --yes @qodeca/xezar serve --no-open --port 4321')).toBe(true);
  });
  it('is false for a checkout (<node> dist/index.js) unit', () => {
    expect(isNpxExecStart('/usr/bin/node /home/xezar/xezar/dist/index.js serve --no-open --port 4321')).toBe(false);
  });
  it('is false for a global bin unit (no npx)', () => {
    expect(isNpxExecStart('/usr/bin/node /usr/bin/xezar serve --no-open --port 4321')).toBe(false);
  });
});

describe('ubuntu-vps redeploy npx-cache refresh (#696)', () => {
  function recordingCtx(execStart: string) {
    const infos: string[] = [];
    const runner: Runner = {
      capture: async (_program, args) =>
        args.includes('ExecStart') ? { code: 0, stdout: execStart, stderr: '' } : { code: 0, stdout: '', stderr: '' },
      interactive: async () => 0,
    };
    const ui = { ...createAutoUi(), info: (message: string) => infos.push(message) } as Ui;
    return { ctx: ctxWith({ dryRun: true, runner, ui }), infos };
  }

  it('reports clearing the npx cache before restarting an npx-based unit', async () => {
    const { ctx, infos } = recordingCtx('/n/npx --yes @qodeca/xezar serve --no-open --port 4321');
    await ubuntuVps.redeploy!(ctx);
    expect(infos.some((message) => /clear cached @qodeca\/xezar|npx refetch/i.test(message))).toBe(true);
  });

  it('does NOT touch the npx cache for a checkout-based unit', async () => {
    const { ctx, infos } = recordingCtx('/usr/bin/node /home/xezar/xezar/dist/index.js serve --no-open --port 4321');
    await ubuntuVps.redeploy!(ctx);
    expect(infos.some((message) => /npx/i.test(message))).toBe(false);
  });

  it('really deletes only the @qodeca/xezar entries in the npx cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'xez-npx-'));
    const prev = process.env.npm_config_cache;
    process.env.npm_config_cache = cache;
    try {
      mkdirSync(join(cache, '_npx', 'aaaa', 'node_modules', '@qodeca', 'xezar'), { recursive: true });
      writeFileSync(join(cache, '_npx', 'aaaa', 'node_modules', '@qodeca', 'xezar', 'x'), '');
      mkdirSync(join(cache, '_npx', 'bbbb', 'node_modules', 'prettier'), { recursive: true });

      refreshNpxCacheForRedeploy(ctxWith({}), '/n/npx --yes @qodeca/xezar serve --port 4321');

      expect(existsSync(join(cache, '_npx', 'aaaa'))).toBe(false);
      expect(existsSync(join(cache, '_npx', 'bbbb'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = prev;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('aborts before restart when the npx cache cannot be read', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'xez-npx-'));
    const previousCache = process.env.npm_config_cache;
    process.env.npm_config_cache = cache;
    writeFileSync(join(cache, '_npx'), 'not a directory');
    const capture = vi.fn(async () => ({
      code: 0,
      stdout: '/n/npx --yes @qodeca/xezar serve --port 4321',
      stderr: '',
    }));
    const interactive = vi.fn(async () => 0);

    try {
      await expect(ubuntuVps.redeploy!(ctxWith({ runner: { capture, interactive } }))).rejects.toThrow(
        /cannot inspect the npx cache.*service was not restarted/,
      );
      expect(interactive).not.toHaveBeenCalled();
    } finally {
      if (previousCache === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('ubuntu-vps autostart step (dry-run)', () => {
  it('records a user-scoped service artifact and writes nothing to disk', async () => {
    const created = await stepById('autostart').run(ctxWith({ dryRun: true }));
    const svc = created?.artifacts.find((a) => a.type === 'service');
    expect(svc?.kind).toBe('owned');
    expect(svc?.scope).toBe('user');
    expect(svc?.name).toBe('xezar.service');
  });
});

describe('ubuntu-vps identity step (end-to-end verify)', () => {
  /** A runner whose curl returns codes by URL/args; sleep + everything else ok. */
  function curlRunner(byPort: string, throughProxy: string): Runner {
    return {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          const code = target.includes(`:${4321}`) ? byPort : throughProxy;
          return { code: 0, stdout: code, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('passes when xezar is up, anon is 401, and an authed request reaches it', async () => {
    const ctx = { ...ctxWith({ runner: curlRunner('200', '401') }), assumeYes: false } as InstallContext;
    ctx.prefs.cockpit = { user: 'ops', password: 'hunter2!' };
    // authed request (curl -K -) must return 2xx/3xx — model that by returning 200
    // for the proxy when credentials are supplied via stdin:
    ctx.runner = {
      interactive: async () => 0,
      capture: async (program, args, opts) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          if (target.includes(':4321')) return { code: 0, stdout: '200', stderr: '' }; // upstream up
          if (opts?.input) return { code: 0, stdout: '200', stderr: '' }; // authed → ok
          return { code: 0, stdout: '401', stderr: '' }; // anon → challenged
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await expect(stepById('identity').run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('fails the run when xezar is down (nginx would 502)', async () => {
    const ctx = { ...ctxWith({ runner: curlRunner('000', '401') }), assumeYes: false } as InstallContext;
    await expect(stepById('identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });
});

describe('ubuntu-vps review fixes (PR #423)', () => {
  it('ufwIsActive reads the world-readable ufw.conf, never root-only `ufw status`', async () => {
    const calls: string[][] = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        calls.push(args);
        return { code: 0, stdout: 'ufw-enabled\n', stderr: '' };
      },
      interactive: async () => 0,
    };
    // reach the sub-step via the proxy step's run with everything else stubbed green
    const ui = {
      ...createAutoUi(),
      text: async () => 'ops',
      password: async () => 'longenough',
    } as Ui;
    const interactive = vi.fn(async () => 0);
    const captured: Array<{ args: string[]; input?: string }> = [];
    const ctx = {
      ...ctxWith({ ui }),
      runner: {
        capture: async (_p: string, args: string[], o?: { input?: string }) => {
          captured.push({ args, input: o?.input });
          if (args.join(' ').includes('openssl') || args[0] === 'passwd') return { code: 0, stdout: '$apr1$abc$hash', stderr: '' };
          if (args.join(' ').includes('ufw.conf')) return { code: 0, stdout: '', stderr: '' }; // ufw not enabled
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive,
      },
    } as InstallContext;
    await stepById('nginx-proxy').run(ctx);
    // no capture or interactive call may contain a root-only bare `ufw status` probe
    const probeCalls = captured.map((c) => c.args.join(' ')).filter((a) => a.includes('ufw'));
    for (const probe of probeCalls) expect(probe).toContain('ufw.conf');
    expect(calls.length).toBe(0); // unused first runner sanity
  });

  it('htpasswd credential line goes to sudo stdin, not argv (hash never ps-visible)', async () => {
    const ui = { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui;
    const interactiveCalls: Array<{ args: string[]; input?: string }> = [];
    const ctx = {
      ...ctxWith({ ui }),
      runner: {
        capture: async (p: string, args: string[]) => {
          if (p === 'openssl') return { code: 0, stdout: '$apr1$abc$secret-hash', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async (_p: string, args: string[], o?: { input?: string }) => {
          interactiveCalls.push({ args, input: o?.input });
          return 0;
        },
      },
    } as InstallContext;
    await stepById('nginx-proxy').run(ctx);
    const htpasswdCall = interactiveCalls.find((c) => c.args.join(' ').includes('htpasswd'));
    expect(htpasswdCall).toBeDefined();
    expect(htpasswdCall?.args.join(' ')).not.toContain('secret-hash');
    expect(htpasswdCall?.input).toBe('ops:$apr1$abc$secret-hash\n');
  });

  it('username validation rejects ":" and whitespace (htpasswd separator)', () => {
    let captured: ((v: string) => string | undefined) | undefined;
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string; validate?: (v: string) => string | undefined }) => {
        if (o.message.toLowerCase().includes('username')) captured = o.validate;
        return 'ops';
      },
      password: async () => 'longenough',
    } as Ui;
    const runner: Runner = {
      capture: async (p) => ({ code: 0, stdout: p === 'openssl' ? '$apr1$abc$hash' : '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = { ...ctxWith({ ui, runner }) } as InstallContext;
    return stepById('nginx-proxy')
      .run(ctx)
      .then(() => {
        expect(captured).toBeDefined();
        expect(captured?.('team:ops')).toMatch(/:/);
        expect(captured?.('team ops')).toBeDefined();
        expect(captured?.('ops')).toBeUndefined();
      });
  });

  it('identity probe escapes `"` and `\\` in curl config credentials', async () => {
    const inputs: string[] = [];
    const ctx = {
      ...ctxWith({}),
      prefs: { cockpit: { user: 'ops', password: 'my"pa\\ss1' } },
      runner: {
        capture: async (_p: string, args: string[], o?: { input?: string }) => {
          if (o?.input) inputs.push(o.input);
          // upstream up + anon 401 + authed 200
          const joined = args.join(' ');
          if (joined.includes('4321')) return { code: 0, stdout: '200', stderr: '' };
          if (o?.input) return { code: 0, stdout: '200', stderr: '' };
          return { code: 0, stdout: '401', stderr: '' };
        },
        interactive: async () => 0,
      },
    } as InstallContext;
    await stepById('identity').run(ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe('user = "ops:my\\"pa\\\\ss1"\n');
  });

  it('SSL re-run with TLS already configured updates server_name in place (no plain-HTTP rewrite)', async () => {
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string }) => (o.message.includes('Domain') ? 'xezar.example.com' : 'you@example.com'),
    } as Ui;
    const commands: string[] = [];
    const ctx = {
      ...ctxWith({ ui }),
      runner: {
        capture: async (_p: string, args: string[]) => {
          const joined = args.join(' ');
          if (joined.includes('ssl_certificate')) return { code: 0, stdout: '', stderr: '' }; // TLS present
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async (_p: string, args: string[]) => {
          commands.push(args.join(' '));
          return 0;
        },
      },
    } as InstallContext;
    await stepById('ssl').run(ctx);
    const rewrites = commands.filter((c) => c.includes('base64 --decode'));
    const seds = commands.filter((c) => c.includes('sed -i') && c.includes('server_name'));
    expect(rewrites).toHaveLength(0); // never wipes certbot's 443 config
    expect(seds).toHaveLength(1);
  });

  it('uninstall reverses linger only when install recorded enabling it', async () => {
    const commands: string[] = [];
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: 'Linger=no', stderr: '' }),
      interactive: async (_p, args) => {
        commands.push(args.join(' '));
        return 0;
      },
    };
    const ctx = { ...ctxWith({ runner }) } as InstallContext;
    await stepById('autostart').undo(ctx, {
      artifacts: [
        { kind: 'owned', type: 'service', name: 'xezar.service', scope: 'user', path: '/tmp/does-not-exist.service' },
        { kind: 'owned', type: 'linger', name: 'ops' },
      ],
    });
    expect(commands.some((c) => c.includes('disable-linger'))).toBe(true);
    // and without the linger artifact, it is left alone
    commands.length = 0;
    await stepById('autostart').undo(ctx, {
      artifacts: [{ kind: 'owned', type: 'service', name: 'xezar.service', scope: 'user', path: '/tmp/does-not-exist.service' }],
    });
    expect(commands.some((c) => c.includes('disable-linger'))).toBe(false);
  });

  it('systemd unit escapes % so specifier expansion cannot corrupt PATH/ExecStart', () => {
    const oldPath = process.env.PATH;
    process.env.PATH = `/weird%dir/bin:${oldPath ?? ''}`;
    try {
      const unit = systemdUnit('/repo', 4321, 'user', '/usr/bin/node /x/dist/index.js');
      expect(unit).toContain('/weird%%dir/bin');
      expect(unit).not.toMatch(/Environment=PATH=[^\n]*\/weird%dir/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
});


describe('ubuntu-vps preflight refuses incompatible hosts before installation', () => {
  it.each([
    { name: 'dry-run', dryRun: true, os: 'Linux', apt: 0, uid: '1000', probes: [] },
    { name: 'macOS', os: 'Darwin', apt: 0, uid: '1000', error: /requires Linux/, probes: ['uname'] },
    { name: 'missing apt', os: 'Linux', apt: 1, uid: '1000', error: /requires apt/, probes: ['uname', 'apt-get'] },
    { name: 'root', os: 'Linux', apt: 0, uid: '0', error: /not root/, probes: ['uname', 'apt-get', 'id'] },
    { name: 'normal user', os: 'Linux', apt: 0, uid: '1000', probes: ['uname', 'apt-get', 'id', 'ss'] },
    { name: 'external proxy', os: 'Linux', apt: 0, uid: '1000', externalProxy: true, probes: ['uname', 'apt-get', 'id'] },
  ])('$name', async (row) => {
    const probes: string[] = [];
    const runner: Runner = {
      capture: async (program) => {
        probes.push(program);
        return { code: program === 'apt-get' ? row.apt : 0, stdout: program === 'uname' ? row.os : program === 'id' ? row.uid : '', stderr: '' };
      },
      interactive: async () => { throw new Error('preflight must not install anything'); },
    };
    const result = ubuntuVps.preflight(ctxWith({ runner, dryRun: row.dryRun, state: { externalProxy: row.externalProxy } }));
    if (row.error) await expect(result).rejects.toThrow(row.error);
    else await expect(result).resolves.toBeUndefined();
    expect(probes).toEqual(row.probes);
  });

  it.each(['docker-proxy', 'nginx', 'none'])('reports existing port owner %s accurately', async (owner) => {
    const warn = vi.fn();
    const runner: Runner = {
      capture: async (program) => ({ code: 0, stdout: program === 'uname' ? 'Linux' : program === 'id' ? '1000' : program === 'ss' && owner !== 'none' ? `LISTEN 0 128 *:80 *:* users:(("${owner}",pid=123,fd=4))` : '', stderr: '' }),
      interactive: async () => { throw new Error('unexpected installation'); },
    };
    await ubuntuVps.preflight(ctxWith({ runner, ui: { ...createAutoUi(), warn }, state: { domain: 'example.test' } }));
    if (owner === 'docker-proxy') {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('--external-proxy --domain example.test'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('docker-proxy'));
    } else expect(warn).not.toHaveBeenCalled();
  });
});

describe('portListener', () => {
  const withSs = (reply: { code: number; stdout: string }) =>
    ctxWith({ runner: { capture: async () => ({ ...reply, stderr: '' }), interactive: async () => 0 } });

  it('names the process squatting on the port, so a collision is explainable', async () => {
    const ctx = withSs({
      code: 0,
      stdout:
        'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n' +
        'LISTEN 0      4096   0.0.0.0:4321       0.0.0.0:*         users:(("docker-proxy",pid=123,fd=4))\n',
    });

    expect(await portListener(ctx, 4321)).toBe('docker-proxy');
  });

  it('says "another process" when ss cannot see the owner (no root)', async () => {
    const ctx = withSs({ code: 0, stdout: 'LISTEN 0 4096 0.0.0.0:4321 0.0.0.0:*\n' });

    // Best effort by design: this only ever makes a collision readable, it never gates anything.
    expect(await portListener(ctx, 4321)).toBe('another process');
  });

  it('is null when nothing is listening, when ss fails, and in a dry run', async () => {
    expect(await portListener(withSs({ code: 0, stdout: 'Netid State ...\n' }), 4321)).toBeNull();
    expect(await portListener(withSs({ code: 1, stdout: '' }), 4321)).toBeNull();
    const dry = ctxWith({ dryRun: true, runner: { capture: async () => { throw new Error('no probing in a dry run') }, interactive: async () => 0 } });
    expect(await portListener(dry, 4321)).toBeNull();
  });
});

describe('upstreamHost', () => {
  it('is loopback unless an external-proxy install bound the cockpit elsewhere', () => {
    expect(upstreamHost(ctxWith({}))).toBe('127.0.0.1');
    expect(upstreamHost(ctxWith({ state: { bindHost: '172.17.0.1' } }))).toBe('172.17.0.1');
    // A blank pin is not a pin — it must not produce `http://:4321/`.
    expect(upstreamHost(ctxWith({ state: { bindHost: '   ' } }))).toBe('127.0.0.1');
  });
});

describe('ubuntu-vps nginx-proxy check()', () => {
  it('is satisfied only when nginx is installed AND our site is enabled', async () => {
    const answers = (nginx: number, site: number): Runner => ({
      capture: async (program) => ({ code: program === 'nginx' ? nginx : site, stdout: '', stderr: '' }),
      interactive: async () => 0,
    });

    expect(await stepById('nginx-proxy').check(ctxWith({ runner: answers(0, 0) }))).toBe(true);
    // nginx present but no xezar site — a bare nginx must not read as "already configured".
    expect(await stepById('nginx-proxy').check(ctxWith({ runner: answers(0, 1) }))).toBe(false);
    expect(await stepById('nginx-proxy').check(ctxWith({ runner: answers(1, 0) }))).toBe(false);
  });

  it('probes nothing in a dry run', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    expect(await stepById('nginx-proxy').check(ctxWith({ dryRun: true, runner: { capture, interactive: async () => 0 } }))).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});

/**
 * The credential prompts, which are the one place this installer can silently stand up a
 * cockpit anyone on the internet can open. Every abandonment has to leave nothing behind, and
 * the username has to stay a legal htpasswd left-hand side — a ":" there produces a login that
 * can never succeed, with no error anywhere.
 */
describe('ubuntu-vps cockpit credentials', () => {
  function identityCtx(ui: Partial<Ui>, assumeYes = false): InstallContext {
    return {
      ...ctxWith({ dryRun: true, ui: { ...createAutoUi(), ...ui } as Ui }),
      assumeYes,
    } as InstallContext;
  }

  it('refuses a username htpasswd cannot store', async () => {
    let validate: ((v: string) => string | undefined) | undefined;
    await stepById('nginx-proxy').run(
      identityCtx(
        {
          text: async (o: { initialValue?: string; validate?: (v: string) => string | undefined }) => {
            validate = o.validate;
            return o.initialValue ?? 'ops';
          },
          select: async (o: { options: Array<{ value: unknown }> }) => o.options[0]?.value,
        } as Partial<Ui>,
      ),
    );

    expect(validate?.('ops')).toBeUndefined();
    expect(validate?.('')).toBe('username is required');
    // htpasswd's line format is `user:hash`.
    expect(validate?.('ops:admin')).toContain('":"');
    expect(validate?.('two words')).toContain('whitespace');
  });

  it('stops before writing anything when the username prompt is abandoned', async () => {
    const select = vi.fn();
    await expect(
      stepById('nginx-proxy').run(identityCtx({ text: async () => CANCEL, select } as unknown as Partial<Ui>)),
    ).rejects.toBeInstanceOf(StepCancelled);
    expect(select).not.toHaveBeenCalled();
  });

  it('stops when the generate-or-type menu is abandoned', async () => {
    const password = vi.fn();
    await expect(
      stepById('nginx-proxy').run(
        identityCtx({
          text: async (o: { initialValue?: string }) => o.initialValue ?? 'ops',
          select: async () => CANCEL,
          password,
        } as unknown as Partial<Ui>),
      ),
    ).rejects.toBeInstanceOf(StepCancelled);
    expect(password).not.toHaveBeenCalled();
  });

  it('takes a typed password when the operator declines the generated one', async () => {
    const notes: string[] = [];
    const ctx = identityCtx({
      text: async (o: { initialValue?: string }) => o.initialValue ?? 'ops',
      // The second option is "Type my own password".
      select: async (o: { options: Array<{ value: unknown }> }) => o.options[1]?.value,
      password: async () => 'typed-by-hand',
      note: (m: string) => { notes.push(m) },
    } as unknown as Partial<Ui>);

    await stepById('nginx-proxy').run(ctx);

    expect(ctx.prefs.cockpit?.password).toBe('typed-by-hand');
    // Nothing is echoed back: only a GENERATED password is shown, because only then is this
    // the operator's one chance to read it.
    expect(notes.some((m) => m.includes('Password:'))).toBe(false);
  });

  it('stops when the typed password is abandoned', async () => {
    await expect(
      stepById('nginx-proxy').run(
        identityCtx({
          text: async (o: { initialValue?: string }) => o.initialValue ?? 'ops',
          select: async (o: { options: Array<{ value: unknown }> }) => o.options[1]?.value,
          password: async () => CANCEL,
        } as unknown as Partial<Ui>),
      ),
    ).rejects.toBeInstanceOf(StepCancelled);
  });

  it('stops when the --yes password prompt is abandoned', async () => {
    await expect(
      stepById('nginx-proxy').run(
        identityCtx(
          {
            text: async (o: { initialValue?: string }) => o.initialValue ?? 'ops',
            password: async () => CANCEL,
          } as unknown as Partial<Ui>,
          true,
        ),
      ),
    ).rejects.toBeInstanceOf(StepCancelled);
  });

  it('keeps the credentials in memory for the final verify, and never on disk', async () => {
    const ctx = identityCtx(
      {
        text: async (o: { initialValue?: string }) => o.initialValue ?? 'ops',
        password: async () => 'longenough',
      } as unknown as Partial<Ui>,
      true,
    );

    const created = await stepById('nginx-proxy').run(ctx);

    expect(ctx.prefs.cockpit).toEqual({ user: expect.any(String), password: 'longenough' });
    // The artifact records the htpasswd PATH and the login name — never the password.
    expect(JSON.stringify(created?.artifacts)).not.toContain('longenough');
  });
});

/**
 * Uninstall of the service step. The rule the branches encode: reverse exactly what THIS install
 * changed. Linger in particular may already have been on for someone else's user services, so
 * turning it off because we saw it on would break a machine we never configured.
 */
describe('ubuntu-vps autostart undo', () => {
  let unitDir: string;

  beforeEach(() => {
    unitDir = mkdtempSync(join(tmpdir(), 'xez-unit-'));
  });
  afterEach(() => {
    rmSync(unitDir, { recursive: true, force: true });
  });

  function recording() {
    const interactive: Array<[string, string[]]> = [];
    const capture: Array<[string, string[]]> = [];
    const runner: Runner = {
      capture: async (program, args) => {
        capture.push([program, args]);
        return { code: 0, stdout: 'Linger=no', stderr: '' };
      },
      interactive: async (program, args) => {
        interactive.push([program, args]);
        return 0;
      },
    };
    return { runner, interactive, capture };
  }

  const userService = (path: string) => ({
    artifacts: [{ kind: 'owned' as const, type: 'service' as const, name: 'xezar.service', scope: 'user' as const, path }],
  });

  it('disables and deletes a user unit, then reloads the user daemon', async () => {
    const path = join(unitDir, 'xezar.service');
    writeFileSync(path, '[Unit]\n', 'utf8');
    const { runner, interactive } = recording();

    await stepById('autostart').undo(ctxWith({ runner }), userService(path));

    expect(existsSync(path)).toBe(false);
    expect(interactive).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'xezar.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('deletes nothing in a dry run', async () => {
    const path = join(unitDir, 'xezar.service');
    writeFileSync(path, '[Unit]\n', 'utf8');
    const { runner, interactive } = recording();

    await stepById('autostart').undo(ctxWith({ dryRun: true, runner }), userService(path));

    expect(existsSync(path)).toBe(true);
    expect(interactive).toEqual([]);
  });

  it('leaves linger alone when this install did not enable it', async () => {
    const { runner, interactive, capture } = recording();

    await stepById('autostart').undo(ctxWith({ runner }), userService(join(unitDir, 'gone.service')));

    // A pre-existing linger may serve other user services — reversing it would break them.
    const touchedLinger = [...interactive, ...capture].some(([, args]) => args.join(' ').includes('linger'));
    expect(touchedLinger).toBe(false);
  });

  it('disables linger when the install recorded that it enabled it', async () => {
    const notes: string[] = [];
    const { runner } = recording();
    const ctx = ctxWith({
      dryRun: true,
      runner,
      ui: { ...createAutoUi(), info: (m: string) => notes.push(m), note: (m: string) => notes.push(m) } as Ui,
    });

    await stepById('autostart').undo(ctx, {
      artifacts: [
        { kind: 'owned', type: 'service', name: 'xezar.service', scope: 'user', path: join(unitDir, 'x.service') },
        { kind: 'owned', type: 'linger', name: 'ops' },
      ],
    });

    expect(notes.join('\n')).toContain('disable-linger');
  });

  it('takes the sudo path for a system-scoped unit', async () => {
    const notes: string[] = [];
    const { runner } = recording();
    const ctx = ctxWith({
      dryRun: true,
      runner,
      ui: { ...createAutoUi(), info: (m: string) => notes.push(m), note: (m: string) => notes.push(m) } as Ui,
    });

    await stepById('autostart').undo(ctx, {
      artifacts: [
        { kind: 'owned', type: 'service', name: 'xezar.service', scope: 'system', path: '/etc/systemd/system/xezar.service' },
      ],
    });

    // A system unit lives in /etc and needs root — never an rmSync from this process.
    expect(notes.join('\n')).toContain('/etc/systemd/system/xezar.service');
  });

  it('does nothing at all when no service was ever recorded', async () => {
    const { runner, interactive, capture } = recording();

    await stepById('autostart').undo(ctxWith({ runner }), null);

    expect(interactive).toEqual([]);
    expect(capture).toEqual([]);
  });
});

/**
 * `server-deploy`. Two things here are silent when wrong: restarting the WRONG scope's unit
 * (the user unit is the install default, so defaulting to `system` sudo-restarts something that
 * was never installed), and finishing without re-verifying — a deploy that broke the cockpit
 * would exit 0.
 */
describe('ubuntu-vps redeploy', () => {
  function deployCtx(over: Partial<InstallContext> = {}, runner?: Runner): InstallContext {
    const ctx = {
      ...ctxWith({ runner: runner ?? okRunner }),
      ...over,
    } as InstallContext;
    return ctx;
  }

  /** A live host: the unit's ExecStart is a checkout launch, curl says everything is healthy. */
  function healthyRunner() {
    const interactive: Array<[string, string[]]> = [];
    const runner: Runner = {
      interactive: async (program, args) => {
        interactive.push([program, args]);
        return 0;
      },
      capture: async (program, args, opts) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          if (target.includes(':4321')) return { code: 0, stdout: '200', stderr: '' };
          return { code: 0, stdout: opts?.input ? '200' : '401', stderr: '' };
        }
        if (args.join(' ').includes('ExecStart')) {
          return { code: 0, stdout: 'ExecStart=/usr/bin/node /opt/xezar/dist/index.js serve', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    return { runner, interactive };
  }

  const withRecordedScope = (scope: 'user' | 'system') => ({
    schema: 1 as const,
    installed: true,
    primaryPort: 4321,
    steps: {
      autostart: {
        status: 'done' as const,
        created: { artifacts: [{ kind: 'owned' as const, type: 'service' as const, name: 'xezar.service', scope, path: '/x' }] },
      },
    },
  });

  it('restarts the USER unit the install recorded, then re-verifies end to end', async () => {
    const { runner, interactive } = healthyRunner();
    const ctx = deployCtx({ state: withRecordedScope('user'), assumeYes: false }, runner);
    ctx.prefs.cockpit = { user: 'ops', password: 'hunter2!' };

    await ubuntuVps.redeploy!(ctx);

    expect(interactive).toContainEqual(['systemctl', ['--user', 'daemon-reload']]);
    expect(interactive).toContainEqual(['systemctl', ['--user', 'restart', 'xezar.service']]);
    // No sudo anywhere: a user-scope unit must never be restarted as root.
    expect(interactive.some(([program]) => program === 'sudo')).toBe(false);
  });

  it('warns instead of throwing when the user restart returns non-zero', async () => {
    const warnings: string[] = [];
    const { runner } = healthyRunner();
    const ctx = deployCtx(
      {
        state: withRecordedScope('user'),
        assumeYes: false,
        ui: { ...createAutoUi(), warn: (m: string) => warnings.push(m) } as Ui,
      },
      {
        ...runner,
        interactive: async (_program, args) => (args.includes('restart') ? 1 : 0),
      },
    );
    ctx.prefs.cockpit = { user: 'ops', password: 'hunter2!' };

    await ubuntuVps.redeploy!(ctx);

    expect(warnings.some((w) => w.includes('systemctl --user restart returned non-zero'))).toBe(true);
  });

  it('fails the deploy when the cockpit does not come back', async () => {
    const runner: Runner = {
      interactive: async () => 0,
      // Nothing answers: xezar is down, so nginx would serve 502.
      capture: async (program) => ({ code: 0, stdout: program === 'curl' ? '000' : '', stderr: '' }),
    };
    const ctx = deployCtx({ state: withRecordedScope('user'), assumeYes: false }, runner);

    // "complete" has to mean the cockpit actually works — a deploy that broke it must exit non-zero.
    await expect(ubuntuVps.redeploy!(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  it('restarts nothing in a dry run', async () => {
    const { runner, interactive } = healthyRunner();

    await ubuntuVps.redeploy!(deployCtx({ dryRun: true, state: withRecordedScope('user') }, runner));

    expect(interactive).toEqual([]);
  });
});
