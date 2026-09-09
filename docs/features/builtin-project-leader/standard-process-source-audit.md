# Standard process source audit and transfer register

Status: **completed static source-to-requirements audit; no implementation or runtime certification**. Audit date: **2026-09-09**.

The user's readiness signal released the current `daxko-platform` **`.ai/xezar/`** baseline at Git commit **`240783084fad65fca78f380ac2b409deb5ae8414`**. The source checkout was clean when read. The retired `.ai/cezar/` tree was not used. References to retired behavior inside current documents are classified as history, not active product requirements.

Related contracts: [built-in leader and standard kit](builtin-project-leader-requirements.md), [project MCP](../mcp-server/mcp-project-leader-requirements.md), [client compatibility](../mcp-server/mcp-client-compatibility.md). This annex is the detailed source register behind L-F31–32 and L-A27–28. It preserves previously approved Xezar outcomes; it is not an executable kit, source-code security audit, or authorization to publish new issues.

## Scope, method and evidence boundary

The tracked baseline contains **56 files: 13 workflows, 14 skills, 16 checks/helpers, 11 operator documents, config and ignore policy**. All workflow/skill roles and operator-document responsibilities were reviewed. Check/helper code was inspected at its behavioral boundaries and test scenarios; this does not claim a line-by-line audit of every implementation path. Supporting context was the current root `AGENTS.md`, `CLAUDE.md`, `docs/xezar.md`, relevant build/test/tool-scope configuration, architecture testing guidance and CI gate callers. Private runtime histories, credentials, launch keys and domain API content were excluded. No historical source directory was audited or migrated.

Every row below preserves an operating effect; project-specific literals are deliberately adapted rather than transplanted. Acceptance references are **required future tests, not passed results**. No Daxko scripts, model sessions, CI jobs, integrations or destructive pilots were executed in this audit. Source reports of previous trials are attributed source evidence only. No source files were changed.

## Practice-to-product matrix

`docs/`, `skills/`, `checks/`, `workflows/` and `config.json` below are relative to `.ai/xezar/`; root context is explicitly named. Generic requirements are in the linked leader contract. Each practice maps to at least one acceptance case with a concrete failing condition.

