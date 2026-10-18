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
