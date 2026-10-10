import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { OwnedPids } from '../../test/helpers/owned-pids.ts';
import { TEST_DIR_RM_OPTIONS, onWindows } from '../../test/helpers/platform.ts';
import { PROCESS_GROUP_GRACE_MS, TREE_STOP_TIMEOUT_MS } from '../platform/process-tree.ts';
import {
  ProviderAuthService,
  defaultRunProviderCommand,
  isRuntimeProviderAuthFailure,
  providerAuthChecksDisabled,
  type ProviderCommandDeps,
  type ProviderCommandResult,
  type RunProviderCommand,
} from './provider-auth.ts';

const connectedResults: Record<string, ProviderCommandResult> = {
  claude: { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 },
  codex: { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 },
  opencode: {
    stdout: [
      '┌  Credentials ~/.local/share/opencode/auth.json',
      '│',
      '●  Anthropic oauth',
      '│',
      '└  1 credential',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  },
  pi: {
    stdout: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
    stderr: '',
    exitCode: 0,
  },
};

const originalEnv = {
  XEZ_AGENT_MODELS_LOCKED: process.env.XEZ_AGENT_MODELS_LOCKED,
  XEZ_DRY_RUN: process.env.XEZ_DRY_RUN,
  XEZ_CLAUDE_BIN: process.env.XEZ_CLAUDE_BIN,
  XEZ_CODEX_BIN: process.env.XEZ_CODEX_BIN,
  XEZ_OPENCODE_BIN: process.env.XEZ_OPENCODE_BIN,
  XEZ_PI_BIN: process.env.XEZ_PI_BIN,
};

beforeEach(() => {
  delete process.env.XEZ_AGENT_MODELS_LOCKED;
  delete process.env.XEZ_DRY_RUN;
  delete process.env.XEZ_CLAUDE_BIN;
  delete process.env.XEZ_CODEX_BIN;
  delete process.env.XEZ_OPENCODE_BIN;
  delete process.env.XEZ_PI_BIN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function resultFor(executable: string): ProviderCommandResult {
  if (executable === 'claude') return connectedResults.claude!;
  if (executable.includes('codex')) return connectedResults.codex!;
  if (executable.includes('opencode')) return connectedResults.opencode!;
  return connectedResults.pi!;
}

function runner(
  resolve: (executable: string, args: readonly string[]) => ProviderCommandResult = resultFor,
): RunProviderCommand {
  return vi.fn(async (executable, args) => resolve(executable, args));
}

function statuses(
  service: ProviderAuthService,
): Promise<Record<string, { status: string; hint?: string }>> {
  return service.status().then(({ providers }) => Object.fromEntries(
    providers.map(({ provider, status, hint }) => [provider, { status, hint }]),
  ));
}

describe('runtime provider authentication failures', () => {
  it.each([
    'claude CLI exited with code 1 — Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    'codex: turn failed: unauthorized',
    'ProviderAuthError: API key expired — run `opencode auth login`',
    'API Error: invalid API key',
    'AuthenticationError: expired api-key',
    '401 invalid x-api-key',
    'x-api-key is invalid',
    'expired API key',
    'API key expired',
    'access token is invalid',
    'authentication failed with HTTP 401',
  ])('recognizes an authoritative runtime auth rejection: %s', (message) => {
    expect(isRuntimeProviderAuthFailure(message)).toBe(true);
  });

  it.each([
    'claude CLI exited with code 1 — TypeScript check failed',
    'API Error: 429 rate limit exceeded',
    'the agent fixed a 401 response in src/auth.ts',
    'added coverage for invalid API key handling',
    'fixed a 401 response in the API key header parser',
    'investigated expired API-key validation before updating the note-event tests',
    'the API key rotation guide is invalid because its example is stale',
    'the invalid response parser documents an API key header',
    'network connection reset',
  ])('does not turn unrelated failures into credential failures: %s', (message) => {
    expect(isRuntimeProviderAuthFailure(message)).toBe(false);
  });
});

describe('provider auth parsers', () => {
  it('accepts only Claude JSON with loggedIn true as connected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'connected' } });
  });

  it('maps Claude loggedIn false, including exit 1 JSON, to disconnected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'disconnected' } });
  });

  it.each([
    ['loggedIn true on exit 7', '{"loggedIn":true}', 7],
    ['loggedIn false on exit 0', '{"loggedIn":false}', 0],
  ])('treats Claude %s as unknown', async (_case, stdout, exitCode) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout, stderr: '', exitCode }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'unknown' } });
  });

  it('treats malformed Claude JSON as unknown', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout: '{not json', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'unknown' } });
  });

  it.each([
    'Logged in using ChatGPT',
    'Logged in using an API key',
    'Logged in using Agent Identity',
  ])('recognizes Codex connected output: %s', async (stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: `\u001B[32m${stdout}\u001B[0m`, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'connected' } });
  });

  it.each([
    'Logged in using ChatGPT',
    'Logged in using an API key - sk-proj-***ABCDE',
    'Logged in using access token',
    'Logged in using personal access token',
    'Logged in using Amazon Bedrock API key',
  ])('recognizes current Codex stderr output: %s', async (statusLine) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? {
          stdout: '',
          stderr: [
            'WARNING: experimental feature enabled',
            `\u001B[32m${statusLine}\u001B[0m`,
          ].join('\n'),
          exitCode: 0,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'connected' } });
  });

  it('recognizes current Codex not-logged-in stderr on exit 1', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? {
          stdout: '',
          stderr: ['WARNING: config migration available', 'Not logged in'].join('\n'),
          exitCode: 1,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'disconnected' } });
  });

  it.each([
    {
      case: 'duplicate answers',
      stdout: 'Logged in using ChatGPT',
      stderr: 'Logged in using ChatGPT',
    },
    {
      case: 'conflicting answers',
      stdout: 'Logged in using ChatGPT',
      stderr: 'Not logged in',
    },
  ])('treats Codex $case across output channels as unknown', async ({ stdout, stderr }) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout, stderr, exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it('never returns the masked Codex API-key identifier', async () => {
    const masked = 'sk-proj-***ABCDE';
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: '', stderr: `Logged in using an API key - ${masked}`, exitCode: 0 }
        : resultFor(executable)),
    });

    const response = await service.status();
    expect(response.providers.find(({ provider }) => provider === 'codex')).toEqual({
      provider: 'codex',
      status: 'connected',
    });
    expect(JSON.stringify(response)).not.toContain(masked);
  });

  it('does not accept known Codex connected output on an unexpected nonzero exit', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 7 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it.each([
    'Not logged in',
    'Run codex login to authenticate',
  ])('recognizes Codex disconnected output: %s', async (stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout, stderr: '', exitCode: 1 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'disconnected' } });
  });

  it('does not accept known Codex disconnected output on exit 0', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: 'Not logged in', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it('does not guess from unrecognized Codex output', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: 'Codex status: account maybe ready', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it.each([
    [
      'one ANSI-styled credential',
      [
        '\u001B[90m┌  Credentials ~/.local/share/opencode/auth.json\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[36m●\u001B[0m  Acme Enterprise \u001B[2moauth\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[90m└\u001B[0m  1 credential',
      ].join('\n'),
    ],
    [
      'multiple arbitrary credential rows',
      [
        '┌  Credentials /srv/opencode/auth.json',
        '│',
        '●  Acme Enterprise oauth',
        '●  local-provider api',
        '●  Custom Gateway wellknown',
        '●  Another Provider api',
        '│',
        '└  4 credentials',
      ].join('\n'),
    ],
  ])('recognizes OpenCode %s as connected', async (_case, stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'connected' } });
  });

  it('recognizes configured OpenCode models without stored credentials', async () => {
    const runCommand = runner((executable, args) => executable === 'opencode'
      ? { stdout: args[0] === 'models'
        ? 'dgx-spark/deepseek-v4-flash-vision\n'
        : '┌  Credentials ~/.local/share/opencode/auth.json\n└  0 credentials\n',
      stderr: '', exitCode: 0 }
      : resultFor(executable));
    const service = new ProviderAuthService({ runCommand });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'connected' } });
    expect(runCommand).toHaveBeenCalledWith('opencode', ['models'], 10_000);
  });

  it('recognizes an OpenCode decorated zero-credential list as disconnected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable, args) => executable === 'opencode'
        ? {
          stdout: args[0] === 'models' ? '' : [
            '┌  Credentials ~/.local/share/opencode/auth.json',
            '│',
            '└  0 credentials',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'disconnected' } });
  });

  it.each([
    { stdout: 'unrecognized output', stderr: '', exitCode: 0 },
    { stdout: 'local/model', stderr: '', exitCode: 1 },
    { stdout: '', stderr: '', exitCode: null, timedOut: true },
  ])('does not claim OpenCode is configured when model discovery fails: %j', async (models) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable, args) => executable === 'opencode'
        ? args[0] === 'models' ? models
          : { stdout: '└  0 credentials\n', stderr: '', exitCode: 0 }
        : resultFor(executable)),
    });
    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });

  it.each([
    [
      'one environment variable',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '│',
        '└  0 credentials',
        '',
        '┌  Environment',
        '│',
        '●  Anthropic ANTHROPIC_API_KEY',
        '│',
        '└  1 environment variable',
      ].join('\n'),
    ],
    [
      'multiple environment variables',
      [
        '\u001B[90m┌  Credentials /srv/opencode/auth.json\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[90m└\u001B[0m  0 credentials',
        '',
        '\u001B[90m┌  Environment\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[36m●\u001B[0m  Acme ACME_API_KEY',
        '\u001B[36m●\u001B[0m  Custom Gateway CUSTOM_TOKEN',
        '\u001B[90m│\u001B[0m',
        '\u001B[90m└\u001B[0m  2 environment variables',
      ].join('\n'),
    ],
  ])('recognizes OpenCode zero stored credentials plus %s as connected', async (_case, stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'connected' } });
  });

  it.each([
    [
      'a missing stored-credential summary',
      [
        '┌  Environment',
        '●  Acme ACME_API_KEY',
        '└  1 environment variable',
      ].join('\n'),
    ],
    [
      'duplicate stored-credential summaries',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '└  1 credential',
      ].join('\n'),
    ],
    [
      'conflicting environment summaries',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '┌  Environment',
        '└  1 environment variable',
        '└  2 environment variables',
      ].join('\n'),
    ],
    [
      'a malformed environment summary',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '┌  Environment',
        '└  environment variables: many',
      ].join('\n'),
    ],
    [
      'an environment summary without its block',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '└  1 environment variable',
      ].join('\n'),
    ],
    [
      'an unsafe environment count',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '┌  Environment',
        '└  9007199254740992 environment variables',
      ].join('\n'),
    ],
  ])('treats OpenCode output with %s as unknown', async (_case, stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });

  it('does not accept an OpenCode credential summary on an unexpected nonzero exit', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { ...connectedResults.opencode!, exitCode: 7 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });

  it.each([
    'New auth output format v99',
    ['┌  Credentials ~/.local/share/opencode/auth.json', '└  credentials: many'].join('\n'),
  ])('does not guess from OpenCode output without a valid count summary', async (stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: 'error', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });

  it('recognizes pi model availability as connected without reading credential files', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'pi'
        ? connectedResults.pi!
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ pi: { status: 'connected' } });
  });

  it('recognizes pi explicit no-models login guidance as disconnected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'pi'
        ? {
          stdout: 'No models available. Use /login to authenticate.',
          stderr: '',
          exitCode: 0,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ pi: { status: 'disconnected' } });
  });

  it('does not guess from unrecognized pi model output', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'pi'
        ? { stdout: 'Models may be available', stderr: 'private detail', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ pi: { status: 'unknown' } });
  });
});

