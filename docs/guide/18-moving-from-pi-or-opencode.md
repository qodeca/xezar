# Moving from pi or OpenCode to Qwen Code

xezar no longer runs pi or OpenCode. Qwen Code takes their place for local and hosted models
that speak the OpenAI API. This page shows how to move your model setup by hand. xezar does not
convert or copy these files for you, and it never writes your Qwen Code settings.

## 1. Install Qwen Code

Install Qwen Code 0.25.2 or newer: `npm i -g @qwen-code/qwen-code`. Run `qwen` once, so it
creates its settings folder (`~/.qwen/`).

## 2. Find your current providers

| You used | Where its providers are |
| --- | --- |
| pi | `~/.pi/agent/models.json` (or the folder in `PI_CODING_AGENT_DIR`), under `providers` |
| OpenCode | `opencode.json` in your project or in `~/.config/opencode/`, under `provider` |

For each provider, note three things: its base URL, its API key, and the model ids you use.

- pi: `providers.<name>.baseUrl`, `providers.<name>.apiKey`, and `providers.<name>.models[].id`.
- OpenCode: `provider.<name>.options.baseURL`, `provider.<name>.options.apiKey`, and the keys of
  `provider.<name>.models`.

## 3. Add them to Qwen Code

Open `~/.qwen/settings.json` and add one entry per model under `modelProviders.openai`. Use
`envKey` to name an environment variable that holds the key – do not paste the key into this file.

```json
{
  "security": { "auth": { "selectedType": "openai" } },
  "modelProviders": {
    "openai": [
      {
        "id": "my-model-id",
        "name": "My model (my server)",
        "baseUrl": "http://127.0.0.1:8000/v1",
        "envKey": "MY_SERVER_API_KEY"
      }
    ]
  }
}
```

- `id` is the model id the server expects, the part after `provider/` in a pi or OpenCode id.
  For example, OpenCode's `myserver/llama-3.3-70b` becomes `"id": "llama-3.3-70b"`.
- `baseUrl` is the provider's base URL, usually ending in `/v1`.
- Put the key in the variable `envKey` names: in your shell, or in `~/.qwen/.env`
  (`MY_SERVER_API_KEY=…`). A local server that needs no key still needs a variable; any value
  works.

Each entry becomes a model choice in xezar's composer. Restart nothing: xezar reads the file
when it lists models.

## 4. Change xezar's stored values

xezar does not start while a saved setting or task record still names `pi` or `opencode`. This
holds for every command that can save settings or records – every command except `mcp`,
`lease` and `state-names` – and the cockpit does not open a project added later that still has such a value.
The message lists every file and field. Change each value to `qwen` (or `claude` or `codex`), or
remove it:

- `.xezar/config.json` – `defaultRunner`, and the `pi` / `opencode` keys under `defaultModels`.
- Workflow files in `.xezar/workflows/` – a step's `runner:`.
- Your xezar settings folder (`~/.xezar/`) – the default agent and saved accounts for pi or
  OpenCode.
- Task history (`runs.json`) – old tasks that ran on pi or OpenCode. Delete those tasks with the
  version of xezar you used before, or change their `runner` and `backend` values. Archiving is not
  enough: an archived task stays in `runs.json` with its values.
- The backup of your settings (`~/.xezar/config.json.bak`) – xezar restores from it when
  `config.json` is missing, so fix it the same way.

## 5. Check it works

Start xezar, open a new task, pick **qwen** as the runner and your model, and run a small task.
