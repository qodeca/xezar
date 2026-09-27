## 💥 Breaking

- 💥 **"Set up this project" and "Re-check now" run the Xezar Skills 3.0.3 onboarding only.** The
  built-in `project-setup` workflow – the cockpit buttons and the leader's `task_create` – now
  runs `xez-onboard-opinionated` instead of the retired `xez-onboard`, and the bundled setup
  templates pin moves from `2c20c60` to the 3.0.3 release (`ec856f8`). A project last checked
  against the old pin is offered one re-check, and that re-check runs the 3.0.3 onboarding; a
  project set up with an older kit no longer gets the old setup skill.

## ✨ Features

- ✨ **A project onboarded outside the cockpit reads as set up.** When a project carries the 3.0.3
  install record, `.xezar/onboarding.json`, the cockpit's Project setup card and the MCP's
  onboarding answer report it as set up and offer neither first-time setup nor a re-check. A
  missing or malformed record changes nothing.

- ✨ **A 3.0.3 project can file issues through its own kit role.** The issue-filing check now
  accepts any skill named by the `-issue-create` convention – the project's own role first, then
  the shared `xez-issue-create` – or the project's `issue-filing` workflow, and reports the skill a
  filing task would select.
