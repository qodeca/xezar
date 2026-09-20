## ✨ Features

- ✨ **A project leader can manage the agent accounts over MCP, and read who one is signed in as.**
  `project_config`'s `create_account`, `update_account`, `remove_account`, `select_account`,
  `check_account_status` and `get_account_details` used to exist only to refuse; all six are real
  now and go through the same routes the cockpit's own Accounts settings use — the same checks, the
  same "that folder is already used by…" refusal, the same single atomic write. Adding an account
  adds it for **every project on this machine**, and pointing one at a folder decides which folder
  that login runs from, so it is worth being sure: the folder becomes an agent's whole home, and an
  agent home can carry settings that run when the next task starts. Choosing which account to use
  applies to **this project only** — a leader cannot change another project's choice, or the
  machine-wide default for new ones. **Over a remote connection none of this works at all**, by
  design: the cockpit refuses the whole accounts area when it is not running on the machine that
  owns the checkout, and that refusal is what a leader gets too.
  **Opening an account's folder in an app is still not something a leader can do**: that starts a
  program on the person's own machine, which stays a person's job. (#677)

## 🔧 Changed

- 🔧 **What a leader is told about account identity.** Until now, the answer to "who is this account
  signed in as?" was always a refusal, and the documentation said it always would be. The owner
  decided otherwise: a leader that names one account gets the same email, organisation and plan the
  person sees behind "Show details", and nothing more. Identity still appears in no other answer —
  the account list, the capability read and the sign-in check carry none of it, and an account
  whose name looks like an email still has that name withheld — including in a refusal. Asking for
  a folder another account already uses says so, but no longer repeats that account's name when the
  name is an email address; the same message in the cockpit is unchanged, because there it is the
  person's own name they are reading. (#677)
