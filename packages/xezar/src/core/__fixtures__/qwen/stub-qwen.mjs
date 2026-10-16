#!/usr/bin/env node
// Test stub for `qwen-runner.test.ts`: records what the runner hands a turn's process (argv,
// stdin, chosen env vars, the run's system-settings file and its `--mcp-config` file) into `QWEN_STUB_RECORD`, then
// answers one turn. `QWEN_STUB_VERSION` sets the version the init frame reports.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const settingsPath = process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
let settings = null;
try {
  settings = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null;
} catch {
  settings = 'unreadable';
}
const mcpPath = argv.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length);
let mcpConfig = null;
try {
  mcpConfig = mcpPath ? JSON.parse(readFileSync(mcpPath, 'utf8')) : null;
} catch {
  mcpConfig = 'unreadable';
}
const env = {};
for (const key of Object.keys(process.env)) env[key] = process.env[key];
if (process.env.QWEN_STUB_RECORD) appendFileSync(process.env.QWEN_STUB_RECORD, `${JSON.stringify({ argv, stdin, env, settings, mcpConfig })}\n`);
const id = (argv.find((a) => a.startsWith('--resume=')) ?? argv.find((a) => a.startsWith('--session-id=')) ?? '=stub-session').split('=')[1];
const model = (argv.find((a) => a.startsWith('--model=')) ?? '=stub-model').split('=')[1];
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
emit({ type: 'system', subtype: 'init', session_id: id, model: process.env.QWEN_STUB_INIT_MODEL ?? model, qwen_code_version: process.env.QWEN_STUB_VERSION ?? '0.25.2' });
if (process.env.QWEN_STUB_EXIT) {
  process.stderr.write('Reached max session turns for this session.\n');
  process.exit(Number(process.env.QWEN_STUB_EXIT));
}
setTimeout(() => {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: process.env.QWEN_STUB_TEXT ?? 'ok' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: process.env.QWEN_STUB_TEXT ?? 'ok', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
  process.exit(0);
}, 20);
