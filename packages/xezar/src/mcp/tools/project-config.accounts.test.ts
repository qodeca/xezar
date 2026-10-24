// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './mcp-test-home.testkit.ts';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../../core/provider-auth.ts';
import { createApp } from '../../server/server.ts';
import { projectStateLayout, setActiveStateLayout } from '../../state-layout.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { REFUSED_ACTIONS, accountsAnswer } from './project-config.ts';
import {
  useProjectConfigWorkspace,
  COCKPIT_HOST,
  EMAIL_CLAUDE,
  EMAIL_LABEL,
  ORG,
  PLAN_CODEX,
  USER_MARKER,
  IDENTITY_MARKERS,
  EMAIL_RE,
  USER_SCOPE_IDS,
  PROJECT_SCOPE_IDS,
  makeDir,
  ws,
  cockpit,
  spyService,
  invoke,
  value,
  hotCockpit,
} from './project-config.testkit.ts';

/**
 * Project configuration tools (#97): the agent accounts (#677 B5), the account reads and import
 * (#819), and the sweep that nothing identifies an account or leaks a secret.
 * The fixture — a real app over a real two-project registry in a sandboxed `XEZ_HOME`, with agent
 * homes seeded with an account identity — and its helpers live in `project-config.testkit.ts`.
 */

useProjectConfigWorkspace();

// ---- the agent accounts --------------------------------------------------------------------------

/**
 * #677 wave 2 slice B5 — the four account writes, the account probe and the identity read.
 *
 * The owner's decision of 2026-09-20 07:41 — accounts are "**Writes and identity read**" — reverses
 * D-03's account rows AND, for `get_account_details`, deletes a negative requirement: F-03 and N-01
 * said account identity is never served to a leader, and this programme recommended keeping it
 * refused (spec § 4 Q3). The owner decided otherwise, so the pins below are the NEW contract rather
 * than a deletion of the old ones: identity is served by `get_account_details` and by nothing else.
 *
 * The division of labour is B1–B4's: the DOOR decides the key set and narrows the answer, the ROUTE
 * decides everything else — its validators, its duplicate-folder 409, its 404, its atomic write of
 * `~/.xezar/agent-accounts.json`, its reference scrub on delete, and each handler's own hosted-mode
 * `capabilities().localHandoff` refusal.
 */
