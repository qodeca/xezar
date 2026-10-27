## 🚀 CI/CD & Infrastructure

- 🚀 **Mutation testing is removed from the project.** The nightly Stryker workflow
  (`mutation.yml`), its configs, its shard, report, survivor and tracking-issue scripts, their
  tests, the committed shard weights and survivor list, the `test:mutation:*` npm scripts and the
  three `@stryker-mutator/*` development libraries (144 packages in the lock file) are gone, by
  owner decision. Nothing a user installs changes: Stryker was never part of the published package.
  The MCP coverage floor and the rule that a new MCP test must fail against a named break stay.
