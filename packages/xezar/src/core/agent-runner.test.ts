import { describe, expect, it } from 'vitest';
import { isSignalTerminationExit, isXezarStopExit } from './agent-runner.ts';

describe('isXezarStopExit', () => {
  // exit code → [linux, darwin, win32]
  const table: ReadonlyArray<readonly [number | null, readonly [boolean, boolean, boolean]]> = [
    [130, [true, true, true]],
    [137, [true, true, true]],
    [143, [true, true, true]],
    [1, [false, false, true]],
    [0, [false, false, false]],
    [2, [false, false, false]],
    [127, [false, false, false]],
    [null, [false, false, false]],
  ];

  it.each(table)('exit %j', (code, expected) => {
    const actual = (['linux', 'darwin', 'win32'] as const).map((platform) => isXezarStopExit(code, { platform }));
    expect(actual).toEqual(expected);
  });

  it('adds nothing to isSignalTerminationExit off Windows', () => {
    for (let code = -1; code <= 255; code += 1) {
      expect(isXezarStopExit(code, { platform: 'linux' })).toBe(isSignalTerminationExit(code));
    }
  });
});
