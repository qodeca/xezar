import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package name this copy of xezar was installed as.
 *
 * Read from the running package rather than spelled in the callers, so a line a person copies
 * cannot drift from what npm actually installs. `@qodeca/xezar` is only the fallback for a
 * package.json that cannot be read.
 */
export function readOwnName(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { name?: string };
    return pkg.name ?? '@qodeca/xezar';
  } catch {
    return '@qodeca/xezar';
  }
}

/**
 * The `npx <name>` command line a person can copy, always SCOPED (#819 F1).
 *
 * This is a security property rather than tidiness: the bare unscoped name asks the registry for a
 * package nobody here publishes, so anyone could publish it and a person following our own line
 * would run their code. Every shipped string that tells somebody to start xezar goes through this
 * one helper — `unscoped-package-scan.test.ts` fails the build if a bare name comes back.
 */
export function npxCommand(): string {
  return `npx ${readOwnName()}`;
}