| Practice | Current source / section | Generic capability or process | Required project adaptation / preserved boundary | Requirement and verification |
| --- | --- | --- | --- | --- |
| P-01 | `AGENTS.md §1; skills/daxko-planning-spec.md` | Leader owns the project/campaign plan; specialists contribute technical plans and evidence without inheriting business authority. | Keep goal/DoD and authority separate from technical decomposition; scale the plan to the work. | L-F36; L-A34 |
| P-02 | `skills/daxko-code-review.md; skills/daxko-review-response.md` | Leader adjudicates prioritized findings using evidence, not reviewer votes. Authors fix, substantiate disagreement, or record a scoped deferral; required blockers prevent PASS. | Risk-based review stops when remaining unread scope cannot plausibly hide a blocker; record the boundary. No mandatory number of rounds; new changes reopen relevant risk. | L-F36; L-A34 |
| P-03 | `docs/parallel-tasks.md; docs/ui-operations.md §0` | Schedule dependencies and shared resources, not just available task slots. Monitor execution status/milestones and act on waiting/blockers. | Map overlapping files, branch/base, spec registry, caches, ports, services and writer/readers; do not copy the source concurrency cap. Leader pause, executor state, and archival remain distinct; no cancellation merely to drain a queue. | L-F37; L-A35 |
| P-04 | `docs/parallel-tasks.md; docs/ui-operations.md; AGENTS.md` | Write common campaign background once and give each specialist a focused brief plus stable references. A worktree executor cannot be assumed to inherit the root conversation. | Use project-owned context artifacts outside peer live worktrees, bounded scope and relevant deltas. Fan-out cost forecasting/design-stage fan-out remain source backlog proposals, not mandatory new numeric budgets or quotas. | L-F38; L-A36 |
| P-05 | `docs/ui-operations.md §11; docs/recovery.md; docs/close-out.md` | Maintain compact checkpoints, decision records and handoffs; durable conclusions/follow-ups must not live only in ignored transient artifacts. | Capture goal, AC, plan/tasks, decisions, current revision, evidence, blockers, next actions. Resume reconciles the current checkpoint and late steering; preserve artifact access after checkout cleanup. | L-F38; L-A36 |
| P-06 | `workflows/*.yaml; skills/daxko-implementation.md; skills/daxko-docs-maintenance.md; skills/daxko-handoff-draft-pr.md` | Writing stages own all content changes and focused checks before canonical gates; evidence/handoff cannot silently change content or commit missing work. | Include tests, generated artifacts, documentation and release metadata in development. If a handoff discovers missing content, return to the correct stage and invalidate affected evidence. Analysis/review keep their separate outputs. | L-F26, L-F39; L-A16, L-A37 |
| P-07 | `checks/resume-complete.sh; docs/recovery.md` | Resume diagnoses current identity, decisions, dependency freshness, content and evidence before deciding what stages remain. | Do not replay an entire workflow or infer completion from status. A dry inspection changes nothing; reusable evidence may skip repeat work only when current checks prove eligibility. The source helper prints context pointers; product reconciliation must actually consume them. | L-F12, L-F39; L-A37 |
| P-08 | `checks/worktree-preflight.sh; checks/lib/common.sh; docs/worktrees.md` | Validate actual checkout/root, derived task identity, registration and branch before mutation and after resume. Refuse unresolved Git states and explain the failed predicate and judged CWD. | Discover project branches, paths and contracts. Never silently fall back from a missing task checkout to the root or repair ownership by adopting another branch. Configuration is discovered/defaulted, never required user-authored setup. | L-F40; L-A38 |
| P-09 | `checks/worktree-git.sh; skills/daxko-review-response.md; docs/recovery.md` | Bind guarded commit/push to the validated checkout and named ref. Corrections reuse the owning task/PR when possible. | Preserve identity between validation and effects. Owner loss requires deliberate, recorded migration within existing authority, not a second incidental PR or an automatic destructive repair. | L-F40; L-A38 |
| P-10 | `checks/worktree-setup.sh; checks/lib/common.sh` | Setup is idempotent and dependency freshness covers lockfile, package manifests, package-manager configuration/version and patches, not only the top-level lockfile. | Discover equivalent inputs for each toolchain; source-only changes need not reinstall, dependency changes must. Never copy secrets. Read-only initialization creates evidence context without install/fetch; if execution is needed, prepare an appropriate isolated environment. | L-F40; L-A38 |
| P-11 | `checks/repo-gates.sh; checks/lib/gate-record.sh; .github/actions/ci-gates/action.yml; .github/actions/ci-gates/contract-test.sh` | Local and CI callers use the same canonical ordered gate contract; each gate has its real command and outcome. | Adapt commands and permitted skips to the project. Reject hidden failure suppression/duplicate divergent gate definitions; missing credentials or dependencies are explicit not-run/skip, never an invented pass. | L-F27, L-F41; L-A39 |
| P-12 | `checks/lib/gate-record.sh; checks/lib/gate-results.mjs` | Record versioned attempts with unique ordered identity, status/exit code/timing, full durable logs and integrity hashes, command-list identity, revision/content and relevant environment observations. | No seal when log creation/writing fails, required results are absent or duplicated, or order cannot be established. Keep bounded excerpts for conversation and full logs for audit. Capture no secrets. | L-F41; L-A39 |
| P-13 | `checks/lib/gate-results.mjs: latest-attempt selection and sealing` | A newer failed/interrupted/malformed attempt supersedes an older success for the same candidate; an unrelated historical failure does not veto a later valid candidate. | Reserve attempt order atomically, diagnose collisions/ties and malformed evidence explicitly. Preserve history; do not guess newest from filename or silently fall back to a green attempt. | L-F41; L-A39 |
| P-14 | `checks/lib/gate-results.mjs: audit and current eligibility; checks/verify-evidence.sh` | Separate historical validity, reuse in this environment and current eligibility. Every caller supplies independently observed current checkout facts. | A seal cannot certify itself as current; compare actual HEAD/tree/environment. Missing Git/inputs are unavailable, not equal. Legacy records remain readable but unverified; unknown schemas cannot pass. | L-F42; L-A40 |
| P-15 | `checks/verify-evidence.sh; checks/lib/gate-results.mjs` | Allow independent read-only verification of another task without changing its checkout or record. | Root evidence paths in trusted project/task context; prevent traversal, symlink escape and record-supplied root substitution. Preserve record hashes and audit diagnosis. | L-F42; L-A40 |
| P-16 | `skills/daxko-handoff-draft-pr.md; checks/lib/gate-results.mjs` | CI observations append without rewriting a sealed local attempt; report tested SHA and pending/failure/skip truthfully. | Distinguish task head, PR merge ref and actual merge commit; local green is not remote CI green. Use pushed-head identity, prevent duplicate publication paths, retain explicit pending rather than unlimited polling. | L-F42; L-A40 |
| P-17 | `workflows/integration.yaml; skills/daxko-integration.md Mode A; checks/integration-preflight.sh` | Integrate the exact reviewed head against the inspected base only when current project delivery gates and actual hosting policy are met. | Discover branch protection/rulesets, current required checks, head-specific approvals and unresolved threads. Zero required approvals may be legitimate; inaccessible policy is not zero. Recheck moved base/head, draft/missing/pending/already-merged cases. Authority stays within approved goal; no extra per-button consent. | L-F43; L-A41 |
| P-18 | `skills/daxko-integration.md Mode A; docs/close-out.md §7` | After integration, verify actual merge identity/parents and target CI; integration does not finish unmet business scope. | Use existing Xezar project operations, add no release engine. Block dependent progression on failed/unknown required results; already merged is reconciliation of prior completion, not a fresh merge. | L-F43; L-A41 |
| P-19 | `workflows/root-sync.yaml; skills/daxko-integration.md Mode B; checks/root-sync-preflight.sh` | Root synchronization is a distinct root-only operation under the actual engine resource lease: clean expected branch, fixed preselected target, fast-forward only. | No task-worktree command may impersonate root ownership with git -C. Refuse fallback, disabled locking, wrong root/branch, dirt or non-FF; a record is not proof of a lease. Finish promptly to release the resource; support already-current no-op. | L-F43; L-A42 |
| P-20 | `checks/merge-recovery.sh; checks/lib/merge-intent.mjs; docs/recovery.md` | Record the intended merge identity before starting; recover only the matching single merge, preserving partial work. Ordinary guards still refuse both unresolved and resolved in-progress merges. | Match project/task/root/branch/original head/incoming ref; never retrofit authorization from arbitrary state. Narrow mechanical recovery cannot waive goal/quality or blocked readiness; no automatic abort/reset/cleanup. | L-F44; L-A43 |
| P-21 | `checks/infra-tests.sh; checks/lib/common.sh: fixture_scratch_dir` | Guard tests use disposable synthetic repositories and safe scratch; cleanup must prove containment and never target real work. | Reject empty/relative/outside/symlink escapes; snapshot fixture refs, worktree registration and working content before/after. Test cleanup failures/leaks and allow unrelated concurrent project work outside fixture scope. | L-F46; L-A45 |
| P-22 | `checks/infra-tests.sh; .github/actions/ci-gates/contract-test.sh` | Exercise actual commands/callers with positive controls and deliberate violating mutants, not just text assertions or the happy path. | Prove each regression test fails without its fix and refusal has no side effects. Cover initial execution, continuation, recovery, local and CI caller paths; mocks must match real payload shapes including check names and approval counts. | L-F46; L-A45 |
| P-23 | `biome.json; knip.json; package.json; checks/infra-tests.sh` | Recursive tooling ignores runtime/generated/worktree artifacts but still analyzes real tracked source and build/generation scripts. | Derive tool-specific scopes, including nested worktrees; pair ignored-artifact fixtures with tracked-error positive controls. Scope correction is not permission to reduce required quality. | L-F46; L-A45 |
| P-24 | `checks/catalog-check.mjs; checks/infra-tests.sh; docs/upgrade-checklist.md` | Catalog validation rejects unsupported keys, malformed agent/check shapes, broken skill/script references, invalid backward retries and required phase-order violations. | Use actual supported schemas/settings. Standalone skills are legitimate; do not add a false rule that every installed skill must be reachable from YAML. Check maintained documentation links and executable references as well as catalog syntax. | L-F47; L-A46 |
| P-25 | `config.json; docs/xezar.md; docs/upgrade-checklist.md` | Effective settings, per-step model pins and installed capabilities outrank composer labels or assumed defaults. Upgrades requalify behavior against a pinned build. | Preserve T-01–09; record source/build/version/artifact identity in qualification. Do not copy vendor IDs, branch names, source cap, mandatory config, or old timeout numbers. Respect zero config, global read-only scope and immutable active-task versions. | L-F22–24, L-F47; L-A46 |
| P-26 | `docs/business-analysis.md: template/reviewer checklist; skills/daxko-business-analysis.md; skills/daxko-code-review.md` | Business analysis states revision, intake/problem, evidence/inference, material assumptions, scope/non-goals, rules, status quo/alternatives, AC/failure paths, unknowns, recommendation and authority. | Stable criterion IDs, verification and a concrete falsifier; cover error, empty, partial, unauthorized, unavailable and already-done paths. Recommendation is analyze further, direct implementation, spec first, defer or reject; safe file:line citation plus relevant fragment for claims; no invented standard, self-asserted totals or unsupported recommendation. Writer and semantic reviewer apply the same complete checklist. Domain-specific facts remain project-owned. | L-F45; L-A44 |
| P-27 | `docs/business-analysis.md: acceptance; docs/ui-operations.md §11.2; governed planning/implementation skills` | Acceptance pins reviewed content identity and actual delegated authority, not a mutable version label or a green build. Material changes require renewed assessment before dependent work. | Use immutable revision plus path/version or criteria snapshot; record accepted scope/conditions and who decided. Do not edit tool-managed manifests ad hoc. Keep file hashes outside the bytes they describe; the source self-hash wording is corrected, not copied. | L-F45; L-A44 |
| P-28 | `docs/README.md; docs/close-out.md; docs/lessons-learned.md; docs/enhancement-ideas.md status index` | Separate source observations, fixture/mocked results, live observations and unknowns. Close out each scope item with evidence and residual disposition. | Implemented, validated, deferred with trigger, qualification needed, rejected; retain partial/context-only qualifiers. A historical candidate is not a demonstrated current Xezar defect. No automatic issue publication from a wish list. | L-F48; L-A47 |
| P-29 | `docs/single-task-pilot.md; docs/close-out.md §6–7; docs/enhancement-ideas.md` | Qualification runs have controlled build/runtime identity and measured evidence; no speed/cost/concurrency claim without a comparable measurement. | Do not change tested build mid-pilot; distinguish ordering observation from proof of lock mechanism. Missing usage is unknown, not zero; deduplicate reported usage before totals. Source coordinator checkpoint-only pilot remains unexecuted evidence. | L-F48; L-A47 |
| P-30 | `docs/lessons-learned.md; docs/upgrade-checklist.md; docs/close-out.md` | Record lessons and actionable residuals in maintained project guidance, preserve rationales, and verify updates against old guarantees. | Outcome-driven improvement retains L-F20 timing, history/rollback and quality. Do not impose a historical resume counter, schedule, generator, archive mechanism or new permission layer. | L-F20–24, L-F48; L-A20–22, L-A47 |

