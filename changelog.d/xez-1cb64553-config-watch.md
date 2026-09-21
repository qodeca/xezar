## ✨ Features

- ✨ **A hand edit of the workspace config now takes effect without a restart.** A running cockpit
  watches its workspace config file (`~/.xezar/config.json`, or `.xezar/workspace.json` in
  single-project mode) and re-reads the resource limits within a quarter of a second of a change —
  whether a person edited the file or another xezar process wrote it. One write is one re-read;
  the lock and backup files beside it are ignored. A directory that cannot be watched logs one
  warning and the cockpit runs as before. Part of #677. (xez-1cb64553)
