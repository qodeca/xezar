## 🐛 Fixes

- 🐛 **Turning GitHub automations on no longer needs a restart — and no longer pretends to work.**
  `XEZ_AUTOMATIONS=1` was read afresh on every request, so setting it on a xezar that was already
  running opened the Automations view and its endpoints: a definition could be created and saved.
  The part that polls GitHub, however, was started once when the server came up and was never asked
  again, so nothing was ever checked and no task was ever launched — with no error anywhere to say
  so. The flag is now live in both halves: turning it on starts the poller as well as opening the
  view, turning it off stops the poller as well as closing it, and each is picked up the next time
  xezar consults the flag rather than only at the next restart. Definitions, receipts and
  high-watermarks are untouched either way, and a xezar started with the flag already on behaves
  exactly as before. (#678)
