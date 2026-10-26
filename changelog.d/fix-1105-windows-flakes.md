## 🚀 CI/CD & Infrastructure

- 🚀 **Three tests that failed at random on Windows CI now wait for the right thing.** Saving a
  workspace setting, such as switching a provider off, no longer fails on Windows while another
  part of xezar is still reading the settings file: the save now waits for that read without
  freezing xezar, as saving agent accounts already did. The session-control acceptance test waits
  for the change summary of the last finished turn before it checks that a refused action changed
  nothing, and the leave-guard test waits for the browser history to settle between cases instead
  of sleeping a fixed 30 ms. (#1105)