## Source conflicts and explicit resolutions

These are interpretations of the pinned source against already-approved Xezar decisions, not newly requested policy deviations.

| Source tension | Resolution in Xezar |
| --- | --- |
| Blanket no-merge wording in source general instructions versus the integration role | Preserve agreed autonomous existing project merge/publication/deletion within approved goal/DoD; preserve integration checks and role stage ownership. Do not import a per-operation human permission layer or add a release engine. |
| Source settings require local branch/config conventions and cap concurrency at two | Discover branches/toolchain/capabilities and use working defaults. Preserve shared-resource enforcement, not literal values or mandatory user configuration. Global limits remain outside leader write authority. |
| Older historical coordinator/cost/fan-out prescriptions versus current leader discretion | Active outcome-driven improvement and risk-based review govern. Do not invent a fixed resume counter, schedule, reviewer minimum or global retry budget. The two agreed repair limits remain independent. |
| Enhancement bodies use wish-list language while the index records implemented behavior | The current status index controls source classification. Retired cockpit observations require current Xezar qualification before they become product defects; deferred triggers remain visible. |
| Close-out opening summary and UI runbook lag the newer integration/root-sync account | Prefer the specifically dated close-out §7 for what the source reports; do not infer every workflow was live-qualified. No remote issue status or current runtime result was independently checked here. |
| BA template asks for the hash of its own final file content inside that same file | Preserve immutable content identity with an external digest/acceptance record computed after the final write. Do not copy an impossible self-referential SHA requirement. |
| Historical orphan-skill commentary versus catalog code deliberately allowing standalone skills | Preserve resolvable references and legitimate independently invoked skills, including quality-gates; no artificial YAML reachability requirement. |
| Source partial late-steering handoff support versus agreed reconcile-before-resume | Require actual current checkpoint/late-steering consumption under L-F12/L-F38. Printing pointers alone does not satisfy reconciliation. This closes a source gap already covered by the approved Xezar outcome. |
| A merge-intent/authority file cannot prove a live engine lease or grant authority | Treat it as recorded intent/context. Enforce actual identity, project authority and root resource ownership in services; do not promote arbitrary file content to permission. |

