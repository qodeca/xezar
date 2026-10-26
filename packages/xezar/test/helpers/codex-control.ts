/**
 * A test's stand-in Codex app-server, listening where the real one does on every OS (#977).
 *
 * POSIX: on the control socket itself, `<home>/app-server-control/app-server-control.sock`.
 * Windows: Node cannot listen on an AF_UNIX path there, and xezar does not dial one – it runs
 * `codex app-server proxy --sock <path>` (`connectCodexLeader`). So the stand-in listens on a named
 * pipe, leaves a plain file at the socket path naming that pipe, makes the control folder private
 * as Codex does, and points `XEZ_CODEX_BIN` at `codex-proxy-stand-in.mjs`, which relays to it.
 * Everything xezar does on Windows runs for real: the folder check, the relay process, its stdio.
 *
 * `relay: true` sets up that relay arrangement on any OS (behind a Unix socket on POSIX), so the
 * Windows connection path – `connectCodexLeader(…, 'win32')` – runs on every CI leg.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';

import { CODEX_CONTROL_SOCKET } from '../../src/mcp/adapters/codex-link.ts';
import { ensurePrivateDir } from '../../src/platform/private-dir.ts';
import { onWindows } from './platform.ts';

export const PROXY_STAND_IN = resolve(import.meta.dirname, 'codex-proxy-stand-in.mjs');

/** Listen `server` at `home`'s Codex control endpoint. Returns what undoes the `XEZ_CODEX_BIN` pin. */
export async function listenCodexControl(server: Server, home: string, { relay = onWindows }: { relay?: boolean } = {}): Promise<() => void> {
  const socketPath = join(home, CODEX_CONTROL_SOCKET);
  if (!relay) {
    await new Promise<void>((done) => server.listen(socketPath, done));
    return () => undefined;
  }
  const verdict = await ensurePrivateDir(join(home, 'app-server-control'));
  if (!verdict.ok) throw new Error(`codex stand-in: ${verdict.message}`);
  const endpoint = onWindows
    ? `\\\\.\\pipe\\xez-codex-stand-in-${randomBytes(8).toString('hex')}`
    : join(home, 'app-server-control', 'relay.sock');
  await new Promise<void>((done) => server.listen(endpoint, done));
  writeFileSync(socketPath, endpoint);
  const before = process.env.XEZ_CODEX_BIN;
  process.env.XEZ_CODEX_BIN = PROXY_STAND_IN;
  return () => {
    if (before === undefined) delete process.env.XEZ_CODEX_BIN;
    else process.env.XEZ_CODEX_BIN = before;
  };
}
