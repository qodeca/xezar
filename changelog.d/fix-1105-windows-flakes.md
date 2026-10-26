## 🐛 Fixes

- 🐛 **On Windows, saving a workspace setting no longer fails with "could not be saved".** Saving a
  setting, such as switching a provider off, failed while another part of xezar was still reading
  the settings file. The save now waits for that read without freezing xezar, as saving agent
  accounts already did. (#1105)

## 🚀 CI/CD & Infrastructure

- 🚀 **Two tests that failed at random on Windows CI now wait for the right thing.** The
  session-control acceptance test waits for the change summary of the last finished turn before it
  checks that a refused action changed nothing, and the leave-guard test waits for the browser
  history to settle between cases instead of sleeping a fixed 30 ms. (#1105)
