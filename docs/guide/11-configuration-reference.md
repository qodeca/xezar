# Configuration reference

Use this reference to find where a setting lives, what happens when you leave it unset, and which value takes precedence. xezar works without a configuration file; project preferences, machine preferences and the environment let you change those defaults when needed.

## To start with zero configuration

Start the cockpit in your project. You do not need to create `.xezar/config.json` or `~/.xezar/config.json`. Missing or invalid project configuration falls back to defaults; workspace loading salvages valid entries and degrades when its file is unavailable. xezar reads environment variables from its process and does **not** automatically load `.env`.

Keep maintained project configuration in `.xezar/`; runtime task state belongs under `.local/xezar/`. See [Project layout](../project-layout.md). `XEZ_HOME` changes the global state directory from `~/.xezar`; separate homes have separate registries and preferences.

## To configure this project: `.xezar/config.json`

The [project schema and resolver](../../packages/xezar/src/config.ts) define these thirteen keys. Defaults below include workspace inheritance where applicable.

| Key | Value and effect |
| --- | --- |
| `skillsRepos` | Array of `{ "repo": "owner/name", "ref": "main" }`; `repo` also accepts a Git URL or local path. Omitted: `qodeca/xezar-skills` at `main`, subject to your personal skill selection. An explicit list loads its sources without that selection; `[]` disables team sources. Any explicit value hides **Manage skills**. |
| `maxParallel` | Integer 1–16, schema default 2. Legacy project key, imported once by workspace migration when applicable: current enforcement uses workspace `resources.maxParallel` and registry `projects[].maxParallel`, not this key. |
| `worktreeRetention` | Integer 0–1000. Overrides workspace retention; otherwise inherits it, ultimately 10. Zero disables automatic reclamation. Reclamation removes finished worktree directories and keeps their branches. |
| `memoryLimitMb` | Integer 0–1,048,576 MiB. A positive value on a registered project overrides the workspace ceiling. Zero or absence contributes no project override and inherits the workspace ceiling. |
| `defaultRunner` | `claude`, `codex`, `opencode` or `pi`. Inherits `agentDefaults.runner` when omitted, then defaults to `claude`. |
| `plannerModel` | Non-empty model string, default `sonnet`, for the chain planner's Claude model. |
| `namerModel` | Non-empty model string, default `haiku`, for Claude task naming. |
| `liveTitleUpdates` | Optional boolean. When set, overrides `XEZ_TITLE_UPDATES`; otherwise live updates default on. `XEZ_AUTONAME=0` still disables all LLM naming. |
| `reviewGate` | Optional boolean. When set, overrides `XEZ_REVIEW_GATE`; otherwise off unless the env is exactly `1`. Autonomous runs skip review regardless. |
| `baseBranch` | Non-empty trimmed branch name for task worktree bases and draft PR targets. When omitted, worktree creation uses the current branch. |
| `systemPrompt` | Optional trimmed text, 1–20,000 characters, supplying extra instructions for agent steps. |
| `defaultModels` | Optional object with `claude`, `codex`, `opencode`, `pi` model strings, each 1–200 trimmed characters. Project values override machine `agentDefaults.models` per backend; unset means no preset. |
| `modelsLocked` | `true` makes native agent model settings authoritative. It combines with the global key and env switch as described below; `false` cannot cancel another enabled lock. |

For example, to retain five finished worktrees and enable the non-autonomous review gate:

```json
{
  "worktreeRetention": 5,
  "reviewGate": true
}
```

## To configure the workspace: `~/.xezar/config.json`

Use global Settings for the exposed controls. This file also holds the project registry; avoid replacing the entire file with a small example and losing its other entries. The [workspace store](../../packages/xezar/src/workspace/config.ts) preserves unknown fields and writes a `config.json.bak` snapshot. A missing, empty or corrupt primary file can recover a non-empty registry from that backup; deleting only `config.json` is therefore not a reliable reset.

