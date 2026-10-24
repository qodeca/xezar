## 📝 Specs & Documentation

- 📝 **The old `mcp-audit.ndjson` audit file stops being read in 0.33.0.** xezar 0.13.0–0.15.0
  wrote the audit trail to `.local/xezar/mcp-audit.ndjson`; every release since 0.16.0 writes
  `audit.ndjson` and reads the old file only when the new one is missing. The backward
  compatibility page now names 0.33.0 as the release that removes that reader. The old file is
  never deleted; keep or archive it by hand. (#563)