## Evidence qualification ledger

| Evidence available at the pinned source | What it supports | What remains unproven |
| --- | --- | --- |
| Current workflow/skill/config/check code and negative-fixture source | Defined behavior and a concrete basis for transferable requirements | Test execution in this audit, correctness of every helper path, or implementation in Xezar |
| Source close-out §7 dated 2026-09-09 reports live integration and two root-sync launches, merge-parent/CI inspection and no execution overlap at recorded resolution | Source-reported successful narrow scenarios; refined integration/root-sync acceptance targets | All refusal paths live, exact engine-lock mechanism from ordering alone, throughput/speedup or all-backend certification |
| Source fixture/mock cases for moved base, protection, checks, approvals, root refusal and evidence corruption | Specified positive/negative scenarios to preserve | Actual hosting-policy compatibility and real concurrency behavior on the future candidate |
| Source checkpoint-only coordinator handoff marked procedure implemented, pilot pending | A maintained recovery procedure | Fresh coordinator continuity from checkpoint alone; L-A36 must exercise it |
| Source reports measured install/disk/gate/CI timing with partial interaction/deferral samples | Those attributed measurements in their original environment | New project performance, total cost, concurrent-gate speedup or a missing token count being zero |
| This documentation change | Baseline manifest, practice mappings and acceptance definitions | Passing L-A01–47, complete kit implementation or certification of Claude Code/Codex/OpenCode |

