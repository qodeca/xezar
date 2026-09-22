import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STATE_NAME_ENTRIES, STATE_NAMES_PAYLOAD, stateNamesPayloadSchema } from './local-xezar-top-level-names.ts';

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/local-xezar-top-level-names.expected.json', import.meta.url));

/**
 * The fixture is the CONTRACT, not a sample (#838 item C3, follow-up): a future
 * `xezar state-names --json` must print these exact bytes, or the build fails. This test is the
 * binding half of that promise — it fails the moment `STATE_NAMES_PAYLOAD` drifts from the
 * committed fixture, before any subcommand exists to serve it.
 */
describe('the local-xezar-top-level state-names payload matches its committed fixture', () => {
  it('serialises byte-for-byte to the fixture', () => {
    const fixtureText = readFileSync(FIXTURE_PATH, 'utf8');
    expect(JSON.stringify(STATE_NAMES_PAYLOAD, null, 2) + '\n').toBe(fixtureText);
  });

  it('parses as valid JSON matching the schema (control: the fixture is not stale hand-edited text)', () => {
    const fixtureJson = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(stateNamesPayloadSchema.parse(fixtureJson)).toEqual(STATE_NAMES_PAYLOAD);
  });

  it('carries no regex — every suffix rule is literal text or structured parts (frozen schema requirement)', () => {
    for (const suffix of STATE_NAMES_PAYLOAD.literalSuffixes) expect(typeof suffix).toBe('string');
    for (const templated of STATE_NAMES_PAYLOAD.templatedSuffixes) {
      for (const part of templated.parts) {
        expect('literal' in part || 'kind' in part).toBe(true);
      }
    }
  });

  it('every entry names a source file in its reason (a human reading a red gate needs it)', () => {
    for (const entry of STATE_NAME_ENTRIES) expect(entry.reason.length).toBeGreaterThan(0);
  });
});
