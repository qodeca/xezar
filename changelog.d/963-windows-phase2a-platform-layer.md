## 💥 Breaking

- 💥 **On Windows, team skill sources on a network share are refused.** `//server/share/…` and
  every file URL except a local drive one (`file:///C:/…`) are no longer fetched, because opening
  one sends your Windows sign-in to that server; use an https or ssh address or a local copy.
  Linux and macOS are unchanged. (#963)
- 💥 **On Windows, the project folder is shown in Windows form.** Health's `repoRoot`, the start
  banner and the audit records show `C:\…` instead of Git's `C:/…`, so a script that compared them
  with a `C:/…` string no longer matches; compare with `C:\…`, or normalize both sides. Linux and
  macOS are unchanged. (#963)

## 🔒 Security

- 🔒 **Windows: a project can no longer run its own copy of Git.** Windows looked for a program in
  the project folder before the system path, so a repository containing a file such as `git.exe`
  could have it run when xezar called Git. xezar now turns that lookup off for itself and the
  programs it starts; in a Command Prompt that xezar or an agent starts, start a program in the
  current folder as `.\name`. (#963)
- 🔒 **Windows: the `.git` folder stays private in every spelling.** The file view refuses `.GIT`,
  `.git.` and other spellings Windows opens as the `.git` folder. (#963)

## ✨ Features

- ✨ **Windows long-path check.** On Windows, `xezar serve` checks once, after it starts, whether
  long file paths are on in Windows and in Git, and prints one warning with the fix when either is
  off. A task whose working copy fails with "Filename too long" carries the same fix in its failure
  reason. Nothing changes on Linux or macOS. (#963)

## 🐛 Fixes

- 🐛 **Windows project folders are kept and accepted.** A project saved with a drive-letter or
  network path (`C:\…`, `\\server\share\…`) no longer disappears on the next start, and Add
  project, clone and the folder settings accept these paths. Two spellings of one folder, such as
  `c:\Repo` and `C:\repo`, count as one project. Linux and macOS are unchanged. (#963)
- 🐛 **Saving on Windows survives a briefly locked file.** When antivirus or search indexing holds a
  file xezar is replacing, xezar retries for up to about a second, and it replaces a file marked
  read-only, as Linux and macOS already do. If the file stays locked, the error names it and the
  likely cause. Linux and macOS still make one attempt. On every system, a save that fails now
  removes its temporary file instead of leaving it next to the file it was replacing. (#963)
- 🐛 **`~\` means your home folder on Windows.** Folder fields and local skill sources expand `~\…`
  on Windows the way they expand `~/…` everywhere. (#963)
