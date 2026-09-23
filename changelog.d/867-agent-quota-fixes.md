## 🐛 Bug fixes

- 🐛 **A shorter limit no longer hides a longer one.** When a login is limited twice, the quota answer keeps the later reset time, so it never reads as ready while the longer limit still holds. (#867)
- 🐛 **Quota times are whole seconds.** Every time in the quota answer now has the form `2026-09-22T14:20:00Z`, without fractions of a second. (#867)
- 🐛 **Dry run returns the published sample.** With `XEZ_DRY_RUN=1` the quota answer is the committed sample answer and no check process starts. (#867)
- 🐛 **Quota checks need Claude Code 2.1.280.** The minimum is now the version the checks were proven on; Codex stays at 0.155.1. (#867)
- 🐛 **A Claude Code usage report without limits is not a format change.** When the fallback usage report lists no limits, the row says the check failed instead of warning that Claude Code changed its format. (#867)
- 🐛 **Per-model weekly limits from Claude Code reach the answer.** Claude Code 2.1.280 lists its limits inside its rate-limit report, and some entries have no model; Xezar now reads that list, so a per-model weekly window such as Fable is shown. (#867, #906)
