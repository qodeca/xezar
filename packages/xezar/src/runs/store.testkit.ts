import { rmSync } from 'node:fs';

import type { RunStore } from './store.ts';

/**
 * Tear down a fixture's run store and the temporary directory it writes into, in that order.
 *
 * Every suite that opens a `RunStore` over a `mkdtemp` directory and removes that directory in
 * teardown owns the same race, and it is the one behind #631 and #671 rows F-26 and F-29: the
 * store's 300 ms debounced `runs.json` save was still pending when the directory went, so the
 * timer fired into a directory that no longer existed. `RunStore` now treats that as a shutdown
 * rather than an error, which closes the defect for every call site; this helper closes it at the
 * source as well, so a fixture stops writing before its directory goes rather than after.
 *
 * Use it instead of a bare `rmSync` — one helper rather than a `flush()` sprinkled over half the
 * sites and forgotten on the other half.
 */
export function closeStoreAndRemove(store: RunStore | undefined, dir: string | undefined): void {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}
