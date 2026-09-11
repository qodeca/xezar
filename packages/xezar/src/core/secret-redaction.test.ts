import { describe, expect, it } from 'vitest';
import { collectSecretValues, redactDeep, redactSecrets, REDACTED } from './secret-redaction.ts';

/**
 * #427: credentials must never be persisted to a run's NDJSON transcript.
 * Value-based redaction scrubs the host's own secret env values; pattern-based
 * redaction catches well-known token shapes from anywhere.
 */
describe('collectSecretValues', () => {
  it('collects values of secret-named vars, skips short and non-secret names', () => {
    const values = collectSecretValues({
      GITHUB_TOKEN: 'gho_averylongtokenvalue',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIabcdefghij',
      PATH: '/usr/bin:/bin',
      SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1', // AUTH but allow-listed
      SHORT_TOKEN: 'abc', // too short
    });
    expect(values).toContain('gho_averylongtokenvalue');
    expect(values).toContain('wJalrXUtnFEMIabcdefghij');
    expect(values).not.toContain('/usr/bin:/bin');
    expect(values).not.toContain('/tmp/ssh-abc/agent.1');
    expect(values).not.toContain('abc');
  });

  /** #427 review: the shared SECRET_NAME_RE means a var stripped from the
   *  child env is also collected for redaction — the two used to diverge. */
  it('collects the name shapes agent-env strips, so the lists cannot drift', () => {
    const values = collectSecretValues({
      SIGNING_KEY: 'signingkeyvalue123',
      MY_KEY_MATERIAL: 'keymaterialvalue123',
      SESSION_SECRET: 'sessionsecretvalue123',
      COOKIE_SIGNING: 'cookiesigningvalue123',
    });
    expect(values).toEqual(
      expect.arrayContaining([
        'signingkeyvalue123',
        'keymaterialvalue123',
        'sessionsecretvalue123',
        'cookiesigningvalue123',
      ]),
    );
  });

  it('skips session/desktop bookkeeping whose value is a path, not a credential', () => {
    const values = collectSecretValues({
      SESSION_MANAGER: 'local/host:@/tmp/.ICE-unix/1234',
      XDG_SESSION_TYPE: 'wayland-session-type',
    });
    expect(values).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('scrubs concrete host secret values found in text', () => {
    const secrets = collectSecretValues({ GITHUB_TOKEN: 'gho_myrealsecrettoken1234' });
    const out = redactSecrets('run: gh auth uses gho_myrealsecrettoken1234 here', secrets);
    expect(out).not.toContain('gho_myrealsecrettoken1234');
    expect(out).toContain(REDACTED);
  });

  it('scrubs well-known token shapes even without knowing the env', () => {
    const line = [
      'gh: ghp_0123456789abcdefghijABCDEFGHIJ0123',
      'anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'aws: AKIAIOSFODNN7EXAMPLE',
      'google: AIzaSyA0123456789abcdefghijklmnopqrstuv',
    ].join('\n');
    const out = redactSecrets(line, []);
    expect(out).not.toMatch(/ghp_|sk-ant|AKIA|AIza/);
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))?.length).toBe(4);
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('the quick brown fox', [])).toBe('the quick brown fox');
  });

  /**
   * #427 review: the old 8-char floor mangled ordinary output — a dev box with
   * `POSTGRES_PASSWORD=postgres` turned `apt install postgresql-16` into
   * `apt install [REDACTED]ql-16`. Short dictionary words are not redactable.
   */
  it('does not redact short dictionary-word "secrets" out of ordinary output', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'postgres', DB_PASSWORD: 'root' });
    expect(secrets).toEqual([]);
    const line = 'apt install postgresql-16 && psql -U postgres -c "select 1"';
    expect(redactSecrets(line, secrets)).toBe(line);
  });

  it('still redacts a real credential value at the raised floor', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'S3cr3t-Pr0d-Passw0rd' });
    const out = redactSecrets('psql://app:S3cr3t-Pr0d-Passw0rd@db/prod', secrets);
    expect(out).not.toContain('S3cr3t-Pr0d-Passw0rd');
    expect(out).toContain(REDACTED);
  });
});

