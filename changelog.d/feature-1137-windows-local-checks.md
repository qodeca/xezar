## 🐛 Fixes

- 🐛 **On Windows, saving a workflow names the file, not its full path.** The "Saved" message and
  the delete confirmation split the saved path on `/` only, so a Windows path showed in full. They
  now show the file name on every system. (#1137, #1193)

## 🚀 CI/CD & Infrastructure

- 🚀 **Eight browser test files and the two-project check now pass on Windows.** The browser
  tests start Chrome with animation allowed (a Windows machine with animation effects off made
  Chrome ask every page to reduce motion), keep fixture servers out of the real user folder, and
  handle the Windows MCP pipe and fake agent programs. Two scroll checks and a settings save now
  retry or re-measure instead of failing on a late layout change. The two-project check measures
  the server's status cache from the right moment and compares full folder names, not short 8.3
  names. (#1137, #1193)
