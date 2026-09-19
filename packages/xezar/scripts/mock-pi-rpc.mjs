#!/usr/bin/env node
import readline from 'node:readline';

/**
 * The options `buildPiArgs` emits, each taking a separate value. The mock parses argv and REFUSES
 * an option it does not know, the way the real CLI does — otherwise the dry-run path accepts any
 * argv and a flag that is fatal against the real binary ships green (#548).
 */
const VALUE_OPTIONS = new Set([
  '--mode',
  '--mcp-config',
  '--session',
  '--session-id',
  '--append-system-prompt',
  '--model',
  '--tools',
  '--extension',
]);

/** The bundled worktree-guard extension's own options, which pi spells `--flag=value`. */
const EXTENSION_PREFIXES = ['--xezar-worktree-root=', '--xezar-primary-root=', '--xezar-allowed-roots='];

/**
 * `--mcp-config` is listed here because the mock stands in for a pi WITH the optional
 * `pi-mcp-adapter` extension installed, which is what the dry-run path has always exercised.
 * `piSupportsMcpConfig` reads this text, so dropping the line switches dry runs to the
 * extension-absent path instead.
 */
const HELP = [
  'Usage: pi [options]',
  '  --mode <value>                 Run mode (rpc)',
  '  --mcp-config <value>           Path to MCP config file',
  '  --session <value>              Resume a session',
  '  --session-id <value>           Start with a session id',
  '  --append-system-prompt <value> Extra system prompt',
  '  --model <value>                Model id',
  '  --tools <value>                Allowed tools',
  '  --extension <value>            Load an extension',
  '  --help                         Show this help',
  '  --version                      Show the version',
].join('\n');

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--help') {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (arg === '--version') {
    process.stdout.write('0.0.0-mock\n');
    process.exit(0);
  }
  if (VALUE_OPTIONS.has(arg)) {
    i += 1;
    continue;
  }
  if (EXTENSION_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
  if (arg.startsWith('-')) {
    process.stderr.write(`Error: Unknown option: ${arg}\n`);
    process.exit(1);
  }
}

const sessionId = '00000000-0000-4000-8000-0000000000pi';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
    });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: `Investigating: ${command.message}`,
        partial: {},
      },
    });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: `Investigating: ${command.message}`,
        partial: {},
      },
    });
    send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
    send({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'mock file' }] },
      isError: false,
    });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.001 },
        },
      },
    });
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