## Baseline file manifest

Each path is relative to the source repository and is pinned by the commit above; the Git blob identifies exact file content. Multiple practices per file are represented by P references, rather than treating a file checkmark as semantic coverage.

| Source file | Git blob | Practice mapping |
| --- | --- | --- |
| `.ai/xezar/.gitignore` | `7f76e9c02db6cdcf8010810c0122249ae0661399` | P-05, P-08, P-23 |
| `.ai/xezar/checks/catalog-check.mjs` | `98b2840cfe10f94ae31d56c797a364a7b3ed71f9` | P-24 |
| `.ai/xezar/checks/infra-tests.sh` | `e67c214fdb9e8976a04d70ab283fb417985379df` | P-11–27; negative/positive cases |
| `.ai/xezar/checks/integration-preflight.sh` | `df9ea4c242a7ffa12c18416d628651be20a9ca39` | P-17 |
| `.ai/xezar/checks/lib/common.sh` | `c421e2d7b0d213fc8334493fc651c4f70634ccb1` | P-08, P-10, P-21 |
| `.ai/xezar/checks/lib/gate-record.sh` | `4c3b195927289625aa071dc610b43def18f7ea79` | P-11–12 |
| `.ai/xezar/checks/lib/gate-results.mjs` | `26c73cd354298a83c7fbf55cf1a0f25be528aa12` | P-12–16 |
| `.ai/xezar/checks/lib/manifest.mjs` | `3ba569d334a890c1528a7b0f18c2213bea2f17cf` | P-05, P-08, P-10, P-12 |
| `.ai/xezar/checks/lib/merge-intent.mjs` | `9a0c7f902abebca7166ca8d9672123383450e385` | P-20 |
| `.ai/xezar/checks/merge-recovery.sh` | `e88cf462a72a83b2fc2ddc59bcb78793679a87db` | P-20 |
| `.ai/xezar/checks/repo-gates.sh` | `0074fc07b98bd6eda103104056997579ba054157` | P-11 |
| `.ai/xezar/checks/resume-complete.sh` | `545e86ed200aaf54fa0ba3bbeb592b04ac9f93a8` | P-05, P-07 |
| `.ai/xezar/checks/root-sync-preflight.sh` | `ffc2200c6e4eab2de59f2b57dbb80a05f4cf2f46` | P-19 |
| `.ai/xezar/checks/verify-evidence.sh` | `f17dc2763aaa7c39f85e8da89b9b73965b00d7f3` | P-14–15 |
| `.ai/xezar/checks/worktree-git.sh` | `87e4560f0cda52990c3d5836b51ae42c2c7a1f8e` | P-09, P-20 |
| `.ai/xezar/checks/worktree-preflight.sh` | `a27ceaf6f34439900d45a9528ea3116f20675450` | P-08 |
| `.ai/xezar/checks/worktree-setup.sh` | `4d54249578fc246805fa567d583202154b857c46` | P-10 |
| `.ai/xezar/config.json` | `4f9bffffb2568ae5af5d2516a3f4e3dc304f1590` | P-24–25; T-01–09 |
| `.ai/xezar/docs/README.md` | `57d454e36844c6aa4a390312bb09c258dd41ba45` | P-28–29 |
| `.ai/xezar/docs/business-analysis.md` | `e297536b9c60bb25fa96187ec82dac9c686b380f` | P-26–27 |
| `.ai/xezar/docs/close-out.md` | `cf9285e33b1872c2999e49e647e01f958a79369a` | P-05, P-18–19, P-28–30 |
| `.ai/xezar/docs/enhancement-ideas.md` | `11b7a021048b133ee35e61cb71cc6134621e695c` | P-04, P-24, P-28–30; disposition ledger below |
| `.ai/xezar/docs/lessons-learned.md` | `1fdd1f4989d3a4c888f4051a9b77be5f59246be9` | P-02–05, P-08–10, P-28–30 |
| `.ai/xezar/docs/parallel-tasks.md` | `1133f7a2630b8fd3e0cf3e6d94e0d1b15da983b1` | P-03–04 |
| `.ai/xezar/docs/recovery.md` | `e0653da9b4cc03457d3d5a35a9658711ee860469` | P-05, P-07–09, P-20 |
| `.ai/xezar/docs/single-task-pilot.md` | `21cc5f4adaf5bb0c517ae7e745259c2c8fd8a29c` | P-29 |
| `.ai/xezar/docs/ui-operations.md` | `5db3db575c043b766528c5a444d44249a439d6f5` | P-03–06, P-27 |
| `.ai/xezar/docs/upgrade-checklist.md` | `23b18f211b21400ce9a0d0d8f62ae50fc6672fe9` | P-24–25, P-30 |
| `.ai/xezar/docs/worktrees.md` | `ea036308545a027c478f3c09f18499ebb1a9d5fe` | P-08–10 |
| `.ai/xezar/skills/daxko-bug-investigation.md` | `b3a9b8eb64a46f33108de7cf5a7b8d472f43d838` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-business-analysis.md` | `c2aa93e24adf69457b62f416d7288abddf7b251f` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-code-review.md` | `31227f3a53074314315098686add5187811009bc` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-dependency-maintenance.md` | `e2e7681b670459d841a0df2e34945ad4c58d3038` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-docs-maintenance.md` | `b7cc3b451ae368d623013c70a07aab7606b418ae` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-handoff-draft-pr.md` | `bcf9097dd0d2627a146b7226430ad101cdcbf3ae` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-implementation.md` | `ce1bbc7bf7995db686ae76a4f2a01ffba57dcc7e` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-integration.md` | `c3a35035b3a9211fd4d0c51139e2708c68780fab` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-issue-triage.md` | `6cf01f73c373cd92e7c4edc0cb1267df292e5daf` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-planning-spec.md` | `8b4c49c68f52c7785a55c70d055c4b180add09a5` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-quality-gates.md` | `b8acc18ed741e99dabdb7c15cd910a4ce49ca0b4` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-release-prep.md` | `037cf1cfceb5748cbd2117a893276b66b2e9f7e6` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-review-response.md` | `676729f4a0b8ef7ad0d4486ad11743285a0b3a47` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/skills/daxko-testing.md` | `6d6ea7cf89a91a8d15a4d743497c638546bf9d17` | P-01–02, P-06, P-09–10, P-16–19, P-26–27; K-01–14 |
| `.ai/xezar/workflows/address-review-findings.yaml` | `ad96e75a0009ea68febafaa6d14dfbefddb59717` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/bug-fix.yaml` | `56da48f54746ff28d69e42232a6ea77eb06a39bf` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/business-analysis.yaml` | `748787c751e3052301d393ee56bdf8ff434474c6` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/code-review.yaml` | `f7e99d9abc976c58a941584487629a6521762b6b` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/dependency-maintenance.yaml` | `9fe0fd823aee2dfbe7effd03fdb9cc75892d74e1` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/docs-maintenance.yaml` | `ddec623d8d5a79ea48a297c5abb3da6d31a8351a` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/feature-implementation.yaml` | `cb29cd648e9405f57aaf2cfa2514e84b224e2726` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/integration.yaml` | `e5bd6b50ca9903ff3c9cc073b7e9c658204f2d87` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/issue-triage.yaml` | `2a00d2684437ab53069c69d89f21c542419dcd59` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/plan-and-spec.yaml` | `e51a0eb77fe77459a073b64914fa656ad56d0ec7` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/release-prep.yaml` | `cef5d5dba61a01e1abd4c488565706acf17efbae` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/root-sync.yaml` | `1142e1df315ea03aa46e1921745a266866fa6bab` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |
| `.ai/xezar/workflows/testing-and-verification.yaml` | `30c72595d6953ba4aa76bcdb8ef72a10dbad018f` | P-06, P-24–25; W-01–13 (name equivalence in leader contract) |

