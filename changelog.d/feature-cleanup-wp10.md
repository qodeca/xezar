## 🐛 Fixes

- 🐛 **Leader event state, journal compaction and the server-install record no longer share a
  fixed `.tmp` staging file.** Each write now stages through its own temporary name and removes
  it on failure, so two writers cannot interleave and a temporary file left by a crash no longer
  blocks later writes.
