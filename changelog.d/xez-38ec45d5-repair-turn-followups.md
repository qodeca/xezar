## 🐛 Fixes

- 🐛 **A repair turn that comes to nothing no longer says the backend "refused" a session it may
  never have been asked about, and can no longer spend the step's wall clock twice.** The first
  automatic return after a red check resumes the author's own session (#676); when that resumed
  turn ends before the model produces any text or tool call, the return falls back to a fresh
  session with the whole brief. That fall-back is unchanged, but its note used to blame a refusal
  for every cause — a usage limit, a transient API error, a silent timeout and a turn that simply
  ended having said nothing all read as "the backend refused the recorded session". It now states
  what was observed and quotes the reason. The fall-back execution is also bounded by what is left
  of the step's wall clock instead of receiving a second full `timeout`, which is what made a
  resumed turn that hung cost 30 minutes and then 30 minutes again on one return, with the
  advertised deadline pointing at the end of the first budget; when nothing is left the return
  ends on the failure it has and says so. An absent step `timeout` still resolves to the runner's
  30-minute default, and the last step stays uncapped. (#732)

## 🔧 Changed

- 🔧 **Adding a fifth agent backend is now a compile error until its resume and token-accounting
  behaviour are answered.** The two lists that decide whether a runner can resume a recorded
  session at all, and whether its `token-usage` figure is the session's running total rather than
  this execution's own, were deny-lists: an unlisted backend silently defaulted to "can resume,
  per-execution tokens", and answering the second one wrong double-bills a resumed step. Both are
  now total `Record<RunnerId, boolean>` maps, and `AGENT_PROTOCOL.md`'s new-runner checklist names
  them. (#732)