| Top-level key | Meaning / default |
| --- | --- |
| `schemaVersion` | Internal migration cursor; absent or invalid becomes 0. Let xezar maintain it. |
| `browseRoot` | Add project folder-browser root; default `XEZ_BROWSE_ROOT`, otherwise `~/`. |
| `projectsDir` | GUI clone destination root; default `XEZ_PROJECTS_DIR`, otherwise `~/xezar/projects`. |
| `skillsAutoUpdate` | Optional boolean; saved value overrides `XEZ_SKILLS_AUTO_UPDATE`, whose default is on. |
| `modelsLocked` | Optional boolean; `true` enables the native-model policy globally. |
| `followups` | Optional boolean controlling the follow-up Inbox; stored value wins over `XEZ_FOLLOWUPS`, absent inherits it (default off). This is top-level, not inside `resources`. |
| `agentEnvPassthrough` | Optional array of up to 64 extra host variable names, each 1–200 trimmed characters. Stored list wins over `XEZ_ENV_PASSTHROUGH`, including `[]`. Stores names, not secret values. Also top-level. |
| `resources` | Resource controls in the next table. |
| `composerDefaults` | Optional booleans `autonomous` and `worktree`, for New Task defaults. Each absent key inherits its exact `0`/`1` env seed; without one, Autonomous depends on the task source (skills default on, other sources off) and Worktree defaults on. Plan first, interactive skills and explicit task choices can alter those defaults. |
| `disabledProviders` | Array of provider IDs (`claude`, `codex`, `opencode`, `pi`), default `[]`. Machine-wide provider preferences; installation and sign-in status are separate. |
| `agentDefaults` | Optional `runner` and `models` object (the four backend keys, each model 1–200 trimmed characters). Supplies defaults where project configuration is silent. |
| `projects` | Registry array, default `[]`. Each row has `id`, absolute `root`, display `name`, `addedAt`, `lastOpenedAt`, `source` (`local` or `checkout`), optional `maxParallel` (1–16) and optional `tags`. Invalid rows are dropped independently. |

| `resources` key | Default and accepted values |
| --- | --- |
| `maxParallel` | 2; integer 1–16. Workspace active-task cap. A registry project's `maxParallel` narrows that project's share. |
| `maxMonitoringSessions` | 2; integer 0–16. Extra monitoring sessions outside the active-task cap. |
| `monitoringWakeIntervalMinutes` | 5; integer 1–60, or `null` to park until resumed. |
| `autoResumeOnUsageLimit` | `true`; eligible tasks stopped by a provider usage limit can resume after reset. |
| `idleTimeoutMinutes` | 15; integer 1–1440, or `null` to never close a waiting session for idleness. |
| `memoryLimitMb` | When absent, `floor(host RAM in MiB × 0.6 / 2)`, clamped to 1024–8192 MiB. Integer 0–1,048,576 or `null`; zero and `null` mean no workspace memory ceiling. The divisor is 2, independent of your chosen parallel cap. |
| `worktreeRetentionDefault` | 10; integer 0–1000. Used where the project has no retention override; zero disables automatic reclamation. |

`browseRoot` and `projectsDir` are special: startup registration/migration writes the resolved defaults into the workspace file. Once saved, changing the environment and restarting does not replace them. Change the stored settings in global **Settings → Projects**.

## To manage `agent-accounts.json`

Global **Settings → Agent accounts** manages `~/.xezar/agent-accounts.json`, a separate store from workspace configuration. It contains `version`, `accounts`, `defaults` and `selections`. Added account rows contain `id`, `provider`, `configDir`, `label` and `addedAt`; `defaults` chooses account IDs per provider, and `selections` maps project roots to per-provider choices. Project choices override machine defaults.

Extra accounts are supported for Claude Code, Codex and pi. OpenCode's credentials do not move with its config directory, so it does not support this feature. The discovered default account is not an added row. This file registers directories and choices; sign in through the agent. Removing an account unregisters it without deleting its configuration directory or sessions.

## To set user-facing environment variables

Export variables before starting xezar, for example `XEZ_REVIEW_GATE=1 xezar`. The [environment contract](../../.env.example) is the full list, including test hooks and developer-only settings. This table covers the user-facing switches and their significant defaults.

