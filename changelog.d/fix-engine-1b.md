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
