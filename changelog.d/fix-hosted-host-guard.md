## 🔒 Security

- 🔒 **A hosted cockpit checks the `Host` name too.** Hosted mode used to accept any `Host`
  header, while the installers keep the cockpit on loopback behind a local proxy. It now serves a
  non-loopback name only when it is an IP address or a public name `xezar server-install` recorded
  on this machine (the entered domain, or an ngrok-assigned name for an ngrok install without one),
  and refuses and logs any other. Existing installs keep working without a reinstall; a machine
  with no recorded name serves every name as before and logs that once.
