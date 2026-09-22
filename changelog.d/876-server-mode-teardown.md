## 🐛 Fixes

- 🐛 **The hosted-server harness no longer deletes its scratch folder while the server's own
  descendants still write into it.** `npm run test:server-mode` failed with `ENOTEMPTY` in cleanup
  after all eight cases had passed (#876): `serve` exits on SIGTERM without waiting for what it
  started, so the background team-skills clone and a run's dry-run agent kept writing into the
  scratch home and repo while the harness removed them. Every CLI the harness starts now leads its
  own process group; cleanup awaits the CLI's `exit` event, ends that exact group, and removes the
  folder only once the kernel reports the group empty. A descendant that outlives teardown is now a
  named failure (`BREAK-TEARDOWN-TREE`) instead of a racy one. Test-only; no server code changed.
