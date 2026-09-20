## 📝 Specs & Documentation

- 📝 **The release-recovery list now names all four manifests, and two release claims match the
  code they describe.** `docs/publishing.md` told a maintainer to hand-bump `version` in
  `packages/contract`, `packages/api-client` and `packages/xezar` when the version-bump PR was not
  opened; the release stamps four — `scripts/release.mjs` reads `contract`, `apiClient`, `web` and
  `xezar` and `.github/workflows/release.yml` stages all four `package.json` files — so
  `packages/web` is now in the list. The same page said Xezar "kills every non-final agent step at
  30 minutes"; an earlier agent step with no `timeout` of its own falls through to the runner's
  30-minute default, and an explicit `timeout` overrides it, so the qualification is now stated.
  It also described the generic-instructions guard and the `check:pack` packed-archive scan as
  something [PR #481](https://github.com/qodeca/xezar/pull/481) "adds"; that PR merged
  2026-09-16, so the wording is past tense and names the landed build leg. Finally,
  `BACKWARD_COMPATIBILITY.md` section 1 listed `--single-project` but not its counterpart
  `--global-layout` (#657, unreleased — ships in 0.17.0), so the protected-flags list and the
  single-project section now both name it. Docs only: no behaviour change. PR 2 of 4 for #447.
