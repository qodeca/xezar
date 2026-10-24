## 🚀 CI/CD & Infrastructure

- 🚀 **Development tooling hygiene.** Building and testing this repository now needs Node 22.13 or
  newer, the version the cockpit build and test tools already required; the published package
  still runs on Node 22. Vite, Vitest and undici move to releases that close their published
  advisories, the cockpit and mutation configs declare the packages they import, and dependency
  update PRs no longer propose an `@types/node` major or stop at five open PRs.
