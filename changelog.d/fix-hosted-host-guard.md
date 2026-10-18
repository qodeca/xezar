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
