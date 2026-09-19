## 🐛 Fixes

- 🐛 **A project re-added while its previous context was still closing keeps its MCP door.** Removing
  a project tears its context down in the background, and that teardown can still be running when the
  same folder is added back and touched again. The removal's notification then arrived after the
  rebuild and closed the door the rebuilt project had just opened, so `xez mcp` in that folder
  answered "xezar is not running" while the cockpit served its routes. A context now says which
  registration it belongs to, and a removal is only ever acted on by the registration it is about.
  (#647)
