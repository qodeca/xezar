# Dogfooding fragments

One file per task, named for the first eight characters of its run id (`e3c4f765.md`). It holds one
dated real-task entry, using the same record template the entries in `../dogfooding.md` use:

```md
### 2026-09-19 — <what the task was>, `<workflow>` step `<step>`, `xezar-<skill>`, <backend/model> — real-task observed
- Input: ...
- Observed: ...
- Regression/control: ...
- Remaining limit: ...
```

Why fragments: `../dogfooding.md` is a ledger every writing task appends to at the top, so two open
pull requests conflict on those exact lines — and a content conflict stops GitHub from running CI.
No two branches ever touch the same fragment bytes.

The `changelog` step of the `release` workflow folds every fragment into the ledger, newest first,
above the entries already there, and deletes the files in the same commit. Existing dated entries
are records: they are never rewritten, moved or reformatted. This `README.md` is skipped.
