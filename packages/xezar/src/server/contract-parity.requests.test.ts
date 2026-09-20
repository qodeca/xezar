import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { InferRequestType } from 'hono/client';
import { hc } from 'hono/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { retryProviderInputSchema, setConfigInputSchema, setProviderEnabledInputSchema, setWorkspaceConfigInputSchema } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunManager } from '../workflows/run.ts';
import type { AppType } from './app-type.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * REQUEST parity, the half `contract-parity*.test.ts` does not cover (#677 wave 1).
 *
 * Those files compare RESPONSE shapes; every one of them imports nothing but `*ResponseSchema`.
 * The two settings routes used to declare their request schemas a second time inside `server.ts`
 * while `packages/contract` held a twin the MCP validated against — two definitions of one shape
 * with nothing proving they agreed. The copies are gone; this file is what keeps them gone.
 *
 * Two halves, because neither alone is enough:
 *
 *   - COMPILE TIME: the route's own `InferRequestType` and the contract schema's `z.input` are
 *     mutually assignable. It reads what the route ACTUALLY validates with — hono records a
 *     request shape in the route type only when validation is middleware — so a route that went
 *     back to a local schema, or a middleware-less `safeParse` in a handler, fails here. Both
 *     directions, because a one-way check is green on real drift (AGENTS.md § The HTTP API).
 *   - RUN TIME: the two things a TYPE cannot carry — the custom 400 message and a numeric bound.
 *     `systemPrompt`'s over-length text and `resources.maxParallel`'s ceiling are wire behaviour,
 *     identical either side of the move, and a schema swap that quietly changed one would be
 *     invisible to every type-level assertion in this repository.
 */
describe('the settings routes validate with the CONTRACT request schemas', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;

  // ---- PUT /api/v1/config (A1) --------------------------------------------------------------
  type SetConfigBody = InferRequestType<typeof client.api.v1.config.$put>['json'];
  type SetConfigSchema = z.input<typeof setConfigInputSchema>;
  type _SetConfigExact = Assert<Mutual<SetConfigSchema, SetConfigBody>>;

  // ---- PUT /api/v1/workspace/config (A2) ----------------------------------------------------
  type SetWorkspaceConfigBody = InferRequestType<typeof client.api.v1.workspace.config.$put>['json'];
  type SetWorkspaceConfigSchema = z.input<typeof setWorkspaceConfigInputSchema>;
  type _SetWorkspaceConfigExact = Assert<Mutual<SetWorkspaceConfigSchema, SetWorkspaceConfigBody>>;

  // ---- PUT /api/v1/providers/:provider/enabled and POST …/retry (#677 B4) -------------------
  // Both moved out of `server.ts` when the MCP door started writing them: the door takes its key
  // set from the contract schema, and a hand-written twin at either end is what this pins shut.
  type SetProviderEnabledBody = InferRequestType<(typeof client.api.v1.providers)[':provider']['enabled']['$put']>['json'];
  type SetProviderEnabledSchema = z.input<typeof setProviderEnabledInputSchema>;
  type _SetProviderEnabledExact = Assert<Mutual<SetProviderEnabledSchema, SetProviderEnabledBody>>;

  type RetryProviderBody = InferRequestType<(typeof client.api.v1.providers)[':provider']['retry']['$post']>['json'];
  type RetryProviderSchema = z.input<typeof retryProviderInputSchema>;
  type _RetryProviderExact = Assert<Mutual<RetryProviderSchema, RetryProviderBody>>;

  const savedHome = process.env.XEZ_HOME;
  let home: string;
  let repoRoot: string;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-request-parity-'));
    process.env.XEZ_HOME = home; // paths.ts sends every workspace path here
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-request-parity-repo-'));
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    app = createApp({
      repoRoot,
      store: RunStore.open(join(repoRoot, '.local/xezar')),
      manager: {} as RunManager,
      version: '0.0.0-test',
      semaphore: new WorkspaceSemaphore(),
    });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const put = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers an over-long systemPrompt with the SAME 400 body as before the schema moved', async () => {
    const res = await put('/api/v1/config', { systemPrompt: 'x'.repeat(20_001) });

    expect(res.status).toBe(400);
    // Byte-identical to what the deleted `setConfigSchema` produced: the custom message travelled
    // into the contract with the schema (#677 wave 1), so BACKWARD_COMPATIBILITY.md needs no line.
    expect(await res.json()).toEqual({ error: 'systemPrompt: must be at most 20000 characters' });
  });

  it('keeps the { error } 400 shape for an ordinary bad field', async () => {
    const res = await put('/api/v1/config', { maxParallel: 99 });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatch(/^maxParallel: /);
  });

  /**
   * The bound is the A2 red proof: widening `setWorkspaceConfigInputSchema.resources.maxParallel`
   * to `.max(64)` and touching nothing else turns this red, which is only true because the ROUTE
   * reads that schema.
   */
  it('caps workspace resources.maxParallel at the schema bound the workspace loader accepts', async () => {
    expect((await put('/api/v1/workspace/config', { resources: { maxParallel: 16 } })).status).toBe(200);

    const res = await put('/api/v1/workspace/config', { resources: { maxParallel: 17 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatch(/^resources\.maxParallel: /);
  });
});
