import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { readNdjson } from './ndjson.ts';
import {
  CodexAppServerRpc,
  endCodexAppServer,
  resolveCodexExecutable,
  spawnCodexAppServer,
  type CodexAppServerMessage,
} from './codex-app-server-transport.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface CodexModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, cwd: string) => ChildProcessWithoutNullStreams;
}

const modelSchema = z.object({
  model: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  // Read as `unknown` on purpose: a value we do not recognise must leave `vision` unknown, never
  // fail the whole page (and with it every model) the way a stricter schema here would.
  inputModalities: z.unknown().optional(),
}).passthrough();

/**
 * `vision` from Codex's own `inputModalities` (#819 item 4): a list that names `image` proves it,
 * a list that does not proves its absence, and no list at all proves nothing — so the key is
 * omitted rather than guessed.
 */
function codexVision(modalities: unknown): { vision?: boolean } {
  if (!Array.isArray(modalities)) return {};
  return { vision: modalities.includes('image') };
}

const pageSchema = z.object({
  data: z.array(modelSchema),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_MODEL_PAGES = 25;
const MAX_MODELS = 500;

/** The fixture `XEZ_DRY_RUN=1` answers with (AGENTS.md: "XEZ_DRY_RUN=1 must keep working,
 *  bundled mock, no real CLI"). Every other backend's discovery either has this same early
 *  return (`backend-detect.ts`'s claude/pi probes) or spawns a bundled mock binary that answers
 *  in-process; Codex had neither, so a dry-run boot with no real `codex` on PATH (every CI
 *  runner) still tried to spawn `codex app-server` and always got `models: []` — the composer's
 *  Codex model menu was structurally empty under dry-run, not just when Codex is genuinely
 *  absent. */
const DRY_RUN_MODELS: ModelOption[] = [
  { id: 'mock-codex-model', label: 'Mock Codex model', description: 'mock (XEZ_DRY_RUN=1)' },
];

/** Discover the visible catalog exposed by the authenticated host Codex CLI. */
export async function discoverCodexModels(options: CodexModelDiscoveryOptions): Promise<ModelOption[]> {
  if (process.env.XEZ_DRY_RUN === '1') return DRY_RUN_MODELS;
  const child = (options.spawn ?? spawnCodexAppServer)(
    resolveCodexExecutable(options.bin),
    options.cwd,
  );
  const rpc = new CodexAppServerRpc(child);
  let readerError: Error | undefined;
  const reader = (async () => {
    try {
      for await (const line of readNdjson(child.stdout)) {
        let message: CodexAppServerMessage;
        try {
          message = JSON.parse(line) as CodexAppServerMessage;
        } catch {
          throw new Error('Codex model discovery returned malformed NDJSON');
        }
        rpc.dispatchResponse(message);
      }
    } catch (error) {
      readerError = error instanceof Error ? error : new Error(String(error));
      rpc.rejectPending(readerError.message);
    }
  })();

  const exited = new Promise<never>((_, reject) => {
    const fail = (detail: string) => {
      const error = new Error(detail);
      rpc.rejectPending(error.message);
      reject(error);
    };
    child.once('error', () => fail('Codex model discovery child failed'));
    child.once('exit', (code) => fail(`Codex model discovery child exited (${code ?? 'unknown'})`));
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Codex model discovery timed out');
      rpc.rejectPending(error.message);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      discoverPages(rpc),
      exited,
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    endCodexAppServer(child);
    void reader.catch(() => undefined);
    if (readerError) rpc.rejectPending(readerError.message);
  }
}

async function discoverPages(rpc: CodexAppServerRpc): Promise<ModelOption[]> {
  await rpc.initialize();
  const models: ModelOption[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_MODEL_PAGES; pageNumber += 1) {
    const raw = await rpc.request('model/list', { cursor, includeHidden: false });
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Codex model discovery returned malformed model data');

    for (const model of parsed.data.data) {
      const id = model.model.trim();
      if (!id || model.hidden || ids.has(id)) continue;
      if (models.length >= MAX_MODELS) throw new Error('Codex model discovery exceeded the size limit');
      ids.add(id);
      models.push({
        id,
        label: model.displayName?.trim() || id,
        description: model.description ?? '',
        ...codexVision(model.inputModalities),
      });
    }

    const nextCursor = parsed.data.nextCursor ?? null;
    if (nextCursor === null) return models;
    if (!nextCursor || cursors.has(nextCursor)) {
      throw new Error('Codex model discovery returned a cursor loop');
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('Codex model discovery exceeded the page limit');
}