Supporting tracked context, pinned by the same commit: root `AGENTS.md` and `CLAUDE.md` (role/authority/engineering obligations); `docs/xezar.md` (configuration, workflows and runtime qualification); `docs/architecture.md` testing guidance; `package.json`, `vitest.config.ts`, `.gitignore`, `biome.json`, `knip.json` (actual gates/scopes); `.github/workflows/ci.yml`, `integration.yml`, `release.yml`, `spec-drift.yml` and `.github/actions/ci-gates/action.yml`, `contract-test.sh` (canonical CI callers, tested-revision and failure-propagation contracts). Detailed domain architecture and API/spec content remain project-specific; adaptation discovers equivalent contracts without distributing private business data.

## Effective settings and source-key coverage

The source config contains ten top-level keys; this table maps each responsibility without publishing its private values. Current root documentation also describes composer and global effective settings. A source file key is evidence of intent, not proof that the installed runtime applies it.

| Source key / effective responsibility | Product mapping and adaptation | Verification |
| --- | --- | --- |
| `skillsRepos` | T-01: project-approved sources; no private repository/trust transplantation | L-A02, L-A46 |
| `baseBranch` | T-02: discover actual project base and enforce exact integration identity; no required authored key | L-A38, L-A41 |
| `worktreeRetention` | T-06: discover actual keep/cleanup behavior, retain durable conclusions and explain branch versus checkout lifecycle; no copied numeric value | L-A36, L-A46 |
| `defaultRunner` | T-03: choose a real available allowed executor | L-A03, L-A14, L-A46 |
| `defaultModels` / `defaultModels.claude` | T-03: map provider-specific model defaults to actual capability; no source model ID imports | L-A14, L-A46 |
| `modelsLocked` | T-03: distinguish UI selection/default from effective enforcement and per-step pins | L-A14, L-A46 |
| `plannerModel` | T-03: respect actual planner capability and project executor policy, separately from the leader list | L-A14, L-A46 |
| `namerModel` | T-03: discover supported naming setting without assuming it controls task execution | L-A46 |
| `reviewGate` | T-05: engine review status, independent assessment, existing handoff and business acceptance remain distinct | L-A23, L-A34, L-A46 |
| `systemPrompt` | T-04: adapt executor conventions while resolving the blanket merge prohibition; never let adaptation edit the protected leader role instruction | L-A20, L-A29, L-A46 |
| Worktree/autonomy composer defaults; per-step workflow runner/model values | T-03, T-07: record effective task snapshot, preserve read-only and root-sync role distinctions | L-A16, L-A21, L-A38, L-A42 |
| Global resource concurrency/memory and config/environment precedence | T-08–09: discover safe effective limits; ignored legacy per-project keys cannot masquerade as enforcement. No new global write authority or copied fixed cap | L-A33, L-A35, L-A46 |

