## 🐛 Fixes

- 🐛 **Copying the project folder no longer fails silently on a page without a clipboard.** On a
  cockpit opened over plain http the browser offers no clipboard, and the Copy button in Settings
  threw an error instead of answering; it now shows the path in a notice so it can be copied by
  hand. The provider sign-in command and the bookmarklet Copy buttons use the same shared copy
  helper, and "Bookmarklet URL copied" lost its stray period.
