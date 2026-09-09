# Working with the Xezar project kit

This is the maintained project operating kit for developing Xezar with Xezar. Read the repository's `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md` and `BACKWARD_COMPATIBILITY.md` first; this guide explains the local kit and does not replace those contracts. It does not implement the future MCP server, built-in leader or distributed kit.

## Structure

- `config.json`: optional project choices (main base, skill-owned handoff, shared task instructions). No credentials, private accounts, foreign model pins or global resource limits. Defaults/discovery remain usable without authored config.
- `workflows/`: 14 role workflows. Nine development workflows retain preflight → setup → author → readiness → gates → evidence → handoff, with at most two gate-repair returns. Integration and root synchronization are separate roles. The final step stays an agent for interactive questions.
- `skills/`: 16 `xezar-*` roles: triage, business analysis, planning, implementation, bug investigation, code review, review response, testing, docs, dependencies, release preparation, release changelog, release publish, quality gates, handoff and integration. The selected backend/model is inherited rather than pinned to another vendor.
- `checks/`: executable isolation/setup/Git, gate/evidence, resume, integration, root-sync and merge-recovery guards. `checks/lib/` holds shared identity/fingerprints, record/manifest/intent verification, bootstrap and SDLC policy helpers. `infra-tests.sh` exercises isolated synthetic repositories; `xezar-contract.test.mjs` checks real loaders, npm gates, snapshots and local guidance.
- `docs/`: operating instructions, analysis checklist, coordination, recovery, qualification, lessons, close-out, adaptation record and learning from actual development tasks. See `docs/README.md` and `docs/installation.md`.
- `.gitignore`: only real local/runtime paths. Maintained documents, workflow/skill definitions and helper scripts are versionable by default, including future ordinary files.

Local-only state includes runs/indexes, worktrees, tmp/cache, UI state, todos, automations/receipts, launch key, credentials, evidence and snapshot markers. Never commit it or copy it into another checkout. Durable task evidence belongs in primary `.local/xezar-tasks/<runId>/`, not reclaimable worktree-local scratch. Do not delete this entire directory to clean runtime; it also contains the maintained kit.

## Discovery and fresh worktrees

The existing Xezar loaders discover `.xezar/workflows` and `.xezar/skills` directly. A committed kit arrives through Git. Until it is committed, every workflow begins with the explicit `kit` command, which locates the same repository's primary checkout and runs `checks/bootstrap.sh`. It copies only maintained kit assets into the validated task worktree, no dirty application source, runtime, personal configuration or secrets. `.local/xezar-kit/snapshot.json` records the local snapshot and is ignored. Existing snapshots are reused on continuation; conflicting existing task content and symlinks are refused, never overwritten.

Standalone skills explain the equivalent prerequisite when checks are absent. Bootstrap is a project command, not an engine feature; the current engine's personal-agent-config seeding does not seed this whole kit. Never solve missing files by committing unrelated primary-checkout work or by operating on a peer worktree. Read effective config/tool availability from the current run; successful static loading is not a live-client certification.

## Commands and stage ownership

```sh
node .xezar/checks/catalog-check.mjs
bash .xezar/checks/infra-tests.sh
npm test -- packages/xezar/src/tracked-files.test.ts
bash .xezar/checks/worktree-preflight.sh
bash .xezar/checks/worktree-setup.sh
bash .xezar/checks/repo-gates.sh --fast
bash .xezar/checks/worktree-preflight.sh --record-gate-evidence
bash .xezar/checks/worktree-preflight.sh --verify-gate-evidence
bash .xezar/checks/resume-complete.sh --dry-run
```

Writing commands require the correct Xezar task checkout. Read-only evidence initialization is `worktree-setup.sh --readonly-init`; it installs nothing. Full setup needs Node >=20 and npm, and uses `npm ci`. Dependency freshness includes lock/shrinkwrap, root/workspace manifests, npm config, patches and Node/npm versions. No `.env` auto-loading or secret copying.

