## 🚀 CI/CD & Infrastructure

- 🚀 **CI and the nightly mutation gate are ready for a `develop` default branch.** CI now runs
  for pull requests and pushes on `develop` as well as `main`. A new **PR source guard** job lets
  only `promote/*`, `release/v*` and `hotfix/*` branches target `main` while another branch is the
  default, and checks nothing under the trunk model. The nightly follows the repository's default
  branch instead of a hard-coded `main`, and compares its survivors with the last `main` run on the
  night the default branch moves. (qodeca/xezar-skills#248)
