## 🔒 Security

- 🔒 **zod and hono move past their published advisories.** zod goes to 4.6.7 (the high-severity
  advisory covers every release before 4.6.6) and hono to 4.13.13 (the moderate advisory covers
  4.12.4–4.13.10); both runtime packages now use one version range everywhere they are declared.
  The MCP tool listing writes a nullable flag as `type: ["boolean", "null"]` instead of an
  `anyOf` pair, which means the same thing to a JSON Schema client.

## 💥 Breaking

- 💥 **A `since` timestamp must carry seconds.** zod 4.6 follows RFC 3339, so the automation log
  `since` filter (MCP `logQuery.since` and the HTTP query) refuses a minute-only value such as
  `2026-10-24T09:30Z`; send `2026-10-24T09:30:00Z`. Timestamps xezar writes itself always carry
  seconds.
