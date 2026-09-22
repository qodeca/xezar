#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const moduleUrl = new URL('../dist/core/codex-read-only-hook.js', import.meta.url);
const ALLOWLIST_ENV = '__XEZAR_CODEX_READ_ONLY_ALLOWLIST';

async function main() {
  const encodedEntries = process.env[ALLOWLIST_ENV];
  // The handler is installed once in the Codex profile. It is intentionally inert for Codex
  // processes not spawned for a xezar read-only step, even if this package was later moved.
  if (encodedEntries === undefined) return;
  const { CODEX_READ_ONLY_ALLOWLIST_ENV, codexHookOutput, decideCodexPreToolUse } = await import(moduleUrl.href);
  if (CODEX_READ_ONLY_ALLOWLIST_ENV !== ALLOWLIST_ENV) throw new Error('read-only allowlist transport mismatch');
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = undefined;
  }
  let entries = [];
  try {
    const parsed = JSON.parse(encodedEntries);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) entries = parsed;
  } catch {
    // The shared decision fails closed because an empty list has no usable entry.
  }
  const output = codexHookOutput(decideCodexPreToolUse(payload, entries));
  if (output) process.stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  // Codex hooks otherwise fail open on an adapter crash. Emit a valid denial instead.
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Rule hook.adapter refused the command: the read-only hook could not start (${reason}).`,
    },
  }));
});
