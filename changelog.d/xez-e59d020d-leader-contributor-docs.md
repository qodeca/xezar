## 📝 Specs & Documentation

- 📝 **The leader guide answers a new leader's first questions up front.** A quick-answers table
  (what to decide alone, what to ask, how to dispatch, what the gates mean) and a table of common
  refusals with what to do about each. It now says the four single-project files are tracked,
  that gate runs queue on the gate lease by themselves, and how a question travels each way
  (`XEZ:ASK` from a task; `AskUserQuestion` from a Claude Code leader to the owner).
- 📝 **Account docs describe what the MCP really answers.** `get_account` returns `accounts`,
  `profiles` and `problems`; `check_account_status` and `get_account_details` are served. Usage
  still cannot be read, so the probe recipe stays.
- 📝 **A new top-level file under `.local/xezar/` needs announcing.** AGENTS.md, the project
  layout, the local-data table and BACKWARD_COMPATIBILITY.md now say the git ignore settles git
  only: an external consumer checks the top-level file names there, so new state goes in a
  subdirectory.
- 📝 The kit docs index lists every file in `.xezar/docs/`, and the docs map lists every testing
  document and the research folder.
