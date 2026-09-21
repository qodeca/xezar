## ✨ Features

- ✨ **A project leader can ask which models each agent tool can run.** The MCP `project_config`
  tool gained the read `list_models` (optionally narrowed with `provider`): one row per tool with
  every model id exactly as that tool's own `--model` flag takes it, whether the list could be read
  and, when it could not, why. It reads the same list the composer's model picker offers, and
  `get_capabilities` is unchanged. Model options on `GET /api/v1/models` may now also say `local`
  and `vision`, but only where the tool's own data proves it – from Codex's input modalities and
  pi's configuration; a missing value means unknown, never "no". (#819)
