# Kit environment variables

The scripts in `.xezar/checks/` read a few environment variables of their own. They belong to this
project's task pipeline, not to the xezar product, so they are listed here and **not** in
`.env.example`: that file is the product's environment contract, and a security-scanned path.

None of them needs to be set. Every one has a working default, and an unset variable is always the
normal case. Each script that reads one also explains it in a comment beside the line that reads it;
the "Read by" column names that file.

## Variables an operator may set

Set these only in the environment of the one command or session that needs them – never in a
shell profile or a CI environment, where they would change every run on that machine.

| Variable | Read by | Default | What it changes | Accepted values |
|---|---|---|---|---|
| `XEZ_REVIEW_RUN_SECONDS` | `checks/review-run.sh` | `300` | How long `review-run.sh run` lets one command take before it stops it and everything it started (`review-run=timeout`, exit 124). | A whole number of seconds, 1 to 999999. Anything else is refused. |
| `XEZ_REVIEW_START_SECONDS` | `checks/review-run.sh` | `120` | How long `review-run.sh start --port <n>` waits for the port to answer before it stops the command and refuses. | A whole number of seconds, 1 to 999999. Anything else is refused. |
| `XEZ_DEPS_DIGEST_TIMEOUT_MS` | `checks/lib/deps.mjs` | `60000` | How long the dependency-tree digest may take. A digest that gives up counts as "not fresh", so the task reinstalls its dependencies instead of trusting them. | Up to nine digits of milliseconds. Anything else falls back to the default. |
| `XEZAR_TIMELINE_ENTRIES` | `checks/leader-context.sh` | `40` | How many of the newest campaign timeline entries are loaded into the leader's context at session start (see `leader-context-loading.md`). | A whole number from 1, at most six digits. Anything else falls back to the default. |
| `GATE_APPLICATION_LANES` | `checks/repo-gates.sh`, `checks/lib/gate-parallel.mjs` | the value written into `repo-gates.sh` at setup | Which application gates run side by side: lanes separated by `;`, gate positions inside a lane by `,`. Set but empty means one lane, every gate in list order – slower, never wrong. | Every application gate's position exactly once. Anything else stops the gate with an error. |

`review-run.sh` notes that a review step's own shell cannot set its two limits: they are for the
operator and the kit's tests.

## Variables the kit sets for itself

These are set by one kit script for another. Setting one by hand does not tune anything; it
breaks a guarantee.

| Variable | Set by | What it is for | What happens if you set it |
|---|---|---|---|
| `XEZ_GATE_LEASE` | `checks/repo-gates.sh` | A re-entry guard: the gate script sets it before it re-starts itself under the machine-wide gate lease (the queue that keeps several gate runs from loading one machine at once), so the inner run does not ask for a second lease. | Any non-empty value skips the lease for every gate run in that environment, so parallel gate runs over-subscribe the machine again. It is not an opt-out, and the engine deliberately offers none. |
| `XEZ_GATE_LEASE_STATUS` | `checks/repo-gates.sh` | The temporary file through which the lease reports how long the run waited (`leaseWaitMs` in the gate record). | Only read when `XEZ_GATE_LEASE` is also set. |
| `XEZAR_LEADER` | `scripts/xezar-leader.sh` | Marks the one session that is the project leader, so the session-start hook loads the leader guide into it and into no other session (`leader-context-loading.md`). | Setting it to `1` by hand makes that session a leader session. |
| `XEZ_SHA256_TOOL`, `XEZ_SHA256_PATH` | `checks/lib/common.sh` | Which SHA-256 program was chosen (`shasum` or `sha256sum`) and the `PATH` it was chosen under. | Cleared when `common.sh` loads, so a value from outside is ignored. |
| `XEZ_DEPS_NPM_VERSION`, `XEZ_DEPS_NPM_VERSION_PINNED` | `checks/lib/common.sh` | The npm version, asked once and reused by the dependency fingerprints that follow, so they do not each start npm. A plain shell variable, never exported. | Cleared when `common.sh` loads, so a value from outside is ignored. |

`checks/lib/common.sh` also notes that there is no `XEZ_RUN_ID`; do not invent one.

## Test hooks

`KIT_TEST_GH`, `KIT_TEST_WORKFLOW`, `KIT_TEST_ROUTE_TOOLS`, `KIT_TEST_GATE_LOG` and
`KIT_TEST_ALLOW_ROOT_BOOTSTRAP` exist for the kit's own tests. They replace `gh`, the recorded
workflow, the list of installed agent programs or the gate log path, or unlock a guarded bootstrap
for one named run. Never set them for real work. The other `GATE_*` names in the gate scripts are
values one gate script hands to the next during a run, not settings.

## Variables xezar sets for every step

`XEZ_TASK_ID`, `XEZ_STEP_ID`, `XEZ_HANDOFF_FILE`, `XEZ_TODOS_FILE` and `XEZ_PR_NUMBER` are read by
many kit scripts, but they come from the xezar engine, which sets them for each workflow step.
They are part of the product's contract and are described in `.env.example` and
`AGENT_PROTOCOL.md`, not here.

Two of the product's own settings are also read by kit scripts, and are likewise described in
`.env.example`: `XEZ_HOME`, where `checks/route.mjs` finds the global `agent-accounts.json`
(a single-project folder, one holding `.xezar/workspace.json`, uses its own copy instead), and
`XEZ_DISABLE_REPO_LOCK`, which makes `checks/root-sync-preflight.sh` refuse (`lease.locking-disabled`), because root-sync relies on the
repository lock it switches off.

## Adding a variable

A new environment variable that only a kit script reads gets a row in the matching table above,
in the same pull request as the script change. Give it a working default; never make it required.
