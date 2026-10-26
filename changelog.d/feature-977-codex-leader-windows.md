## ✨ Features

- ✨ **A running Codex session can be the project leader on Windows.** Attaching it was refused
  there with "not available on this system yet". Codex listens on the same local socket on
  Windows as on macOS and Linux, but Node cannot open that kind of socket on Windows, so xezar now
  connects through Codex's own relay, `codex app-server proxy`, while the leader is attached and
  stops it afterwards. The same checks apply as on macOS and Linux: the socket must belong to you,
  in a folder only you can open, and the app-server must confirm the Codex home and the session.
  (#977, #1195)
