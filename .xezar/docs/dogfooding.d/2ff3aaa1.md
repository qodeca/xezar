# Run 2ff3aaa1 — bug-fix, issue #715 (Minors 1–2 of the #707 re-check)

## What worked

- **A review's own throwaway, handed over as a file, is the cheapest red proof there is.** The
  reviewer (run `23eb256f`) left `zz-reviewer-zombie-throwaway.test.ts` in its evidence directory.
  Turning it into the permanent regression test took one read and one adaptation, and it was RED
  against the pre-fix source on the first run — no re-derivation of the interleaving, no guessing
  at which await the window sits behind. Evidence directories are worth reading before the code.
- **The harness left a slot, and it paid.** `packages/xezar/test/red-proofs.mjs` (from #467/#647)
  took the three new cases as three literals; one command proved all three RED and restored the
  source. On a task whose whole point is "a test written after the diagnosis passes against the
  bug more often than anyone expects", having the proof be a committed, re-runnable artifact
  rather than a transcript is the difference between a claim and a record.

## What cost time

- **`gh issue view <n> --comments` printed nothing and exited 0 on this host.** No error, no body —
  a silent empty success, twice, including with the sandbox disabled. `gh issue view <n> --json
  body,title -q .body` returned the full issue immediately. Any brief or skill that tells an agent
  to read an issue with the plain form should name the `--json` form as the fallback, because the
  failure mode is indistinguishable from an empty issue.

## What the fix itself teaches

- **An async fix opens a window the synchronous shape it replaced did not have.** #707's Major 1
  correctly replaced "skip the removal when superseded" with "remove, then REFRESH from the
  registry". The refresh is async because the remote has to be resolved, and that await is a new
  window in which the row it resolved can go stale. This is AGENTS.md § Changing a mechanism that
  already works, one turn further on: the replacement was right, and it still needed the question
  "what is the NEW mechanism load-bearing for, and what can change under it while it waits?".
- **An assertion that pins two CALLS is not the same as one that pins the PROPERTY, and the gap is
  invisible until you probe it.** RP-5's old form (`add` called, `remove` called) stayed green
  against a refresh that re-adds and then removes again (net absent), and the whole 29-test file
  stayed green against a refresh that never re-seeds the automation coordinator at all. Both probes
  are now cases in the harness. "Which of my new assertions would survive the two most plausible
  next regressions of this seam?" is a question worth asking of every test written from a diagnosis.
