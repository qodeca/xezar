## ✨ Features

- ✨ **xezar warns when a project's setup collection is too old for it.** A project whose
  `.xezar/onboarding.json` names a `qodeca/xezar-skills` release older than 3.2.0 still reads as set
  up, but Settings → Project setup now says "Setup needs an upgrade", one notice above the page
  links the collection's upgrade guide (Later hides it for the running versions), and
  `discover_project` tells a project leader the same. The setup status gains the additive, nullable
  `olderSetup` field (`recordedVersion`, `minimumVersion`, `upgradeGuideUrl`) on
  `GET /api/v1/onboarding` and in `discover_project.onboarding`; `state` keeps its five values. A
  missing or unreadable version is never called old.

## 🔧 Changed

- 🔧 **The bundled setup templates pin moves to Xezar Skills 3.2.1 (`b86ddf0`).** 3.2.0 is the first
  release that works with xezar 0.30.0. A project last checked against the 3.0.3 pin (`ec856f8`) is
  offered one re-check; a re-check does not upgrade an older setup collection.
