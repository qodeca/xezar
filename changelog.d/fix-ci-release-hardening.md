## 🚀 CI/CD & Infrastructure

- 🚀 **The Release workflow builds and publishes in separate jobs.** A read-only `build` job
  installs, tests, builds and packs the release tarball; the `publish` job (environment
  `production`, the only holder of the npm identity) installs nothing, checks the tarball's
  SHA-256 and publishes exactly those bytes with provenance. The tag and GitHub Release are now
  created right after the publish and before the version-bump PR, and the run summary reports
  each of the three from its own step's outcome.
- 🚀 **CI and the local test environment run one pinned, checksum-verified agent-browser.** The
  release and the SHA-256 of each asset live in `scripts/agent-browser-pin.sh`, read by the
  `ui-e2e` job, `scripts/test-env-up.sh` and the install snippets in the testing docs. None of
  them installs `latest`; a binary runs only when it matches (cached copies included), with
  `sha256sum`, `shasum` or `openssl`, whichever the machine has. The CI browser cache is keyed on
  the pin.
- 🚀 **CI also runs for `release/**` maintenance branches**, on pull requests and pushes, so a
  fix bound for a patch line is verified before the Release workflow ships it.
- 🚀 **The npm package ships only the scripts the CLI runs.** `@qodeca/xezar` now carries the two
  dry-run mocks and the two bundled tool-policy hooks from `scripts/`, not the build, release and
  test helpers beside them (12 files down to 4).
- 🚀 **Dependabot proposes weekly dependency updates into `develop`.** npm (all workspaces) and the
  pinned workflow actions, minor and patch grouped into one pull request per ecosystem, majors
  on their own, each version at least a week old.

## 🔒 Security

- 🔒 **Dependency updates for published advisories.** `npm audit fix` moves `smol-toml` to 1.9.1
  (runtime dependency of the CLI), and the cockpit's `streamdown` moves to 2.7.0 (same major),
  which no longer depends on `mermaid`; the cockpit never rendered diagrams, and with it go
  `katex`, `dompurify` and 106 other packages. `npm audit --omit=dev` now reports nothing.
