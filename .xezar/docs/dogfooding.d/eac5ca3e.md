### 2026-09-23 — Review evidence must outlive its run

- The review-response brief named a QA evidence directory that no longer existed even though the
  QA worktree and NDJSON transcript remained. The real captured provider reply was recoverable
  from the transcript, but durable review inputs should be copied into the primary evidence
  directory before the producing task finishes.
- The review-response worktree started at the current base rather than the reviewed PR tip. With
  no unique task commits, restoring the task branch to the immutable reviewed tip before the
  guarded base merge preserved the required ancestry and left the author's checkout untouched.
