## 🔧 Changed

- 🔧 **The MCP `update_automation` door states the route's own revision rule.** Its
  `expectedRevision` is now a positive integer in the tool schema, as `PUT /automations/:id` has
  always required, so a leader is refused before the call instead of by the route's 400. Three
  routes – project checkout, agent-config write and the automation check – now validate with the
  contract's request schemas instead of their own copies, with the same bodies accepted and the
  same errors returned. (#1177)
