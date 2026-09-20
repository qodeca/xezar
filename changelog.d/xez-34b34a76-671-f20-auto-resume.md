## 🐛 Fixes

- 🐛 **The `auto-resume.test.ts` queue-hold case owns its clock instead of reading a count after a
  fixed sleep, and asserts the account hold itself rather than only its effect.** F-20 of the #671
  flake inventory failed once on CI with `expected [...] to have a length of 4 but got 5` (run
  35110511675): the case drove the real mock CLI and asserted "the fifth task never started" 250 ms
  after a poll, so the claim rested on how fast the machine settled, and the count could not tell a
  working hold from a queue that had quietly drained. The case now scripts the limit turn and
  freezes the usage-limit window on its own clock, reads every count after awaiting the store's own
  change signal (no `expect.poll`, no sleep), and ends by releasing the account and watching the
  fifth run start. Review round 1 found the counts were still explained by `maxParallel: 2` slot
  cycling alone — forcing either gate site (`pump()`'s FIFO check, or `requeueWhileHeld`) to never
  hold left the case green while it reddened a sibling — so the case now also asserts the account is
  REPORTED held, proves a sweep ran with a free slot by starting a run on a second account, and
  exercises the spawn-time gate with in-place runs that are dequeued before the account closes. No
  production change. PR G of #671. (#671)