The canonical gate preserves the repository's required order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`; dependency preparation and kit fixtures surround those five commands. UI smoke/manual QA is separate per SDLC and is not a pass when unavailable. Its maintained browser guide is `docs/testing/agent-browser.md`. Never replace real gates with synthetic fixture results or use `npx` to fetch a different test runner.

Complete code, tests, docs, generated outputs and release metadata in development; run focused checks there. Gate stage runs the full canonical list. Handoff changes no content and makes no late commit: missing work returns to development/gates. Use `worktree-git.sh` for bound commit/push. Quality-gates repairs the same failure at most twice; workflow repair returns are separately capped at two. Retain failed attempts across reassignment; do not invent a global retry allowance or weaken a control.

## Identity, decisions, evidence and recovery

Validate actual task directory, Git registration, branch `xez/<first8>` and current CWD. Never silently fall back to root, adopt another branch or infer authority from a file. The leader owns goals/plans and review adjudication; specialists provide technical evidence. Within existing authority proceed; ask genuinely missing decisions with structured options/custom answer. Silence is not approval. An unresolved dependent decision records `BLOCKED`, and readiness must stop before gates. Independent work continues.

Evidence records complete hashed logs, ordered attempts, real outcomes, current content/revision and safe environment facts. Historical validity, reuse here and current eligibility are distinct. New failure cannot be hidden behind an older green attempt; missing logs, skipped/unavailable gates, unknown schemas or changed content never imply pass. Current fingerprint includes local kit content even when a task snapshot is ignored. Cross-task audit is read-only with trusted path containment; CI observations append without rewriting seals.

Consume the current checkpoint and late steering before resume/handoff. A diagnostic-only resume writes nothing; normal resume checks remaining work and eligibility rather than replaying everything. Merge recovery requires matching intent recorded before the authorized operation, preserves partial work and never performs automatic abort/reset. Normal readiness/quality still applies afterward.

Integration uses the exact reviewed head/base, real hosting policy plus SDLC labels/QA, and the actual Xezar CI check. Xezar merges by squash into main: verify resulting content/commit and single-parent/base relationship, then target CI and remaining business scope. Root-sync is a separate Worktree OFF operation, fixed-target fast-forward on a clean expected branch under actual engine root ownership. The guard's authority record cannot prove a live lease. Release publication remains the existing manually dispatched Release workflow when authorized; ordinary CI does not publish.

The `release` role runs one whole patch/minor/major release as one Worktree ON task from a one-line brief (`bump: patch`, optionally `version:` and `dry-run: true`), with no hand-written changelog brief: the `changelog` step derives the `# <version> (<date>)` section from the PRs merged since the last `v*` tag, folds every `# Unreleased` section into it (`checks/changelog-check.sh` refuses more than one or a misplaced one) and commits; the normal readiness → gates → evidence spine follows; and the last step merges the changelog PR, dispatches the Release workflow once for that bump, verifies npm/tag/GitHub Release and merges the bot's bump PR. Every wait on CI, npm or a merge lives in that last step because a non-final agent step that does not set its own `timeout` still falls through to the runner's 30-minute default (#22 added the field; no kit workflow sets one), and being last keeps `XEZ:ASK` live for each stop. The role never touches the primary checkout; bringing it to the bump merge commit is the separate `root-sync` role. `release-prep` stays as the brief-driven fallback.

## Learning and limits

Each future authorized development task may improve the recommended way of working. Record workflow/skill/effective settings, kit/runtime/code identity, expectation, observation, evidence, problem, change, regression proof and remaining limit. Distinguish adapted, fixture-tested, real-task verified and recommended. Review evidence and remaining risk, not votes or quotas. Preserve public-safe lessons and actionable follow-ups in maintained docs; keep private logs local. No extra task, fixed improvement schedule or blanket completion claim follows from the learning loop.

This kit was adapted from the current reference `.xezar` baseline recorded in `docs/installation.md`; the reference repository was not modified. Tests cover local helpers and synthetic policy/identity cases. Real model/browser sessions, live hosting integration, actual root-lock serialization and checkpoint-only coordinator continuity remain unqualified until observed in future authorized work. Existing product requirements in `docs/features/` remain requirements, not capabilities installed by this kit.
