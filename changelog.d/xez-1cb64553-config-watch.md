## ✨ Features

- ✨ **A hand edit of the workspace config now takes effect without a restart.** A running cockpit
  watches its workspace config file (`~/.xezar/config.json`, or `.xezar/workspace.json` in
  single-project mode) and re-reads the resource limits on the watcher's next delivery of a change —
  whether a person edited the file or another xezar process wrote it. The delivery is usually within
  a quarter of a second, but the operating system's own delivery time is not guaranteed, so a hand
  edit can occasionally take longer. One write's burst is one re-read; a save made in the cockpit
  refreshes immediately from the route and once more from the watch; the lock and backup files
  beside it are ignored. A directory that cannot be watched logs one warning and the cockpit runs
  as before. Part of #677. (xez-1cb64553)