describe('ProviderAuthService', () => {
  it('always returns claude, codex, opencode, pi in descriptor order', async () => {
    const service = new ProviderAuthService({ runCommand: runner() });

    await expect(service.status()).resolves.toMatchObject({
      providers: [
        { provider: 'claude' },
        { provider: 'codex' },
        { provider: 'opencode' },
        { provider: 'pi' },
      ],
    });
  });

  it('runs the four status commands concurrently with a 10 second timeout', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable, args, timeoutMs) => {
      calls.push({ executable, args, timeoutMs });
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });
    const pending = service.status();

    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls).toEqual([
      { executable: 'claude', args: ['auth', 'status', '--json'], timeoutMs: 10_000 },
      { executable: 'codex', args: ['login', 'status'], timeoutMs: 10_000 },
      { executable: 'opencode', args: ['auth', 'list'], timeoutMs: 10_000 },
      { executable: 'pi', args: ['--list-models'], timeoutMs: 10_000 },
    ]);
    release();
    await expect(pending).resolves.toBeDefined();
  });

  it('maps an ENOENT command failure to not-installed', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'codex'
        ? { stdout: '', stderr: '', exitCode: null, errorCode: 'ENOENT' }
        : resultFor(executable)),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'not-installed' } });
  });

  it.each(['ETIMEDOUT', 'EACCES'])('maps %s to unknown without exposing raw output', async (errorCode) => {
    const secret = 'provider-auth-sentinel-secret';
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'codex'
        ? {
          stdout: errorCode === 'EACCES' ? 'Logged in using ChatGPT' : secret,
          stderr: secret,
          exitCode: null,
          errorCode,
          timedOut: errorCode === 'ETIMEDOUT',
        }
        : resultFor(executable)),
    });

    const response = await service.status();
    const codex = response.providers.find(({ provider }) => provider === 'codex');
    expect(codex).toMatchObject({ provider: 'codex', status: 'unknown' });
    expect(codex?.hint).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  describe('cache lifetime is asymmetric on purpose', () => {
    it('keeps an all-connected answer for MINUTES — it is what every run needs and rarely changes', async () => {
      let now = 1_000;
      const runCommand = runner();
      const service = new ProviderAuthService({ runCommand, now: () => now });

      await service.status();
      now += 9 * 60_000;
      await service.status();
      // Still four: one probe per provider, from the first call only.
      expect(runCommand).toHaveBeenCalledTimes(4);
    });

    it('re-probes an all-connected answer once the long window passes', async () => {
      let now = 1_000;
      const runCommand = runner();
      const service = new ProviderAuthService({ runCommand, now: () => now });

      await service.status();
      now += 10 * 60_000 + 1;
      await service.status();
      expect(runCommand).toHaveBeenCalledTimes(8);
    });

    it('re-checks a NOT-connected answer sooner, so a terminal login is noticed on its own', async () => {
      // xezar cannot see `claude auth login` happen, so a card that says disconnected has to find
      // out for itself. A minute, not seconds: every expiry costs a background probe now that
      // reading revalidates behind the answer, and a polling cockpit would turn a five-second
      // window into a spawn every five seconds forever.
      let now = 1_000;
      const runCommand = runner((executable) =>
        executable === 'claude'
          ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
          : resultFor(executable));
      const service = new ProviderAuthService({ runCommand, now: () => now });

      await service.status();
      now += 59_999;
      await service.status();
      expect(runCommand).toHaveBeenCalledTimes(4); // still inside the short window
      now += 2;
      await service.status();
      expect(runCommand).toHaveBeenCalledTimes(8); // past it → re-probed
    });

    it('serves the stale answer immediately and refreshes BEHIND it, never in front', async () => {
      // The bug this fixes: `GET /api/v1/providers/status` awaited the re-probe, so every lapse of
      // the window made one reader pay ~0.8s (~3s on a slower box) for an endpoint the cockpit
      // polls. Measured on the built server before the change: 3ms, 3ms, then 817ms.
      let now = 1_000;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let probes = 0;
      const service = new ProviderAuthService({
        now: () => now,
        runCommand: async (executable) => {
          probes += 1;
          if (probes > 4) await gate; // only the SECOND round of probes hangs
          return resultFor(executable);
        },
      });

      await service.status();
      now += 11 * 60_000; // past even the long window

      // Resolves while the refresh is still hanging — that is the whole point.
      await expect(service.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'connected' }),
        ]),
      });
      expect(probes).toBe(8); // …and it did kick the refresh off

      // A reader arriving mid-revalidation is served from cache too, not attached to the probe.
      await expect(service.status()).resolves.toBeDefined();
      expect(probes).toBe(8); // no second refresh piled on top
      release();
    });

    it('waits when NOTHING is known yet — there is no stale answer to serve', async () => {
      const runCommand = runner();
      const service = new ProviderAuthService({ runCommand, now: () => 1_000 });
      await expect(service.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'connected' }),
        ]),
      });
      expect(runCommand).toHaveBeenCalledTimes(4);
    });

    it('applies the same asymmetry per account', async () => {
      let now = 1_000;
      const runCommand = runner((_executable, _args) => connectedResults.claude!);
      const service = new ProviderAuthService({ runCommand, now: () => now });

      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      now += 9 * 60_000;
      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      expect(runCommand).toHaveBeenCalledTimes(1);
    });
  });

  it('refresh bypasses a completed cache entry', async () => {
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand, now: () => 1_000 });

    await service.status();
    await service.status({ refresh: true });
    expect(runCommand).toHaveBeenCalledTimes(8);
  });

  it('keeps one incident id until an explicit matching clear and creates a new id afterward', async () => {
    const ids = ['incident-1', 'incident-2'];
    const service = new ProviderAuthService({
      platform: 'linux',
      runCommand: runner(),
      createAuthFailureId: () => ids.shift()!,
    });

    const first = service.reportRuntimeAuthFailure('claude');
    expect(first).not.toBeNull();
    if (!first) throw new Error('runtime incident was not created');
    expect(first).toEqual({
      transitioned: true,
      status: {
        provider: 'claude',
        status: 'disconnected',
        hint: 'Authentication was rejected during a run. Reconnect, then try again.',
        authFailureId: 'incident-1',
      },
    });
    expect(service.reportRuntimeAuthFailure('claude')).toEqual({
      transitioned: false,
      status: first.status,
    });
    await expect(service.status()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', authFailureId: 'incident-1' }),
      ]),
    });

    expect(service.clearRuntimeAuthFailure('claude', 'stale')).toBe(false);
    expect(service.clearRuntimeAuthFailure('claude', first.status.authFailureId)).toBe(true);

    expect(service.reportRuntimeAuthFailure('claude')).toMatchObject({
      status: { authFailureId: 'incident-2' },
    });
  });

  it('does not clear a runtime latch when an ordinary fresh probe finds credentials', async () => {
    const service = new ProviderAuthService({ runCommand: runner() });
    const report = service.reportRuntimeAuthFailure('claude');
    expect(report).not.toBeNull();
    if (!report) throw new Error('runtime incident was not created');
    const incident = report.status.authFailureId;

    await expect(service.status({ refresh: true })).resolves.toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: incident,
      })]),
    });
    expect(service.clearRuntimeAuthFailure('claude', incident)).toBe(true);
    await expect(service.status()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', status: 'connected' }),
      ]),
    });
  });

  it('applies a runtime failure that arrives while an ordinary probe is in flight', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable: string) => {
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });

    const pending = service.status();
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(4));
    service.reportRuntimeAuthFailure('claude');
    release();

    await expect(pending.then(({ providers }) => providers[0])).resolves.toMatchObject({
      provider: 'claude',
      status: 'disconnected',
    });
  });

  it('rejects a stale clear after a newer incident replaces it', async () => {
    const ids = ['incident-1', 'incident-2'];
    const service = new ProviderAuthService({
      runCommand: runner(),
      createAuthFailureId: () => ids.shift()!,
    });
    const firstReport = service.reportRuntimeAuthFailure('claude');
    expect(firstReport).not.toBeNull();
    if (!firstReport) throw new Error('runtime incident was not created');
    const first = firstReport.status.authFailureId;

    expect(service.clearRuntimeAuthFailure('claude', first)).toBe(true);
    const secondReport = service.reportRuntimeAuthFailure('claude');
    expect(secondReport).not.toBeNull();
    if (!secondReport) throw new Error('runtime incident was not created');
    const second = secondReport.status.authFailureId;

    expect(service.clearRuntimeAuthFailure('claude', first)).toBe(false);
    await expect(service.status()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', authFailureId: second }),
      ]),
    });
  });

  it('keeps XEZ_DRY_RUN connected and ignores runtime invalidation', async () => {
    process.env.XEZ_DRY_RUN = '1';
    const createAuthFailureId = vi.fn(() => 'unused-incident');
    const service = new ProviderAuthService({ runCommand: runner(), createAuthFailureId });

    expect(service.reportRuntimeAuthFailure('claude')).toBeNull();
    expect(createAuthFailureId).not.toHaveBeenCalled();
    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'connected' } });
  });

  it('keeps exact XEZ_AGENT_MODELS_LOCKED=1 connected without credential probes or runtime invalidation', async () => {
    process.env.XEZ_AGENT_MODELS_LOCKED = '1';
    const runCommand = runner();
    const createAuthFailureId = vi.fn(() => 'unused-incident');
    const service = new ProviderAuthService({ runCommand, createAuthFailureId });

    expect(providerAuthChecksDisabled()).toBe(true);
    expect(service.reportRuntimeAuthFailure('claude')).toBeNull();
    await expect(service.status({ refresh: true })).resolves.toEqual({
      providers: [
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'connected' },
        { provider: 'opencode', status: 'connected' },
        { provider: 'pi', status: 'connected' },
      ],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(createAuthFailureId).not.toHaveBeenCalled();
  });

  it.each(['0', 'true', 'yes', ''])(
    'does not disable provider checks for XEZ_AGENT_MODELS_LOCKED=%j',
    (value) => {
      process.env.XEZ_AGENT_MODELS_LOCKED = value;
      expect(providerAuthChecksDisabled()).toBe(false);
    },
  );

  it('coalesces ordinary and refresh callers while a probe is in flight', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable: string) => {
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });

    const ordinary = service.status();
    const refresh = service.status({ refresh: true });
    expect(refresh).toBe(ordinary);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(4));
    release();
    await expect(Promise.all([ordinary, refresh])).resolves.toHaveLength(2);
    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  it('gives ordinary callers one shared visible promise for a fresh probe after a latch', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable: string) => {
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });
    service.reportRuntimeAuthFailure('claude');

    const refresh = service.status({ refresh: true });
    const ordinary = service.status();

    expect(refresh).toBe(ordinary);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(4));
    release();
    await expect(ordinary.then(({ providers }) => providers[0])).resolves.toMatchObject({
      provider: 'claude',
      status: 'disconnected',
    });
  });

  it('uses XEZ_CODEX_BIN and XEZ_OPENCODE_BIN for both probe and login commands', async () => {
    process.env.XEZ_CODEX_BIN = '/tools/codex custom';
    process.env.XEZ_OPENCODE_BIN = '/tools/opencode custom';
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand, platform: 'linux' });

    await service.status();
    expect(runCommand).toHaveBeenCalledWith('/tools/codex custom', ['login', 'status'], 10_000);
    expect(runCommand).toHaveBeenCalledWith('/tools/opencode custom', ['auth', 'list'], 10_000);
    expect(service.loginCommand('codex')).toBe("'/tools/codex custom' login");
    expect(service.loginCommand('opencode')).toBe("'/tools/opencode custom' auth login");
  });

  it('uses XEZ_PI_BIN for the model-availability probe and interactive login', async () => {
    process.env.XEZ_PI_BIN = '/tools/pi custom';
    const runCommand = runner((executable) =>
      executable === '/tools/pi custom' ? connectedResults.pi! : resultFor(executable));
    const service = new ProviderAuthService({ runCommand, platform: 'linux' });

    await service.status();
    expect(runCommand).toHaveBeenCalledWith('/tools/pi custom', ['--list-models'], 10_000);
    expect(service.loginCommand('pi')).toBe("'/tools/pi custom' /login");
  });

  it('uses the documented XEZ_CLAUDE_BIN override for both probe and login commands', async () => {
    process.env.XEZ_CLAUDE_BIN = '/tools/claude custom';
    const runCommand = runner((executable) =>
      executable === '/tools/claude custom' ? connectedResults.claude! : resultFor(executable));
    const service = new ProviderAuthService({ runCommand, platform: 'linux' });

    await service.status();
    expect(runCommand).toHaveBeenCalledWith('/tools/claude custom', ['auth', 'status', '--json'], 10_000);
    expect(service.loginCommand('claude')).toBe("'/tools/claude custom' auth login");
  });

  it('renders POSIX and Windows login commands safely for executable special characters', () => {
    process.env.XEZ_CODEX_BIN = "a path/'codex'";
    process.env.XEZ_OPENCODE_BIN = 'C:\\Program Files\\op%en&co!de".exe';

    expect(new ProviderAuthService({ platform: 'linux' }).loginCommand('codex'))
      .toBe("'a path/'\\''codex'\\''' login");
    expect(new ProviderAuthService({ platform: 'win32' }).loginCommand('opencode'))
      .toBe('"C:\\Program Files\\op^%en^&co^!de^".exe" auth login');
  });

  it('reports all four providers connected in XEZ_DRY_RUN without executing a command', async () => {
    process.env.XEZ_DRY_RUN = '1';
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand });

    await expect(service.status()).resolves.toEqual({
      providers: [
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'connected' },
        { provider: 'opencode', status: 'connected' },
        { provider: 'pi', status: 'connected' },
      ],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  describe('per-account status (spec 2026-07-29-agent-profiles)', () => {
    it('probes an account with its own config dir in the environment', async () => {
      const runCommand = runner();
      const service = new ProviderAuthService({ runCommand });

      const row = await service.profileStatus('claude', { id: 'work', configDir: '/home/u/.claude-klaudiusz' });

      expect(row).toEqual({ provider: 'claude', status: 'connected', profileId: 'work' });
      expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], 10_000, {
        CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz',
      });
    });

    it('keeps `status()` byte-identical — the default probe still gets THREE arguments', async () => {
      const runCommand = runner();
      const service = new ProviderAuthService({ runCommand });
      await service.status();
      // `runCommand` is an injected seam; handing every existing implementation a trailing
      // `undefined` would change the zero-config path for no gain.
      expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], 10_000);
    });

    it('never carries `profileId` on the rows `status()` builds', async () => {
      const service = new ProviderAuthService({ runCommand: runner() });
      const { providers } = await service.status();
      expect(providers.every((row) => !('profileId' in row))).toBe(true);
    });

    it('keeps peeking after the probe window closes — a peek blocks nothing', async () => {
      // The window exists to stop a stale NEGATIVE from blocking a run. A peek only fills in a dot
      // on a settings page, so applying it there made the cache expire in 5s on any machine with
      // one provider logged out (most of them) and put the shell-out back on the page load.
      let now = 1_000;
      let spawns = 0;
      const service = new ProviderAuthService({
        now: () => now,
        runCommand: async (executable) => {
          spawns += 1;
          return executable === 'claude'
            ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
            : resultFor(executable);
        },
      });

      await service.status();
      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      const before = spawns;
      now += 60 * 60_000; // an hour later

      expect(service.peekStatus()?.providers).toHaveLength(4);
      expect(service.peekProfileStatus('claude', 'work')).toBeDefined();
      expect(spawns).toBe(before); // …and still nothing spawned
    });

    it('peeks the cache without probing, and reports a miss rather than spawning', async () => {
      // The accounts listing reads through these: a peek that spawned would put a CLI shell-out
      // back on a page load, which is the regression this pair exists to prevent.
      let spawns = 0;
      const service = new ProviderAuthService({
        runCommand: async (executable) => {
          spawns += 1;
          return resultFor(executable);
        },
      });

      expect(service.peekStatus()).toBeUndefined();
      expect(service.peekProfileStatus('claude', 'work')).toBeUndefined();
      expect(spawns).toBe(0);

      await service.status();
      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      const before = spawns;
      expect(service.peekStatus()?.providers).toHaveLength(4);
      expect(service.peekProfileStatus('claude', 'work')?.profileId).toBe('work');
      expect(spawns).toBe(before);
    });

    it('caches per (provider, account) — two logins never read each other\'s answer', async () => {
      let calls = 0;
      const runCommand: RunProviderCommand = vi.fn(async (executable, args, _timeout, env) => {
        calls += 1;
        // The work account is signed out; the personal one is not.
        return env?.CLAUDE_CONFIG_DIR === '/work'
          ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
          : connectedResults.claude!;
      });
      const service = new ProviderAuthService({ runCommand });

      const work = await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      const client = await service.profileStatus('claude', { id: 'client', configDir: '/client' });
      expect(work.status).toBe('disconnected');
      expect(client.status).toBe('connected');
      expect(calls).toBe(2);

      // Both answers are cached independently, on the same asymmetric lifetime `status()` uses
      // (`cacheTtlFor`) — not a flat 5s window; that spelling is what this file's own
      // "cache lifetime is asymmetric on purpose" block replaced.
      expect((await service.profileStatus('claude', { id: 'work', configDir: '/work' })).status)
        .toBe('disconnected');
      expect(calls).toBe(2);

      service.forgetProfileStatus();
      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      expect(calls).toBe(3);
    });

    it('forgets ONE account, leaving the rest of the warmed cache alone', async () => {
      // This cache is pre-warmed at boot and meant to survive, so evicting every account because
      // one was repointed (or re-checked) would throw away knowledge that is still true.
      let calls = 0;
      const service = new ProviderAuthService({
        runCommand: async () => {
          calls += 1;
          return connectedResults.claude!;
        },
      });
      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      await service.profileStatus('claude', { id: 'client', configDir: '/client' });
      await service.profileStatus('codex', { id: 'work', configDir: '/codex-klaudiusz' });
      expect(calls).toBe(3);

      service.forgetProfileStatus('claude', 'work');
      // Same id under a different provider is a different account, and is untouched.
      expect(service.peekProfileStatus('codex', 'work')).toBeDefined();
      expect(service.peekProfileStatus('claude', 'client')).toBeDefined();
      expect(service.peekProfileStatus('claude', 'work')).toBeUndefined();

      await service.profileStatus('claude', { id: 'client', configDir: '/client' });
      await service.profileStatus('codex', { id: 'work', configDir: '/codex-klaudiusz' });
      expect(calls).toBe(3);
      await service.profileStatus('claude', { id: 'work', configDir: '/work' });
      expect(calls).toBe(4);
    });

    it('answers connected per account in XEZ_DRY_RUN without executing a command', async () => {
      process.env.XEZ_DRY_RUN = '1';
      const runCommand = runner();
      const service = new ProviderAuthService({ runCommand });
      await expect(service.profileStatus('claude', { id: 'work', configDir: '/work' })).resolves.toEqual({
        provider: 'claude',
        status: 'connected',
        profileId: 'work',
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('aims the login command at the account, and refuses a dir it cannot embed safely', () => {
      const posix = new ProviderAuthService({ platform: 'linux' });
      expect(posix.loginCommand('claude', '/home/u/.claude-klaudiusz'))
        .toBe("export CLAUDE_CONFIG_DIR='/home/u/.claude-klaudiusz'; 'claude' auth login");
      expect(posix.loginCommand('claude', null)).toBe("'claude' auth login");

      const win = new ProviderAuthService({ platform: 'win32' });
      expect(win.loginCommand('codex', 'C:\\codex-klaudiusz'))
        .toBe('set "CODEX_HOME=C:\\codex-klaudiusz" && "codex" login');
      // Fail closed rather than sign the user into a different account than the one they clicked.
      expect(win.loginCommand('codex', 'C:\\bad"dir')).toBeNull();
    });

    it('adds nothing for OpenCode, whose credentials do not follow its config dir', () => {
      expect(new ProviderAuthService({ platform: 'linux' }).loginCommand('opencode', '/oc-work'))
        .toBe("'opencode' auth login");
    });
  });
});

