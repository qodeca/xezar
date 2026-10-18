## 🚀 CI/CD & Infrastructure

- 🚀 **The Release workflow builds and publishes in separate jobs.** A read-only `build` job
  installs, tests, builds and packs the release tarball; the `publish` job (environment
  `production`, the only holder of the npm identity) installs nothing, checks the tarball's
  SHA-256 and publishes exactly those bytes with provenance. The tag and GitHub Release are now
  created right after the publish and before the version-bump PR, and the run summary reports
  each of the three from its own step's outcome.
- 🚀 **CI runs one pinned, checksum-verified agent-browser.** The `ui-e2e` job downloads a fixed
  release instead of `latest`, runs the binary only when its SHA-256 matches the pinned value
  (cached copies included), and keys the browser cache on that version.
- 🚀 **CI also runs for `release/**` maintenance branches**, on pull requests and pushes, so a
  fix bound for a patch line is verified before the Release workflow ships it.
- 🚀 **The npm package ships only the scripts the CLI runs.** `@qodeca/xezar` now carries the two
  dry-run mocks and the two bundled tool-policy hooks from `scripts/`, not the build, release and
  test helpers beside them (12 files down to 4).
- 🚀 **Dependabot proposes weekly dependency updates into `develop`.** npm (all workspaces) and the
  pinned workflow actions, minor and patch grouped into one pull request per ecosystem, majors
  on their own, each version at least a week old.

## 🔒 Security

- 🔒 **Dependency updates for published advisories.** `npm audit fix` (no forced majors) moves
  `smol-toml` to 1.9.1 (runtime dependency of the CLI) and, in the cockpit, `mermaid` to 11.17.2
  and `dompurify` to 3.4.17. `katex` stays at 0.16.47: the fixed release is outside the range
  `mermaid` 11 accepts, and needs a `streamdown`/`mermaid` major update of its own.
