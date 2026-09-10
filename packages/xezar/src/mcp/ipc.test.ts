import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineFramer, mcpSocketLocation } from './ipc.ts';
import { negotiateProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.ts';

describe('mcpSocketLocation (D-01 § 1.3–1.4)', () => {
  const project = { id: 'shop', root: '/work/shop' };

  it('is <XEZ_HOME>/ipc/<projectId>.sock when it fits', () => {
    expect(mcpSocketLocation(project, { XEZ_HOME: '/h' }, 'darwin')).toEqual({ kind: 'socket', path: '/h/ipc/shop.sock' });
  });

  it('falls back to 12 hex characters of SHA-256(root) past the OS limit', () => {
    // Project ids run to 64 characters. 104 bytes is the measured macOS limit (D-01 E5):
    // `/<36 x a>/ipc/<60 x p>.sock` is 107 bytes.
    const long = { id: 'p'.repeat(60), root: '/work/long' };
    const home = `/${'a'.repeat(36)}`;
    const hash = createHash('sha256').update(long.root).digest('hex').slice(0, 12);
    expect(mcpSocketLocation(long, { XEZ_HOME: home }, 'darwin')).toEqual({
      kind: 'socket',
      path: join(home, 'ipc', `${hash}.sock`),
    });
    // Linux allows 107, so the same path still fits there.
    expect(mcpSocketLocation(long, { XEZ_HOME: home }, 'linux')).toEqual({
      kind: 'socket',
      path: join(home, 'ipc', `${long.id}.sock`),
    });
  });

  it('reports a readable reason when even the fallback is too long, and on Windows', () => {
    const tooLong = mcpSocketLocation(project, { XEZ_HOME: `/${'a'.repeat(120)}` }, 'darwin');
    expect(tooLong).toMatchObject({ kind: 'unavailable' });
    expect(tooLong.kind === 'unavailable' && tooLong.reason).toMatch(/too long.*XEZ_HOME/);
    expect(mcpSocketLocation(project, { XEZ_HOME: '/h' }, 'win32')).toMatchObject({ kind: 'unavailable' });
  });
});

describe('LineFramer', () => {
  const collect = (max?: number) => {
    const frames: string[] = [];
    let oversize = 0;
    const framer = new LineFramer((l) => frames.push(l), () => oversize++, max);
    return { framer, frames, oversize: () => oversize };
  };

  it('reassembles frames split across chunks and strips CRLF and blank lines', () => {
    const { framer, frames } = collect();
    framer.push(Buffer.from('{"a":1}\r\n{"b"'));
    framer.push(Buffer.from(':2}\n\n{"c":3}'));
    framer.push(Buffer.from('\n'));
    expect(frames).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('skips an oversize frame up to its newline, reports it once and keeps working', () => {
    const { framer, frames, oversize } = collect(8);
    framer.push(Buffer.from('0123'));
    framer.push(Buffer.from('456789ab'));
    framer.push(Buffer.from('cdef\nok\n'));
    expect(frames).toEqual(['ok']);
    expect(oversize()).toBe(1);
  });
});

describe('negotiateProtocolVersion (D-01 § 1.6)', () => {
  it('echoes both revisions the three required clients offer', () => {
    expect(negotiateProtocolVersion('2025-06-18')).toBe('2025-06-18'); // Codex (D-01 E3)
    expect(negotiateProtocolVersion('2025-11-25')).toBe('2025-11-25'); // Claude Code, OpenCode (E1, E2)
  });

  it('answers the newest supported revision for anything else and lets the client decide', () => {
    expect(negotiateProtocolVersion('2024-11-05')).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocolVersion(undefined)).toBe('2025-11-25');
  });
});
