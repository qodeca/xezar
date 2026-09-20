## 📝 Specs & Documentation

- 📝 **Three user-guide claims now match the code they describe, and a 0.17.0-only claim is marked
  unreleased.** Guide 13 said Codex tasks had followed the project-only MCP-server rule "since
  0.13.0"; Codex MCP isolation (#324) shipped in 0.15.0, so the guide now says 0.15.0. Guide 17
  called `mcp-audit.ndjson` "written by xezar 0.13.0–0.15.0"; the file first shipped in 0.14.0
  (`git describe --contains 8e1a2161` is `v0.14.0~75`), so it now says 0.14.0–0.15.0. Guide 16
  quoted a server log line the server never emits; it now quotes the real line from
  `packages/xezar/src/server/server.ts` and keeps the source-checkout build advice as the guide's
  own. Guides 07 and 11 said `XEZ_AUTOMATIONS` is read live "since 0.17.0"; the flag is read live on
  `main` but 0.17.0 has not shipped, so both now say "unreleased – ships in 0.17.0". Docs only: no
  behaviour change. (#447)
