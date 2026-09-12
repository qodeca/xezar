import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAccountIdentity } from './account-identity.ts';

/**
 * Reading who an agent account is signed in as (spec 2026-07-29-agent-profiles, "Show details").
 *
 * The assertion that matters most is the last one in each provider block: `~/.codex/auth.json`
 * holds `OPENAI_API_KEY`, `access_token` and `refresh_token` beside the identity claims, and
 * `.claude.json` holds far more than `oauthAccount`. Nothing may pass through.
 */
describe('readAccountIdentity', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-identity-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** An account dir whose `.claude.json` lives INSIDE it, as an overridden config dir does. */
  const claudeAccount = (state: unknown): string => {
    const dir = join(home, 'claude-klaudiusz');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(state), 'utf8');
    return dir;
  };

  const jwt = (claims: unknown): string =>
    ['e30', Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url'), 'sig'].join('.');

  const codexAccount = (auth: unknown): string => {
    const dir = join(home, 'codex-klaudiusz');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth), 'utf8');
    return dir;
  };

  describe('claude', () => {
    it('reads the identity out of the account\'s OWN .claude.json', async () => {
      const dir = claudeAccount({
        oauthAccount: {
          emailAddress: 'me@example.com',
          displayName: 'Me',
          organizationName: "Me's Organization",
          organizationRole: 'admin',
          seatTier: 'max',
        },
      });
      const identity = await readAccountIdentity('claude', dir);
      expect(identity.available).toBe(true);
      expect(identity.fields).toEqual([
        { label: 'Email', value: 'me@example.com' },
        { label: 'Name', value: 'Me' },
        { label: 'Organization', value: "Me's Organization" },
        { label: 'Role', value: 'admin' },
        { label: 'Seat', value: 'max' },
      ]);
    });

    it('omits a row the vendor left blank rather than rendering an empty one', async () => {
      const dir = claudeAccount({ oauthAccount: { emailAddress: 'me@example.com', displayName: '  ' } });
      const identity = await readAccountIdentity('claude', dir);
      expect(identity.fields.map((f) => f.label)).toEqual(['Email']);
    });

    it('says "not signed in" for a folder with no state file, and for one with no account', async () => {
      expect(await readAccountIdentity('claude', join(home, 'nope'))).toMatchObject({
        available: false,
        fields: [],
      });
      const dir = claudeAccount({ projects: {} });
      expect((await readAccountIdentity('claude', dir)).available).toBe(false);
      expect((await readAccountIdentity('claude', dir)).reason).toContain('Not signed in');
    });

    it('passes NOTHING through — only the named identity fields', async () => {
      const dir = claudeAccount({
        oauthAccount: {
          emailAddress: 'me@example.com',
          accountUuid: 'uuid-should-not-surface',
          organizationUuid: 'org-uuid-should-not-surface',
        },
        // Everything else in the file, including anything credential-shaped.
        primaryApiKey: 'sk-should-not-surface',
        oauthToken: 'token-should-not-surface',
      });
      const identity = await readAccountIdentity('claude', dir);
      const rendered = JSON.stringify(identity);
      expect(rendered).toContain('me@example.com');
      for (const secret of ['sk-should-not-surface', 'token-should-not-surface', 'uuid-should-not-surface', 'org-uuid-should-not-surface']) {
        expect(rendered, secret).not.toContain(secret);
      }
    });
  });

  describe('codex', () => {
    it('reads the identity out of the id_token claims', async () => {
      const dir = codexAccount({
        tokens: {
          id_token: jwt({
            email: 'me@example.com',
            name: 'Me',
            'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
          }),
        },
      });
      const identity = await readAccountIdentity('codex', dir);
      expect(identity.available).toBe(true);
      expect(identity.fields).toEqual([
        { label: 'Email', value: 'me@example.com' },
        { label: 'Name', value: 'Me' },
        { label: 'Plan', value: 'pro' },
      ]);
    });

    it('names an API-key login instead of calling it "not signed in"', async () => {
      const dir = codexAccount({ OPENAI_API_KEY: 'sk-live-key', tokens: {} });
      expect(await readAccountIdentity('codex', dir)).toEqual({
        available: true,
        fields: [{ label: 'Login', value: 'API key' }],
      });
    });

    it('degrades on a token that is not a readable JWT', async () => {
      const dir = codexAccount({ tokens: { id_token: 'not-a-jwt' } });
      expect((await readAccountIdentity('codex', dir)).available).toBe(false);
    });

    it('never surfaces the credentials sitting in the same file', async () => {
      const dir = codexAccount({
        OPENAI_API_KEY: 'sk-should-not-surface',
        tokens: {
          access_token: 'access-should-not-surface',
          refresh_token: 'refresh-should-not-surface',
          account_id: 'acct-should-not-surface',
          id_token: jwt({ email: 'me@example.com', sub: 'sub-should-not-surface' }),
        },
      });
      const rendered = JSON.stringify(await readAccountIdentity('codex', dir));
      expect(rendered).toContain('me@example.com');
      for (const secret of [
        'sk-should-not-surface',
        'access-should-not-surface',
        'refresh-should-not-surface',
        'acct-should-not-surface',
        'sub-should-not-surface',
      ]) {
        expect(rendered, secret).not.toContain(secret);
      }
    });
  });

  describe('pi', () => {
    const piAccount = (auth: unknown): string => {
      const dir = join(home, 'pi-klaudiusz');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth), 'utf8');
      return dir;
    };

    /**
     * The finding this block exists for: before #329's follow-up, `readAccountIdentity` fell
     * through to OpenCode's refusal for every provider it did not name, so a pi account's
     * "Show details" answered with a sentence about OpenCode — a different product, and false of
     * pi, whose `auth.json` really is inside the config folder.
     */
    it('answers in pi\'s own words, never OpenCode\'s', async () => {
      const identity = await readAccountIdentity('pi', join(home, 'nope'));
      expect(identity.available).toBe(false);
      expect(identity.reason).not.toContain('OpenCode');
      expect(identity.reason).toContain('Not signed in');
    });

    it('names which model providers this account is signed in to, and how', async () => {
      const dir = piAccount({
        openai: { type: 'api_key', key: 'sk-should-not-surface' },
        anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      });
      expect(await readAccountIdentity('pi', dir)).toEqual({
        available: true,
        fields: [{ label: 'Signed in to', value: 'anthropic (OAuth), openai (API key)' }],
      });
    });

    it('reads a fresh pi\'s empty auth.json as "not signed in", not as a broken file', async () => {
      // What pi 0.85.1 actually writes before any login — observed on a real run (#329).
      const identity = await readAccountIdentity('pi', piAccount({}));
      expect(identity.available).toBe(false);
      expect(identity.reason).toContain('Not signed in');
    });

    it('never surfaces the credentials sitting in the same file', async () => {
      const dir = piAccount({
        openai: { type: 'api_key', key: 'sk-should-not-surface', env: { X: 'env-should-not-surface' } },
        anthropic: {
          type: 'oauth',
          refresh: 'refresh-should-not-surface',
          access: 'access-should-not-surface',
          expires: 1,
        },
      });
      const rendered = JSON.stringify(await readAccountIdentity('pi', dir));
      expect(rendered).toContain('anthropic');
      for (const secret of [
        'sk-should-not-surface',
        'env-should-not-surface',
        'refresh-should-not-surface',
        'access-should-not-surface',
      ]) {
        expect(rendered, secret).not.toContain(secret);
      }
    });
  });

  it('says OpenCode cannot be read, because its login is not in the config folder', async () => {
    const identity = await readAccountIdentity('opencode', home);
    expect(identity.available).toBe(false);
    expect(identity.reason).toContain('outside its config folder');
  });
});