## Historical/backlog disposition ledger

This lists every entry in the maintained enhancement **status index**, not the retired implementation described in older prose. Source status is attributed and is not a new Xezar capability claim. Deferred triggers remain those in the pinned index; no automatic watcher, issue publication or additional work is authorized. An implemented row maps through the matrix; a deferred/rejected/context row is retained as provenance, not silently promoted to mandatory implementation.

| Source index entry | Attributed source status | Xezar disposition / relevant obligation |
| --- | --- | --- |
| A first-class `setup:` / `postCreate:` hook | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| `XEZ:ASK` from a step that is not the last one | **Qualification needed** | Requalify on current Xezar before calling a defect; P-28–29. No automatic issue. |
| A project-level worktree policy | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| The per-task worktree toggle should not outlive its task | **Qualification needed** | Requalify on current Xezar before calling a defect; P-28–29. No automatic issue. |
| The dashboard should not lag a task's own header | **Qualification needed** | Requalify on current Xezar before calling a defect; P-28–29. No automatic issue. |
| Show an auto-inferred issue or PR number as inferred | **Qualification needed** | Requalify on current Xezar before calling a defect; P-28–29. No automatic issue. |
| A killed step's token spend should not be recorded as zero | **Qualification needed** | Requalify on current Xezar before calling a defect; P-28–29. No automatic issue. |
| Surface per-run step records in the cockpit | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| A switch for autosave | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Retention that preserves the ignored files it destroys | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Archive-before-reclaim | **Rejected — deliberately not built** | Do not import the rejected mechanism; preserve durable/non-rebuildable evidence under P-05. |
| A tracked permission allowlist | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Measured cost per worktree | **Validated** | P-29: preserve attributed measurements; do not infer speedup or total cost. Attributed source status is not a current Xezar test result. |
| A shared step template for the writing workflows | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| An acceptance record pins content, not a version string | **Implemented** | P-27: immutable accepted content identity and real authority. Attributed source status is not a current Xezar test result. |
| The evidence chain — four gaps, one contract | **Implemented** | P-11–13: complete canonical attempt records and seal eligibility. Attributed source status is not a current Xezar test result. |
| A CI conclusion at the pushed head, or an explicit pending | **Implemented** | P-16: actual pushed-head CI identity and explicit pending. Attributed source status is not a current Xezar test result. |
| A third-party seal verifier | **Implemented** | P-14–15: independent read-only verification and trusted path containment. Attributed source status is not a current Xezar test result. |
| Print the CWD the guard judged | **Implemented** | P-08: refusal identifies actual judged checkout and failed predicate. Attributed source status is not a current Xezar test result. |
| Allow the commit when `MERGE_HEAD` is the only marker | **Implemented** | P-20: narrow matching-intent recovery; ordinary writes still refuse. Attributed source status is not a current Xezar test result. |
| A mid-merge regression case driving `worktree-git.sh` | **Implemented** | P-20, P-22: execute both unresolved/resolved refusal cases with no effects. Attributed source status is not a current Xezar test result. |
| Fixture scratch out of the worktree's own `.local/` | **Implemented** | P-21: lifecycle-safe scratch with containment; do not hardcode source location. Attributed source status is not a current Xezar test result. |
| Create the evidence directory for read-only runs | **Implemented** | P-10: read-only initialization without installation. Attributed source status is not a current Xezar test result. |
| **F1** — the authority guard grepped case-sensitively | **Implemented** | P-22, P-27: case variation cannot bypass authority; real service authority required. Attributed source status is not a current Xezar test result. |
| **F2** — the content-revision guard omitted the implementation skill | **Implemented** | P-22, P-27: content acceptance applied at every authoring/dependent execution surface. Attributed source status is not a current Xezar test result. |
| Template rule — failure paths | **Implemented** | P-26: error, empty, partial, unauthorized, unavailable and already-done paths. Attributed source status is not a current Xezar test result. |
| Template rule — no self-totals, and the list wins | **Implemented** | P-26: enumerate actual obligations; a self-total is not proof of completeness. Attributed source status is not a current Xezar test result. |
| Template rule — cite `file:line` **plus** the quoted fragment | **Implemented** | P-26: safe file:line plus relevant fragment, beyond a citation-only checkbox. Attributed source status is not a current Xezar test result. |
| Template rule — every criterion names its falsifier | **Implemented** | P-26: concrete falsifier per criterion. Attributed source status is not a current Xezar test result. |
| Template rule — `rN` plus the file's SHA-256 | **Implemented** | P-27: compute final content digest externally; no in-file self-hash. |
| Two private-evidence conventions, both legitimate | **Context only — no action** | Context only; preserve explicit evidence/context limits under P-04, P-28. |
| The sentence the docs-maintenance skill was missing | **Implemented** | P-06: focused development checks; PR belongs to handoff stage. Attributed source status is not a current Xezar test result. |
| An executing assertion for the CLI stderr contract | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| The reference-style link guard does not strip fenced blocks | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Confirm the pilot assumptions with numbers | **Partially validated** | P-29: preserve partial-evidence qualifications; ordering is not proof of mechanism. Attributed source status is not a current Xezar test result. |
| Read-only runs get a worktree with no dependencies | **Implemented — decision recorded** | P-10: isolated read-only run without dependencies; unexecutable test is not passed. Attributed source status is not a current Xezar test result. |
| Measure concurrent gate runs before claiming speedup | **Deferred — and it gates the claim** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Ask upstream to relabel the destructive worktree actions | **Deferred to a private product draft** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| A final handoff reads the task's own current state | **Partially implemented** | P-05/P-07: require actual checkpoint and late-steering reconciliation, closing the partial source gap. |
| Two concurrent tasks, not more | **Implemented** | P-03: preserve measured resource limits, exclude literal cap of two. |
| Write shared fan-out background once | **Implemented** | P-04: common stable background once, focused specialist deltas. Attributed source status is not a current Xezar test result. |
| Forecast a fan-out instead of discovering its cost | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Stop a review on remaining risk, not a round count | **Implemented** | P-02: remaining risk and stated boundary, no minimum/quota. Attributed source status is not a current Xezar test result. |
| Hand a long-lived coordinator off through its checkpoint | **Implemented as procedure; pilot PENDING** | P-05/P-29: preserve procedure; checkpoint-only fresh-session pilot remains required and unproven. |
| Do not declare a track COMPLETE while its follow-ups live only in an ignored file | **Implemented** | P-05, P-28: actionable follow-ups durable and per-item close-out truthful. Attributed source status is not a current Xezar test result. |
| Fan out at design stage, not over a small diff | **Deferred** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| Two sentences of doctrine that already work in practice | **Implemented** | P-01–02: leader owns plan, authors answer reviews, leader adjudicates evidence. Attributed source status is not a current Xezar test result. |
| Poll slower, and act on `waiting` | **Implemented** | P-03: preserve status-only intervention; use approved pushed events, no model polling. |
| The live-API path is unreachable, not pending | **Deferred — a product decision** | Retain the source trigger; not a new mandatory mechanism. P-28–30; approved quality/authority requirements remain. |
| A candidate CLI follow-up | **Deferred — unverified** | Requalify on current Xezar before calling a defect; P-28–29. No automatic issue. |
| The root conversation is not readable from a worktree agent | **Context only — no action** | Context only; preserve explicit evidence/context limits under P-04, P-28. |

## Completeness and next gate

The current source baseline is no longer deferred: all 56 tracked kit files are classified, all 13 workflow and 14 skill roles retained, T-01–09 settings responsibilities mapped, and the 30 distinct practice records cover the operating documents as well as executable roles/guards. Historical candidates and source limitations have explicit dispositions. This is **requirements coverage of the pinned baseline**, not implemented transfer completeness.

Before whole-feature acceptance, implement and execute the mapped cases on the same candidate, preserve actual baseline/build and kit identities, resolve the leader contract's engineering decisions, and qualify all three clients. A later source change requires an explicit baseline delta and refreshed mappings, not silent substitution of whatever happens to be in the reference checkout. No automatic source monitor is created.
