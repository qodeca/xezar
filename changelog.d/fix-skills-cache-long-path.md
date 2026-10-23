## 🐛 Fixes

- 🐛 **Team skills load from a deep project on Windows again.** In a deep project, the skills cache
  clone went past the 260-character Windows path limit, so the clone failed with "Filename too
  long" and the team skills never arrived. xezar now turns on Git's long-path support for its own
  skills commands, whatever the machine's Git config says. A team skills source given as a Windows
  drive path (`C:\…` or `C:/…`) also gets a short cache folder name when its old name was longer
  than 40 characters, because Git for Windows refuses a clone folder whose own path is too long.
  Such a source is cloned once more the next time its skills are loaded or listed, which needs the
  network: offline, that source's team skills are missing until a clone succeeds. Its old cache
  folder stays on disk unused. Every other source – `owner/name`, a URL, a Linux or macOS path –
  keeps its cache folder exactly as it was. (#1134)
