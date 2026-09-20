### 2026-09-20 — an inferred flake mechanism was wrong, and the measurement took twenty minutes

Issue #723 (F-06 of the #671 flake inventory) carried a careful INFERRED mechanism for the
`design-debt-b6.e2e.ts` AC-6 virtual case: `VirtualFiles` measures `startMargin` once, the review
thread above the diff keeps growing, the mapping goes stale and the spec's 40 viewport steps run
out before the last file's rows mount. The row said so itself — "Not proven" — and asked for a red
proof. The measurement says the mechanism is something else entirely.

A probe spec (a scratch copy of the real one, `cp`, never a stash) logged the scroller's geometry
and virtua's mounted card set at every one of the 40 steps. `big.txt` is the FIRST file of that
diff, and `content-visibility` keeps every row of a mounted card in the DOM, so line 420 is present
the moment the card mounts — near the TOP of the list — and is gone from step 13 onward, when the
scroller reaches the bottom and virtua has unmounted it. The loop only ever moves DOWN. So the case
was decided entirely by its FIRST check, before any scrolling: if the thread's own scroll-restore
had already left the scroller past that first card, all forty steps could only make it worse. That
is a one-way ratchet, not a step count that ran out, and no bigger step count would have helped.

The red proof is then deterministic rather than statistical: force the scroller to the bottom until
the card unmounts, and from that one state the old body returns `false` after all 40 steps — the
reported `expected false to be true` — while the rebuilt body returns `true`. `startMargin` was
never stale in any sample: the virtualizer's container top stayed at 1044 px and the first rendered
slot tracked it throughout.

Three things worth keeping:

- **An inventory row's mechanism is a hypothesis with a run-id list attached.** The run ids were
  right and useful; the mechanism was not. The row was honest about which was which, and that
  honesty is what made it cheap to check — twenty minutes of probing against days of arguing.
- **"Scroll N times and then assert" cannot be repaired by raising N** when the thing asserted is
  unmounted by scrolling. The rebuild had to change what the wait waits FOR: content height still
  for ten animation frames, then the scroller parked at the virtual list's own measured start, then
  the card's own arrival.
- **`npm run test:e2e -- <spec>` does not narrow the browser suite to one spec.** `scripts/e2e.sh`
  forwards its arguments to `test-env-up.sh`, which rejects anything that is not `--force` /
  `--force-rebuild`, and then runs the whole suite anyway. Narrowing is
  `sh scripts/test-env-up.sh` once, then
  `npm test -- --config packages/web/e2e/vitest.config.ts <filter>`. Worth a line in the briefs.
