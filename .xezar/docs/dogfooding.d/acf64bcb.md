### 2026-09-20 — rebuilding the task-thread tool-card and diff-scroll sticky waits (#671 PR B)

- **The brief's own iteration command does not work, and the docs already say so.**
  `npm run test:e2e -- <spec>` forwards the extra argument to `scripts/test-env-up.sh`, which
  rejects any unknown flag (`unknown flag: diff-scroll`, exit 2) — the e2e wrapper takes no file
  filter at all. `docs/testing/agent-browser.md` § Iterating on one spec has the working recipe
  (boot once with `sh scripts/test-env-up.sh`, then
  `npm test -- --config packages/web/e2e/vitest.config.ts <spec>`, then
  `sh scripts/test-env-down.sh`). Worth aligning the brief template with the doc rather than
  letting each agent rediscover the refusal.
- **F-09's inventory row proposed a fix the file had already received, and the residue was a
  different shape.** Row F-09 says the spec "steps and hopes" and proposes measured geometry;
  `c0ce42a5` (#467) had already added a measured-geometry aim on 2026-09-16, before the row's last
  observed failure. What remained was the fixed `scrollTop = 900` and an aim that returns true
  after ONE assignment whether or not it worked — from the end of the list that assignment is
  clamped away entirely and the fold is left in the gap between two cards. Reading the source
  before editing was what separated the two.
- **The F-08 rebuild is a DOM click, deliberately, and it removes the race instead of narrowing
  it.** A `browser.click(selector)` re-reads a live box and then hit-tests it, so a click issued
  while the transcript replays can land on a neighbour; `trigger.click()` inside the wait's own
  page task has no point to lose, and the wait succeeds only when the card reports
  `data-state="open"`. The spec already used the same DOM click two cases earlier (the check-step
  card), so this is the file's own idiom, not a new one.
- **Both red proofs force the inventory's named condition deterministically, with no synthetic
  CPU load.** F-08: a real pointer tap lands on the neighbouring execute card's trigger, and the
  pre-fix wait then times out at the harness budget. F-09: at the end of the list a transform
  moves the rendered list so the fold falls in the gap between two cards (the scroller cannot move
  further down), the pre-fix aim is clamped and leaves no straddling card, and the rebuilt wait
  scrolls back to a measured card centre. Both scratch files and their run logs are in the primary
  evidence directory; each ran green three times.
