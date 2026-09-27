# Project kit

A project kit keeps reusable agent instructions and workflows beside your source, so everyone who clones the project gets the same ones. It is optional: xezar works with no kit at all. `xezar init` writes two small starter files — a workflow that already runs, and a conventions skill with your project's own notes to fill in — and you commit only the ones your team needs.

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
| `.xezar/workflows/fix-and-verify.yaml` | A short chain: do the task, then verify the result. Its exact shape depends on whether `init` found a check your project already declares — see below. |
| `.xezar/skills/project-conventions.md` | A Markdown skill with `name` and `description` frontmatter and placeholders for what the work is for, what a finished result looks like, the constraints it must respect and how results are checked. |

Existing example files are left untouched. Initialization also creates or updates `.local/.gitignore` with a blanket `*` rule when it can write there. It does **not** create `.xezar/config.json`, and it generates none of the roles xezar's own project uses to develop itself.

**`init` writes no placeholder command.** It reads the project for a check that is plainly declared — a real `test` script in `package.json`, or a `test` or `check` target in a `Makefile` — and writes one of two workflows. It guesses at nothing less certain than that:

| What `init` found | Steps it writes |
| --- | --- |
| A check (`npm test`, `make test`, `make check`) | `implement` (agent, your task) → `verify` (that command, and a failure retries `implement` at most twice) → `report` (agent: what changed, the check's result, what the check did not cover, and any open question) |
| No check | `implement` (agent, your task) → `verify` — an **agent** step, not a command: it reviews the result against the task's own criteria and reports each as met, not met or not verifiable, rather than claiming a check that never ran |

Either way the workflow runs as written; there is nothing to replace first. To give the second form a real check, swap the `verify` step's `prompt` for a `command` your project already runs and add `onFail` with `retry: implement` and `max: 2`. The generated file says the same in a comment, with an example per kind of project.

Fill in `project-conventions.md` and add `skill: project-conventions` to a workflow agent step if you want it selected there; the starter workflow does not reference the skill automatically.

### If something else reads this file

The generated file is recognised by its **step shape** — the step ids, and the last step being an agent step — not by its bytes. Its prose is reworded between releases, so its content hash moves and anything pinning that hash needs the new one after an upgrade.

Adding, renaming or reordering a step is therefore the change that breaks a reader of this file, and neither id is only a name. `implement` is what the command form's `onFail.retry` points at, so renaming it breaks the retry loop. And the last step is an agent step because a run stays open for your questions and answers only when its last agent step is also its last step — append a check after it and the whole run goes silent. Edit the file freely for your own project; but if you generate or inspect it somewhere else, key on those ids rather than on the text.

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

`.xezar/config.json` holds this project's own choices, such as the base branch or the default agent. It travels with the project, so everyone who opens the project gets the same choices. You do not need it to start: a missing file behaves like the defaults below, and an unreadable or invalid file falls back to them without blocking startup. Add only the keys you want to change. [Guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional) writes only these real keys.

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
- Resource limits under `resources`: `maxParallel`, `maxMonitoringSessions`, `monitoringWakeIntervalMinutes`, `autoResumeOnUsageLimit`, `idleTimeoutMinutes`, `memoryLimitMb`, `worktreeRetentionDefault` and `gateSlots`.
- Machine-wide agent defaults (`agentDefaults`), disabled providers, New Task defaults, and stored switches such as `skillsAutoUpdate`, `followups`, `agentEnvPassthrough` and `modelsLocked`.
- Terminal defaults under `cli`, and folder settings `browseRoot` and `projectsDir`.

`gateSlots` has no project-level counterpart, and that is deliberate: it bounds how many full check runs work at once on **this computer**, across every project and every checkout of every project. A project file travels to every machine that clones the project, so it cannot say anything true about one machine's disk and memory.

Its keys and defaults are listed in the [Configuration reference](11-configuration-reference.md#to-configure-the-workspace-xezarconfigjson), and the [workspace schema](../../packages/xezar/src/workspace/config.ts) defines them. Do not copy this file, or its registry, into a project. Guided setup never writes it.

## To add an optional agent pipeline

A software project on GitHub can add a full agent delivery pipeline: a project leader on Claude Code, workflows with their role skills, gates, labels and branch protection. Most projects do not need one, and xezar works without it.

The pipeline comes from xezar-skills 3.0.3, the default team-skills source (`qodeca/xezar-skills`). Its `xez-onboard-opinionated` skill installs it: run [guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional), or start the skill from the kit's [one-prompt bootstrap](https://github.com/qodeca/xezar-skills/blob/main/docs/bootstrap-prompt.md). It works on clean GitHub projects with a Claude Code leader, and stops without writing anything on any other project.

Setup itself uses the public `xez-onboard-opinionated` skill (Xezar Skills 3.0.3) from your team-skills source; it is the only setup xezar offers. A project it has finished carries its install record, `.xezar/onboarding.json`, and xezar reports any project with that record as set up – also when the skill ran outside the cockpit – without offering first-time setup or prompting for a re-check (Re-check now stays available). xezar records which release of the setup templates it bundles, but only to know when to offer a re-check; it does not load the skill at that release. A project last checked against an older kit is offered one re-check, which runs the 3.0.3 onboarding; older kits' own setup skills are no longer started.

The kit it installs has 38 workflows under `.xezar/workflows/`, each with its role skill under `.xezar/skills/`, plus the project's checks, `.xezar/routing.json` for model and lane routing, and the pipeline configuration under `.xezar/pipeline/`. The kit, not xezar, owns the shape of those files. After setup they are ordinary project files that you review and version with the rest of the project.

xezar records which reviewed revision of the setup templates it bundles, but only to know when to offer a re-check; it does not load the skill at that revision.

xezar also bundles its own setup prompt as a fallback, so setup still runs offline or without a team-skills source. That prompt only inspects the project, asks what it cannot tell, shows a per-file preview, writes what you accept and reports the result. It installs no pipeline.

xezar supports projects onboarded with xezar-skills 3.0.3, which needs xezar 0.19.0 or later. A project still on kit 2.x moves to 3.0.3 first; the kit's [upgrade notes](https://github.com/qodeca/xezar-skills/blob/main/UPGRADE_NOTES.md) list the steps.

## Related settings / env / config

- `.xezar/workflows/` and `.xezar/skills/`: project-maintained workflow and instruction files.
- `.xezar/config.json`: optional project settings; [schema](../../packages/xezar/src/config.ts).
- `.xezar/pipeline/`, `.xezar/routing.json`: optional agent-pipeline files installed by [guided setup](01-getting-started.md#to-let-an-agent-set-up-this-project-optional); shape owned by xezar-skills.
- `~/.xezar/config.json`: separate workspace settings and project registry.
- `XEZ_REVIEW_GATE`, `XEZ_SKILLS_AUTO_UPDATE`, `XEZ_HOME`: see the [environment contract](../../.env.example), including stored-setting precedence.

Next: [Troubleshooting and FAQ](16-troubleshooting-faq.md)

Describes xezar 0.18.0.
