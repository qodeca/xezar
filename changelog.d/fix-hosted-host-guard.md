## 🔒 Security

- 🔒 **A hosted cockpit checks the `Host` name too.** Hosted mode used to accept any `Host`
  header, while the installers keep the cockpit on loopback behind a local proxy. It now serves a
  non-loopback name only when it is an IP address, a public name `xezar server-install` recorded
  on this machine (the entered domain, or an ngrok-assigned name for an ngrok install without one),
  or a name listed in the new `XEZ_ALLOWED_HOSTS`. Any other name is refused with a 403 that says
  how to allow it, and logged once. Installs that recorded their domain keep working without a
  reinstall; a hosted setup the installer did not record lists its public name in
  `XEZ_ALLOWED_HOSTS`.
- 🔒 **A hosted cockpit keeps machine-level settings local.** In hosted mode, saving the folder
  the project picker may browse, the folder new checkouts land in, the environment variables
  passed to agents, or the instance mode is refused with a `409` and nothing is saved, as editing
  agent configuration already was. Display and resource settings stay editable. The folder picker
  no longer lists hidden folders in hosted mode.
- 🔒 **Hosted settings screens show the locked settings read-only.** In hosted mode, Global
  settings → Projects (browse and checkout folders), Resources (extra variables agents receive)
  and Terminal (instance mode) show the current value in a read-only field with the reason on
  screen, instead of an editable field the server would refuse. The MCP `set_workspace_config`
  description says the same keys are refused in hosted mode.
- 🔒 **A page under a refused address explains itself.** In hosted mode, a non-API page requested
  under a name the cockpit does not serve gets a small self-contained `403` page that names the
  refused name and how to allow it, instead of a cockpit that cannot load its data. On a phone,
  a long locked folder path now wraps instead of being cut off.
