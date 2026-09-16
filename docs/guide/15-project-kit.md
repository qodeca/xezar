# Project kit

Use a project kit to keep reusable agent instructions and workflows beside your source. A kit is optional: start with the small `xezar init` examples, replace their placeholders with your project's conventions, and commit only the maintained files your team needs.

## To find the project's kit

The repository-root `.xezar/` directory holds project configuration, [workflows](05-workflows.md) and [skills](06-skills.md). A project can also keep its own checks, documentation and guidance there. Its files are ordinary project files: you review and version them with the rest of the project. [Guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional) can prepare the configuration for you. To run a project leader over the project, see [MCP project leader](13-mcp-leader.md). It is separate from `.local/xezar/` execution data and the per-user `~/.xezar/` workspace settings.

An absent kit leaves defaults in place. There is no fallback to the old `.ai/xezar/` kit location. One collision guard applies when the kit path would be the workspace home: the kit goes under `.local/xezar/kit` instead, protecting the user's global settings. See [Project layout](../project-layout.md) for the directory rules and migration guidance.

## To create the starter files

Run in your project, or name the project explicitly:

```sh
xezar init --repo /path/to/project
```

Today, initialization creates these directories and writes these examples when the files do not already exist:

| File | Initial content |
| --- | --- |
| `.xezar/workflows/fix-and-verify.yaml` | An `implement` agent step with `prompt: "{{task}}"`, then a `verify` command step. A failed verify retries `implement`, at most twice. |
| `.xezar/skills/project-conventions.md` | A Markdown skill with `name` and `description` frontmatter and placeholders for your stack, style and testing conventions. |

Existing example files are left untouched. Initialization also creates or updates `.local/.gitignore` with a blanket `*` rule when it can write there. It does **not** create `.xezar/config.json` or install this repository's development kit.

**The generated verify command is a placeholder.** It only runs:

```sh
echo 'replace me with: npm test / yarn test / pytest'
```

Replace that command with your project's actual check before relying on the workflow to verify anything. Fill in `project-conventions.md` and add `skill: project-conventions` to a workflow agent step if you want it selected there; the starter workflow does not reference the skill automatically.

## To resolve skills with the same name

Skill discovery uses the first definition with a given name, in this order:

1. Project `.xezar/skills/`.
2. Project `.ai/skills/`.
3. Project `.agents/skills/`.
4. Project `.claude/skills/`, `.codex/skills/`, `.cursor/skills/`, then `.opencode/skills/`.
5. Global `~/.agents/skills/`, then `~/.claude/skills/`.
6. Configured team repositories.

A local definition can therefore hide a team skill with the same name. Missing directories are fine. Skills can be Markdown files or directories with a `SKILL.md` entry point; supporting Markdown inside such a directory is not discovered as additional skills. See the [discovery implementation](../../packages/xezar/src/skills.ts) and [layout guide](../project-layout.md).

## To add optional project configuration

`.xezar/config.json` holds this project's own choices, such as the base branch or the default agent. It travels with the project, so everyone who opens the project gets the same choices. You do not need it to start: a missing file behaves like the defaults below, and an unreadable or invalid file falls back to them without blocking startup. Add only the keys you want to change. [Guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional) writes only these real keys; your domain, outputs and way of working go into the instruction file instead.

The [project configuration schema](../../packages/xezar/src/config.ts) defines these keys:

| Key | Default when absent |
| --- | --- |
| `skillsRepos` | `[{ "repo": "qodeca/xezar-skills", "ref": "main" }]`, subject to your personal skill selection |
| `worktreeRetention` | The workspace retention default, otherwise 10 |
| `memoryLimitMb` | No project override; the workspace ceiling applies |
| `defaultRunner` | The machine's `agentDefaults.runner`, otherwise `claude` |
| `defaultModels` | The machine's `agentDefaults.models`; otherwise no preset |
| `plannerModel` | `sonnet` |
| `namerModel` | `haiku` |
| `liveTitleUpdates` | `XEZ_TITLE_UPDATES` decides (on by default) |
| `reviewGate` | `XEZ_REVIEW_GATE` decides (off by default) |
| `baseBranch` | The branch currently checked out |
| `systemPrompt` | No extra instructions |
| `modelsLocked` | Not locked by this project |
| `maxParallel` | 2 in the schema, but ignored: see below |

