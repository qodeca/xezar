import { z } from 'zod';

import { clampSlots } from './core/gate-lease.ts';

/**
 * `xezar lease gates --probe` (#838 item B) — the capability check a caller runs instead of
 * reading the usage text.
 *
 * Before this, the only way a script could tell "this xezar can lease gate slots" from "this
 * xezar is too old" was to run the verb wrongly and look for the `usage: xezar lease gates …`
 * line on stderr. That turned a sentence written for a person into a contract nobody had agreed
 * to. The probe is the agreed one: one JSON object, one line, on stdout, exit 0.
 *
 * It reports CAPABILITY, not health. It never looks at the slot directory, takes no slot and
 * writes no file — not a lock, not a state file, not the first-run import — so a missing or
 * unwritable `~/.cache/xez/gate-slots/` gives the same answer as a healthy one. That matches what
 * the verb itself does with such a directory: it runs the command anyway (fail-open), so the
 * capability is there either way.
 *
 * WHY THE SHAPE IS PINNED HERE and not in `packages/contract`: that package is the HTTP contract,
 * and every CLI JSON shape this engine prints is pinned beside the command that prints it — the
 * `state-names --json` payload in `local-xezar-top-level-names.ts`, the `--status-file` line in
 * `index.ts`. `lease-probe.test.ts` pins the exact bytes.
 */
export const leaseProbeSchema = z
  .object({
    /** Which leases this xezar can take. `gates` is the only one today. */
    lease: z.object({ gates: z.literal(true) }).strict(),
    /** How many gate runs may hold a slot at once, as resolved: `resources.gateSlots`, else 1. */
    slots: z.number().int().min(1).max(16),
  })
  .strict();

export type LeaseProbe = z.infer<typeof leaseProbeSchema>;

/** The one usage line of the probe, printed to stderr on every refusal. */
export const LEASE_PROBE_USAGE = 'usage: xezar lease gates --probe';

/** The probe's answer for a stored `resources.gateSlots` (absent → the default of 1). */
export function leaseProbe(storedGateSlots: number | undefined): LeaseProbe {
  return { lease: { gates: true }, slots: clampSlots(storedGateSlots) };
}

/** The exact bytes the probe prints: one compact JSON object and one trailing newline. */
export function leaseProbeJson(probe: LeaseProbe): string {
  return `${JSON.stringify(leaseProbeSchema.parse(probe))}\n`;
}
