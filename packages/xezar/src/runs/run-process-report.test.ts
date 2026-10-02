import { describe, expect, it } from 'vitest';
import { REDACTED } from '../core/secret-redaction.ts';
import {
  REPORT_COMMAND_MAX,
  REPORT_LIST_MAX,
  buildSweepReport,
  redactCommandLine,
  type ReportedProcess,
} from './run-process-report.ts';

const GH_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

/** Every run of `size` characters of `secret`: none of them may reach the note. */
function fragments(secret: string, size = 6): string[] {
  return Array.from({ length: secret.length - size + 1 }, (_, at) => secret.slice(at, at + size));
}

function expectNoTrace(text: string, secret: string): void {
  for (const fragment of fragments(secret)) expect(text).not.toContain(fragment);
}

describe('redactCommandLine', () => {
  it('leaves an ordinary command as it is', () => {
    expect(redactCommandLine('node server.js --port 3000', [])).toBe('node server.js --port 3000');
    expect(redactCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\dev.js" --watch', [])).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\dev.js" --watch',
    );
  });

  it("masks the host's own secret values and known token shapes", () => {
    const hostSecret = 'hunter2-hunter2-hunter2';
    const text = redactCommandLine(`deploy --target prod ${hostSecret} ${GH_TOKEN}`, [hostSecret]);
    expect(text).toBe(`deploy --target prod ${REDACTED} ${REDACTED}`);
  });

  it.each([
    ['NAME=v', 'env GITHUB_TOKEN=plainvalue123 node app.js', `env GITHUB_TOKEN=${REDACTED} node app.js`],
    ['--flag=v', 'cli --api-key=plainvalue123 run', `cli --api-key=${REDACTED} run`],
    ['--flag v', 'cli --password plainvalue123 run', `cli --password ${REDACTED} run`],
    ['-flag v', 'cli -token plainvalue123', `cli -token ${REDACTED}`],
    ['--flag "quoted value"', 'cli --secret "plain value 123" run', `cli --secret ${REDACTED} run`],
    ['NAME="quoted value"', 'DB_PASSWORD="two words" psql', `DB_PASSWORD=${REDACTED} psql`],
    ['a query parameter', 'curl https://api.example.test/x?access_token=plainvalue123', `curl https://api.example.test/x?access_token=${REDACTED}`],
    ['URL userinfo', 'git clone https://someone:plainvalue123@example.test/r.git', `git clone https://${REDACTED}@example.test/r.git`],
    ['a Bearer header', 'curl -H "Authorization: Bearer plainvalue123" x', `curl -H "Authorization: Bearer ${REDACTED}" x`],
    ['a JWT', `worker --jwt-in ${JWT}`, `worker --jwt-in ${REDACTED}`],
  ])('masks %s', (_label, command, expected) => {
    expect(redactCommandLine(command, [])).toBe(expected);
  });

  it('does not treat an ordinary flag as a secret one', () => {
    expect(redactCommandLine('vite --host 0.0.0.0 --port=5173 KEYBOARD=us', [])).toBe('vite --host 0.0.0.0 --port=5173 KEYBOARD=us');
  });

  it('flattens control characters, so a command cannot forge another line of the note', () => {
    expect(redactCommandLine('node a.js\nStopped 0 programs\t\u0007x', [])).toBe('node a.js Stopped 0 programs x');
  });

  it(`cuts to ${REPORT_COMMAND_MAX} characters, never inside a character`, () => {
    const text = redactCommandLine(`run ${'x'.repeat(300)}`, []);
    expect(Array.from(text)).toHaveLength(REPORT_COMMAND_MAX);
    expect(text.endsWith('…')).toBe(true);
    const emoji = redactCommandLine(`${'y'.repeat(198)}😀😀😀`, []);
    expect(Array.from(emoji)).toHaveLength(REPORT_COMMAND_MAX);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('redacts before it cuts: a token straddling character 200 leaves nothing behind (SEC-6)', () => {
    for (const start of [185, 190, 195, 198, 199]) {
      const command = `${'a'.repeat(start - 1)} ${GH_TOKEN} --tail`;
      const text = redactCommandLine(command, []);
      expect(Array.from(text).length).toBeLessThanOrEqual(REPORT_COMMAND_MAX);
      expectNoTrace(text, GH_TOKEN.slice(4));
    }
    const named = `${'b'.repeat(185)} --token=${'s3cr3tvalue'.repeat(4)} x`;
    expectNoTrace(redactCommandLine(named, []), 's3cr3tvalue'.repeat(4));
    const jwt = `${'c'.repeat(190)} ${JWT}`;
    expectNoTrace(redactCommandLine(jwt, []), JWT.slice(3));
  });
});

describe('buildSweepReport', () => {
  const server: ReportedProcess = { pid: 4121, command: 'node server.js' };
  const watcher: ReportedProcess = { pid: 4133, command: 'esbuild --watch' };

  it('says nothing when nothing was found', () => {
    expect(buildSweepReport({ stopped: [], unstoppable: [] })).toBeNull();
  });

  it('names what it stopped and what it could not, with why', () => {
    expect(
      buildSweepReport({
        stopped: [server, watcher],
        unstoppable: [{ pid: 5000, command: 'python3 -m http.server', reason: 'still-running' }],
      }),
    ).toBe(
      'Stopped 2 programs this task started: 4121 node server.js; 4133 esbuild --watch. Could not stop 1: 5000 python3 -m http.server (still running).',
    );
  });

  it('reads well for one program, for only unstoppable ones, and without a command', () => {
    expect(buildSweepReport({ stopped: [server], unstoppable: [] })).toBe('Stopped 1 program this task started: 4121 node server.js.');
    expect(buildSweepReport({ stopped: [], unstoppable: [{ pid: 77, reason: 'access-denied' }, { ...watcher, reason: 'still-running' }] })).toBe(
      'Could not stop 2 programs this task started: 77 (access denied); 4133 esbuild --watch (still running).',
    );
  });

  it(`names at most ${REPORT_LIST_MAX} per list and counts the rest`, () => {
    const many = Array.from({ length: REPORT_LIST_MAX + 1 }, (_, index) => ({ pid: 1000 + index }));
    const text = buildSweepReport({ stopped: many, unstoppable: [] })!;
    expect(text).toContain(`Stopped ${REPORT_LIST_MAX + 1} programs`);
    expect(text).toContain(`1049; and 1 more.`);
    expect(text).not.toContain('1050');
  });
});
