## 🔒 Security

- 🔒 **zod and hono move past their published advisories.** zod goes to 4.6.7 (the high-severity
  advisory covers every release before 4.6.6) and hono to 4.13.13 (the moderate advisory covers
  4.12.4–4.13.10); both runtime packages now use one version range everywhere they are declared.
  The MCP tool listing writes a nullable flag as `type: ["boolean", "null"]` instead of an
  `anyOf` pair, which means the same thing to a JSON Schema client. (#1160)
