## ✨ Features

- ✨ **`xezar state-names` tells you which names xezar writes at the top of a project's
  `.local/xezar/` folder.** Run it plain for a table to read, or `xezar state-names --json` for the
  published form a check of your own can parse — the names with their kind, the suffixes a name may
  carry and the audit trail's numbered rotations, with no regular expression in it, so an ordinary
  shell pattern is enough. A project that guarded that folder with a hand-copied list can now read
  the list from the version it has installed, and stop copying. Standard output carries the listing
  and nothing else, it reads no project and writes no file, and the `--json` bytes are a fixed
  surface recorded in `BACKWARD_COMPATIBILITY.md`. (#852)
