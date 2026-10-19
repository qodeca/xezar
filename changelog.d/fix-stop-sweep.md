## 🐛 Fixes

- 🐛 **Every way xezar stops a task now also stops the programs the task started.** Before, only a
  cancel, a memory-limit pause and a step's time limit did; a session closed after inactivity, a
  session the user closed with Finish, an autonomous turn closed at its nudge limit (a read-only
  step's finish included), an agent error, and an agent program that xezar had to stop because it
  did not exit after its session closed left a background program such as a dev server running. A
  task whose agent finishes on its own is still left alone. (#943)
