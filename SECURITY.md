# Security policy

**xezar runs AI coding agents with shell access on your machine, as your user, and that is a different risk from a chat window: an agent can run any command you could.** By default an agent step gets unrestricted `Bash`, Codex runs with `sandbox: danger-full-access` (unless `XEZ_CODEX_NETWORK=0`), and OpenCode auto-approves its permissions (`packages/xezar/src/workflows/types.ts` `DEFAULT_ALLOWED_TOOLS`, `packages/xezar/src/core/codex-app-server-runner.ts`, `packages/xezar/src/core/opencode-server-runner.ts`). The cockpit is an HTTP server with no login of its own.

This page says where the line sits between "xezar doing what it says" and "a vulnerability", how to report the second kind privately, and what happens if nobody answers.

## What is and is not a vulnerability

### Not a vulnerability – working as designed

- **An agent runs a destructive command because someone asked it to**, or because a prompt, an issue body or a file it read steered it there. Prompt injection into an agent that has a shell is the threat class this page opens with, not a flaw in xezar.
- **An agent reads, changes or deletes any file your user can reach**, inside or outside its task worktree. A worktree keeps parallel tasks apart in git; it is not a sandbox.
- **An agent reads a secret from disk** (`~/.aws/credentials`, a `.env` file) and uses or prints it. The agent has your shell.
- **Any process on this machine can call the cockpit's API.** It binds `127.0.0.1` with no authentication on purpose (`packages/xezar/src/index.ts`, `packages/xezar/src/server/server.ts`). A program that does not send an `Origin` header, such as `curl`, is treated as local.
- **The cockpit shows and drives every project you registered.** It is one user's workspace, not a multi-tenant service.
- **A cockpit that you exposed with `--bind-host` or `XEZ_REMOTE=1`, without an authenticating proxy in front of it.** xezar prints a warning on a non-loopback bind and has no auth of its own; the [remote-access guide](docs/server-install/README.md) puts a login in front of it.
- **Anything that needs `XEZ_AGENT_ENV_FULL=1`, `XEZ_REDACT_SECRETS=0` or `XEZ_ENV_PASSTHROUGH`** to happen. Those switches exist to turn a protection off.

The mitigation for all of these is yours as the operator: run xezar in a machine, VM or container you are willing to let an agent change; review what agents do before you merge it; and do not put secrets where an agent can read them.

### A vulnerability – a boundary xezar claims to hold

Report anything that gets through one of these. Each names the code that is meant to hold it.

- **A web page reaches the API.** In local mode every `/api/*` request must carry a loopback `Host` header, which stops DNS rebinding, and every `POST`, `PUT`, `PATCH` or `DELETE` that carries an `Origin` must come from the cockpit's own origin, which stops cross-site request forgery. `/api/v1/health` is the one CORS-open route, and it still gets the `Host` check. The WebSocket handshake has the same checks, and a connection that is not provably the cockpit only sees topics marked safe for any local page. Code: the `app.use('/api/*', …)` guard and `verifyWsUpgrade` in `packages/xezar/src/server/server.ts`; `isLoopbackHostHeader` in `packages/xezar/src/server/capabilities.ts`; topic gating in `packages/xezar/src/server/ws.ts`.
- **A hosted cockpit changes the host machine.** With a non-loopback bind or `XEZ_REMOTE=1`, xezar is in hosted mode and refuses with `409` the routes that act on the machine rather than the repository: writing the agents' own config files (they can define hooks and MCP commands, so a write is a code-execution path), agent profiles and accounts, "open in" an editor or terminal, and reading home-directory config files. Code: `resolveCapabilities` (`localHandoff`) in `packages/xezar/src/server/capabilities.ts`, and the `PUT /agent-config/:id` handler and its siblings in `packages/xezar/src/server/server.ts`.
- **One project's MCP session reaches another project.** An MCP session is bound to one project by the socket it connected on, and every task, file, worktree, cursor and automation it names must belong to that project. Code: `packages/xezar/src/mcp/session-binding.ts` and `packages/xezar/src/mcp/resource-ownership.ts`.
- **xezar itself serves a file outside the place it promises.** When the cockpit reads a task's files, it reads only inside that task's worktree and refuses symlinks and `.git` (`readWorktreePath` in `packages/xezar/src/server/git-changes.ts`). The folder picker lists only directories under its browse root, judged after resolving symlinks (`packages/xezar/src/server/fs-browse.ts`). MCP file reads refuse any symlink on the path (`ownWorktreeFile` in `packages/xezar/src/mcp/resource-ownership.ts`). Agent config files are addressed by catalog id, never by a path (`packages/xezar/src/agent-config/files.ts`). This is about xezar's own routes; an agent's shell is covered above.
- **A credential survives redaction.** With redaction on (the default), the value of a secret-named environment variable of 12 or more characters, or a known token shape (GitHub, Anthropic, OpenAI, AWS, Google, Slack, GitLab), must not reach a run transcript, the run index, an automation receipt or an MCP tool response. Code: `redactSecrets` and `redactDeep` in `packages/xezar/src/core/secret-redaction.ts`, applied in `packages/xezar/src/runs/store.ts`, `packages/xezar/src/automations/store.ts` and `packages/xezar/src/mcp/`.
- **A host secret reaches an agent's environment.** Agents start with an allowlisted environment: secret-shaped variables are dropped unless they are the chosen backend's own credentials, the `gh` token, or variables you named. Code: `buildChildEnv` in `packages/xezar/src/core/agent-env.ts`.

If you are not sure which list something belongs on, report it privately. That is always the safe choice.

## How to report

Use **Report a vulnerability** on this repository's [Security tab](https://github.com/qodeca/xezar/security/advisories/new). The report stays private between you and the maintainers.

**Do not open a public issue, pull request or discussion for a vulnerability.**

Please include:

- the xezar version (`xezar --version`) and how you installed it;
- your operating system;
- which agent backend was involved: Claude Code, Codex, OpenCode or pi;
- whether `XEZ_DRY_RUN` was set;
- whether the cockpit was local or hosted (`--bind-host`, `XEZ_REMOTE=1`);
- a reproduction: the smallest steps, request or prompt that shows the problem.

## Supported versions

xezar is a young 0.x project. Only the latest release on npm is supported. A security fix ships in a new release; older versions are not patched.

## If nobody answers

xezar has a small maintainer team. If your private report has had no response after 14 days, open a **public** issue whose entire content is that you are waiting on a private security report – for example, "I filed a private security report on 2026-01-01 and have not had a reply." Put no details and no reproduction in it. That gets attention without disclosing anything.