/**
 * #272: the shapes were matched case-sensitively, so a credential printed in another case passed
 * through. An AWS key id is upper-case letters and digits only, so its lower-cased copy IS the key
 * id. Every value below is a fake of the right shape.
 */
describe('redactSecrets is not defeated by case (#272)', () => {
  it('redacts an AWS access key id in lower and mixed case', () => {
    const line = 'id=akiafakefakefake0000 temp=asiafakefakefake0000 mixed="AkiaFakeFakeFake0000"';
    expect(redactSecrets(line, [])).toBe(`id=${REDACTED} temp=${REDACTED} mixed="${REDACTED}"`);
  });

  it('redacts the shapes whose prefix is not ordinary text in any case', () => {
    const shapes = [
      'GHP_FAKEFAKEFAKEFAKEFAKEFAKE0000', // GitHub PAT, upper-cased
      'aizafakefakefakefakefakefakefakefake000', // Google API key, lower-cased
      'YA29.FAKE-FAKE-FAKE', // Google OAuth token, upper-cased
      'XOXB-0000000000-FAKEFAKEFAKE', // Slack, upper-cased
      'GLPAT-FAKEFAKEFAKEFAKEFAKE', // GitLab, upper-cased
    ];
    for (const shape of shapes) expect(redactSecrets(`value: ${shape}`, [])).toBe(`value: ${REDACTED}`);
  });

  it('redacts a known secret value printed in another case', () => {
    const secrets = collectSecretValues({ SERVICE_API_TOKEN: 'deadbeefcafe0000feedface1234' });
    expect(redactSecrets('token DEADBEEFCAFE0000FEEDFACE1234 ok', secrets)).toBe(`token ${REDACTED} ok`);
  });

  it('redacts a known secret value in its URL-encoded form', () => {
    const secrets = collectSecretValues({ DB_PASSWORD: 'Fake/P@ss+word-2026' });
    const out = redactSecrets('postgres://app:Fake%2FP%40ss%2Bword-2026@db/prod and fake%2fp%40ss%2bword-2026', secrets);
    expect(out).toBe(`postgres://app:${REDACTED}@db/prod and ${REDACTED}`);
  });

  // Guards — these pass before and after the fix. They pin what the fix must NOT change.
  it('leaves text alone that only resembles a shape case-insensitively', () => {
    const line = [
      'branch TASK-1234-FIX-LOGIN-REDIRECT-HANDLER', // `sk-` stays case-sensitive
      'GITHUB_PAT_READONLY_ORG_ACCESS_FOR_CI=unset', // an env var NAME, not a fine-grained PAT
      'asiaPacificRegionConfig and akiaFeatureFlagEnabledForAll', // identifiers, not key ids
      'Slovakia, Asia and akia',
    ].join('\n');
    expect(redactSecrets(line, [])).toBe(line);
  });

  it('is not defeated by surrounding whitespace or a wrapping quote', () => {
    for (const wrapped of ['  AKIAFAKEFAKEFAKE0000  ', '"AKIAFAKEFAKEFAKE0000"', "'AKIAFAKEFAKEFAKE0000'"]) {
      expect(redactSecrets(wrapped, [])).not.toContain('FAKEFAKEFAKE0000');
    }
  });

  it('throws on a non-string rather than passing it through', () => {
    expect(() => redactSecrets(42 as unknown as string, [])).toThrow(TypeError);
    expect(() => redactSecrets(null as unknown as string, ['deadbeefcafe0000feedface1234'])).toThrow(TypeError);
  });
});

describe('redactDeep', () => {
  it('scrubs string leaves in nested event structures', () => {
    const event = {
      type: 'tool-result',
      result: 'export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ0123',
      item: { output: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', nested: [{ text: 'safe' }] },
      seq: 3,
    };
    const out = redactDeep(event, []);
    expect(out.result).not.toContain('ghp_');
    expect((out.item as { output: string }).output).not.toContain('sk-ant');
    expect(out.seq).toBe(3); // non-strings preserved
    expect((out.item as { nested: Array<{ text: string }> }).nested[0]?.text).toBe('safe');
  });
});
