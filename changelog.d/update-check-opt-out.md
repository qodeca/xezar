## 🔧 Changed

- 🔧 **`XEZ_UPDATE_CHECK=0` skips the startup check for a newer xezar on npm.** It is on by default
  and nothing else changes. xezar's own tests now set it, so a release no longer makes the terminal
  width tests fail until its version bump merges.
