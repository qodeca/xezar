## 🚀 CI/CD & Infrastructure

- 🚀 **Pull request CI runs three fewer runners.** The cross-platform matrix no longer repeats
  the Linux gate that `verify` already runs, and its informational current-LTS canaries on Windows
  and macOS now run only after a merge into `develop`. The four required Windows and macOS legs are
  unchanged, and their timeout comment now cites measured run times instead of first estimates.
  (#1182)
