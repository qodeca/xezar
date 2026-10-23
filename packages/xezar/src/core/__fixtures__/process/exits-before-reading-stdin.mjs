#!/usr/bin/env node
// Stub agent that exits with an error before it reads anything from stdin, so a large first
// message written to it fails with EPIPE. The runner must report a failed step, not crash.
process.stderr.write('stub: exited before reading its input\n');
setTimeout(() => process.exit(1), 200);