| Variable | Effect |
| --- | --- |
| `XEZ_REMOTE=1` | Hosted-mode capabilities; hides local-machine handoffs. |
| `XEZ_BROWSE_ROOT`, `XEZ_PROJECTS_DIR` | Seeds for the two stored folder settings above. |
| `XEZ_HOME` | Global state directory; empty means `~/.xezar`. |
| `XEZ_CLAUDE_BIN`, `XEZ_CODEX_BIN`, `XEZ_OPENCODE_BIN`, `XEZ_PI_BIN` | Override backend executable discovery on `PATH`. |
| `XEZ_CODEX_REASONING` | `auto` (default), `concise`, `detailed` or `none`; unknown values use `auto`. |
| `XEZ_APPROVAL_GATE=1` | Claude `acceptEdits` approval mode instead of the default denial of tools needing approval. |
| `XEZ_CODEX_NETWORK=0` | Codex workspace-write, network-blocked sandbox instead of full access. |
| `XEZ_SKILLS_AUTO_UPDATE=0` | Disable automatic tracked-skill update application unless the stored setting overrides it. |
| `XEZ_AUTONOMOUS_DEFAULT`, `XEZ_WORKTREE_DEFAULT` | Exact `0`/`1` New Task seeds; stored composer defaults win. |
| `XEZ_DISABLE_REPO_LOCK=1` | Bypass the repository-root lease. Concurrent in-place runs can overwrite each other's work; isolated worktrees are unaffected. |
| `XEZ_SINGLE_PROJECT=1` | Show only the launch project and refuse project add/edit/browse/checkout/remove. Registry entries remain. |
| `XEZ_HIDE_TOKEN_USAGE=1`, `XEZ_HIDE_COST=1` | Hide the corresponding cockpit metrics; telemetry is still collected. Restart after changing. |
| `XEZ_HIDE_TOKEN_METRICS=1` | Legacy switch hiding both token counts and cost. |
| `XEZ_NO_BANNER=1` | Suppress the team-skills terminal banner for `serve`. |
| `XEZ_FOLLOWUPS=1` | Inbox default on; the stored `followups` choice wins. |
| `XEZ_AUTOMATIONS=1` | Enable GitHub automations at boot; restart required. Off by default. |
| `XEZ_TITLE_UPDATES=0` | Disable live title refresh unless project `liveTitleUpdates` overrides it. |
| `XEZ_AUTONAME=0` | Disable all LLM naming, including creation-time names. |
| `XEZ_REVIEW_GATE=1` | Default review gate on for changed non-autonomous runs; project setting wins. |
| `XEZ_AUTOSAVE=1` | Enable periodic worktree autosaves every 90 seconds. Turn-end/finalization/pre-PR flushes are separate and do not depend on this flag. |
| `XEZ_ENV_PASSTHROUGH` | Comma-separated extra variable names; stored `agentEnvPassthrough` wins. |
| `XEZ_AGENT_ENV_FULL=1` | Give agents the full host environment, including secrets, instead of the filtered default. |
| `XEZ_AGENT_TMPDIR=0` | Disable private per-task temporary directories and their write preflight. |
| `XEZ_REDACT_SECRETS=0` | Disable best-effort secret redaction in persisted state; enabled by default. |
| `XEZ_DRY_RUN=1` | Use mock agents without real model calls. LLM naming is off unless forced with `XEZ_AUTONAME=1`. |
| `XEZ_AGENT_MODELS_LOCKED=1` | Enable native-model policy; also bypass xezar's provider-auth probes and disable preferences. Stored `modelsLocked` alone does not imply that auth bypass. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` | The agents' own default configuration homes. Use Agent accounts for extra logins. OpenCode configuration and credential locations are separate. |
| `ANTHROPIC_MODEL` | Claude's native model default. A saved cockpit preset is layered over that default and the chosen model is passed as `--model`. |
| `GITHUB_TOKEN` | Token-based GitHub access where needed; `gh` can use its own login. |
| `VITE_XEZ_API_BASE` | Build-time API origin for a separately deployed cockpit bundle; empty uses the page origin. An HTML `xez-api-base` meta value takes precedence. |

## To resolve stored-key-wins rules

- For `followups`, `skillsAutoUpdate`, `liveTitleUpdates` and `reviewGate`, an explicit stored `false` wins just as `true` does. Remove the stored override to inherit the relevant env default again.
- For `agentEnvPassthrough`, `[]` means **no extra named variables**. It does not remove the normal agent environment allowlist. Remove the key to follow `XEZ_ENV_PASSTHROUGH` again.
- For `composerDefaults`, resolve each key independently: stored boolean, then exact env `0`/`1`, then the built-in default. These are New Task composer defaults, not CLI `run` flags.
- For workspace `resources.memoryLimitMb` and `resources.idleTimeoutMinutes`, absence chooses a limit; explicit `null` disables it. Deleting a key and setting it to `null` have different effects. A positive registered-project memory override still wins over a workspace `null`.
- Model locking is an exception to simple override precedence: env `1`, global `modelsLocked: true`, **or** project `modelsLocked: true` enables it. A `false` in another place does not unlock it.

## Related settings / env / config

- Project **Settings → Agents** and **Worktrees** expose project preferences; global **Resources**, **Projects**, **Skills** and **Agent accounts** expose workspace preferences.
- [Full environment contract](../../.env.example), [project layout](../project-layout.md), [project schema](../../packages/xezar/src/config.ts), [workspace schema](../../packages/xezar/src/workspace/config.ts) and [account store](../../packages/xezar/src/workspace/agent-accounts.ts).

Next: [CLI reference](12-cli-reference.md)

Describes xezar 0.15.0.
