// The adapters' source guards (`claude-code.test.ts`, `qwen-code.test.ts`) read an adapter's own
// file as text and forbid a process, an environment read or a Node import in it. Both guards read
// the file through `guardedCode`, so a comment that names a forbidden word is not a regression. A
// testkit rather than a helper inside one test file, because importing a `.test.ts` file would run
// its suite twice; `*.testkit.ts` is outside the coverage floor.

/** The adapter's code as the source guard reads it: comments removed. */
export function guardedCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
