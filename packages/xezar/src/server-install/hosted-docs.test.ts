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

/**
 * Claim -> harness case. The `test:server-mode` harness is the only level that
 * observes the built CLI behind an authenticated hop, so every reconciled claim
 * names the case id that observes it. Editing a claim to something the harness
 * does NOT observe, or deleting the case, turns the last describe red
 * (BREAK-DOC-VS-HARNESS).
 */
const RECONCILED_WITH_HARNESS = [
  {
    doc: 'docs/guide/14-remote-access.md',
    claim: /an explicit `--port` outranks `XEZ_PORT` and that `XEZ_PORT` decides when no `--port` is given/,
    caseId: 'A-PORT-01',
  },
  {
    doc: 'docs/guide/14-remote-access.md',
    claim: /anonymous and wrong credentials are challenged with `401` before the backend is reached, and valid credentials reach it/,
    caseId: 'A-AUTH',
  },
  {
    doc: 'docs/server-install/README.md',
    claim: /anonymous is challenged, authenticated[\s\S]*?reaches xezar/,
    caseId: 'A-AUTH',
  },
  {
    doc: 'docs/server-install/ubuntu-vps.md',
    claim: /anonymous request is challenged \(401\)/,
    caseId: 'A-AUTH',
  },
];

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

describe('hosted-mode docs tied to the server-mode harness (#547 AC-5)', () => {
  const harness = read('packages/xezar/test/e2e/server-mode-harness.mjs');

  it.each(RECONCILED_WITH_HARNESS)('$doc states the claim and names $caseId', ({ doc, claim, caseId }) => {
    const text = read(doc);
    expect(text, `${doc} no longer states the reconciled claim`).toMatch(claim);
    expect(text, `${doc} does not name harness case ${caseId}`).toContain(`harness case \`${caseId}\``);
    expect(harness, `the harness no longer observes ${caseId}`).toContain(`PASS ${caseId}`);
  });
});
