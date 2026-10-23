import { describe, expect, it } from 'vitest';
import { UNIX_SOCKET_PATH_MAX_BYTES, socketTempRoot } from './socket-dir.ts';

describe('socketTempRoot', () => {
  const below = '/xez-qwen-XXXXXX/r.sock'.length;

  it('keeps a temp folder that leaves room for the socket, byte for byte', () => {
    const base = '/var/folders/j5/abcdefghijklmnopqrstuvwxyz0000gn/T';
    expect(socketTempRoot(below, base, 'darwin')).toBe(base);
    expect(socketTempRoot(below, base, 'linux')).toBe(base);
    // The exact limit still fits; one byte more does not.
    const edge = `/${'a'.repeat(UNIX_SOCKET_PATH_MAX_BYTES - below - 1)}`;
    expect(socketTempRoot(below, edge, 'darwin')).toBe(edge);
    expect(socketTempRoot(below, `${edge}b`, 'darwin')).toBe('/tmp');
  });

  it('moves a socket out of a temp folder too deep for it on POSIX', () => {
    const deep = `/Users/someone/projects/app/.local/xezar/worktrees/${'x'.repeat(40)}/.local/test-tmp`;
    expect(socketTempRoot(below, deep, 'darwin')).toBe('/tmp');
    expect(socketTempRoot(below, deep, 'linux')).toBe('/tmp');
  });

  it('counts bytes, not characters', () => {
    const base = `/${'é'.repeat(40)}`; // 81 bytes, 41 characters
    expect(socketTempRoot(below, base, 'linux')).toBe('/tmp');
  });

  it('never moves anything on Windows, where sockets are named pipes', () => {
    const deep = `C:\\Users\\someone\\${'x'.repeat(200)}`;
    expect(socketTempRoot(below, deep, 'win32')).toBe(deep);
  });
});
