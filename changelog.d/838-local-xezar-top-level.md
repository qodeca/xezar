## 🐛 Fixes

- 🐛 **Every name the engine writes at the top of `.local/xezar/` now follows the documented
  shape, and a test refuses a new one.** The pi leader extension staged `pi-leader.json` as
  `pi-leader.json.tmp-<pid>`; it now uses the documented `.<pid>.<hex>.tmp` form. The documented
  shape now also names `.lock.takeover`, the short-lived guard file every lock release creates
  (for example `audit.ndjson.lock.takeover`), so a consumer that checks those names no longer
  rejects it at random. A source scan fails when shipped code builds a top-level name outside
  the allowed list or the documented suffixes. (#838)
