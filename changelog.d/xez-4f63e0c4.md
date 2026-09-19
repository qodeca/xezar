## 🐛 Fixes

- 🐛 **The single-project layout's `machine-state.json` is read through a schema, written under
  the same lock the project registry uses, and a launch that cannot be recorded is no longer
  silent.** In the layout that keeps a folder's state in the repository, this gitignored working
  file holds the per-machine facts — `addedAt`, `lastOpenedAt` and `lastListen` — and all three
  were fragile. A hand-rolled `JSON.parse` kept only the keys it knew, so any key a newer xezar
  wrote was dropped on the next rewrite, and it accepted a stamp of any length. The two
  read-modify-writes held no lock, so two xezar instances starting at the same moment could each
  read the same bytes and the later write lose the other's fact. And a registration whose write
  failed swallowed the error in an empty `catch {}`, so the launch quietly forgot where it had
  been. The parse now mirrors the registry's schema (per-field `.catch`, `.passthrough()`, and the
  same 64-character cap on the stamps, so an over-long hand-edited stamp is dropped rather than
  persisted), both writers take the bounded, fail-open cross-process lock the registry merge
  already uses, and a failed registration write warns once per process while the boot still
  finishes. A missing, unreadable or corrupt file still answers "nothing recorded" and never
  throws, and the default global layout is byte-for-byte unchanged. (#649)
