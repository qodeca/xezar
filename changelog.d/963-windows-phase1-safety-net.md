## 💥 Breaking

- 💥 **xezar needs Node.js 22 or newer.** The supported range moves from Node 20 and later to
  Node 22 and later; Node 20 reached end of life on 30 April 2026. On Node 20, npm warns
  `EBADENGINE` at install, or refuses with `engine-strict` set. Upgrade to Node 22 or the current
  LTS. (#963)

## 📝 Specs & Documentation

- 📝 **Prerequisites per operating system.** The README's Quick start and the getting-started
  guide list what each system needs, including WSL on Windows; the contributing guide lists the
  extra tools a Windows contributor needs. (#963)

## 🚀 CI/CD & Infrastructure

- 🚀 **CI also verifies Node 22, Windows and macOS.** A new job repeats the validation steps on
  Linux with Node 22, and on Windows and macOS with Node 22 and the current LTS. It is not a
  required check, the Windows and macOS legs never fail the run, and the five required checks
  keep their names. (#963)
- 🚀 **Line endings are fixed by the repository.** A new `.gitattributes` checks text out with LF
  on every system and marks images and fonts binary, so a Windows clone holds the same bytes as
  Linux and macOS. (#963)
- 🚀 **Tests no longer assume a POSIX machine where they do not need one.** Temporary homes,
  folder links and npm calls in the test suites go through a small shared helper that keeps the
  exact Linux and macOS behavior; every remaining Windows skip names its reason and #963. (#963)
