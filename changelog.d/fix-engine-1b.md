## 🐛 Fixes

- 🐛 **A headless `xezar run` no longer cancels the recovery of other tasks.** It marked every
  queued, running or waiting task in the project as failed, so the next `xezar serve` had nothing
  to resume and dropped the list of programs those tasks had started without stopping them. A
  headless run now touches only the task it creates.
- 🐛 **A queued task keeps its own system prompt across a restart.** A task's extra system prompt
  (automations set one) was saved only when the task started, so a task still waiting in the queue
  when xezar restarted ran with the project default instead. It is now saved when the task is
  created.
- 🐛 **A monitoring session no longer stays open forever.** A session that reports it is still
  watching background work is woken up to 40 times; after the last wake-up nothing could end it
  except a person typing. It now closes after the usual idle timeout once the wake-ups run out.
- 🐛 **Worktree clean-up no longer removes the working copy of a task that was just continued.** The
  clean-up picks every old finished worktree first and removes them one at a time; a task
  continued in between lost its isolated working copy (Git worktree). Each removal now checks
  again that the task is still finished and not running, and a Continue that arrives during a
  removal waits for it and then restores the working copy before it starts.
- 🐛 **A check step that reads its input no longer hangs.** A workflow check ran with an open input
  that nothing ever wrote to or closed, so a command that asks a question or reads its input waited
  forever. A check step now has no input at all, on Linux, macOS and Windows (Git Bash).
