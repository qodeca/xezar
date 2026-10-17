#!/usr/bin/env node
// Mock `qwen` binary for XEZ_DRY_RUN=1 (#1044) — emits a plausible Qwen Code 0.25.2 headless
// stream-json turn so the engine, store and cockpit can run a Qwen task without a model.
// Mirrors the real CLI's contract: ONE process per turn, the prompt on stdin, `--session-id` on
// the first turn and `--resume` after it, frames on stdout, exit 0 after the `result`.

import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const flag = (name) => {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes('--version')) {
  process.stdout.write('0.25.2\n');
  process.exit(0);
}

// Testability hook, as in mock-claude.mjs: the argv this mock was spawned with, one JSON array per line.
if (process.env.XEZ_MOCK_ARGS_FILE) {
  try {
    appendFileSync(process.env.XEZ_MOCK_ARGS_FILE, `${JSON.stringify(argv)}\n`);
  } catch {
    // best effort
  }
}

const resumed = flag('resume');
const sessionId = resumed ?? flag('session-id') ?? randomUUID();
const model = flag('model') ?? 'mock-qwen-model';

function writeHandoff() {
  try {
    const handoff = process.env.XEZ_HANDOFF_FILE;
    if (!handoff) return;
    const text = readFileSync(handoff, 'utf8');
    const line = `- ${new Date().toISOString()} — mock qwen: implemented the change (dry run)\n`;
    const marker = '## Progress log\n';
    const idx = text.indexOf(marker);
    writeFileSync(handoff, idx >= 0 ? text.slice(0, idx + marker.length) + '\n' + line + text.slice(idx + marker.length).replace(/^\n+/, '') : text + line, 'utf8');
  } catch {
    // best effort
  }
}

function writeVerdictPacket(userText) {
  const match = /mock:verdict:([a-z-]+):([A-Z][A-Z -]*[A-Z])(?::([A-Za-z0-9._-]+))?/.exec(userText);
  const handoff = process.env.XEZ_HANDOFF_FILE;
  if (!match || !handoff) return;
  const stepId = match[3] ?? process.env.XEZ_STEP_ID;
  if (!stepId) return;
  try {
    const packet = {
      id: `mock-${stepId}`,
      taskId: process.env.XEZ_TASK_ID,
      stepId,
      role: match[1],
      verdict: match[2],
      reviewedHeadSha: 'f'.repeat(40),
      summary: 'mock review (dry run)',
      recordedAt: new Date().toISOString(),
      labels: { requestedAdd: [], requestedRemove: [], observed: [], state: 'verified' },
    };
    const target = `${handoff}.verdict.json`;
    writeFileSync(`${target}.tmp`, JSON.stringify(packet), 'utf8');
    renameSync(`${target}.tmp`, target);
  } catch {
    // best effort
  }
}

const assistant = (content, parent = null) => ({
  type: 'assistant',
  session_id: sessionId,
  parent_tool_use_id: parent,
  message: { role: 'assistant', model, content, usage: { input_tokens: 0, output_tokens: 0 } },
});
const toolResult = (id, content, parent = null, isError = false) => ({
  type: 'user',
  session_id: sessionId,
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
});

async function main() {
  const userText = readFileSync(0, 'utf8');
  if (process.env.XEZ_MOCK_STDIN_FILE) {
    try {
      appendFileSync(process.env.XEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText, imageCount: (userText.match(/@\S+\.(?:png|jpe?g|gif|webp)/g) ?? []).length })}\n`);
    } catch {
      // best effort
    }
  }
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['read_file', 'edit', 'write_file', 'glob', 'grep_search', 'run_shell_command', 'todo_write', 'agent'],
    mcp_servers: [],
    model,
    permission_mode: 'default',
    qwen_code_version: '0.25.2',
  });
  await sleep(150);
  writeVerdictPacket(userText);
  if (userText.includes('mock:slow')) await sleep(25_000);

  if (userText.includes('mock:auth-error')) {
    const message = '[API Error: 401 Incorrect API key provided. Authentication failed.]';
    emit(assistant([{ type: 'text', text: message }]));
    emit({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [], error: { message } });
    process.exit(1);
  }

  const doneMarker = userText.includes('mock:done') ? '\n\nXEZ:DONE' : '';
  const monitoringMarker = userText.includes('mock:monitoring') ? '\n\nXEZ:MONITORING' : '';
  const askMarker = userText.includes('mock:ask')
    ? '\n\nXEZ:ASK ' + JSON.stringify({
      questions: [{
        header: 'Library',
        question: 'Which date library should I standardize on?',
        options: [{ label: 'date-fns', description: 'Tree-shakeable, functional' }, { label: 'Luxon', description: 'Immutable, tz-aware' }],
      }],
    })
    : '';

  if (!resumed) {
    writeHandoff();
    emit(assistant([{ type: 'thinking', thinking: 'Plan the change, read the file, edit it.', signature: '' }]));
    emit(assistant([{ type: 'tool_use', id: 'call_mock_todo_1', name: 'todo_write', input: { todos: [{ id: 'read', content: 'Read the code', status: 'completed' }, { id: 'edit', content: 'Apply the change', status: 'in_progress' }] } }]));
    emit(toolResult('call_mock_todo_1', 'Todos have been modified successfully.'));
    emit(assistant([{ type: 'tool_use', id: 'call_mock_read_1', name: 'read_file', input: { file_path: 'src/index.ts' } }]));
    emit(toolResult('call_mock_read_1', 'export const answer = 41;\n'));
    emit(assistant([{ type: 'tool_use', id: 'call_mock_edit_1', name: 'edit', input: { file_path: 'src/index.ts', old_string: 'answer = 41', new_string: 'answer = 42' } }]));
    emit(toolResult('call_mock_edit_1', 'The file: src/index.ts has been updated.'));
    emit(assistant([{ type: 'tool_use', id: 'call_mock_agent_1', name: 'tool_call', input: { name: 'agent', arguments: { description: 'Check the tests', prompt: 'Run a quick check', subagent_type: 'general-purpose' } } }]));
    emit(assistant([{ type: 'tool_use', id: 'call_mock_sub_1', name: 'glob', input: { pattern: '**/*.test.ts' } }], 'call_mock_agent_1'));
    emit(toolResult('call_mock_sub_1', 'src/index.test.ts', 'call_mock_agent_1'));
    emit(toolResult('call_mock_agent_1', 'The tests cover the change.'));
  }
  const text = resumed
    ? `Follow-up received: "${userText.slice(0, 100)}". Applied (dry run).${doneMarker}${monitoringMarker}${askMarker}`
    : `Done (dry run): changed the answer to 42.${doneMarker}${monitoringMarker}${askMarker}`;
  emit(assistant([{ type: 'text', text }]));
  await sleep(100);
  emit({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    duration_ms: 400,
    num_turns: 1,
    result: text,
    usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 200, total_tokens: 1280 },
    permission_denials: [],
  });
}

main().then(() => process.exit(0));