The [Configuration reference](11-configuration-reference.md#to-configure-this-project-xezarconfigjson) gives the accepted values and full precedence for each key. Keep these distinctions in mind:

- A stored `reviewGate` value wins over `XEZ_REVIEW_GATE`; with neither enabled, the gate is off. Autonomous runs skip it.
- Leaving `skillsRepos` absent keeps the default `qodeca/xezar-skills` catalog and personal selection. An explicit list replaces the sources; `[]` disables team sources. Any explicit list bypasses personal selection and hides **Manage skills**, even if it names the default repository.
- `maxParallel` no longer controls how many tasks run. Concurrency is machine state: set it in `~/.xezar/config.json` under `resources.maxParallel`, or per project in the registry entry `projects[].maxParallel`.
- A positive `memoryLimitMb` in a registered project overrides the machine's memory ceiling. A memory ceiling usually describes a computer, not a project, so a shared project is often better without it; set it per machine in `~/.xezar/config.json` under `resources.memoryLimitMb`.

## To keep machine settings out of the project

`~/.xezar/config.json` is separate from the project's file. It belongs to you and your computer, never to a project, and it holds:

- The project registry (`projects`), including each project's optional `maxParallel` and tags.
- Resource limits under `resources`: `maxParallel`, `maxMonitoringSessions`, `monitoringWakeIntervalMinutes`, `autoResumeOnUsageLimit`, `idleTimeoutMinutes`, `memoryLimitMb` and `worktreeRetentionDefault`.
- Machine-wide agent defaults (`agentDefaults`), disabled providers, New Task defaults, and stored switches such as `skillsAutoUpdate`, `followups`, `agentEnvPassthrough` and `modelsLocked`.
- Folder settings: `browseRoot` and `projectsDir`.

Its keys and defaults are listed in the [Configuration reference](11-configuration-reference.md#to-configure-the-workspace-xezarconfigjson), and the [workspace schema](../../packages/xezar/src/workspace/config.ts) defines them. Do not copy this file, or its registry, into a project. Guided setup never writes it.

## To add an optional agent pipeline

A software project can add an agent delivery pipeline: a configuration file, `.xezar/pipeline/config.json`, that describes the project's delivery stages. Most projects do not need one, and xezar works without it.

To add one, accept the pipeline option during [guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional). Setup then uses the public `xez-setup-agent-pipeline` skill from the default team-skills source, `qodeca/xezar-skills`. That skill, not xezar, owns the file's shape.

Setup itself follows a reviewed, pinned revision of the public setup skill. xezar also bundles a complete setup prompt as a fallback, so setup still runs offline or without the team-skills source. If the pipeline skill cannot be found in that case, setup reports the pipeline part as incomplete. It does not guess the file.

To skip it, decline the option. Setup then writes no pipeline file, and the rest of setup still applies. You can add the pipeline later with another setup or re-check task.

## To learn from xezar's own kit

The xezar repository's kit contains **18 workflow YAML files and 20 skill Markdown files** at the source revision used for this guide. It includes documentation maintenance, bug investigation, implementation, review, testing and release workflows, alongside checks and pipeline guidance.

Browse its [directory guide](../../.xezar/CLAUDE.md) and [kit overview](../../.xezar/docs/README.md) as an example of one project's development process. Those roles, gates and release rules belong to the xezar project. They are not prerequisites for using the product, and `xezar init` does not generate them.

The kit can also wrap a shared skill locally. For example, its issue-filing wrapper adds the project's tracker, templates, labels, and evidence rules to a pinned shared procedure, while the catalog entry makes that adapted skill discoverable for a quick task. Keep the shared procedure upstream and make project-specific policy a small local layer, so updating the pinned revision remains a deliberate reviewable change.

## Related settings / env / config

- `.xezar/workflows/` and `.xezar/skills/`: project-maintained workflow and instruction files.
- `.xezar/config.json`: optional project settings; [schema](../../packages/xezar/src/config.ts).
- `.xezar/pipeline/config.json`: optional agent-pipeline configuration added by [guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional); shape owned by the `xez-setup-agent-pipeline` skill.
- `~/.xezar/config.json`: separate workspace settings and project registry.
- `XEZ_REVIEW_GATE`, `XEZ_SKILLS_AUTO_UPDATE`, `XEZ_HOME`: see the [environment contract](../../.env.example), including stored-setting precedence.

Next: [Troubleshooting and FAQ](16-troubleshooting-faq.md)

Describes xezar 0.15.0.
