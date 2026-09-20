## 📝 Specs & Documentation

- 📝 **The README's guide count, backend-status wording and environment table now match the source
  they describe.** The "complete 16-part user guide" link said 16 while `docs/guide/README.md`
  lists parts 01–17 (and `docs/README.md` already said "17-part"), so it now says 17-part. The
  backend table marked **pi** _(experimental)_; only OpenCode is experimental
  (`docs/guide/04-agent-backends.md` and `AGENTS.md` agree, and no runner carries such a marker in
  `packages/xezar/src/core/`), so pi's marker is gone. The env table listed `XEZ_API_PORT` under
  "Every user-facing `XEZ_*` variable"; the server never reads it (it is the Vite dev proxy target,
  read by `packages/web/vite.config.ts` and set by `scripts/dev.mjs`), so its row is removed and
  `.env.example` stays the only surface. Docs only: no behaviour change. (#447)
