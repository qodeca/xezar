# Project kit

Use a project kit to keep reusable agent instructions and workflows beside your source. A kit is optional: start with the small `xezar init` examples, replace their placeholders with your project's conventions, and commit only the maintained files your team needs.

## To find the project's kit

The repository-root `.xezar/` directory holds project configuration, [workflows](05-workflows.md) and [skills](06-skills.md). A project can also keep its own checks, documentation and guidance there. It is separate from `.local/xezar/` execution data and the per-user `~/.xezar/` workspace settings.

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

You do not need `.xezar/config.json` to start. Add only the keys you want to set; the [project configuration schema](../../packages/xezar/src/config.ts) defines the supported keys. Examples include `baseBranch`, `defaultRunner`, `defaultModels`, `systemPrompt`, `worktreeRetention` and `reviewGate`.

Keep these distinctions in mind:

- A stored `reviewGate` value wins over `XEZ_REVIEW_GATE`; with neither enabled, the gate is off. Autonomous runs skip it.
- Leaving `skillsRepos` absent keeps the default `qodeca/xezar-skills` catalog and personal selection. An explicit list replaces the sources; `[]` disables team sources. Any explicit list bypasses personal selection and hides **Manage skills**, even if it names the default repository.
- Per-project `memoryLimitMb` can override the workspace ceiling. The old project-file `maxParallel` key no longer controls enforcement; workspace resources and the project's registry entry govern concurrency.

These project settings are separate from `~/.xezar/config.json`. Do not copy the workspace registry into your project's kit.

## To learn from xezar's own kit

The xezar repository's kit contains **18 workflow YAML files and 20 skill Markdown files** at the source revision used for this guide. It includes documentation maintenance, bug investigation, implementation, review, testing and release workflows, alongside checks and pipeline guidance.

Browse its [directory guide](../../.xezar/CLAUDE.md) and [kit overview](../../.xezar/docs/README.md) as an example of one project's development process. Those roles, gates and release rules belong to the xezar project. They are not prerequisites for using the product, and `xezar init` does not generate them.

The kit can also wrap a shared skill locally. For example, its issue-filing wrapper adds the project's tracker, templates, labels, and evidence rules to a pinned shared procedure, while the catalog entry makes that adapted skill discoverable for a quick task. Keep the shared procedure upstream and make project-specific policy a small local layer, so updating the pinned revision remains a deliberate reviewable change.

## Related settings / env / config

- `.xezar/workflows/` and `.xezar/skills/`: project-maintained workflow and instruction files.
- `.xezar/config.json`: optional project settings; [schema](../../packages/xezar/src/config.ts).
- `~/.xezar/config.json`: separate workspace settings and project registry.
- `XEZ_REVIEW_GATE`, `XEZ_SKILLS_AUTO_UPDATE`, `XEZ_HOME`: see the [environment contract](../../.env.example), including stored-setting precedence.

Next: [Troubleshooting and FAQ](16-troubleshooting-faq.md)

Describes xezar 0.15.0.
