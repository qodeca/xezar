## 🐛 Fixes

- 🐛 **The `auto-resume.test.ts` queue-hold case owns its clock instead of reading a count after a
  fixed sleep.** F-20 of the #671 flake inventory failed once on CI with `expected [...] to have a
  length of 4 but got 5` (run 35110511675): the case drove the real mock CLI and asserted "the
  fifth task never started" 250 ms after a poll, so the claim rested on how fast the machine
  settled, and the count could not tell a working hold from a queue that had quietly drained. The
  case now scripts the limit turn and freezes the usage-limit window on its own clock, reads every
  count after awaiting the store's own change signal (no `expect.poll`, no sleep), and ends by
  releasing the account and watching the fifth run start, so the negative half is falsifiable. No
  production change. PR G of #671. (#671)
