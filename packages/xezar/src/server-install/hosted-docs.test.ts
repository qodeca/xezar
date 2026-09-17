/**
 * Narrow claim checks for the hosted/remote-server docs (#547, SM2).
 *
 * These pin specific sentences, not whole files: each one exists because a
 * real doc-vs-behavior mismatch was found (see the SM2 spec's "Documentation
 * claim check against the harness" table) and must not silently come back.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativeToRepoRoot: string): string =>
  readFileSync(new URL(`../../../../${relativeToRepoRoot}`, import.meta.url), 'utf8');

describe('docs/guide/14-remote-access.md', () => {
  const guide = read('docs/guide/14-remote-access.md');

  // BREAK-DOC-MODE: restoring the old unconditional "starting at port 4321"
  // sentence must turn this red — the CLI's own `--port` help (index.ts) names
  // a saved-port / XEZ_PORT / last-listened precedence chain ahead of 4321,
  // so an unqualified "starting at 4321" overstates what a normal launch does.
  it('never claims an unconditional starting port of 4321', () => {
    expect(guide).not.toMatch(/binds to `127\.0\.0\.1`, starting at port `4321`/);
  });

  it('names the actual port precedence ahead of the 4321 default', () => {
    expect(guide).toMatch(/saved port/i);
    expect(guide).toMatch(/last listened/i);
  });
});

describe('docs/server-install/macosx-ngrok.md', () => {
  const guide = read('docs/server-install/macosx-ngrok.md');

  // Companion to BREAK-NGROK-PROOF-COPY: the .ts success copy is pinned in
  // macosx-ngrok.test.ts, but the .md prose is a separate artifact that could
  // drift back to an unqualified "basic-auth enforced" claim on its own.
  it('discloses that the installer never probes the basic-auth gate itself', () => {
    expect(guide).toMatch(/the installer sends no request through the tunnel to test the gate/i);
  });
});

describe('docs/server-install/README.md', () => {
  const overview = read('docs/server-install/README.md');

  it('discloses that macOS verification does not probe the authentication gate', () => {
    expect(overview).toMatch(/does not probe its authentication gate/i);
  });
});
