#!/usr/bin/env node
// Stub `claude` binary for #943: it answers every message with a finished turn that ends in
// `XEZ:DONE`, so xezar closes the session – and then it never exits on its own. It ignores stdin
// EOF (the CLI hang the EOF watchdog exists for) and handles SIGTERM itself, exiting 143, as the
// real CLI does. Set as XEZ_CLAUDE_BIN.
import { createInterface } from 'node:readline';

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.on('SIGTERM', () => process.exit(143));

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'work done\n\nXEZ:DONE' }] } });
  emit({ type: 'result', subtype: 'success', result: 'work done', usage: { input_tokens: 10, output_tokens: 5 } });
});

// Keep the event loop alive and stay deaf to EOF, exactly like the real hang.
process.stdin.on('end', () => {});
setInterval(() => {}, 60_000);
