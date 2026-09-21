## 🐛 Fixes

- 🐛 **Deleting an agent account no longer leaves a dangling machine-wide default.**
  `DELETE /api/v1/workspace/agent-profiles/:id` scrubbed every project's `selections` but walked
  past `defaults`, so removing the account a provider defaulted to left `defaults.<provider>`
  naming an account that no longer existed — served back by the listing forever after, and
  silently ignored by every run. The scrub now clears that reference in the same atomic write.
  (#819)
- 🐛 **A stored account reference that names no account is now reported instead of only ignored.**
  `GET /api/v1/workspace/agent-profiles` answers a new `problems` array naming every dangling
  `defaults.<provider>` and every project selection whose account is gone, with the provider and
  the handle as stored. It is a report, never a rule: run resolution still falls back to the
  discovered account, so zero-config behaviour is unchanged. (#819)
