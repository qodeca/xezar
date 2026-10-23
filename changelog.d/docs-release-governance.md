## 📝 Specs & Documentation

- 📝 **The security policy, the server-install guides and the release docs match the code and the
  current settings.** `SECURITY.md` lists the new boundaries: the frame refusal, the hosted `Host`
  name check, the `409` for machine-level settings in hosted mode and the removal of credentials
  from remote URLs. The Ubuntu guide warns that a proxy on the same host must overwrite or strip
  `X-Xezar-User`, says when `XEZ_ALLOWED_HOSTS` is needed, and documents `--yes` and
  `XEZ_DRY_RUN=1` for the installer. `docs/publishing.md` describes the `production` environment's
  reviewer and branch limits, the release-tag ruleset and npm's current unpublish policy, and
  `SDLC.md` records four owner decisions as deviations from the core.
