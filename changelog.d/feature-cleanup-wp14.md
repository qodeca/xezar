## 📝 Specs & Documentation

- 📝 **The user guide shows the 0.31.0 cockpit.** Every screenshot and the tour are re-captured
  from 0.31.0 into `docs/screenshots/0.31.0/`, so the removed pi and OpenCode backends no longer
  appear, and the 0.18.0 set is gone. Settings reference gains a Project setup section, Workflows
  lists the variables a step can read (`XEZ_TASK_ID`, `XEZ_STEP_ID`, `XEZ_HANDOFF_FILE`,
  `XEZ_TODOS_FILE`, `XEZ_PR_NUMBER`), and Upgrading gains notes for 0.20.0, 0.30.0 and 0.31.0.
  A unit test now ties every "Describes xezar X." footer to the released version. (#1168)

## 🚀 CI/CD & Infrastructure

- 🚀 **The release version bump restamps the documentation footers.** The Release workflow's
  version-bump commit now moves every "Describes xezar X." footer to the new version next to the
  four manifests, so the footer test passes on the bump PR and releases stay fully automatic.
  (#1168)