// #894: the sign-in check runs in its own process group and stops everything it started. The
// seam tests run the POSIX group path and the Windows tree path on every OS against a fake child;
// the real-process tests below prove the same against a CLI that forks a background grandchild.
describe('defaultRunProviderCommand – a probe stops everything it started (#894)', () => {
  type ProbeStart = NonNullable<ProviderCommandDeps['start']>;
  type FakeStream = EventEmitter & { destroy: Mock<() => void> };
  interface FakeProbe extends EventEmitter {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: Mock<(signal?: NodeJS.Signals) => boolean>;
    stdin: FakeStream;
    stdout: FakeStream;
    stderr: FakeStream;
  }

  const PID = 4_242;
  const TIMEOUT_MS = 10_000;
  const MAX_OUTPUT_BYTES = 256 * 1024;

  const fakeStream = (): FakeStream => Object.assign(new EventEmitter(), { destroy: vi.fn<() => void>() });

  function fakeProbe(): FakeProbe {
    return Object.assign(new EventEmitter(), {
      pid: PID as number | undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
      stdin: fakeStream(),
      stdout: fakeStream(),
      stderr: fakeStream(),
    });
  }

  function startWith(child: FakeProbe): Mock<ProbeStart> {
    return vi.fn<ProbeStart>(() => child as unknown as ChildProcessWithoutNullStreams);
  }

  /** Whether `pending` has settled, without waiting for it. */
  async function isSettled(pending: Promise<unknown>): Promise<boolean> {
    const marker = Symbol('pending');
    return (await Promise.race([pending, Promise.resolve(marker)])) !== marker;
  }

  /** Signals sent through `process.kill`, recorded and never delivered. */
  function recordGroupSignals(): Mock {
    return vi.spyOn(process, 'kill').mockImplementation(() => true) as unknown as Mock;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts the CLI in its own group, hidden, without a shell, with a profile env on top of the host env', async () => {
    recordGroupSignals();
    const child = fakeProbe();
    const start = startWith(child);
    const pending = defaultRunProviderCommand('claude', ['auth', 'status'], TIMEOUT_MS, { CLAUDE_CONFIG_DIR: '/p' }, {
      start,
      tree: { platform: 'linux' },
    });
    child.emit('close', 0, null);
    await pending;
    expect(start).toHaveBeenCalledWith('claude', ['auth', 'status'], expect.objectContaining({
      detached: true,
      windowsHide: true,
      shell: false,
      env: { ...process.env, CLAUDE_CONFIG_DIR: '/p' },
    }));

    // The default profile adds nothing: the CLI reads the host environment, exactly as before.
    const bare = fakeProbe();
    const bareStart = startWith(bare);
    const barePending = defaultRunProviderCommand('codex', ['login', 'status'], TIMEOUT_MS, undefined, {
      start: bareStart,
      tree: { platform: 'linux' },
    });
    bare.emit('close', 0, null);
    await barePending;
    expect(bareStart.mock.calls[0]?.[2]).not.toHaveProperty('env');
  });

  // Q-02: on Windows `detached` is DETACHED_PROCESS – the probe has no console, so each console
  // program it starts (codex and opencode start their native binary) opens a visible window.
  it('Windows: starts the CLI hidden and NOT detached; the tree stop replaces the group', async () => {
    const child = fakeProbe();
    const start = startWith(child);
    const pending = defaultRunProviderCommand('codex', ['login', 'status'], TIMEOUT_MS, undefined, {
      start,
      tree: { platform: 'win32', isOwnChild: () => false },
    });
    child.emit('close', 0, null);
    await pending;
    const options = start.mock.calls[0]?.[2];
    expect(options).toEqual(expect.objectContaining({ windowsHide: true, shell: false }));
    expect(options).not.toHaveProperty('detached');
  });

  it('POSIX: a hung CLI gets TERM to its group at the timeout, KILL a grace later, and settles a grace after that', async () => {
    vi.useFakeTimers();
    const kill = recordGroupSignals();
    const child = fakeProbe();
    const pending = defaultRunProviderCommand('claude', [], TIMEOUT_MS, undefined, {
      start: startWith(child),
      tree: { platform: 'linux' },
    });
    child.stdout.emit('data', Buffer.from('{"loggedIn":'));

    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill.mock.calls).toEqual([[-PID, 'SIGTERM']]);
    vi.advanceTimersByTime(PROCESS_GROUP_GRACE_MS);
    expect(kill.mock.calls).toEqual([[-PID, 'SIGTERM'], [-PID, 'SIGKILL']]);
    vi.advanceTimersByTime(PROCESS_GROUP_GRACE_MS - 1);
    expect(await isSettled(pending)).toBe(false);

    // No exit ever arrives: the settle timer answers anyway, after one more KILL to the group.
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual({
      stdout: '{"loggedIn":',
      stderr: '',
      exitCode: null,
      errorCode: undefined,
      timedOut: true,
    });
    expect(kill.mock.calls).toEqual([[-PID, 'SIGTERM'], [-PID, 'SIGKILL'], [-PID, 'SIGKILL']]);
    expect(child.kill).not.toHaveBeenCalled();
    // Whatever left the group can still hold the pipes: xezar lets go of its ends.
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
  });

  it('POSIX: a CLI that exits has its group killed before the answer (#892), and no timer fires later', async () => {
    vi.useFakeTimers();
    const kill = recordGroupSignals();
    const child = fakeProbe();
    const pending = defaultRunProviderCommand('claude', [], TIMEOUT_MS, undefined, {
      start: startWith(child),
      tree: { platform: 'darwin' },
    });
    child.stdout.emit('data', Buffer.from('{"loggedIn":false}'));
    child.stderr.emit('data', Buffer.from('not signed in'));
    child.emit('close', 1, null);

    await expect(pending).resolves.toEqual({
      stdout: '{"loggedIn":false}',
      stderr: 'not signed in',
      exitCode: 1,
      errorCode: undefined,
      timedOut: false,
    });
    expect(kill.mock.calls).toEqual([[-PID, 'SIGKILL']]);
    vi.advanceTimersByTime(TIMEOUT_MS * 3);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroy).not.toHaveBeenCalled();
  });

  it('POSIX: a CLI that closes while it is being stopped answers at once, timed out, with no later signal', async () => {
    vi.useFakeTimers();
    const kill = recordGroupSignals();
    const child = fakeProbe();
    const pending = defaultRunProviderCommand('claude', [], TIMEOUT_MS, undefined, {
      start: startWith(child),
      tree: { platform: 'linux' },
    });
    vi.advanceTimersByTime(TIMEOUT_MS);
    child.emit('close', null, 'SIGTERM');

    await expect(pending).resolves.toMatchObject({ exitCode: null, errorCode: undefined, timedOut: true });
    expect(kill.mock.calls).toEqual([[-PID, 'SIGTERM'], [-PID, 'SIGKILL']]);
    vi.advanceTimersByTime(PROCESS_GROUP_GRACE_MS * 5);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('a CLI that cannot start answers with its error code and signals nothing', async () => {
    const kill = recordGroupSignals();
    const child = fakeProbe();
    child.pid = undefined;
    const pending = defaultRunProviderCommand('claude', [], TIMEOUT_MS, undefined, {
      start: startWith(child),
      tree: { platform: 'linux' },
    });
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    // Node follows a failed start with a `close` carrying the negative errno; it changes nothing.
    child.emit('close', -2, null);

    await expect(pending).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: null,
      errorCode: 'ENOENT',
      timedOut: false,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('output over 256 KiB stops the group with the maxBuffer code and keeps exactly 256 KiB', async () => {
    vi.useFakeTimers();
    const kill = recordGroupSignals();
    const child = fakeProbe();
    const pending = defaultRunProviderCommand('pi', ['--list-models'], TIMEOUT_MS, undefined, {
      start: startWith(child),
      tree: { platform: 'linux' },
    });
    child.stdout.emit('data', Buffer.alloc(200 * 1024, 'a'));
    expect(kill).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.alloc(100 * 1024, 'b'));
    expect(kill.mock.calls).toEqual([[-PID, 'SIGTERM']]);
    // More output while it stops is dropped, and the timeout no longer changes the reason.
    child.stdout.emit('data', Buffer.alloc(1024, 'c'));
    vi.advanceTimersByTime(TIMEOUT_MS);
    child.emit('close', null, 'SIGTERM');

    const result = await pending;
    expect(result).toMatchObject({
      exitCode: null,
      errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      timedOut: false,
    });
    expect(result.stdout).toBe('a'.repeat(200 * 1024) + 'b'.repeat(MAX_OUTPUT_BYTES - 200 * 1024));
  });

  it('Windows: the stop is the tree stop, never a group signal, and nothing is stopped after an exit', async () => {
    vi.useFakeTimers();
    const kill = recordGroupSignals();
    const tree = { platform: 'win32' as const, isOwnChild: () => false };

    const hung = fakeProbe();
    const hungPending = defaultRunProviderCommand('claude', [], TIMEOUT_MS, undefined, { start: startWith(hung), tree });
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(hung.kill.mock.calls).toEqual([['SIGTERM']]);
    // The kill ended it: its pid may now be anyone's, so neither the escalation nor the answer
    // stops anything more.
    hung.signalCode = 'SIGTERM';
    vi.advanceTimersByTime(2 * PROCESS_GROUP_GRACE_MS);
    await expect(hungPending).resolves.toMatchObject({ timedOut: true, exitCode: null });
    expect(hung.kill.mock.calls).toEqual([['SIGTERM']]);

    const done = fakeProbe();
    const donePending = defaultRunProviderCommand('claude', [], TIMEOUT_MS, undefined, { start: startWith(done), tree });
    done.exitCode = 0;
    done.emit('close', 0, null);
    await expect(donePending).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(done.kill).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('defaultRunProviderCommand with real processes (#894)', () => {
  const HOLDS_STDOUT = fileURLToPath(new URL('./__fixtures__/process/probe-grandchild-holds-stdout.mjs', import.meta.url));
  const LEAVES_MEMBER = fileURLToPath(new URL('./__fixtures__/process/probe-leaves-group-member.mjs', import.meta.url));
  /** Long enough for two cold Node starts in a row (the CLI, then its grandchild) and the pid file
   *  on a loaded 2-core runner: a grandchild started after the stop would escape it (T-08). */
  const PROBE_TIMEOUT_MS = 5_000;
  const SETTLE_SLACK_MS = 1_000;
  /** Windows stops the grandchild after the answer: one bounded PowerShell reads and kills. */
  const TREE_STOP_BOUND_MS = TREE_STOP_TIMEOUT_MS;
  /** The answer comes by the timeout plus two graces. On Windows, starting the tree stop's
   *  PowerShell can hold the event loop – and so every timer – for seconds (2.5 s measured cold),
   *  so there the bound also allows the tree stop's own; the fake-timer tests above pin the exact
   *  schedule on every OS. */
  const SETTLE_BOUND_MS = PROBE_TIMEOUT_MS + 2 * PROCESS_GROUP_GRACE_MS + SETTLE_SLACK_MS
    + (onWindows ? TREE_STOP_BOUND_MS : 0);

  let dir: string;
  /** Pid files the fixtures write and the test has not read yet, so a failing test still stops them. */
  const pidFiles = new Set<string>();
  /** The fixtures' processes, stopped after each test only while each pid is still theirs (T-04). */
  const owned = new OwnedPids();

  /** The pids a fixture wrote – all alive when it wrote the file – owned from now on. */
  function own<T extends Record<string, number>>(pidFile: string): T {
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as T;
    owned.add(Object.values(pids), statSync(pidFile).mtimeMs);
    pidFiles.delete(pidFile);
    return pids;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xez-provider-probe-'));
  });

  afterEach(async () => {
    for (const file of [...pidFiles]) if (existsSync(file)) own(file);
    pidFiles.clear();
    await owned.stopAll();
    await rm(dir, TEST_DIR_RM_OPTIONS);
  }, 30_000);

  it('a hung CLI whose background grandchild holds its stdout answers by the timeout plus two graces, and both are gone', async () => {
    const pidFile = join(dir, 'pids.json');
    pidFiles.add(pidFile);
    const started = Date.now();
    const result = await defaultRunProviderCommand(process.execPath, [HOLDS_STDOUT, pidFile], PROBE_TIMEOUT_MS);
    const elapsed = Date.now() - started;

    expect(result).toMatchObject({ exitCode: null, errorCode: undefined, timedOut: true });
    expect(elapsed).toBeLessThan(SETTLE_BOUND_MS);
    const pids = own<{ child: number; grandchild: number }>(pidFile);
    expect(result.stdout).toContain(`"grandchild":${pids.grandchild}`);
    await expect
      .poll(() => alive(pids.child) || alive(pids.grandchild), { timeout: TREE_STOP_BOUND_MS, interval: 100 })
      .toBe(false);
    owned.gone(pids.child, pids.grandchild);
  }, 40_000);

  // win32-skip(#975): the sign-in check runs in its own process group on POSIX only, and Windows has no
  // `kill(-pgid)` group to sweep; the Windows tree stop is pinned by the timeout case above
  it.skipIf(onWindows)('POSIX: a CLI that exits 0 leaves no member of its group behind', async () => {
    const pidFile = join(dir, 'pids.json');
    pidFiles.add(pidFile);
    const result = await defaultRunProviderCommand(process.execPath, [LEAVES_MEMBER, pidFile], 10_000);

    expect(result).toMatchObject({ exitCode: 0, errorCode: undefined, timedOut: false });
    const pids = own<{ child: number; member: number }>(pidFile);
    expect(result.stdout).toContain(`"member":${pids.member}`);
    await expect.poll(() => alive(pids.member), { timeout: 2_000, interval: 50 }).toBe(false);
    owned.gone(pids.child, pids.member); // the CLI's exit 0 above, and the poll
  }, 15_000);

  it('a CLI that is not installed answers ENOENT', async () => {
    await expect(defaultRunProviderCommand('xez-no-such-provider-cli-894', ['auth', 'status'], 5_000))
      .resolves.toMatchObject({ exitCode: null, errorCode: 'ENOENT', timedOut: false });
  }, 15_000);

  it('output over 256 KiB answers with the maxBuffer code', async () => {
    const result = await defaultRunProviderCommand(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.alloc(300 * 1024, 97)); setInterval(() => {}, 1_000);'],
      10_000,
    );
    expect(result).toMatchObject({ exitCode: null, errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', timedOut: false });
    expect(result.stdout).toHaveLength(256 * 1024);
  }, 15_000);
});
