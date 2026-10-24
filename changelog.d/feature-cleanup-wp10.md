## 🐛 Fixes

- 🐛 **Leader event state, journal compaction and the server-install record no longer share a
  fixed `.tmp` staging file.** Each write now stages through its own temporary name and removes
  it on failure, so two writers cannot interleave and a temporary file left by a crash no longer
  blocks later writes. (#1164)
- 🐛 **Audit payload digests now follow the documented canonical form for number-like keys.**
  Operation receipts, audit records and version tokens share one canonical JSON serializer, so
  a payload with keys such as `"10"` and `"9"` is digested in code-unit order everywhere. Only
  new audit records of such payloads get a different digest; stored records are never re-checked
  against new ones. (#1164)
