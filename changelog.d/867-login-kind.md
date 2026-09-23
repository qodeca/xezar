## 🔧 Changed

- 🔧 **Each agent-quota row now says what kind of login it is, and names its time `observedAt`.**
  The answer that the HTTP route, the MCP `read_quota` / `check_quota` actions and the cockpit share
  carries `loginKind` on every row: `subscription`, `api-key` or `unknown`, read from the login's
  own credentials as Claude Code (`claude auth status`) or Codex (`account/read`) reports them,
  never from the plan facts. `unknown` means xezar could not tell and is never read as a
  subscription. The row's observation time is renamed from `checkedAt` to `observedAt`, with no
  alias; no released version carried the old name, so `schemaVersion` stays `1`. The plan-limits
  chip now shows an agent only when one of its logins is a subscription, and Show details names the
  login kind. A login whose tool reported no plan limits is called an API-key login only when its
  login kind is `api-key`; any other login reads "Claude Code said this login has no plan
  limits.", says to sign in again and Refresh, and keeps its Refresh. A login whose answer carried
  no limit lines says so and says to Refresh. (#867)