describe('project_config: the agent accounts (#677 B5)', () => {
  const accountsFile = (): string => join(process.env.XEZ_HOME!, 'agent-accounts.json');
  const accountDirs: string[] = [];
  /** A folder to point an account at. Absolute, unique, and never an existing account's. */
  const accountDir = (name: string): string => {
    const dir = join(ws.home, 'accounts', name);
    accountDirs.push(dir);
    return dir;
  };

  /** A request against a cockpit other than the fixture's own. */
  async function via(app: ReturnType<typeof createApp>, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
    const res = await app.request(path, {
      method,
      headers: {
        host: COCKPIT_HOST,
        origin: `http://${COCKPIT_HOST}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }

  /** Whatever this case registered, removed again — the next case starts from the fixture's state. */
  afterEach(async () => {
    const listing = (await cockpit('/api/v1/workspace/agent-profiles')).body;
    for (const row of listing.profiles as Array<{ id: string; isDefault: boolean }>) {
      if (!row.isDefault) await cockpit(`/api/v1/workspace/agent-profiles/${row.id}`, 'DELETE');
    }
  });

  it('adds an account through the cockpit’s own route, once, and answers a narrowed row', async () => {
    const dir = accountDir('second-claude');
    const spy = spyService();
    const called = await invoke({ action: 'create_account', account: { provider: 'claude', label: 'Second Claude', configDir: dir } }, { service: spy });
    const account = value(called).account;
    expect(spy.requests, 'the cockpit’s own route, once, and nothing else').toEqual(['POST /api/v1/workspace/agent-profiles']);
    expect(account).toMatchObject({ provider: 'claude', label: 'Second Claude', configDir: dir, isDefault: false });
    // THE NARROWING (named break `BREAK-B5-ROW-WIDE`). The route's `profile` carries the EXPANDED
    // absolute home and every config path inside it. Return it unchanged and this goes red.
    expect(account).not.toHaveProperty('path');
    expect(account).not.toHaveProperty('files');
    expect(account).not.toHaveProperty('status');
    // It really is the machine-wide accounts file — the exposure the owner accepted.
    expect(JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts).toContainEqual(expect.objectContaining({ configDir: dir }));
    // And the person's pane sees it, through the route it reads.
    const pane = (await cockpit('/api/v1/workspace/agent-profiles')).body;
    expect(pane.profiles.find((row: { id: string }) => row.id === account.id)).toMatchObject({ configDir: dir, path: dir });
  });

  it('carries the route’s own duplicate-folder 409 and its 404, in the route’s own words', async () => {
    const dir = accountDir('shared-folder');
    const first = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: dir } }));
    // The same folder twice would be two accounts silently sharing one session store; the ROUTE
    // refuses it, compared through `realpath`, and this door neither repeats nor softens that.
    const viaUi = await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: dir });
    expect(viaUi.status).toBe(409);
    const duplicate = await invoke({ action: 'create_account', account: { provider: 'claude', configDir: dir } });
    expect(duplicate.result.isError).toBe(true);
    expect(duplicate.structured.status, 'the route’s own 409').toBe(409);
    expect(duplicate.text, 'the route’s own reason').toContain(viaUi.body.error);
    // A well-formed but unknown id is the route's 404, and nothing is rewritten.
    const before = readFileSync(accountsFile(), 'utf8');
    const unknown = await invoke({ action: 'update_account', accountId: 'no-such-account', accountUpdate: { label: 'x' } });
    expect(unknown.structured.status).toBe(404);
    expect(readFileSync(accountsFile(), 'utf8')).toBe(before);
    expect(first.account.id).toBeTruthy();
  });

  it('scrubs identity-looking quoted runs only for account actions', async () => {
    const rejecting = (error: string): ServiceDispatch => ({
      request: () => Promise.resolve(new Response(JSON.stringify({ error }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })),
    });

    const workflow = await invoke({ action: 'list_workflows' }, { service: rejecting('unknown workflow "deploy@prod"') });
    expect(workflow.structured.error).toBe('unknown workflow "deploy@prod"');
    expect(workflow.text).not.toContain('label that looks like an identity');

    const account = await invoke(
      { action: 'create_account', account: { provider: 'claude', configDir: accountDir('rejected') } },
      { service: rejecting('step "build" failed for "boss@corp"') },
    );
    expect(account.structured.error).toBe('step "build" failed for (a label that looks like an identity, withheld)');
    expect(account.json).not.toContain('boss@corp');
  });

  /**
   * THE IDENTITY IN AN ERROR (named breaks `BREAK-B5-IDENTITY-IN-ERROR` and
   * `BREAK-677-IDENTITY-TWO-DEFS`; #764 review, Major 1 and re-check N1).
   *
   * The case above pins that the route's own 409 reaches the leader unsoftened. This one pins the
   * one word of it that must not: the 409 names the CONFLICTING account by its label, and a person
   * who labelled their own account with their email in the cockpit put an identity into a sentence
   * this door forwards. Every successful answer withholds exactly that label; the error path had
   * no such rule, and before this slice no leader call could reach that 409 at all.
   *
   * Drop `scrubIdentity` from `failed()` and this goes red on the first assertion.
   */
  it('withholds an identity-looking label from the route’s own refusal, keeping the rest of its words', async () => {
    const dir = accountDir('identity-labelled-folder');
    // The PERSON's own account, labelled with their email in the cockpit — not the leader's doing.
    const person = await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: dir, label: EMAIL_LABEL });
    expect(person.status).toBeLessThan(300);
    // The cockpit's own 409 is untouched: the person who typed the label is who it is for.
    const viaUi = await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: dir });
    expect(viaUi.status).toBe(409);
    expect(viaUi.body.error, 'the route really does quote the label back').toContain(EMAIL_LABEL);

    const duplicate = await invoke({ action: 'create_account', account: { provider: 'claude', configDir: dir } });
    expect(duplicate.json, 'the leader’s answer carries no identity').not.toContain(EMAIL_LABEL);
    expect(duplicate.json, 'nor any other email-shaped text').not.toMatch(EMAIL_RE);
    // Everything else the route said is still there: the status, and the sentence around the word.
    expect(duplicate.structured.status, 'the route’s own 409').toBe(409);
    expect(duplicate.text).toContain('that folder is already used by');
    expect(duplicate.text).toContain('withheld');
    // The same 409 through `update_account`, which repoints a folder onto an existing one.
    const other = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: accountDir('repointed') } })).account;
    const repointed = await invoke({ action: 'update_account', accountId: other.id, accountUpdate: { configDir: dir } });
    expect(repointed.structured.status).toBe(409);
    expect(repointed.json).not.toContain(EMAIL_LABEL);
    expect(repointed.json).not.toMatch(EMAIL_RE);

    // The success and 409 paths deliberately share `looksLikeIdentity`. Restore the old dotted-
    // domain-only error regex and these two cases disclose the exact label in the refusal.
    for (const [index, label] of ['boss@corp', '@marcin'].entries()) {
      const shortDir = accountDir(`short-identity-${index}`);
      expect((await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: shortDir, label })).status).toBe(201);
      const refused = await invoke({ action: 'create_account', account: { provider: 'claude', configDir: shortDir } });
      expect(refused.structured.status).toBe(409);
      expect(refused.json, label).not.toContain(label);
      expect(refused.text, label).toContain('withheld');
    }
  });

  /**
   * `BREAK-677-ID-FROM-EMAIL`: restore `allocateAgentProfileId(label ?? configDir, …)` in the
   * account route and this returns `someone-private-example-invalid`, leaking the supplied email
   * as both the create answer's id and the selected account's handle.
   */
  it('BREAK-677-FOLDER-IDENTITY: allocates a new identity-shaped account id from an opaque source', async () => {
    const label = 'someone.private@example.invalid';
    // Both resolved sources are identity-shaped; either one independently requires an opaque id.
    const dir = accountDir('folder@example.invalid');
    const created = value(await invoke({ action: 'create_account', account: { provider: 'claude', label, configDir: dir } })).account;
    expect(created.id).not.toContain('someone-private-example-invalid');
    expect(created.id).not.toContain('someone');
    expect(created.id).not.toContain('folder-example-invalid');
    expect(created.id).toMatch(/^account-[a-f0-9]{8}$/);
    expect(created).not.toHaveProperty('label');

    const stored = JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts.find((row: { id: string }) => row.id === created.id);
    expect(stored).toMatchObject({ id: created.id, label, configDir: dir });
    value(await invoke({ action: 'select_account', provider: 'claude', accountId: created.id }));
    const effective = value(await invoke({ action: 'get_account' })).accounts.find((row: { provider: string }) => row.provider === 'claude');
    expect(effective.handle).toBe(created.id);
    expect(JSON.stringify(effective)).not.toContain('someone-private-example-invalid');

    // E1 / `BREAK-677-FOLDER-IDENTITY`: with no label, allocation resolves from the folder
    // basename. It must become opaque before slugging removes the `@` that marks it as identity.
    const folderOnlyDir = accountDir('boss@corp.example.invalid');
    const folderOnly = value(await invoke({
      action: 'create_account',
      account: { provider: 'claude', configDir: folderOnlyDir },
    })).account;
    expect(folderOnly.id).toMatch(/^account-[a-f0-9]{8}$/);
    expect(folderOnly.id).not.toContain('boss-corp-example-invalid');
    const folderOnlyStored = JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts.find(
      (row: { id: string }) => row.id === folderOnly.id,
    );
    expect(folderOnlyStored).toMatchObject({ id: folderOnly.id, label: folderOnly.id, configDir: folderOnlyDir });
    const folderOnlyDuplicate = await invoke({
      action: 'create_account',
      account: { provider: 'claude', configDir: folderOnlyDir },
    });
    expect(folderOnlyDuplicate.structured.status).toBe(409);
    expect(folderOnlyDuplicate.text).toContain('that folder is already used by');
    expect(folderOnlyDuplicate.json).not.toContain('boss-corp-example-invalid');
    value(await invoke({ action: 'select_account', provider: 'claude', accountId: folderOnly.id }));
    const folderOnlyEffective = value(await invoke({ action: 'get_account' })).accounts.find(
      (row: { provider: string }) => row.provider === 'claude',
    );
    expect(folderOnlyEffective).toEqual({ provider: 'claude', handle: folderOnly.id, label: folderOnly.id, builtIn: false });
    expect(JSON.stringify(folderOnlyEffective)).not.toContain('boss-corp-example-invalid');
  });

  it('edits and removes one, and the route’s own reference scrub goes with the removal', async () => {
    const dir = accountDir('renamed');
    const created = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: dir } })).account;
    value(await invoke({ action: 'select_account', provider: 'claude', accountId: created.id }));

    const spy = spyService();
    const edited = value(await invoke({ action: 'update_account', accountId: created.id, accountUpdate: { label: 'Renamed' } }, { service: spy }));
    expect(spy.requests).toEqual([`PATCH /api/v1/workspace/agent-profiles/${created.id}`]);
    expect(edited.account).toMatchObject({ id: created.id, label: 'Renamed' });
    // THE ECHO RULE (named break `BREAK-B5-ROW-ECHOES-STORED-DIR`; #764 review, Minor 2, leader
    // adjudication). `configDir` is here because the call sent it, never because the account has
    // one: a rename that answered the stored folder would hand back an absolute host path the
    // leader never sent. Answer `profile.configDir` unconditionally and this goes red.
    expect(edited.account, 'a rename sent no folder, so none comes back').not.toHaveProperty('configDir');
    expect(JSON.stringify(edited)).not.toContain(dir);
    // An update that DOES repoint the folder echoes it, exactly as `create_account` does.
    const moved = accountDir('moved');
    const repointed = value(await invoke({ action: 'update_account', accountId: created.id, accountUpdate: { configDir: moved } }));
    expect(repointed.account).toMatchObject({ id: created.id, configDir: moved });

    const removed = value(await invoke({ action: 'remove_account', accountId: created.id }));
    expect(removed).toEqual({ removed: true, id: created.id });
    const store = JSON.parse(readFileSync(accountsFile(), 'utf8'));
    expect(store.accounts.map((row: { id: string }) => row.id)).not.toContain(created.id);
    // The selection that named it went in the SAME write — the route's atomic scrub, inherited.
    expect(store.selections?.[ws.roots.a]?.claude).toBeUndefined();
    // The folder itself is never touched: deregistration only.
    expect(existsSync(dir)).toBe(false);
  });

  /**
   * THE NARROWING ON THE SELECTION (named break `BREAK-B5-SELECTIONS-WIDE`), and the one place
   * this slice narrows rather than inherits. The route answers `selections` keyed by every repo
   * ROOT on the machine and takes a `projectId` whose `null` writes the MACHINE-WIDE default; a
   * leader has no project id argument at all, so the bound project's is supplied and only its own
   * selection comes back. Answer the route's body unnarrowed and the leader learns where the
   * person's other checkouts are.
   */
  it('points THIS project at an account, and never another project or the machine-wide default', async () => {
    const dir = accountDir('for-project-a');
    const created = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: dir } })).account;
    // B chose this account too, in the cockpit — so the route's own answer has two roots in it.
    expect((await cockpit('/api/v1/workspace/agent-profiles/selection', 'PUT', { projectId: 'proj-b', provider: 'claude', profileId: created.id })).status).toBe(200);

    const spy = spyService();
    const selected = value(await invoke({ action: 'select_account', provider: 'claude', accountId: created.id }, { service: spy }));
    expect(spy.requests).toEqual(['PUT /api/v1/workspace/agent-profiles/selection']);
    expect(selected).toEqual({ selection: { provider: 'claude', accountId: created.id } });
    expect(JSON.stringify(selected)).not.toContain(ws.roots.b);

    // Both doors wrote the same file, each for its own project.
    const store = JSON.parse(readFileSync(accountsFile(), 'utf8'));
    expect(store.selections[ws.roots.a].claude).toBe(created.id);
    expect(store.selections[ws.roots.b].claude).toBe(created.id);
    // `get_account` reads the leader's own choice back.
    expect(value(await invoke({ action: 'get_account' })).accounts).toContainEqual(expect.objectContaining({ provider: 'claude', handle: created.id }));

    // `null` puts this project back on the discovered account — stored as absence — and leaves B's
    // choice and the machine-wide default alone.
    const cleared = value(await invoke({ action: 'select_account', provider: 'claude', accountId: null }));
    expect(cleared).toEqual({ selection: { provider: 'claude', accountId: 'default' } });
    const after = JSON.parse(readFileSync(accountsFile(), 'utf8'));
    expect(after.selections[ws.roots.a]?.claude).toBeUndefined();
    expect(after.selections[ws.roots.b].claude).toBe(created.id);
    expect(after.defaults?.claude, 'the machine-wide default is not this door’s to write').toBeUndefined();
  });

  it('probes one account’s sign-in state and narrows it the way get_capabilities narrows a provider row', async () => {
    const spy = spyService();
    const called = value(await invoke({ action: 'check_account_status', provider: 'claude', accountId: 'default' }, { service: spy }));
    // The route id is built with the CONTRACT's own encoder — a discovered account is addressed
    // as `default:<provider>`, which is never spelled at this door — and nothing is looked up
    // first: one request, and the route's own 404 is what answers an id no account carries.
    expect(spy.requests).toEqual(['GET /api/v1/workspace/agent-profiles/default:claude/status']);
    expect(called).toMatchObject({ account: { provider: 'claude', accountId: 'default' } });
    expect(typeof called.status).toBe('string');
    // F-03 for an account row exactly as for a provider row.
    expect(JSON.stringify(called)).not.toMatch(/authFailureId|profileId/);
    // An account id becomes a URL PATH SEGMENT, so it is checked the way every other id that does
    // is (`validPathId`): the typed client substitutes `:id` literally, and a `../` would address
    // a different route entirely. Refused as an argument, nothing dispatched.
    for (const action of ['check_account_status', 'get_account_details', 'update_account', 'remove_account']) {
      const traversal = spyService();
      const reads = action === 'check_account_status' || action === 'get_account_details';
      const called = await invoke(
        {
          action,
          accountId: '../../runs',
          ...(reads ? { provider: 'claude' } : {}),
          ...(action === 'update_account' ? { accountUpdate: { label: 'x' } } : {}),
        },
        { service: traversal },
      );
      expect(called.result.isError, action).toBe(true);
      expect(called.text, action).toContain('not an account id');
      expect(traversal.requests, action).toEqual([]);
    }
    // An id no account carries is the ROUTE's own 404, carried through unrewritten.
    const unknown = await invoke({ action: 'check_account_status', provider: 'codex', accountId: 'not-an-account' });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.structured.status).toBe(404);
    expect(unknown.text).toContain((await cockpit('/api/v1/workspace/agent-profiles/not-an-account/status')).body.error);
  });

  /**
   * THE PROVIDER IN THE ANSWER IS THE ACCOUNT'S (named break `BREAK-B5-STATUS-ECHOES-CALLER`;
   * #764 review, Nit 6). A stored account is addressed by its ID alone, so a call naming the wrong
   * backend used to probe the right account and label the answer with the caller's word. Echo
   * `args.provider` back and the refusal below stops happening.
   */
  it('answers about the account the id names, and refuses a call that claims the wrong backend', async () => {
    const created = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: accountDir('whose-backend') } })).account;
    const right = value(await invoke({ action: 'check_account_status', provider: 'claude', accountId: created.id }));
    expect(right.account).toEqual({ provider: 'claude', accountId: created.id });

    const wrong = await invoke({ action: 'check_account_status', provider: 'codex', accountId: created.id });
    expect(wrong.text, 'it never answers `codex` for a Claude account').not.toContain('"provider": "codex"');
    expect(wrong.result.isError).toBe(true);
    expect(wrong.text).toContain('is a claude account, not a codex one');
  });

  it('keeps the claimed provider when the stored-account listing fails open', async () => {
    const created = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: accountDir('listing-fails') } })).account;
    const service: ServiceDispatch = {
      request(url, init) {
        const path = new URL(typeof url === 'string' ? url : String(url)).pathname;
        if (path.endsWith('/workspace/agent-profiles')) return Promise.resolve(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
        return ws.app.request(url, init);
      },
    };
    const called = value(await invoke({ action: 'check_account_status', provider: 'codex', accountId: created.id }, { service }));
    expect(called.account).toEqual({ provider: 'codex', accountId: created.id });
  });

  it('keeps the claimed provider when the stored-account listing has no matching row', async () => {
    const created = value(await invoke({ action: 'create_account', account: { provider: 'claude', configDir: accountDir('listing-misses') } })).account;
    const service: ServiceDispatch = {
      request(url, init) {
        const path = new URL(typeof url === 'string' ? url : String(url)).pathname;
        if (path.endsWith('/workspace/agent-profiles')) {
          return Promise.resolve(new Response(JSON.stringify({ editable: true, profiles: [], profileCapableProviders: [], selections: {}, defaults: {} }), { status: 200 }));
        }
        return ws.app.request(url, init);
      },
    };
    const called = value(await invoke({ action: 'check_account_status', provider: 'codex', accountId: created.id }, { service }));
    expect(called.account).toEqual({ provider: 'codex', accountId: created.id });
  });

  /**
   * THE IDENTITY READ, AND THE NEGATIVE REQUIREMENT IT REPLACES.
   *
   * Until #677 B5 this suite pinned the opposite: `get_account_details` was refused and no answer
   * of this tool carried an email, an organisation or a plan (F-03, F-12, N-01). The owner's
   * decision of 2026-09-20 07:41 — "Writes and identity read" — reverses that for ONE action, so
   * the pin is rewritten rather than removed: the identity is served HERE, from the cockpit's own
   * route, and the negative half still holds everywhere else.
   */
  it('serves the account identity the cockpit serves — and no other action carries one', async () => {
    const spy = spyService();
    const called = value(await invoke({ action: 'get_account_details', provider: 'claude', accountId: 'default' }, { service: spy }));
    expect(spy.requests).toEqual(['GET /api/v1/workspace/agent-profiles/default:claude/details']);
    // Exactly the cockpit's own answer, byte for byte: no join, no second source, nothing added.
    const pane = await cockpit('/api/v1/workspace/agent-profiles/default:claude/details');
    expect(called).toEqual(pane.body);
    // And it really is the identity — a case that asserted nothing would pass against a blank one.
    expect(JSON.stringify(called)).toContain(EMAIL_CLAUDE);
    expect(JSON.stringify(called)).toContain(ORG);

    // THE HALF THAT DID NOT CHANGE. Identity reaches no other answer of this tool: a label that
    // looks like an email is withheld from the listing AND from the row a write echoes back.
    const dir = accountDir('identity-label');
    const created = value(await invoke({ action: 'create_account', account: { provider: 'codex', label: EMAIL_LABEL, configDir: dir } })).account;
    expect(created).not.toHaveProperty('label');
    expect(JSON.stringify(created)).not.toMatch(EMAIL_RE);
    value(await invoke({ action: 'select_account', provider: 'codex', accountId: created.id }));
    for (const args of [
      { action: 'get_account' },
      { action: 'get_capabilities' },
      { action: 'check_account_status', provider: 'codex' as const, accountId: created.id },
    ]) {
      const other = await invoke(args);
      for (const marker of IDENTITY_MARKERS) expect(other.json, JSON.stringify(args)).not.toContain(marker);
    }
  });

  it('needs an operation key for every write, refuses one for every read, and takes no argument another action owns', async () => {
    const dir = accountDir('argument-rules');
    for (const args of [
      { action: 'create_account', account: { provider: 'claude', configDir: dir } },
      { action: 'update_account', accountId: 'a', accountUpdate: { label: 'x' } },
      { action: 'remove_account', accountId: 'a' },
      { action: 'select_account', provider: 'claude', accountId: null },
    ]) {
      const called = await invoke({ ...args, operationId: undefined });
      expect(called.result.isError, JSON.stringify(args)).toBe(true);
      expect(called.text, JSON.stringify(args)).toMatch(new RegExp(`${args.action} needs operationId`));
    }
    // The two READS refuse a key rather than accepting one: a receipt over a read would answer the
    // next identical read with the receipt instead of the answer (D-06 § 5.2).
    for (const action of ['check_account_status', 'get_account_details']) {
      const called = await invoke({ action, provider: 'claude', accountId: 'default', operationId: 'op-read-0001' });
      expect(called.result.isError, action).toBe(true);
      expect(called.text, action).toMatch(/operationId is not used by/);
    }
    // No cross-talk between the account arguments themselves.
    const mixed = await invoke({ action: 'remove_account', accountId: 'a', accountUpdate: { label: 'x' } });
    expect(mixed.text).toMatch(/accountUpdate is not used by remove_account/);
    const half = await invoke({ action: 'create_account' });
    expect(half.text).toMatch(/create_account needs account/);
    // And no project id argument, on any of them: the project is the connection's.
    const named = await invoke({ action: 'select_account', provider: 'claude', accountId: null, projectId: 'proj-b' });
    expect(named.result.isError).toBe(true);
  });

  /**
   * HOSTED MODE REFUSES ALL OF IT, THROUGH EITHER DOOR (named break `BREAK-B5-HOSTED-WRITE`).
   *
   * Unlike the settings and preference writes, which the owner permits in hosted mode, every
   * mutating verb of the accounts family refuses, and so does each of its two GETs. That is the
   * mitigation the spec's § 3 names for `configDir`: a hosted server cannot be talked into
   * choosing which file tree runs code on the machine that owns the checkout.
   *
   * WHAT REFUSES IS EACH HANDLER'S OWN `if (!capabilities().localHandoff) … 409` (#764 review,
   * Minor 4), which is why this case walks all six routes rather than one: the guard is per
   * route, so take the check out of ONE handler and only that row goes red — `create 201≠409`,
   * `update 404≠409`, `remove 404≠409`, `select 200≠409`, `status 200≠409`, `details 200≠409`.
   * The `localHandoffRoute` middleware these routes also carry is registration metadata for
   * `localHandoffRouteManifest`; removing it changes the manifest and refuses nothing, and this
   * case stays green — which is exactly the mistake the earlier wording invited.
   */
  it('is refused in hosted mode for every write and both reads, through the leader’s door and the cockpit’s alike', async () => {
    const { app } = hotCockpit('0.0.0.0');
    const health = (await via(app, '/api/v1/health')).body as { capabilities: { localHandoff: boolean } };
    expect(health.capabilities.localHandoff, 'the fixture really is hosted').toBe(false);

    const dir = accountDir('hosted');
    const cases: Array<[Record<string, unknown>, [string, string, unknown?]]> = [
      [{ action: 'create_account', account: { provider: 'claude', configDir: dir } }, ['POST', '/api/v1/workspace/agent-profiles', { provider: 'claude', configDir: dir }]],
      [{ action: 'update_account', accountId: 'any', accountUpdate: { label: 'x' } }, ['PATCH', '/api/v1/workspace/agent-profiles/any', { label: 'x' }]],
      [{ action: 'remove_account', accountId: 'any' }, ['DELETE', '/api/v1/workspace/agent-profiles/any']],
      [{ action: 'select_account', provider: 'claude', accountId: null }, ['PUT', '/api/v1/workspace/agent-profiles/selection', { projectId: null, provider: 'claude', profileId: null }]],
      [{ action: 'check_account_status', provider: 'claude', accountId: 'default' }, ['GET', '/api/v1/workspace/agent-profiles/default:claude/status']],
      [{ action: 'get_account_details', provider: 'claude', accountId: 'default' }, ['GET', '/api/v1/workspace/agent-profiles/default:claude/details']],
      // #819 PR 9 (P9-AC6): the copy of the machine-wide accounts, through both doors.
      [{ action: 'import_global_accounts' }, ['POST', '/api/v1/workspace/agent-profiles/import-global']],
    ];
    for (const [args, [method, path, body]] of cases) {
      const cockpitDoor = await via(app, path, method, body);
      expect(cockpitDoor.status, `${method} ${path}`).toBe(409);
      const leaderDoor = await invoke(args, { service: app });
      expect(leaderDoor.result.isError, JSON.stringify(args)).toBe(true);
      expect(leaderDoor.text, JSON.stringify(args)).toMatch(/409|hosted mode/);
    }
    // Nothing was written on the way: the hosted refusals are refusals.
    expect(existsSync(accountsFile()) ? JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts : []).toEqual([]);
  });

  /**
   * OPENING AN ACCOUNT'S FOLDER STAYS REFUSED (named break `BREAK-B5-OPEN-FILE-LEAKS`), and its
   * boundary is the host process rather than the account: `POST …/:id/open` hands a path to an
   * application on the person's desktop (owner, 2026-09-20 07:41; spec § 4 Q3). Take it out of
   * `REFUSED_ACTIONS` and this goes red.
   */
  it('still refuses open_account_file, naming the host process and dispatching nothing', async () => {
    const spy = spyService();
    const called = await invoke({ action: 'open_account_file' }, { service: spy });
    expect(called.result.isError).toBe(true);
    expect(called.structured).toMatchObject({ refused: true, boundary: 'host-process' });
    expect(called.text).toMatch(/^Refused \(host process\)/);
    expect(spy.requests).toEqual([]);
    expect(REFUSED_ACTIONS.open_account_file.boundary).toBe('host-process');
  });
});

// ---- the negative sweep: no identity, no secret, anywhere in this surface ----------------------------

/**
 * #819 PR 9 — `import_global_accounts`: the leader's door to the merge `xezar accounts import-global`
 * runs (owner, 2026-09-21: "Allow both, people and MCP (leader) to use the import my accounts
 * functionality"). Each case names the break it fails against.
 */
describe('project_config: import_global_accounts (#819 PR 9)', () => {
  const globalAccounts = (): string => join(process.env.XEZ_HOME!, 'agent-accounts.json');
  let saved: string | null = null;
  beforeEach(() => {
    saved = existsSync(globalAccounts()) ? readFileSync(globalAccounts(), 'utf8') : null;
  });
  afterEach(() => {
    setActiveStateLayout(null);
    if (saved === null) rmSync(globalAccounts(), { force: true });
    else writeFileSync(globalAccounts(), saved);
    rmSync(join(ws.roots.a, '.xezar', 'agent-accounts.json'), { force: true });
  });

  // Break: a handler that copies on its own instead of dispatching the cockpit's route (the two
  // doors would drift), or one that answers the machine-wide file's names.
  it('dispatches the cockpit’s own route once and answers counts, never names', async () => {
    writeFileSync(globalAccounts(), JSON.stringify({
      accounts: [
        { id: 'mcp-work', provider: 'claude', configDir: '~/.claude-mcp-work', label: 'someone@example.com' },
        { id: 'mcp-team', provider: 'codex', configDir: '~/.codex-mcp-team', label: 'Team' },
      ],
    }));
    setActiveStateLayout(projectStateLayout(ws.roots.a));
    const read = value(await invoke({ action: 'get_account' }));
    expect(read.globalImport).toEqual({ state: 'unknown', importable: 2 });

    const spy = spyService();
    const called = await invoke({ action: 'import_global_accounts' }, { service: spy });
    expect(spy.requests).toEqual(['POST /api/v1/workspace/agent-profiles/import-global']);
    expect(value(called)).toEqual({ added: 2, kept: 0, globalImport: { state: 'done', importable: 0 } });
    expect(called.json).not.toMatch(/mcp-work|mcp-team|someone@example|claude-mcp/);
    // Merge-only and idempotent, exactly as the CLI: a second call adds nothing.
    expect(value(await invoke({ action: 'import_global_accounts' }))).toEqual({
      added: 0,
      kept: 2,
      globalImport: { state: 'done', importable: 0 },
    });
  });

  // Break: a refusal softened or re-worded at this door, or a write where there is nothing to
  // import into.
  it('carries the route’s own 409 in the global layout, and writes nothing', async () => {
    writeFileSync(globalAccounts(), JSON.stringify({ accounts: [{ id: 'mcp-work', provider: 'claude', configDir: '~/.claude-mcp-work' }] }));
    const refused = await invoke({ action: 'import_global_accounts' });
    expect(refused.result.isError).toBe(true);
    expect(refused.structured.status).toBe(409);
    expect(refused.text).toContain('nothing to copy');
    expect(existsSync(join(ws.roots.a, '.xezar', 'agent-accounts.json'))).toBe(false);
    // …and get_account carries no import state where the listing sends none.
    expect(value(await invoke({ action: 'get_account' }))).not.toHaveProperty('globalImport');
  });

  it('needs an operation key and takes nothing else', async () => {
    const withoutKey = await invoke({ action: 'import_global_accounts', operationId: undefined });
    expect(withoutKey.result.isError).toBe(true);
    expect(withoutKey.text).toMatch(/import_global_accounts needs operationId/);
    const mixed = await invoke({ action: 'import_global_accounts', provider: 'claude' });
    expect(mixed.result.isError).toBe(true);
    expect(mixed.text).toMatch(/provider is not used by import_global_accounts/);
  });
});

/**
 * #819 PR 5 — `get_account` reads every account, the one in use, and the stored choices that name no
 * account, as the cockpit's Agent accounts pane does. Each case names the break it fails against.
 */
describe('project_config: get_account lists every account and its problems (#819 PR 5)', () => {
  const accountsFile = (): string => join(process.env.XEZ_HOME!, 'agent-accounts.json');
  let saved: string | null = null;
  beforeEach(() => {
    saved = existsSync(accountsFile()) ? readFileSync(accountsFile(), 'utf8') : null;
  });
  afterEach(() => {
    if (saved === null) rmSync(accountsFile(), { force: true });
    else writeFileSync(accountsFile(), saved);
  });
  const create = async (label: string): Promise<string> => {
    const made = await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: makeDir('xez-pc-pr5-'), label });
    expect(made.status).toBe(201);
    return made.body.profile.id as string;
  };
  const select = async (projectId: string | null, profileId: string | null): Promise<void> => {
    expect((await cockpit('/api/v1/workspace/agent-profiles/selection', 'PUT', { projectId, provider: 'claude', profileId })).status).toBe(200);
  };
  /** Drop an account row from the file by hand, leaving every reference to it dangling. */
  const dangle = (id: string): void => {
    const store = JSON.parse(readFileSync(accountsFile(), 'utf8'));
    store.accounts = store.accounts.filter((row: { id: string }) => row.id !== id);
    writeFileSync(accountsFile(), JSON.stringify(store));
  };
  type Row = { provider: string; handle: string; label?: string; builtIn: boolean; selected?: boolean };

  // P5-AC1. Break: the 0.17.0 one-row mapping — no `profiles` at all — or `selected` computed from
  // the listing's own subject (the machine default) instead of this project's selection.
  it('P5-AC1: lists every account per provider with the built-in login, and exactly one selected, following selection → default → built-in', async () => {
    const [work, team, lab, ops] = [await create('Work'), await create('Team'), await create('Lab'), await create('Ops')];
    const claude = (answer: { profiles: Row[] }) => answer.profiles.filter((r) => r.provider === 'claude');

    // Nothing chosen: the built-in login is the one in use.
    let answer = value(await invoke({ action: 'get_account' }));
    expect(claude(answer).map((r) => r.handle)).toEqual(['default', work, team, lab, ops]);
    expect(claude(answer).filter((r) => r.builtIn).map((r) => r.handle)).toEqual(['default']);
    for (const provider of PROVIDER_IDS) {
      expect(answer.profiles.filter((r: Row) => r.provider === provider && r.selected), provider).toHaveLength(1);
    }
    expect(claude(answer).find((r) => r.selected)!.handle).toBe('default');

    // A machine-wide default: every project without its own choice uses it.
    await select(null, team);
    answer = value(await invoke({ action: 'get_account' }));
    expect(claude(answer).find((r) => r.selected)!.handle).toBe(team);

    // This project's own choice outranks the default, and project B still follows the default.
    await select('proj-a', lab);
    answer = value(await invoke({ action: 'get_account' }));
    expect(claude(answer).filter((r) => r.selected).map((r) => r.handle)).toEqual([lab]);
    expect(answer.accounts.find((r: Row) => r.provider === 'claude')).toEqual({ provider: 'claude', handle: lab, label: 'Lab', builtIn: false });
    const b = value(await invoke({ action: 'get_account' }, { project: 'b' }));
    expect(claude(b).filter((r) => r.selected).map((r) => r.handle)).toEqual([team]);
    expect(answer.problems).toEqual([]);
  });

  // P5-AC2. Break: the 0.17.0 raw echo, `handle = selection ?? default` with no existence check,
  // which reported `qodeca-org` as the account in use while every run used the built-in login.
  it('P5-AC2: a dangling handle is a problem with its fix and its raw handle, never the account in use', async () => {
    const gone = await create('Gone');
    await select(null, gone);
    dangle(gone);
    const answer = value(await invoke({ action: 'get_account' }));
    expect(answer.accounts.find((r: Row) => r.provider === 'claude')).toEqual({ provider: 'claude', handle: 'default', label: 'Default', builtIn: true });
    expect(answer.profiles.filter((r: Row) => r.provider === 'claude' && r.selected)).toEqual([
      { provider: 'claude', handle: 'default', label: 'Default', builtIn: true, selected: true },
    ]);
    expect(JSON.stringify(answer.profiles)).not.toContain(gone);
    expect(answer.problems).toEqual([
      { kind: 'unknown-account', where: 'defaults', provider: 'claude', handle: gone, fix: expect.stringContaining('select_account') },
    ]);
  });

  // Break: the listing's `problems` forwarded whole — another project's stored choice is not this
  // project's fact (N-01) — or reported twice.
  it('reports this project’s own dangling selection and not another project’s', async () => {
    const mine = await create('Mine');
    const theirs = await create('Theirs');
    await select('proj-a', mine);
    await select('proj-b', theirs);
    dangle(mine);
    dangle(theirs);
    const a = value(await invoke({ action: 'get_account' }));
    expect(a.problems).toEqual([
      { kind: 'unknown-account', where: 'selection', provider: 'claude', handle: mine, fix: expect.stringContaining('accountId null') },
    ]);
    expect(a.accounts.find((r: Row) => r.provider === 'claude').handle).toBe('default');
    const b = value(await invoke({ action: 'get_account' }, { project: 'b' }));
    expect(b.problems.map((p: { handle: string }) => p.handle)).toEqual([theirs]);
  });

  // P5-AC3. Break: a row built by spreading the listing's profile (it carries `configDir` and
  // `path`), or `profiles` skipping the identity rule `accounts` applies. The fixture really holds
  // an e-mail-shaped label and a folder on this machine; the control proves the listing serves both.
  it('P5-AC3: no identity-looking label and no config folder anywhere in the answer', async () => {
    const dir = makeDir('xez-pc-pr5-secret-folder-');
    const made = await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: dir, label: EMAIL_LABEL });
    expect(made.status).toBe(201);
    const listing = JSON.stringify((await cockpit('/api/v1/workspace/agent-profiles')).body);
    expect(listing, 'control: the pane itself does serve both').toContain(EMAIL_LABEL);
    expect(listing).toContain(basename(dir));
    await select('proj-a', made.body.profile.id);
    const called = await invoke({ action: 'get_account' });
    expect(value(called).profiles.some((r: Row) => r.handle === made.body.profile.id)).toBe(true);
    expect(called.json).not.toContain(EMAIL_LABEL);
    expect(called.json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(called.json).not.toContain(basename(dir));
    expect(called.json).not.toMatch(/configDir|"path"/);
  });

  // P5-AC5. Break: the new keys served where the whole family is withheld.
  it('P5-AC5: hosted mode answers exactly what it answered before', async () => {
    process.env.XEZ_REMOTE = '1';
    expect(value(await invoke({ action: 'get_account' }))).toEqual({ available: false, reason: 'account information is not served in hosted mode' });
  });

  // P5-AC6. Break: `accounts` replaced by the full list (option (b) of Q1), which a 0.16.0/0.17.0
  // leader would read as "the first Claude row is the one in use".
  it('P5-AC6: a reader of `accounts` alone still gets one row per provider in the 0.17.0 shape', async () => {
    await create('Extra');
    await create('Another');
    const answer = value(await invoke({ action: 'get_account' }));
    expect(answer.accounts.map((r: Row) => r.provider)).toEqual([...PROVIDER_IDS]);
    for (const row of answer.accounts) {
      expect(Object.keys(row).filter((k) => !['provider', 'handle', 'label', 'builtIn'].includes(k)), JSON.stringify(row)).toEqual([]);
      expect(typeof row.handle).toBe('string');
    }
  });
});

/** The pure builder, for the branches the live fixture cannot reach. */
describe('accountsAnswer (#819 PR 5)', () => {
  const base = {
    editable: true,
    profileCapableProviders: [],
    selections: {},
    defaults: {},
  };
  const profile = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    provider: 'claude' as const,
    label: id === 'default' ? 'Default' : id,
    configDir: `/home/someone/.claude-${id}`,
    path: `/home/someone/.claude-${id}`,
    exists: true,
    looksValid: true,
    isDefault: id === 'default',
    selected: false,
    ...extra,
  });

  // Break: a problem's handle echoed even when a hand-edited file put an address there.
  it('withholds an identity-looking problem handle, keeps a plain one, and de-duplicates', () => {
    const answer = accountsAnswer(
      {
        ...base,
        profiles: [profile('default')],
        selections: { '/r': { claude: 'me@example.com' } },
        defaults: { claude: 'qodeca-org' },
        problems: [
          { kind: 'unknown-account', where: 'defaults', provider: 'claude', handle: 'qodeca-org' },
          { kind: 'unknown-account', where: 'selection', provider: 'claude', handle: 'me@example.com' },
          { kind: 'unknown-account', where: 'selection', provider: 'claude', handle: 'me@example.com' },
        ],
      } as never,
      '/r',
    );
    if (!answer.available) throw new Error('expected an answer');
    expect(answer.problems.map((p) => [p.where, p.handle])).toEqual([
      ['defaults', 'qodeca-org'],
      ['selection', '(a handle that looks like an identity, withheld)'],
    ]);
    expect(JSON.stringify(answer)).not.toContain('@');
    expect(answer.accounts).toEqual([{ provider: 'claude', handle: 'default', label: 'Default', builtIn: true }]);
  });

  // Break: a listing that predates `problems` (optional in the contract) read as an error.
  it('reads an absent `problems` as none, and never copies a folder', () => {
    const answer = accountsAnswer({ ...base, profiles: [profile('default'), profile('work', { label: '' })] } as never, '/r');
    if (!answer.available) throw new Error('expected an answer');
    expect(answer.problems).toEqual([]);
    expect(answer.profiles[1]).toEqual({ provider: 'claude', handle: 'work', builtIn: false, selected: false });
    expect(JSON.stringify(answer)).not.toContain('/home/someone');
  });

  // Break: an in-use handle whose row the listing lacks answered without a row at all.
  it('still answers a row when the chosen account has no listing row of its own', () => {
    const answer = accountsAnswer({ ...base, profiles: [profile('work')], defaults: { claude: 'work' } } as never, '/r');
    if (!answer.available) throw new Error('expected an answer');
    expect(answer.accounts).toEqual([{ provider: 'claude', handle: 'work', label: 'work', builtIn: false }]);
    const orphan = accountsAnswer({ ...base, profiles: [profile('work')] } as never, '/r');
    if (!orphan.available) throw new Error('expected an answer');
    expect(orphan.accounts).toEqual([{ provider: 'claude', handle: 'default', builtIn: true }]);
  });
});

describe('project_config: nothing identifies an account or leaks a secret', () => {
  it('the fixture is live: the cockpit’s own identity route DOES serve the email and organisation (control)', async () => {
    const details = await cockpit('/api/v1/workspace/agent-profiles/default:claude/details');
    expect(details.status).toBe(200);
    expect(JSON.stringify(details.body)).toContain(EMAIL_CLAUDE);
    expect(JSON.stringify(details.body)).toContain(ORG);
    const codex = await cockpit('/api/v1/workspace/agent-profiles/default:codex/details');
    expect(JSON.stringify(codex.body)).toContain(PLAN_CODEX);
  });

  const calls: Array<Record<string, unknown>> = [
    { action: 'get_config' },
    { action: 'get_project' },
    { action: 'get_prompt_templates' },
    { action: 'get_limits' },
    { action: 'get_capabilities' },
    { action: 'get_account' },
    { action: 'list_agent_config' },
    ...PROJECT_SCOPE_IDS.map((fileId) => ({ action: 'read_agent_config', fileId })),
    ...USER_SCOPE_IDS.map((fileId) => ({ action: 'read_agent_config', fileId })),
    ...USER_SCOPE_IDS.map((fileId) => ({ action: 'write_agent_config', fileId, content: '{}', version: null })),
    { action: 'list_workflows' },
    { action: 'list_skills' },
    { action: 'list_importable_skills' },
    { action: 'check_skill_updates' },
    { action: 'list_automations' },
    { action: 'get_automation_log' },
    { action: 'list_worktrees' },
    { action: 'get_project', projectId: 'proj-b' },
    ...Object.keys(REFUSED_ACTIONS).map((action) => ({ action })),
  ];

  // Each action gets its own fixture and timeout; a slow aggregate sweep must not
  // time out and let teardown race the remaining privacy checks.
  it.each(calls)('does not disclose identity, user config or the launch key: %j', async (args) => {
    process.env.XEZ_AUTOMATIONS = '1';
    const other = makeDir('xez-pc-second-claude-');
    const created = await cockpit('/api/v1/workspace/agent-profiles', 'POST', { provider: 'claude', configDir: other, label: EMAIL_LABEL });
    await cockpit('/api/v1/workspace/agent-profiles/selection', 'PUT', { projectId: 'proj-a', provider: 'claude', profileId: created.body.profile.id });
    const launchKey = (await cockpit('/api/v1/p/proj-a/launch-key')).body.key as string;
    expect(launchKey.length).toBeGreaterThan(8);

    for (const project of ['a', 'b'] as const) {
      const called = await invoke(args, { project });
      for (const marker of IDENTITY_MARKERS) expect(called.json, `${String(args.action)} leaked ${marker}`).not.toContain(marker);
      expect(called.json, `${String(args.action)} carries an email address`).not.toMatch(EMAIL_RE);
      expect(called.json, `${String(args.action)} carries the launch key`).not.toContain(launchKey);
      expect(called.json, `${String(args.action)} carries a user-scope file`).not.toContain(USER_MARKER);
    }
  });
});
