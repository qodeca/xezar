#!/usr/bin/env bash
# Behaviour tests for this repository's Xezar worktree machinery.
#
# These test what the checks DO, not that they exist. Every case builds a throwaway git
# repository under the PRIMARY checkout's git-ignored `.local/xezar-tests/` (removed on
# exit) and drives the real scripts against it, so a regression in the isolation rules
# fails here rather than in production on someone's working tree.
#
# Run directly for kit changes and in the unconditional CI job
# `Xezar infrastructure fixtures`. The ordinary local gate runs repository-checks.sh;
# this suite remains mandatory locally when checks/workflows change. No path-filter,
# fingerprint cache or skip makes synthetic fixtures optional in CI.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

# Fixture scratch goes to the PRIMARY checkout, never the task worktree's own `.local/`:
# retention, the startup orphan sweep and the cockpit's Delete action destroy a worktree
# directory without warning, and a SIGKILL'd run would leave the orphan somewhere that is
# about to disappear. `--git-common-dir`'s parent IS the primary checkout in a linked
# worktree and the checkout itself otherwise, so this is one rule for both cases.
MAIN_ROOT="$(cd "$(dirname "$(cd "$REPO_ROOT" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s/.git' "$REPO_ROOT")")" && pwd -P)"

# The placement rule and the path validation now live in lib/common.sh, so the suite exercises
# the same helper the checks do rather than a second copy of the same string concatenation.
# `fixture_scratch_dir` also drops an OWNER file naming this run and pid, which is what makes a
# leftover directory identifiable as an interrupted run rather than a mystery nobody dares remove.
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
export MAIN_ROOT

WORK="$(fixture_scratch_dir "infra-$$" "infra-tests.sh")" || exit 1

# Fixtures create real worktrees. Remove them through git, not rm -rf alone, so the parent
# fixture's administrative directory never outlives the test.
#
# CLEANUP IS BEST EFFORT. This trap runs on a normal exit, on INT and on TERM. It does NOT run on
# SIGKILL, on a power loss, or when the process is killed by the OOM killer — no trap does — so
# this suite makes no promise that its scratch is always gone. What it promises instead is that a
# leftover is IDENTIFIABLE: it is under the primary checkout's .local/xezar-tests/, it is named
# after the pid that made it, and it carries an OWNER file saying so.
cleanup() {
  local fixture
  for fixture in "$WORK"/*; do
    [ -d "$fixture/.git" ] || continue
    git -C "$fixture" worktree list --porcelain 2>/dev/null |
      awk '/^worktree /{print $2}' |
      while IFS= read -r wt; do
        [ "$wt" = "$fixture" ] && continue
        git -C "$fixture" worktree remove --force "$wt" >/dev/null 2>&1
      done
  done
  fixture_scratch_remove "$WORK"
}
trap cleanup EXIT INT TERM

pass=0
fail=0
failures=()

ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); failures+=("$1"); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# Assert a command exits zero / non-zero. Output is captured and only shown on failure, so
# a green run stays readable.
expect_ok() {
  local label="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then ok "$label"; else bad "$label" "expected exit 0, got $?"; printf '%s\n' "$out" | tail -20; fi
}
expect_fail() {
  local label="$1" needle="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then
    bad "$label" "expected a non-zero exit, got 0"
    printf '%s\n' "$out" | tail -20
  elif [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then
    bad "$label" "failed as expected but the message did not mention: $needle"
    printf '%s\n' "$out" | tail -20
  else
    ok "$label"
  fi
}

# --- Fixture builder -------------------------------------------------------------------
# A minimal but honest copy of this repo's Xezar surface: the real check scripts, the same
# ignore rules, a config with the same baseBranch.
make_fixture() {
  local name="$1"
  local root="$WORK/$name"
  mkdir -p "$root/.xezar" "$root/.ai/cezar"
  cp -R "$SCRIPT_DIR" "$root/.xezar/checks"
  printf '{\n  "baseBranch": "main",\n  "worktreeRetention": 0\n}\n' > "$root/.xezar/config.json"
  printf '# fixture contract\n' > "$root/AGENTS.md"
  # `.npmrc` is ignored here because it can carry a registry token. It is also the one input
  # `deps_fingerprint` reads that is NOT a tracked file, which is what lets a fixture change the
  # dependency inputs without moving the tree fingerprint — see the resumed-completion section.
  printf 'node_modules/\ndist/\ncoverage/\n.local/\n.npmrc\n' > "$root/.gitignore"
  printf 'runs.json\nruns/\nworktrees/\ntmp/\ntodos.json\nui-state.json\nlaunch-key\n' > "$root/.xezar/.gitignore"
  # The retained legacy Cezar ignore. It is the only tracked file left under `.ai/cezar/`
  # after the migration, and the preflight probes it, so a fixture without it is a real
  # failure rather than an artefact — see the `legacy-ignore` case in §14.
  printf 'runs.json\nruns/\nworktrees/\ntmp/\ntodos.json\nui-state.json\nlaunch-key\n' > "$root/.ai/cezar/.gitignore"
  printf 'export const seed = 1;\n' > "$root/seed.ts"
  # A fixture that is not its OWN repository must never be handed on: every later `git -C "$root"`
  # would walk up the directory tree and act on whatever repository contains it — which, since the
  # scratch lives under the primary checkout, is this project.
  if ! git init -q -b main "$root"; then
    printf 'make_fixture: git init failed for %s — refusing to return a non-repository root\n' "$root" >&2
    return 1
  fi
  root="$(assert_isolated_fixture_root "$root" "new fixture")" || return 1
  git -C "$root" -c user.email=t@t -c user.name=t add -A
  git -C "$root" -c user.email=t@t -c user.name=t commit -q -m "init"
  printf '%s' "$root"
}

# Add a Xezar-shaped worktree: directory named after the run id, branch xez/<first 8>.
#
# TWO GUARDS, AND THEY ARE NOT DECORATION. Together they caused a real leak in this suite:
#
#   1. `git -C ""` LEAVES THE WORKING DIRECTORY UNCHANGED — it is not an error. So a fixture path
#      that arrived empty silently redirected the command at whatever checkout the suite happened
#      to be running in, which is the task's own worktree.
#   2. The worktree path used to be RELATIVE (".local/xezar/worktrees/<id>"), and git resolves a
#      relative worktree path against the process's working directory. Combined with (1), a fixture
#      worktree was created inside the TASK's worktree and registered against the PRIMARY
#      repository, on a real `xez/<id8>` branch — a stray checkout of the actual repo that knip
#      then scanned, failing a gate for a reason that had nothing to do with the code.
#
# The path is now absolute, so it cannot be re-based by a stray working directory, and an empty or
# non-repository root fails loudly instead of being aimed somewhere else. `leak_check` at the end
# of the suite is the backstop that proves neither can silently return.
# The branch name is ALWAYS derived from the run id. There used to be an optional third argument
# overriding it, which no caller used — and which could have created a fixture-owned ref outside the
# two names `fixture_ref_snapshot` watches, leaving the §25 backstop silently blind to it. A
# creation path the detector cannot see is worse than no parameter, and nothing needed it.
add_worktree() {
  local root runid="$2" suffix
  # Prove the target FIRST, and then use the proved canonical path — not the argument.
  root="$(assert_isolated_fixture_root "$1" "worktree parent")" || return 1
  if [ "$#" -gt 2 ]; then
    printf 'add_worktree: takes exactly two arguments; the branch name is derived from the run id so
' >&2
    printf 'that every ref it can create is one the leak detector watches.
' >&2
    return 1
  fi
  suffix="$(printf '%s' "$runid" | cut -c1-8)"
  # Absolute, so a stray working directory cannot re-base it.
  git -C "$root" worktree add -q -b "xez/$suffix" "$root/.local/xezar/worktrees/$runid" main || return 1
  printf '%s/.local/xezar/worktrees/%s' "$root" "$runid"
}

# A task worktree that already carries the task's work: one real commit over main. Readiness and
# both evidence modes refuse a branch with no commits over its base (#312, §7b), so every fixture
# that seals or verifies gate evidence starts here — sealing an empty branch is the bug, not a
# setup shortcut. Fixtures that test plain preflight keep `add_worktree`, which stays empty.
add_worktree_with_work() {
  local wt
  wt="$(add_worktree "$@")" || return 1
  printf 'export const work = 1;\n' > "$wt/work.ts"
  git -C "$wt" -c user.email=t@t -c user.name=t add work.ts || return 1
  git -C "$wt" -c user.email=t@t -c user.name=t commit -q -m "the task's work" || return 1
  printf '%s' "$wt"
}

RUN_A="aaaaaaaa-0000-4000-8000-000000000001"
RUN_B="bbbbbbbb-0000-4000-8000-000000000002"
FIXTURE_ID8_A="$(printf '%s' "$RUN_A" | cut -c1-8)"
FIXTURE_ID8_B="$(printf '%s' "$RUN_B" | cut -c1-8)"

# --- Fixture isolation: the guard every fixture git mutation goes through first ---------------
#
# THE INCIDENT THIS EXISTS FOR. One `add_worktree` call received an EMPTY fixture root.
# `git -C ""` does not fail — it leaves the working directory unchanged — and the worktree path was
# RELATIVE, so git resolved it against the task's own checkout. Git created a real worktree OF THE
# PRIMARY REPOSITORY inside the task tree, on a real `xez/<id8>` branch. knip then scanned that
# nested checkout and failed a gate over code that had nothing to do with the change.
#
# Prevention is the primary protection, and it belongs BEFORE the mutation, not after it. Nothing
# in this suite may run a git command that writes until the target has been proved to be:
#   1. non-empty                    — `git -C ""` and `cd ""` both silently stay put;
#   2. absolute                     — a relative path is resolved against whatever the CWD is;
#   3. canonical and inside $WORK   — symlinks resolved, so no path can point out of the scratch;
#   4. a repository                 — otherwise every `git -C` walks UP and finds the real one;
#   5. NOT the real repository      — checked by comparing git common directories, which is the
#                                     one test that catches every variant of the mistake above.
#
# On success it prints the canonical root, so callers use the proved path rather than the argument.
WORK_CANON="$(cd "$WORK" && pwd -P)"

assert_isolated_fixture_root() {
  local root="$1" canon common
  local what="${2:-fixture root}"
  if [ -z "$root" ]; then
    printf 'fixture guard: refusing an EMPTY %s — `git -C ""` would target the current checkout\n' "$what" >&2
    return 1
  fi
  case "$root" in
    /*) ;;
    *)
      printf 'fixture guard: refusing a RELATIVE %s ("%s") — it resolves against whatever the CWD is\n' "$what" "$root" >&2
      return 1
      ;;
  esac
  if ! canon="$(cd "$root" 2>/dev/null && pwd -P)"; then
    printf 'fixture guard: %s "%s" is not a directory this suite can enter\n' "$what" "$root" >&2
    return 1
  fi
  case "$canon" in
    "$WORK_CANON"/*) ;;
    *)
      printf 'fixture guard: %s "%s" is outside this run'"'"'s scratch (%s)\n' "$what" "$canon" "$WORK_CANON" >&2
      return 1
      ;;
  esac
  if [ ! -e "$canon/.git" ]; then
    printf 'fixture guard: %s "%s" is not a repository — every `git -C` there walks up to the real one\n' "$what" "$canon" >&2
    return 1
  fi
  # The decisive check. Whatever the path looked like, the repository it actually resolves to must
  # not be this project's.
  common="$(git -C "$canon" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [ -z "$common" ]; then
    printf 'fixture guard: could not resolve a git common dir for %s "%s"\n' "$what" "$canon" >&2
    return 1
  fi
  if [ "$common" = "$MAIN_ROOT/.git" ] || [ "$common" = "$REPO_ROOT/.git" ]; then
    printf 'fixture guard: %s "%s" resolves to the REAL repository (%s) — refusing to mutate it\n' "$what" "$canon" "$common" >&2
    return 1
  fi
  printf '%s' "$canon"
}

# --- Fixture-footprint snapshots ---------------------------------------------------------------
#
# The isolation contract is NOT "the real repository contains no fixture-shaped ref". A fixture
# branch from an earlier incident is deliberately PRESERVED, and a check that demanded its absence
# would be demanding that history be erased.
#
# The contract is: THIS RUN OF THIS SUITE changes nothing. So the footprint is measured before and
# after and compared. A pre-existing entry is disclosed and carried; a new, moved or deleted one is
# the failure. Everything is scoped to the fixture-owned namespace, so another agent legitimately
# advancing its own branch is invisible here and cannot fail this suite — and no global lock is
# needed to get that.
# The watched namespace is exactly the branch names `add_worktree` can produce: it derives them from
# the run id and takes no override, so this list cannot fall behind the creation path.
fixture_ref_snapshot() {
  git -C "$1" for-each-ref --format='%(refname) %(objectname)' \
    "refs/heads/xez/$FIXTURE_ID8_A" "refs/heads/xez/$FIXTURE_ID8_B" 2>/dev/null | LC_ALL=C sort
}

fixture_registration_snapshot() {
  local repo="$1" id
  for id in "$RUN_A" "$RUN_B"; do
    [ -e "$repo/.git/worktrees/$id" ] && printf 'registration %s\n' "$id"
  done
  return 0
}

# Worktree directories nested inside the checkout the suite is running in. A task worktree has none.
nested_worktree_snapshot() {
  ls "$1/.local/xezar/worktrees" 2>/dev/null | LC_ALL=C sort
}

# One line per difference, "<" for what was lost and ">" for what appeared. Empty means unchanged.
snapshot_delta() {
  diff <(printf '%s\n' "$1") <(printf '%s\n' "$2") 2>/dev/null | grep -E '^[<>]'
  return 0
}

# The baseline, taken before any fixture has run.
BASELINE_FIXTURE_REFS="$(fixture_ref_snapshot "$MAIN_ROOT")"
BASELINE_FIXTURE_REGS="$(fixture_registration_snapshot "$MAIN_ROOT")"
BASELINE_NESTED="$(nested_worktree_snapshot "$REPO_ROOT")"

printf '=== xezar infra tests ===\n'

# --- 1. Catalog: the real repository ------------------------------------------------------
printf '\n-- catalog --\n'
expect_ok "the repo's own workflow/skill/config catalog is valid" \
  node "$SCRIPT_DIR/catalog-check.mjs" "$REPO_ROOT"

# Each of these breaks the catalog in one specific way that Xezar itself would NOT report,
# because its step schema strips unknown keys instead of rejecting them.
catalog_fixture() {
  local name="$1"
  local root="$WORK/cat-$name"
  mkdir -p "$root/.xezar/workflows" "$root/.xezar/skills" "$root/.xezar/checks"
  cp "$SCRIPT_DIR/repo-gates.sh" "$root/.xezar/checks/repo-gates.sh"
  printf '{\n  "baseBranch": "main",\n  "worktreeRetention": 0\n}\n' > "$root/.xezar/config.json"
  printf -- '---\nname: s\ndescription: d\n---\nbody\n' > "$root/.xezar/skills/s.md"
  printf '%s' "$root"
}

root="$(catalog_fixture unknown-key)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: a
    prompt: "{{task}}"
    model: claude-opus-5
    when: always
EOF
expect_fail "an invented step key is rejected (Xezar would silently strip it)" \
  'unknown step key "when"' node "$SCRIPT_DIR/catalog-check.mjs" "$root"
# `mode:` is the same class and needs no fixture of its own: the repo's own catalog is checked
# above, so a `mode:` key added to any real workflow fails there. There is no way to select a
# skill "mode" from YAML — the only per-run channel is `{{task}}` substituted into `prompt:`.

# --- The shared phase contract, and its negative controls -------------------------------------
# Added 2026-09-09 (#116). Each case below is a workflow that Xezar loads happily and that would
# then behave wrongly at run time, so the checker is the only thing standing between the mistake
# and a production run.

# A writing workflow that dropped `readiness`. This is the expensive one: without it a BLOCKED
# task sails into the gates, pays for a full run, and can reach a handoff it should never reach.
root="$(catalog_fixture no-readiness)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: preflight
    command: ".xezar/checks/repo-gates.sh"
  - id: setup
    command: ".xezar/checks/repo-gates.sh"
  - id: work
    prompt: "{{task}}"
    model: claude-opus-5
  - id: gates
    command: ".xezar/checks/repo-gates.sh"
  - id: evidence
    command: ".xezar/checks/repo-gates.sh"
  - id: handoff
    prompt: "hand off"
    model: claude-opus-5
EOF
expect_fail "a writing workflow with no readiness step is rejected" \
  'has no "readiness" step' node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# Phases present but out of order: gates before readiness defeats the same stop.
root="$(catalog_fixture phase-order)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: preflight
    command: ".xezar/checks/repo-gates.sh"
  - id: setup
    command: ".xezar/checks/repo-gates.sh"
  - id: work
    prompt: "{{task}}"
    model: claude-opus-5
  - id: gates
    command: ".xezar/checks/repo-gates.sh"
  - id: readiness
    command: ".xezar/checks/repo-gates.sh"
  - id: evidence
    command: ".xezar/checks/repo-gates.sh"
  - id: handoff
    prompt: "hand off"
    model: claude-opus-5
EOF
expect_fail "a writing workflow whose phases are out of order is rejected" \
  'runs before' node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# A workflow that installs dependencies it will never use. `worktree-setup.sh` runs a full
# `npm install`; a read-only or coordination run paying that cost is the waste §5.4 names.
root="$(catalog_fixture setup-without-gates)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: preflight
    command: ".xezar/checks/repo-gates.sh"
  - id: setup
    command: ".xezar/checks/repo-gates.sh"
  - id: work
    prompt: "{{task}}"
    model: claude-opus-5
EOF
expect_fail "a workflow that installs dependencies but never builds or tests is rejected" \
  'must not run a full dependency install' node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# THE POSITIVE CONTROL for the phase rules. A correct writing workflow must still pass, or the
# three refusals above would be indistinguishable from a checker that rejects everything.
root="$(catalog_fixture phases-ok)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: preflight
    command: ".xezar/checks/repo-gates.sh"
  - id: setup
    command: ".xezar/checks/repo-gates.sh"
  - id: work
    prompt: "{{task}}"
    model: claude-opus-5
  - id: readiness
    command: ".xezar/checks/repo-gates.sh"
  - id: gates
    command: ".xezar/checks/repo-gates.sh"
  - id: evidence
    command: ".xezar/checks/repo-gates.sh"
  - id: handoff
    prompt: "hand off"
    model: claude-opus-5
EOF
expect_ok "a correctly ordered writing workflow still passes" \
  node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# And a gate-free coordination workflow with no setup is legitimate — `integration` and
# `root-sync` are exactly that shape, so a rule that rejected them would be wrong.
root="$(catalog_fixture gateless-ok)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: preflight
    command: ".xezar/checks/repo-gates.sh"
  - id: act
    prompt: "{{task}}"
    model: claude-opus-5
EOF
expect_ok "a gate-free workflow with no dependency install is accepted" \
  node "$SCRIPT_DIR/catalog-check.mjs" "$root"

root="$(catalog_fixture trailing-check)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: a
    prompt: "{{task}}"
    model: claude-opus-5
  - id: b
    command: ".xezar/checks/repo-gates.sh"
EOF
expect_fail "a workflow ending in a check step is rejected (it would silence XEZ:ASK)" \
  "NOT interactive" node "$SCRIPT_DIR/catalog-check.mjs" "$root"

root="$(catalog_fixture forward-retry)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: a
    command: ".xezar/checks/repo-gates.sh"
    onFail:
      retry: b
      max: 2
  - id: b
    prompt: "{{task}}"
    model: claude-opus-5
EOF
expect_fail "onFail.retry pointing at a later step is rejected" \
  "EARLIER step" node "$SCRIPT_DIR/catalog-check.mjs" "$root"

root="$(catalog_fixture missing-skill)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: a
    prompt: "{{task}}"
    skill: does-not-exist
    model: claude-opus-5
EOF
expect_fail "a workflow naming a skill with no file is rejected" \
  "does-not-exist" node "$SCRIPT_DIR/catalog-check.mjs" "$root"

root="$(catalog_fixture unpinned-model)"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: a
    prompt: "{{task}}"
    skill: s
EOF
expect_ok "an agent step inherits the selected backend model" node "$SCRIPT_DIR/catalog-check.mjs" "$root"

root="$(catalog_fixture repo-maxparallel)"
mkdir -p "$root/.xezar/workflows"
cat > "$root/.xezar/workflows/w.yaml" <<'EOF'
name: w
steps:
  - id: a
    prompt: "{{task}}"
    skill: s
    model: claude-opus-5
EOF
printf '{\n  "baseBranch": "main",\n  "worktreeRetention": 0,\n  "maxParallel": 1\n}\n' \
  > "$root/.xezar/config.json"
expect_fail "a repo-level maxParallel is rejected because the scheduler ignores it" \
  "The scheduler ignores it" node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# Refused for a DIFFERENT reason, and the reason is what this case pins. The engine honours a
# per-repo memoryLimitMb (B2: run.ts -> WorkspaceSemaphore.projectMemoryLimitMb), so the old
# "which the scheduler ignores" wording was false and this assertion was keeping it alive. The
# refusal is kit policy: a memory ceiling belongs to a machine, not to a file every checkout gets.
printf '{\n  "baseBranch": "main",\n  "worktreeRetention": 0,\n  "memoryLimitMb": 16384\n}\n' \
  > "$root/.xezar/config.json"
expect_fail "a repo-level memoryLimitMb is rejected on kit policy, not as ignored" \
  "The engine DOES honour a per-repo value" node "$SCRIPT_DIR/catalog-check.mjs" "$root"
expect_fail "and its refusal never claims the scheduler ignores it" \
  "must not set" node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# --- 1b. Changelog structure ---------------------------------------------------------------------
# Added 2026-09-09 (#31). Two fix PRs each added their own `# Unreleased` section in different
# places and the release had to consolidate them by hand. The `changelog` step of the `release`
# workflow runs this check before it commits; each case here is one shape the check must refuse
# or accept, on synthetic files, so the real CHANGELOG.md is never the fixture.
printf '\n-- changelog structure --\n'
CLC="$SCRIPT_DIR/changelog-check.sh"
cl="$WORK/changelog"
mkdir -p "$cl"

printf '# Unreleased\n\n## 🐛 Fixes\n- 🐛 **a.** (#1)\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- b\n' > "$cl/one.md"
expect_ok "one Unreleased section above the newest dated release is accepted" "$CLC" --file "$cl/one.md"

printf '# 0.1.0 (2026-01-01)\n\n- b\n\n---\n\n# 0.0.9 (2025-12-01)\n\n- c\n' > "$cl/none.md"
expect_ok "a changelog with no Unreleased section is accepted" "$CLC" --file "$cl/none.md"

printf '# Unreleased\n\n- a\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- b\n\n# Unreleased\n\n- c\n' > "$cl/two.md"
expect_fail "two Unreleased headings are refused (the #23/#26 shape)" \
  "has 2 '# Unreleased' headings" "$CLC" --file "$cl/two.md"

printf '# 0.1.0 (2026-01-01)\n\n- b\n\n---\n\n# Unreleased\n\n- c\n' > "$cl/below.md"
expect_fail "an Unreleased heading below a dated release is refused" \
  "below a dated release heading" "$CLC" --file "$cl/below.md"

printf '# Unreleased\n\n- a\n\n```\n# Unreleased\n```\n\n# 0.1.0 (2026-01-01)\n' > "$cl/fence.md"
expect_ok "a heading inside a fenced code block is not counted" "$CLC" --file "$cl/fence.md"

printf '## Unreleased\n\n- not top level\n\n# 0.1.0 (2026-01-01)\n' > "$cl/h2.md"
expect_ok "a second-level Unreleased heading is not a section and is ignored" "$CLC" --file "$cl/h2.md"

# --require-version: the shape the release step must leave behind.
printf '# 0.2.0 (2026-02-01)\n\n- new\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- b\n' > "$cl/released.md"
expect_ok "--require-version passes with exactly one target heading and no Unreleased" \
  "$CLC" --file "$cl/released.md" --require-version 0.2.0
expect_fail "--require-version refuses when the target heading is absent" \
  "has 0 '# 0.3.0 (' headings" "$CLC" --file "$cl/released.md" --require-version 0.3.0
printf '# 0.2.0 (2026-02-01)\n\n- new\n\n---\n\n# 0.2.0 (2026-02-01)\n\n- dup\n' > "$cl/twice.md"
expect_fail "--require-version refuses a target recorded twice" \
  "has 2 '# 0.2.0 (' headings" "$CLC" --file "$cl/twice.md" --require-version 0.2.0
expect_fail "--require-version refuses a leftover Unreleased section" \
  "still has an '# Unreleased' heading" "$CLC" --file "$cl/one.md" --require-version 0.1.0
expect_fail "--require-version rejects a non-semver argument as usage, not as a pass" \
  "wants a semver" "$CLC" --file "$cl/released.md" --require-version v0.2.0
expect_fail "a missing changelog file is a failure, never a pass" \
  "does not exist" "$CLC" --file "$cl/absent.md"

# The real repository's changelog must satisfy the structural rule today; a regression here is
# the exact consolidation problem the check exists for.
expect_ok "the repo's own CHANGELOG.md has at most one Unreleased section, above every dated release" \
  "$CLC" --file "$REPO_ROOT/CHANGELOG.md"

# --- 2. Preflight: isolation --------------------------------------------------------------
printf '\n-- preflight: isolation --\n'
root="$(make_fixture iso)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"

# The environment carries no XEZ_TASK_ID here, exactly as a workflow `command:` step sees it
# (check steps are spawned with the cockpit server's process.env, never the agent env).
# `cd ""` succeeds and stays put, exactly like `git -C ""`, so an empty fixture path would run the
# case against the real checkout and report whatever that checkout happens to say.
run_in() {
  local dir="$1"; shift
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    printf 'run_in: refusing to run in "%s" — an empty or missing directory means the real checkout\n' "${dir:-<empty>}" >&2
    return 1
  fi
  ( cd "$dir" && env -u XEZ_TASK_ID -u DOGFOOD_ALLOW_ROOT_BOOTSTRAP "$@" )
}

expect_ok "a genuine Xezar worktree passes, with no XEZ_TASK_ID in the environment" \
  run_in "$wt" "$PF"

expect_fail "the primary checkout is refused for a writing task" \
  "PRIMARY checkout" run_in "$root" "$PF"

expect_ok "the primary checkout is accepted for a read-only task" \
  run_in "$root" "$PF" --allow-root

# A worktree that is a real, registered git worktree but lives outside Xezar's directory.
git -C "$root" worktree add -q -b xez/deadbeef "$WORK/stray" main
expect_fail "a registered worktree outside .local/xezar/worktrees is refused" \
  "Xezar did not create it" run_in "$WORK/stray" "$PF"

# --- 3. Preflight: branch binding -----------------------------------------------------------
printf '\n-- preflight: branch binding --\n'
root="$(make_fixture branch)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"

# Syntactically a perfect xez branch — but it belongs to a different run. Shape alone is not
# identity: two runs on one branch is the exact collision worktrees exist to prevent.
git -C "$wt" switch -q -c xez/12345678
expect_fail "a well-formed xez/ branch from another run is refused" \
  "whose branch is" run_in "$wt" "$PF"

git -C "$wt" switch -q "xez/${RUN_A:0:8}"
expect_ok "the run's own branch is accepted" run_in "$wt" "$PF"

git -C "$wt" switch -q main 2>/dev/null || git -C "$wt" switch -q -C main-copy
if [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "main" ]; then
  expect_fail "main checked out in a task worktree is refused" \
    "integration or release branch" run_in "$wt" "$PF"
  git -C "$wt" switch -q "xez/${RUN_A:0:8}"
fi

# There is no branch-adoption escape hatch, and a manifest cannot invent one. Xezar's recovery
# path reattaches `xez/<id8>` and nothing else, so work on any other branch in this worktree is
# lost the moment retention reclaims it and a resume restores the tree.
git -C "$root" branch -q legacy/pr-42 main
git -C "$wt" switch -q legacy/pr-42
expect_fail "an existing PR branch cannot be adopted into this worktree" \
  "Xezar restores only its own branch" run_in "$wt" "$PF"
node "$SCRIPT_DIR/lib/manifest.mjs" "$root/.local/xezar-tasks/$RUN_A/manifest.json" \
  --set adoptedBranch=legacy/pr-42
expect_fail "a manifest claiming adoptedBranch does not unlock it" \
  "Xezar restores only its own branch" run_in "$wt" "$PF"

git -C "$root" branch -q feature/ordinary main
git -C "$wt" switch -q feature/ordinary
node "$SCRIPT_DIR/lib/manifest.mjs" "$root/.local/xezar-tasks/$RUN_A/manifest.json" \
  --set adoptedBranch=feature/ordinary
expect_fail "an ordinary conventional branch is refused too, manifest or not" \
  "Xezar restores only its own branch" run_in "$wt" "$PF"
git -C "$wt" switch -q "xez/${RUN_A:0:8}"

# --- 4. Preflight: identity ------------------------------------------------------------------
printf '\n-- preflight: identity --\n'
root="$(make_fixture identity)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"

expect_fail "an environment claiming a different run is refused" \
  "identity conflict" \
  env XEZ_TASK_ID="$RUN_B" bash -c "cd '$wt' && '$PF'"

expect_ok "an environment agreeing with the worktree path is accepted" \
  env XEZ_TASK_ID="$RUN_A" bash -c "cd '$wt' && '$PF'"

# The bootstrap exception must name its own run, so it cannot be exported once and forgotten.
expect_fail "a root bootstrap override naming a different run is refused" \
  "must name the run" \
  env XEZ_TASK_ID="$RUN_A" DOGFOOD_ALLOW_ROOT_BOOTSTRAP="$RUN_B" bash -c "cd '$root' && '$PF'"
git -C "$root" switch -q -c chore/bootstrap
expect_ok "a root bootstrap override naming this run is accepted on a focused branch" \
  env XEZ_TASK_ID="$RUN_A" DOGFOOD_ALLOW_ROOT_BOOTSTRAP="$RUN_A" bash -c "cd '$root' && '$PF'"
# The exception unlocks the primary checkout, never the integration branch.
git -C "$root" switch -q main
expect_fail "the bootstrap exception still refuses to work on main" \
  "integration or release branch" \
  env XEZ_TASK_ID="$RUN_A" DOGFOOD_ALLOW_ROOT_BOOTSTRAP="$RUN_A" bash -c "cd '$root' && '$PF'"

# A symlinked path must resolve to the same checkout, not look like a second one.
ln -s "$wt" "$WORK/link-to-wt"
expect_ok "reaching the worktree through a symlink resolves to the same checkout" \
  env -u XEZ_TASK_ID -u DOGFOOD_ALLOW_ROOT_BOOTSTRAP bash -c "cd '$WORK/link-to-wt' && '$PF'"

# --- 5. Preflight: tree state -----------------------------------------------------------------
printf '\n-- preflight: tree state --\n'
root="$(make_fixture state)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"

# An unresolved merge: autosave refuses to commit one, so a step must not proceed into one.
git -C "$wt" switch -q -c side "xez/${RUN_A:0:8}"
printf 'export const seed = 2;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "side"
git -C "$wt" switch -q "xez/${RUN_A:0:8}"
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "main-side"
git -C "$wt" -c user.email=t@t -c user.name=t merge side >/dev/null 2>&1
expect_fail "an unresolved merge stops the task" \
  "unresolved git operation" run_in "$wt" "$PF"
git -C "$wt" merge --abort >/dev/null 2>&1

# .local must be ignored, and must never be tracked — .gitignore cannot protect a tracked path.
root="$(make_fixture ignore)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"
printf 'node_modules/\ndist/\ncoverage/\n' > "$root/.gitignore"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "drop .local from gitignore"
git -C "$wt" merge -q --ff-only main 2>/dev/null || git -C "$wt" -c user.email=t@t -c user.name=t merge -q main
expect_fail "a checkout where .local is not ignored is refused" \
  "\".local\" is not git-ignored" run_in "$wt" "$PF"

root="$(make_fixture tracked-local)"
mkdir -p "$root/.local"
printf 'secret notes\n' > "$root/.local/notes.md"
git -C "$root" -c user.email=t@t -c user.name=t add -f .local/notes.md
git -C "$root" -c user.email=t@t -c user.name=t commit -q -m "track .local by mistake"
wt="$(add_worktree "$root" "$RUN_A")"
expect_fail "a tracked file under .local is refused" \
  "tracked files" run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh"

# A malformed project config must stop the run, not silently fall back to main. The
# worktree's own copy is the one that counts, so break that one.
root="$(make_fixture bad-config)"
wt="$(add_worktree "$root" "$RUN_A")"
printf '{ this is not json\n' > "$wt/.xezar/config.json"
expect_fail "a malformed .xezar/config.json stops the task" \
  "could not resolve" run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh"

# The task's contract is the one checked out in ITS worktree, never whatever branch the human
# happens to be sitting on in the primary checkout. `origin/main` in this repository carries no
# .xezar/ at all, so reading the primary checkout would abort every worktree task the moment
# someone switched to main — and even where the file exists, a branch switch there would
# silently move the fork point and PR base of every running task.
root="$(make_fixture primary-branch)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"
git -C "$root" switch -q -c release/no-xezar
git -C "$root" rm -rq --cached .xezar >/dev/null 2>&1
rm -rf "$root/.xezar/config.json"
git -C "$root" -c user.email=t@t -c user.name=t commit -q -m "a branch without the Xezar surface"
expect_ok "a worktree task runs while the primary checkout is on a branch with no .xezar/config.json" \
  run_in "$wt" "$PF"
base="$(cd "$wt" && . "$root/.xezar/checks/lib/common.sh" && resolve_task_paths && printf '%s' "$BASE_BRANCH")"
[ "$base" = "main" ] && ok "the base branch comes from the worktree's own config" \
  || bad "the base branch comes from the worktree's own config" "resolved '$base'"

# --- 5b. Guarded git writes -------------------------------------------------------------------
#
# The regression these lock down: the handoff ran the preflight in one shell call and the
# commit and push in later, separate ones. A read-only inspection of the primary checkout in
# between moved the shell's CWD, and the write followed the CWD, not the preflight. Pilot A
# (task 38ecfe9c) pushed from the primary checkout on `main`; it survived only because
# `main` was already in sync.
#
# Each case drives the REAL scripts against a fixture with a real bare `origin`, and asserts
# on what reached that origin — not on the message printed.
printf '\n-- guarded git writes --\n'
root="$(make_fixture gitwrite)"
wt="$(add_worktree "$root" "$RUN_A")"
WG="$root/.xezar/checks/worktree-git.sh"
[ -x "$WG" ] && ok "worktree-git.sh exists and is executable" \
  || bad "worktree-git.sh exists and is executable" "no guard script at $WG"

git init -q --bare "$WORK/gitwrite-origin.git"
git -C "$root" remote add origin "$WORK/gitwrite-origin.git"
git -C "$root" push -q -u origin main
ORIGIN="$WORK/gitwrite-origin.git"
origin_ref() { git -C "$ORIGIN" rev-parse --verify --quiet "refs/heads/$1" 2>/dev/null; }

# The human's checkout carries an unpushed local commit. This is the one thing the incident
# lacked, and the only reason it was harmless there.
printf 'export const humanWip = 1;\n' > "$root/human-wip.ts"
git -C "$root" -c user.email=t@t -c user.name=t add -A
git -C "$root" -c user.email=t@t -c user.name=t commit -q -m "the human's unpushed work"
develop_local="$(git -C "$root" rev-parse main)"
develop_at_origin="$(origin_ref main)"

# --- a stale CWD in the primary checkout: both writes must be refused, and nothing may move
printf 'export const stray = 1;\n' > "$root/stray.ts"
expect_fail "a guarded commit from a stale CWD in the primary checkout is refused" \
  "PRIMARY checkout" run_in "$root" "$WG" commit -m "docs: a commit the agent thought was on its branch"
[ "$(git -C "$root" rev-parse main)" = "$develop_local" ] \
  && ok "the refused commit left the primary checkout's main where it was" \
  || bad "the refused commit left the primary checkout's main where it was" "main moved"

expect_fail "a guarded push from a stale CWD in the primary checkout is refused" \
  "PRIMARY checkout" run_in "$root" "$WG" push
[ "$(origin_ref main)" = "$develop_at_origin" ] \
  && ok "the refused push sent nothing to origin/main" \
  || bad "the refused push sent nothing to origin/main" "origin/main moved to $(origin_ref main)"
git -C "$root" checkout -q -- . 2>/dev/null; rm -f "$root/stray.ts"

# --- the run's own worktree: both writes must work, on the run's own branch ------------------
printf 'export const fix = true;\n' > "$wt/fix.ts"
git -C "$wt" add -A
expect_ok "a guarded commit in the run's own worktree succeeds" \
  run_in "$wt" env GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \
  "$WG" commit -m "fix: the task's own work"
[ "$(git -C "$wt" log -1 --pretty=%s)" = "fix: the task's own work" ] \
  && ok "the guarded commit landed on the run's own branch" \
  || bad "the guarded commit landed on the run's own branch" "HEAD is $(git -C "$wt" log -1 --pretty=%s)"

expect_ok "a guarded push from the run's own worktree succeeds" run_in "$wt" "$WG" push
[ "$(origin_ref "xez/${RUN_A:0:8}")" = "$(git -C "$wt" rev-parse HEAD)" ] \
  && ok "the run's own branch, and only it, reached origin" \
  || bad "the run's own branch, and only it, reached origin" "origin has $(origin_ref "xez/${RUN_A:0:8}")"
[ "$(origin_ref main)" = "$develop_at_origin" ] \
  && ok "the successful push did not move origin/main" \
  || bad "the successful push did not move origin/main" "origin/main is now $(origin_ref main)"

# --- a stale CWD in ANOTHER run's worktree ---------------------------------------------------
# This is the case `preflight && git push` in one command does NOT catch on its own: the other
# tree is a perfectly valid Xezar worktree. The identity assertion is what catches it, so the
# environment must carry this run's id — as it does in an agent step.
wt_b="$(add_worktree "$root" "$RUN_B")"
b_head_before="$(git -C "$wt_b" rev-parse HEAD)"
expect_fail "a guarded push from ANOTHER run's worktree is refused on identity" \
  "identity conflict" \
  env XEZ_TASK_ID="$RUN_A" bash -c "cd '$wt_b' && '$WG' push"
[ -z "$(origin_ref "xez/${RUN_B:0:8}")" ] \
  && ok "the other run's branch was never pushed" \
  || bad "the other run's branch was never pushed" "origin has xez/${RUN_B:0:8}"
[ "$(git -C "$wt_b" rev-parse HEAD)" = "$b_head_before" ] \
  && ok "the other run's worktree was left untouched" \
  || bad "the other run's worktree was left untouched" "its HEAD moved"

# --- the guard is two verbs, not a git wrapper ------------------------------------------------
expect_fail "an unguarded git subcommand is refused (this is not a git wrapper)" \
  "not a git wrapper" run_in "$wt" "$WG" reset --hard
expect_fail "no verb at all is refused" "" run_in "$wt" "$WG"
expect_fail "push takes no arguments, so no caller-supplied refspec can redirect it" \
  "takes no arguments" run_in "$wt" "$WG" push origin main

# Handoff guidance is checked by the project contract suite.
# --- 6. Gate evidence: recording ------------------------------------------------------------
#
# These drive the REAL recorder, `lib/gate-record.sh`, with synthetic gate commands. They never
# call repo-gates.sh — the suite is itself the last gate, so calling it back would recurse —
# but the code under test is the same code repo-gates.sh calls, not a copy of it.
printf '\n-- gate evidence: recording --\n'

# usage: drive-gates.sh <checksDir> <commandListId> <requiredNamesJson> [STEP …]
#   NAME::<shell command>     run a gate
#   NAME::SKIP:<reason>       record a skip without running anything
#   !chmod-logs:<mode>        test scaffolding: change the log directory's mode mid-attempt
#   !rm-log:<file>            test scaffolding: delete a log after its gate finished
cat > "$WORK/drive-gates.sh" <<'DRIVER'
#!/usr/bin/env bash
set -uo pipefail
checks="$1"; list_id="$2"; required="$3"; shift 3
. "$checks/lib/common.sh"
resolve_task_paths || exit 1
. "$checks/lib/gate-record.sh"
gate_attempt_begin "$required" "$list_id" || exit 1
printf 'ATTEMPT_DIR=%s\n' "$GATE_ATTEMPT_DIR"
for spec in "$@"; do
  case "$spec" in
    '!chmod-logs:'*) chmod "${spec#!chmod-logs:}" "$GATE_LOG_DIR" ;;
    '!rm-log:'*)     rm -f "$GATE_LOG_DIR/${spec#!rm-log:}" ;;
    *)
      name="${spec%%::*}"
      body="${spec#*::}"
      case "$body" in
        SKIP:*) gate_note_skip "$name" "${body#SKIP:}" ;;
        *) gate_run "$name" bash -c "$body" ;;
      esac
      ;;
  esac
done
chmod u+rwx "$GATE_LOG_DIR" 2>/dev/null
gate_attempt_complete
DRIVER
chmod +x "$WORK/drive-gates.sh"

drive() { local wt="$1"; shift; ( cd "$wt" && env -u XEZ_TASK_ID -u DOGFOOD_ALLOW_ROOT_BOOTSTRAP "$WORK/drive-gates.sh" "$@" ); }
attempt_dir_of() { printf '%s' "$1" | sed -n 's/^ATTEMPT_DIR=//p' | head -1; }
record_field() { node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const cmd = process.argv[3] ? r.commands.find((c) => c.name === process.argv[3]) : r;
  process.stdout.write(String(cmd?.[process.argv[2]]));
' "$1/result.json" "$2" "${3:-}"; }

root="$(make_fixture gate-record)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
LIST_JSON="$("$CHECKS/repo-gates.sh" --list --json)"
list_pluck() { printf '%s' "$LIST_JSON" | node -e '
  let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const j = JSON.parse(raw);
    process.stdout.write(process.argv[1] === "id" ? j.commandListId : JSON.stringify(j.gates.map((g) => g.name)));
  });' "$1"; }
LIST_ID="$(list_pluck id)"
REQUIRED_ALL="$(list_pluck names)"
# Every canonical gate, stubbed to succeed. This is the shape of a green run.
ALL_PASS=()
while IFS= read -r n; do ALL_PASS+=("$n::true"); done < <(printf '%s' "$REQUIRED_ALL" | node -e '
  let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    for (const n of JSON.parse(raw)) process.stdout.write(`${n}\n`);
  });')

out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["a","b"]' 'a::true' 'b::exit 3')"
att="$(attempt_dir_of "$out")"
[ "$(record_field "$att" result)" = "failed" ] && ok "a failing gate makes the attempt failed" \
  || bad "a failing gate makes the attempt failed" "result=$(record_field "$att" result)"
[ "$(record_field "$att" exitCode b)" = "3" ] && ok "the real exit code is recorded, not just pass/fail" \
  || bad "the real exit code is recorded, not just pass/fail" "exitCode=$(record_field "$att" exitCode b)"
[ -s "$att/logs/01-a.log" ] && ok "each gate gets its own durable log file" \
  || bad "each gate gets its own durable log file" "no 01-a.log under $att/logs"

out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::true')"
[ "$(record_field "$(attempt_dir_of "$out")" result)" = "passed" ] && ok "an all-green attempt records passed" \
  || bad "an all-green attempt records passed" "$out"

# A required gate with no recorded outcome at all — the "not run" case that used to be
# indistinguishable from a pass, because nothing was written down either way.
out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["a","never-ran"]' 'a::true')"
att="$(attempt_dir_of "$out")"
[ "$(record_field "$att" result)" = "failed" ] && ok "a required gate with no outcome cannot pass" \
  || bad "a required gate with no outcome cannot pass" "result=$(record_field "$att" result)"

# The one permitted skip, and only for the one gate it belongs to.
out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["npm ci"]' \
  'npm ci::SKIP:deps-verified-current')"
[ "$(record_field "$(attempt_dir_of "$out")" result)" = "passed" ] && ok "the verified-current install skip still satisfies its gate" \
  || bad "the verified-current install skip still satisfies its gate" "$out"
out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["npm lint"]' 'npm lint::SKIP:deps-verified-current')"
[ "$(record_field "$(attempt_dir_of "$out")" result)" = "failed" ] && ok "the same excuse does not excuse a different gate" \
  || bad "the same excuse does not excuse a different gate" "$out"

# --- 6a. Logging failure is a gate failure ----------------------------------------------------
printf '\n-- gate evidence: logging failures --\n'

# A gate that exits ZERO and destroys its own log. The command succeeded; nobody can read what
# it said; that is not evidence, and the attempt must not be certifiable.
out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::printf tampered > "$DOGFOOD_GATE_LOG"; exit 0')"
att="$(attempt_dir_of "$out")"
[ "$(record_field "$att" status a)" = "passed" ] && [ "$(record_field "$att" logOk a)" = "false" ] \
  && [ "$(record_field "$att" result)" = "failed" ] \
  && ok "a gate that exits 0 but breaks its log cannot be certified" \
  || bad "a gate that exits 0 but breaks its log cannot be certified" \
       "status=$(record_field "$att" status a) logOk=$(record_field "$att" logOk a) result=$(record_field "$att" result)"

# An unwritable log directory: the gate is not even run, because a command whose outcome cannot
# be recorded is not a command anyone may later claim passed.
# The redirect failure is reported on stderr by the shell itself; silence it so a green run
# stays readable. The assertion is on what was RECORDED, not on the noise.
out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["a","b"]' 'a::true' '!chmod-logs:500' 'b::true' 2>/dev/null)"
att="$(attempt_dir_of "$out")"
[ "$(record_field "$att" status b)" = "not-run" ] && [ "$(record_field "$att" result)" = "failed" ] \
  && ok "a gate whose log cannot be written is recorded not-run, not passed" \
  || bad "a gate whose log cannot be written is recorded not-run, not passed" \
       "status=$(record_field "$att" status b) result=$(record_field "$att" result)"

# --- 6b. Attempt sequence and selection --------------------------------------------------------
printf '\n-- gate evidence: attempts --\n'
root="$(make_fixture attempts)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
GATES_ROOT="$root/.local/xezar-tasks/$RUN_A/gates"
head_sha="$(git -C "$wt" rev-parse HEAD)"
RESULTS="$CHECKS/lib/gate-results.mjs"

first="$(attempt_dir_of "$(drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::true')")"
second="$(attempt_dir_of "$(drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::true')")"
[ "$first" != "$second" ] && ok "two attempts on one revision get separate directories" \
  || bad "two attempts on one revision get separate directories" "both at $first"
[ "$(record_field "$second" sequence)" -gt "$(record_field "$first" sequence)" ] \
  && ok "the attempt sequence increases" \
  || bad "the attempt sequence increases" "$(record_field "$first" sequence) then $(record_field "$second" sequence)"

selected="$(node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha")"
[ "$selected" = "$second" ] && ok "selection returns the newest attempt" \
  || bad "selection returns the newest attempt" "picked $selected"

# The rule the whole contract turns on: a newer bad attempt hides an older good one.
failed_attempt="$(attempt_dir_of "$(drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::exit 1')")"
selected="$(node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha")"
[ "$selected" = "$failed_attempt" ] && ok "a newer failed attempt is what selection returns, not the older pass" \
  || bad "a newer failed attempt is what selection returns, not the older pass" "picked $selected"

# An interrupted attempt leaves attempt.json and no result.json, and it counts.
interrupted="$GATES_ROOT/$head_sha/9999-interrupted"
mkdir -p "$interrupted/logs"
node -e '
  const fs = require("node:fs");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify({ ...src, sequence: 9999, complete: false, result: "incomplete" }, null, 2));
' "$first/result.json" "$interrupted/attempt.json"
expect_fail "an interrupted newest attempt blocks selection" \
  "is interrupted" node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha"
rm -rf "$interrupted"

# Fail closed on anything the reader does not understand.
unknown="$GATES_ROOT/$head_sha/9998-unknown"
mkdir -p "$unknown"
printf '{"schemaVersion":99,"kind":"xezar.gate-attempt","sequence":9998,"commands":[]}\n' > "$unknown/result.json"
expect_fail "an unknown schema version is refused, not ignored" \
  "is unsupported" node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha"
printf 'not json at all\n' > "$unknown/result.json"
expect_fail "a malformed record is refused, not skipped over" \
  "is malformed" node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha"
rm -rf "$unknown"

# A symlinked attempt directory would read another run's evidence.
ln -s "$first" "$GATES_ROOT/$head_sha/9997-linked"
expect_fail "a symlinked attempt directory is refused" \
  "is a symlink" node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha"
rm "$GATES_ROOT/$head_sha/9997-linked"

# --- 6c. Sealing --------------------------------------------------------------------------------
printf '\n-- gate evidence: sealing --\n'
root="$(make_fixture sealing)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
PF="$CHECKS/worktree-preflight.sh"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
GATES_ROOT="$root/.local/xezar-tasks/$RUN_A/gates"

# THE DEFECT THIS CONTRACT CLOSES. Until now this step wrote `repo-gates: pass` into the
# manifest whenever it was reached, with nothing behind the claim but the workflow's step
# order — so a resumed run, a hand-driven step or a truncated gates step all sealed a pass that
# had never happened. With no attempt recorded, sealing must refuse.
expect_fail "sealing with no recorded gate attempt is refused (the old false pass)" \
  "no gate attempt recorded" run_in "$wt" "$PF" --record-gate-evidence

drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
expect_ok "a complete passing attempt can be sealed" run_in "$wt" "$PF" --record-gate-evidence
expect_ok "an unchanged checkout verifies against the seal" run_in "$wt" "$PF" --verify-gate-evidence

mval() { node "$CHECKS/lib/manifest.mjs" "$MANIFEST" --get "$1"; }
[ "$(mval gateEvidence.schemaVersion)" = "1" ] && ok "the seal carries its schema version" \
  || bad "the seal carries its schema version" "got '$(mval gateEvidence.schemaVersion)'"
[ -n "$(mval gateEvidence.resultSha256)" ] && ok "the seal names the result record's digest" \
  || bad "the seal names the result record's digest" "empty"
[ "$(mval headSha)" = "$(git -C "$wt" rev-parse HEAD)" ] \
  && ok "sealing synchronizes the manifest's own head identity" \
  || bad "sealing synchronizes the manifest's own head identity" "manifest says $(mval headSha)"

# A newer failed attempt on the same head must stop the older pass being re-sealed.
drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::exit 1' > /dev/null
expect_fail "an older pass cannot be sealed once a newer attempt failed" \
  "not \"passed\"" run_in "$wt" "$PF" --record-gate-evidence

# A changed gate list invalidates an attempt produced by the old one.
root="$(make_fixture sealing-list)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
drive "$wt" "$CHECKS" "deadbeef-not-the-real-list" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
expect_fail "an attempt run against a different command list cannot be sealed" \
  "commandListId changed" run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence

# Changed inputs, and an uncommitted tree.
root="$(make_fixture sealing-inputs)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
printf 'export const seed = 42;\n' > "$wt/seed.ts"
expect_fail "a checkout edited after the gate run cannot be sealed" \
  "changed after the gate run" run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "edit"
expect_fail "committing the edit does not resurrect the old attempt — its head moved" \
  "no gate attempt recorded" run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
printf 'export const dirty = 1;\n' > "$wt/dirty.ts"
expect_fail "an uncommitted tree cannot be certified" \
  "uncommitted changes" run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence
rm "$wt/dirty.ts"

# The content-fingerprint cases the seal still has to catch. A file modified BEFORE the gates
# and modified again after them leaves `git status --porcelain` byte-for-byte identical, so
# only hashing content sees it.
root="$(make_fixture evidence)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
PF="$CHECKS/worktree-preflight.sh"
printf 'export const seed = 99;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "seed 99"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
expect_ok "evidence sealed on a clean tree" run_in "$wt" "$PF" --record-gate-evidence
printf 'export const seed = 100;\n' > "$wt/seed.ts"
expect_fail "editing a tracked file voids the seal" \
  "changed after the green gate run" run_in "$wt" "$PF" --verify-gate-evidence
git -C "$wt" checkout -q -- seed.ts
printf 'export const extra = 1;\n' > "$wt/extra.ts"
expect_fail "a new untracked file voids the seal" \
  "changed after the green gate run" run_in "$wt" "$PF" --verify-gate-evidence
rm "$wt/extra.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "later commit"
expect_fail "a new commit voids the seal" \
  "changed after the green gate run" run_in "$wt" "$PF" --verify-gate-evidence

# Verification with nothing sealed is a failure, never an implicit pass.
root="$(make_fixture no-evidence)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
expect_fail "verification with no sealed evidence fails" \
  "never verified as green" run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh" --verify-gate-evidence

# Evidence from before this contract stays history. It is never promoted to a verified result
# by inference, and it is never silently converted.
root="$(make_fixture legacy-evidence)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
node "$SCRIPT_DIR/lib/manifest.mjs" "$root/.local/xezar-tasks/$RUN_A/manifest.json" \
  --init "runId=$RUN_A" --set-json 'gateEvidence={"headSha":"abc","fingerprint":"deadbeef","at":"2026-01-01T00:00:00Z"}'
expect_fail "pre-contract evidence is not accepted as verification" \
  "predates the versioned contract" \
  run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh" --verify-gate-evidence

# --- 6d. The seal is immutable; CI observations are not -------------------------------------------
printf '\n-- gate evidence: seal versus CI --\n'
root="$(make_fixture ci-observations)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null
sealed_before="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).gateEvidence))' "$MANIFEST")"
sealed_head="$(node "$CHECKS/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.headSha)"
node "$CHECKS/lib/gate-results.mjs" observe-ci --manifest "$MANIFEST" \
  --json "{\"status\":\"pending\",\"testedSha\":\"$sealed_head\",\"runUrl\":\"https://example.invalid/1\"}"
node "$CHECKS/lib/gate-results.mjs" observe-ci --manifest "$MANIFEST" \
  --json "{\"status\":\"success\",\"testedSha\":\"$sealed_head\",\"runUrl\":\"https://example.invalid/1\"}"
sealed_after="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).gateEvidence))' "$MANIFEST")"
[ "$sealed_before" = "$sealed_after" ] && ok "pending-then-green CI observations leave the seal byte-identical" \
  || bad "pending-then-green CI observations leave the seal byte-identical" "the seal changed"
obs="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).ciObservations.length))' "$MANIFEST")"
[ "$obs" = "2" ] && ok "CI observations accumulate in their own list" || bad "CI observations accumulate in their own list" "length $obs"

# --- 6e. Read-only cross-task verification ----------------------------------------------------
printf '\n-- gate evidence: cross-task verification --\n'
VERIFY="$CHECKS/verify-evidence.sh"
expect_ok "a sealed run verifies from the primary checkout" run_in "$root" "$VERIFY" "$RUN_A"

# Verification must survive the worktree being reclaimed: the branch and the commit remain, and
# they are what the seal is bound to.
git -C "$root" worktree remove --force "$wt"
expect_ok "the evidence still verifies after the worktree is reclaimed" run_in "$root" "$VERIFY" "$RUN_A"

# It is read-only: it must not have put the worktree back, or changed the checkout.
[ ! -d "$wt" ] && ok "verification does not re-create the reclaimed worktree" \
  || bad "verification does not re-create the reclaimed worktree" "$wt exists again"
[ -z "$(git -C "$root" status --porcelain)" ] && ok "verification leaves the checkout untouched" \
  || bad "verification leaves the checkout untouched" "$(git -C "$root" status --porcelain | head -3)"

# Missing Git objects are "unavailable", never a pass — and the honest way to reach that is to
# audit the evidence from a repository that genuinely never had the commit, rather than by
# editing the seal to name a SHA nobody has. Editing it is now caught earlier, as a seal that
# disagrees with its own digest-protected record, so it can no longer stand in for this case.
other_root="$(make_fixture no-such-commit)"
mkdir -p "$other_root/.local/xezar-tasks"
cp -R "$root/.local/xezar-tasks/$RUN_A" "$other_root/.local/xezar-tasks/$RUN_A"
node -e '
  const fs = require("node:fs");
  const [file, from, to] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  m.gateEvidence.resultPath = m.gateEvidence.resultPath.replace(from, to);
  m.gateEvidence.attemptDir = m.gateEvidence.attemptDir.replace(from, to);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
' "$other_root/.local/xezar-tasks/$RUN_A/manifest.json" "$root" "$other_root"
out="$(run_in "$other_root" "$other_root/.xezar/checks/verify-evidence.sh" "$RUN_A" 2>&1)"; rc=$?
[ "$rc" = "3" ] && printf '%s' "$out" | grep -q UNAVAILABLE \
  && ok "a commit this repository does not have gives unavailable, not a pass" \
  || bad "a commit this repository does not have gives unavailable, not a pass" "rc=$rc: $out"

# Tampering with the sealed record or one of its logs is caught by the digests.
root="$(make_fixture verify-tamper)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null
result_path="$(node "$CHECKS/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.resultPath)"
cp "$result_path" "$WORK/pristine-result.json"
node -e '
  const fs = require("node:fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  r.commands[1].status = "passed";
  fs.writeFileSync(process.argv[1], JSON.stringify(r, null, 2));
' "$result_path"
expect_fail "a record edited after sealing no longer matches its digest" \
  "changed after sealing" run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A"
cp "$WORK/pristine-result.json" "$result_path"
expect_ok "restoring the record restores verification" run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A"
printf 'rewritten\n' > "$(dirname "$result_path")/logs/02-npm-run-typecheck.log"
expect_fail "a rewritten log no longer matches its sealed digest" \
  "no longer matches its sealed digest" run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A"
rm "$(dirname "$result_path")/logs/02-npm-run-typecheck.log"
expect_fail "a deleted log is a missing log, not an absent problem" \
  "missing or unreadable" run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A"

# A seal that points its result file outside the run's own evidence root is refused before it
# is ever read.
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.gateEvidence.resultPath = `${process.argv[2]}/../../../escaped.json`;
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
' "$MANIFEST" "$(dirname "$result_path")"
expect_fail "a result path outside the evidence root is refused" \
  "outside this run's evidence root" run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A"

# An unknown seal schema fails closed rather than being interpreted optimistically.
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.gateEvidence.schemaVersion = 99;
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
' "$MANIFEST"
expect_fail "an unsupported seal schema is refused" \
  "unsupported seal" run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A"

# --- 6f. The returned findings, each with the case that caught it ---------------------------------
#
# Every case below reproduces a defect two independent reviews found in the first cut of this
# contract at `d0a6c7c`. They are written as the reviewers reproduced them — against the REAL
# recorder, the REAL sealer and the REAL auditor — so a regression fails here rather than in a
# pull request that quotes a green seal it should not have.
printf '\n-- gate evidence: returned findings --\n'

# F1. Concurrency. Reading the next free sequence and then writing the attempt is a race: two
# gate runs in one run id that cross that window used to get the SAME number, the sort tied, and
# directory read order decided which attempt spoke for the head — so a concurrent failing
# attempt could hide behind a passing one. Sequences are now claimed by mkdir, which exactly one
# process can win. Driven concurrently for real, released by a barrier, not hand-built.
root="$(make_fixture concurrency)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
GATES_ROOT="$root/.local/xezar-tasks/$RUN_A/gates"
head_sha="$(git -C "$wt" rev-parse HEAD)"
RESULTS="$CHECKS/lib/gate-results.mjs"
barrier="$WORK/concurrency-barrier"
rm -f "$barrier"
for i in 1 2 3 4 5 6; do
  (
    while [ ! -f "$barrier" ]; do :; done
    drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' "a::$([ "$i" = 3 ] && printf 'exit 9' || printf 'true')" > "$WORK/conc-$i.out" 2>&1
  ) &
done
sleep 1
: > "$barrier"
wait
seqs="$(for f in "$WORK"/conc-*.out; do record_field "$(attempt_dir_of "$(cat "$f")")" sequence 2>/dev/null; printf '\n'; done | grep -c '^[0-9]')"
uniq_seqs="$(for f in "$WORK"/conc-*.out; do record_field "$(attempt_dir_of "$(cat "$f")")" sequence 2>/dev/null; printf '\n'; done | grep '^[0-9]' | sort -u | wc -l | tr -d ' ')"
[ "$seqs" = "6" ] && [ "$uniq_seqs" = "6" ] \
  && ok "six concurrent gate attempts each reserve a distinct sequence" \
  || bad "six concurrent gate attempts each reserve a distinct sequence" "recorded=$seqs distinct=$uniq_seqs"
# One of the six failed, and it is somewhere in the order. Whatever the winner is, the contract
# is that selection names a single attempt and sealing agrees with what that attempt recorded.
sel="$(node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha" 2>/dev/null)"
[ -n "$sel" ] && [ "$(record_field "$sel" sequence)" = "$(for f in "$WORK"/conc-*.out; do record_field "$(attempt_dir_of "$(cat "$f")")" sequence; printf '\n'; done | sort -n | tail -1)" ] \
  && ok "selection returns the highest reserved sequence, not the first directory read" \
  || bad "selection returns the highest reserved sequence, not the first directory read" "picked $sel"
rm -f "$WORK"/conc-*.out "$barrier"

# The same defect in its deterministic form: two attempts that DO share a sequence cannot be
# ranked, and a tie is refused rather than resolved by directory order.
tie_src="$(node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha" 2>/dev/null)"
for name in 0001-tie-pass 0001-tie-fail; do
  mkdir -p "$GATES_ROOT/$head_sha/$name/logs"
  node -e '
    const fs = require("node:fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    r.sequence = 4242;
    r.result = process.argv[3];
    fs.writeFileSync(process.argv[2], JSON.stringify(r, null, 2));
  ' "$tie_src/result.json" "$GATES_ROOT/$head_sha/$name/result.json" "$([ "$name" = 0001-tie-fail ] && printf failed || printf passed)"
done
expect_fail "two attempts sharing a sequence are refused, never ranked by directory order" \
  "share sequence 4242" node "$RESULTS" select --gates-root "$GATES_ROOT" --head "$head_sha"
rm -rf "$GATES_ROOT/$head_sha/0001-tie-pass" "$GATES_ROOT/$head_sha/0001-tie-fail"

# C6 / F3. One record, one reading. The completer took the FIRST entry for a gate and the sealer
# took the LAST, so a gate recorded twice whose second run failed derived "passed" for the
# runner and was then refused by sealing — a green run whose own evidence the next step throws
# out. A duplicate is now a defect in the record, everywhere.
out="$(drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::true' 'a::exit 7')"
att="$(attempt_dir_of "$out")"
[ "$(record_field "$att" result)" = "failed" ] \
  && ok "a gate recorded twice, failing the second time, does not derive a pass" \
  || bad "a gate recorded twice, failing the second time, does not derive a pass" "result=$(record_field "$att" result)"

# C4. A malformed attempt must fail closed — but a fresh, whole, passing attempt must not be
# stuck behind it for ever. The order of a corrupt record is recovered from OUTSIDE its bytes,
# so a later attempt can supersede it, and the seal carries the anomaly rather than forgetting
# it. Nothing is deleted and no empty commit is invented to escape.
root="$(make_fixture malformed-recovery)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
GATES_ROOT="$root/.local/xezar-tasks/$RUN_A/gates"
head_sha="$(git -C "$wt" rev-parse HEAD)"
first="$(attempt_dir_of "$(drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}")")"
# A crash or a full disk truncating both halves of the record — the case that used to wedge the
# head for ever, because a record with no readable sequence sorted ahead of everything.
printf '{"schemaVersion":1,"kind":"xezar.gate-attempt","truncated' > "$first/result.json"
printf '{"schemaVersion":1,"kind":"xezar.gate-attempt","truncated' > "$first/attempt.json"
expect_fail "a truncated newest record is refused, not read optimistically" \
  "is malformed" run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
expect_ok "a fresh whole attempt supersedes the malformed one instead of being wedged behind it" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence
anomaly="$(node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String((m.gateEvidence.anomalies ?? []).length));
' "$MANIFEST")"
[ "$anomaly" = "1" ] && [ -s "$first/result.json" ] \
  && ok "the superseded malformed attempt is kept, and the seal records it as an anomaly" \
  || bad "the superseded malformed attempt is kept, and the seal records it as an anomaly" "anomalies=$anomaly"

# The terminal case, stated honestly rather than looped over: a malformed directory whose order
# cannot be recovered from anywhere. The message must NOT tell the agent to re-run the gates,
# because re-running cannot clear it.
mkdir -p "$GATES_ROOT/$head_sha/unorderable-attempt"
printf 'not json\n' > "$GATES_ROOT/$head_sha/unorderable-attempt/result.json"
out="$(run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence 2>&1)"
printf '%s' "$out" | grep -qF "will NOT clear this" \
  && ok "an unorderable malformed record gives an accurate next action, not endless re-run advice" \
  || bad "an unorderable malformed record gives an accurate next action, not endless re-run advice" "$(printf '%s' "$out" | tail -6)"
rm -rf "$GATES_ROOT/$head_sha/unorderable-attempt"

# C1. The seal lives in the manifest, which is NOT digest-protected and which normal operation
# rewrites. Only `result.json` is. Point the seal's head and tree at a different REAL commit in
# the same repository and the old auditor checked those two fields against each other, agreed
# with itself, and printed VERIFIED for a revision the gates never ran on. The `ffffff…` case
# above only ever exercised the missing-object branch.
root="$(make_fixture seal-binding)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
VERIFY="$CHECKS/verify-evidence.sh"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null
expect_ok "the sealed run verifies before tampering (control)" run_in "$root" "$VERIFY" "$RUN_A"
cp "$MANIFEST" "$WORK/seal-binding-pristine.json"
git -C "$wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "a second real commit"
other_sha="$(git -C "$wt" rev-parse HEAD)"
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.gateEvidence.headSha = process.argv[2];
  m.gateEvidence.treeSha = process.argv[3];
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
' "$MANIFEST" "$other_sha" "$(git -C "$wt" rev-parse "$other_sha^{tree}")"
expect_fail "a seal re-pointed at a different REAL commit is refused, not verified" \
  "the digest-protected record says" run_in "$root" "$VERIFY" "$RUN_A"

# Every other identity field the seal copies from the record is asserted the same way.
for field in attemptId branch commandListId sequence; do
  node -e '
    const fs = require("node:fs");
    const [file, f, pristine] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(pristine, "utf8"));
    m.gateEvidence[f] = f === "sequence" ? 99 : "not-what-the-record-says";
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
  ' "$MANIFEST" "$field" "$WORK/seal-binding-pristine.json"
  expect_fail "a seal whose $field disagrees with the record is refused" \
    "the digest-protected record says" run_in "$root" "$VERIFY" "$RUN_A"
done

# F2. The auditor's containment fence used to be derived from `seal.runId` — a field inside the
# very document it was checking — and `resolve` collapses `..`, so a crafted run id moved the
# fence wherever the caller liked and the fence then trivially contained the target. The root is
# now the manifest's own location, and every run identity in play has to agree with it.
cp "$WORK/seal-binding-pristine.json" "$MANIFEST"
escaped="$root/not-an-evidence-root/gates"
mkdir -p "$escaped"
cp -R "$root/.local/xezar-tasks/$RUN_A/gates/." "$escaped/"
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.gateEvidence.runId = "../../../not-an-evidence-root";
  m.gateEvidence.resultPath = m.gateEvidence.resultPath.replace(process.argv[2], process.argv[3]);
  m.gateEvidence.attemptDir = m.gateEvidence.attemptDir.replace(process.argv[2], process.argv[3]);
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
' "$MANIFEST" "$root/.local/xezar-tasks/$RUN_A/gates" "$escaped"
expect_fail "a tampered runId cannot move the evidence fence outside the run's own root" \
  "is not a valid run id" run_in "$root" "$VERIFY" "$RUN_A"
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.gateEvidence.runId = "some-other-run";
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
' "$MANIFEST"
expect_fail "a seal claiming another run's id is refused even when the id is well-shaped" \
  "this evidence lives under" run_in "$root" "$VERIFY" "$RUN_A"
rm -rf "$escaped"
cp "$WORK/seal-binding-pristine.json" "$MANIFEST"

# C5. A probe that fails yields an empty string, and an empty string used to read as "no
# difference" — so an auditor on a machine where the probe breaks was told the evidence was
# reusable here, having compared nothing.
unknown_out="$(node "$CHECKS/lib/gate-results.mjs" verify --manifest "$MANIFEST" --repo "$root" \
  --run-id "$RUN_A" --command-list-id "" --deps-fingerprint "" 2>&1)"
printf '%s' "$unknown_out" | grep -q "reusable here        unknown" \
  && ok "an input this environment could not measure reads as unknown, never as reusable" \
  || bad "an input this environment could not measure reads as unknown, never as reusable" "$unknown_out"
expect_fail "strict current certification refuses inputs it could not measure" \
  "an unmeasured input is not a match" \
  node "$CHECKS/lib/gate-results.mjs" verify --manifest "$MANIFEST" --repo "$root" \
  --run-id "$RUN_A" --command-list-id "" --deps-fingerprint "" --require-current

# C2. The boundary that mattered. Sealing is monotonic, but NOTHING after sealing was: re-run
# the gates, have one fail, and the handoff checks both still said yes — the fingerprint because
# no file had moved, and the auditor because it printed the newer attempt's STATE ("complete")
# rather than its outcome ("failed"). A draft PR then quoted a green seal that the newest
# recorded outcome for that exact head contradicted.
root="$(make_fixture current-eligibility)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
VERIFY="$CHECKS/verify-evidence.sh"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null
expect_ok "the freshly sealed evidence is eligible for handoff" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --verify-gate-evidence
drive "$wt" "$CHECKS" "$LIST_ID" '["a"]' 'a::exit 1' > /dev/null
expect_fail "a newer FAILED attempt blocks handoff even though no file changed" \
  "not eligible to certify this handoff" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --verify-gate-evidence
out="$(run_in "$root" "$VERIFY" "$RUN_A" 2>&1)"
printf '%s' "$out" | grep -q "historical validity  VERIFIED" \
  && ok "the authentic older pass stays VERIFIED history — a later failure does not make it a lie" \
  || bad "the authentic older pass stays VERIFIED history — a later failure does not make it a lie" "$out"
printf '%s' "$out" | grep -qF "is failed" \
  && ok "the newer attempt is named by its outcome, not by the word complete" \
  || bad "the newer attempt is named by its outcome, not by the word complete" "$out"

# Run the auditor FROM THE WORKTREE, i.e. at the sealed revision.
#
# This used to run from `$root`, the fixture's primary checkout, which sits on `main` and not on
# the sealed head. Now that the auditor observes its own revision, that would refuse for a
# revision-mismatch reason and mask the one this case exists to prove. Worse, asserting only the
# word INELIGIBLE became vacuous: a genuinely superseded seal and a merely-elsewhere checkout would
# both satisfy it. The revision is made to MATCH, so the failed newest attempt is the only thing
# left that can refuse — and that exact reason is what is asserted.
out="$(run_in "$wt" "$VERIFY" "$RUN_A" --require-current 2>&1)"; rc=$?
[ "$rc" != "0" ] && ok "a superseded seal is refused for present use" \
  || bad "a superseded seal is refused for present use" "rc=$rc: $out"
printf '%s' "$out" | grep -q "historical validity  VERIFIED" \
  && ok "historical validity and current eligibility are reported apart, and only the second refuses" \
  || bad "historical validity and current eligibility are reported apart, and only the second refuses" "$out"
printf '%s' "$out" | grep -qF "is failed, and it is not the sealed one" \
  && ok "and the refusal names the FAILED newest attempt, not just the word INELIGIBLE" \
  || bad "and the refusal names the FAILED newest attempt, not just the word INELIGIBLE" "$out"
printf '%s' "$out" | grep -q "was not observed by the caller" \
  && bad "the auditor observed its own revision rather than reporting it unobserved" "$out" \
  || ok "the auditor observed its own revision instead of reporting it unobserved"

# --- C2a. The three callers agree at a matching head, and disagree the moment it moves -----------
#
# `verify-evidence.sh`, `worktree-preflight.sh --verify-gate-evidence` and `resume-complete.sh` all
# ask the same strict question. The auditor was the one that did not supply the current observations,
# so it answered for a different reason than the other two. These cases pin the agreement.
root="$(make_fixture caller-agreement)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
VERIFY="$CHECKS/verify-evidence.sh"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null

expect_ok "at the sealed head the handoff check accepts" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --verify-gate-evidence
expect_ok "and the auditor agrees, from the same checkout" \
  run_in "$wt" "$VERIFY" "$RUN_A" --require-current

# Move the head with a source-only commit. Both must now refuse, and for the SAME reason.
printf 'export const seed = 7;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "moved head"
# The handoff check refuses at its OWN earlier predicate here: `tree_fingerprint` covers HEAD, so a
# commit moves it and `evidence.tree-unchanged` fires before the verifier is reached. That is the
# more specific answer, and asserting the predicate tag pins which check did the refusing.
expect_fail "once the head moves the handoff check refuses" \
  "[evidence.tree-unchanged]" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --verify-gate-evidence
out="$(run_in "$wt" "$VERIFY" "$RUN_A" --require-current 2>&1)"; rc=$?
[ "$rc" != "0" ] && ok "and the auditor refuses too" \
  || bad "and the auditor refuses too" "rc=$rc: $out"
printf '%s' "$out" | grep -q "but the seal certifies" \
  && ok "naming the revision mismatch, which is the actual reason" \
  || bad "naming the revision mismatch, which is the actual reason" "$out"
printf '%s' "$out" | grep -q "historical validity  VERIFIED" \
  && ok "while the historical pass stays VERIFIED at the head it was taken" \
  || bad "while the historical pass stays VERIFIED at the head it was taken" "$out"

# An environment that cannot observe its revision reports unknown, never agreement.
out="$(node "$CHECKS/lib/gate-results.mjs" verify \
  --manifest "$root/.local/xezar-tasks/$RUN_A/manifest.json" --repo "$root" --run-id "$RUN_A" \
  --require-current 2>&1)"
printf '%s' "$out" | grep -q "not observed by the caller" \
  && ok "an unobserved revision stays unknown rather than becoming a match" \
  || bad "an unobserved revision stays unknown rather than becoming a match" "$out"

# An interrupted newest attempt is the same boundary, and it must read as interrupted.
root="$(make_fixture current-eligibility-interrupted)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
GATES_ROOT="$root/.local/xezar-tasks/$RUN_A/gates"
head_sha="$(git -C "$wt" rev-parse HEAD)"
sealed="$(attempt_dir_of "$(drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}")")"
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null
mkdir -p "$GATES_ROOT/$head_sha/9990-interrupted/logs"
node -e '
  const fs = require("node:fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify({ ...r, sequence: 9990, complete: false, result: "incomplete" }, null, 2));
' "$sealed/result.json" "$GATES_ROOT/$head_sha/9990-interrupted/attempt.json"
expect_fail "a newer INTERRUPTED attempt blocks handoff too" \
  "not eligible to certify this handoff" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --verify-gate-evidence
out="$(run_in "$root" "$CHECKS/verify-evidence.sh" "$RUN_A" --require-current 2>&1)"
printf '%s' "$out" | grep -qF "is interrupted" \
  && ok "an interrupted newer attempt is named interrupted" \
  || bad "an interrupted newer attempt is named interrupted" "$out"

# C3. A CI observation for another revision must not sit in the list looking like this seal's
# corroboration. The three things CI can legitimately test stay apart instead of being flattened.
root="$(make_fixture ci-binding)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
OBSERVE="$CHECKS/lib/gate-results.mjs"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence > /dev/null
sealed_head="$(node "$CHECKS/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.headSha)"
expect_fail "a green CI result for another SHA is refused as this seal's corroboration" \
  "is other-revision" \
  node "$OBSERVE" observe-ci --manifest "$MANIFEST" \
  --json '{"status":"completed","conclusion":"success","testedSha":"0123456789012345678901234567890123456789"}'
expect_ok "the same observation may be kept deliberately, as a related one" \
  node "$OBSERVE" observe-ci --manifest "$MANIFEST" --unmatched-ok \
  --json '{"status":"completed","conclusion":"success","testedSha":"0123456789012345678901234567890123456789"}'
marked="$(node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const o = m.ciObservations.at(-1);
  process.stdout.write(`${o.sealBinding}/${o.matchesSeal}`);
' "$MANIFEST")"
[ "$marked" = "other-revision/false" ] \
  && ok "a kept unmatched observation is marked as such, never relabelled as the exact head" \
  || bad "a kept unmatched observation is marked as such, never relabelled as the exact head" "$marked"
sealed_before="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).gateEvidence))' "$MANIFEST")"
expect_ok "a pending observation for the exact sealed head is accepted" \
  node "$OBSERVE" observe-ci --manifest "$MANIFEST" --json "{\"status\":\"queued\",\"testedSha\":\"$sealed_head\",\"testedRef\":\"refs/heads/xez/aaaaaaaa\"}"
expect_ok "and so is the green one that follows it" \
  node "$OBSERVE" observe-ci --manifest "$MANIFEST" --json "{\"status\":\"completed\",\"conclusion\":\"success\",\"testedSha\":\"$sealed_head\",\"testedRef\":\"refs/heads/xez/aaaaaaaa\"}"
sealed_after="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).gateEvidence))' "$MANIFEST")"
[ "$sealed_before" = "$sealed_after" ] \
  && ok "pending-then-green CI for the exact head still leaves the seal byte-identical" \
  || bad "pending-then-green CI for the exact head still leaves the seal byte-identical" "the seal changed"

# --- 7. Blocked scope ------------------------------------------------------------------------------
printf '\n-- blocked scope --\n'
root="$(make_fixture blocked)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"
mkdir -p "$root/.local/xezar-tasks/$RUN_A"
printf 'Which envelope should the new resource use?\n' > "$root/.local/xezar-tasks/$RUN_A/BLOCKED"

# The readiness step sits between the implementation step and the gates, and carries no
# `onFail`. A blocked task therefore stops there — before a full build/test/coverage run,
# and long before the handoff. This is the step order the leader asked for after two
# read-only runs paid for duplicate full-gate passes.
expect_fail "a blocked task stops at readiness, before the gates" \
  "the workflow stops here" run_in "$wt" "$PF" --readiness
expect_fail "and it still cannot seal gate evidence" \
  "No gates, no pull request" run_in "$wt" "$PF" --record-gate-evidence
expect_fail "and it still cannot hand off" \
  "No gates, no pull request" run_in "$wt" "$PF" --verify-gate-evidence

# The workflow files must actually place that step where it can do its job: after the agent
# step and before the gates, with no onFail that could retry past it.
expect_ok "every writing workflow puts readiness before its gates step" \
  node -e '
    const { readFileSync, readdirSync } = require("node:fs");
    const dir = process.argv[1];
    let bad = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
      const text = readFileSync(`${dir}/${f}`, "utf8");
      if (!text.includes("id: gates")) continue;
      const ids = [...text.matchAll(/^  - id: (\S+)$/gm)].map((m) => m[1]);
      const r = ids.indexOf("readiness");
      const g = ids.indexOf("gates");
      const h = ids.indexOf("handoff");
      if (r === -1 || g === -1 || r >= g) bad.push(`${f}: readiness(${r}) must precede gates(${g})`);
      if (h !== ids.length - 1) bad.push(`${f}: handoff must be the last step`);
      const block = text.slice(text.indexOf("id: readiness"), text.indexOf("id: gates"));
      if (block.includes("onFail")) bad.push(`${f}: readiness must not carry onFail`);
    }
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
  ' "$REPO_ROOT/.xezar/workflows"

rm "$root/.local/xezar-tasks/$RUN_A/BLOCKED"
# A resolved decision leads to work, and readiness needs that work to exist (§7b): the branch gets
# its real commit here, so this case keeps testing BLOCKED alone.
printf 'export const seed = 2;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "the work the decision unblocked"
expect_ok "clearing the decision unblocks readiness" run_in "$wt" "$PF" --readiness
# Clearing the blocker removes the blocker, and nothing else. The evidence step still has to
# find a real recorded gate attempt — an unblocked task is not thereby a tested one.
expect_fail "clearing it does not conjure gate evidence" \
  "no gate attempt recorded" run_in "$wt" "$PF" --record-gate-evidence

# --- 7b. An empty branch is not a task's work (#312) ---------------------------------------------
#
# THE INCIDENT. Run b86c6066's author step ended its turn on a design question: no code and no
# BLOCKED file. (Its session transcript shows the turn ended on an `XEZ:ASK` line, which the cockpit
# strips from the thread, so it read as prose; the engine ignored that marker in a non-final step
# until #317.) The engine marked the step done — only the last agent step is
# interactive — and readiness, whose only scope check was "is there a BLOCKED file", read the
# ABSENT file as "not blocked". The gates then ran on the base commit and the evidence step sealed
# `a0cf85e`, the manifest's own baseSha: a valid, verifiable seal for a branch holding none of the
# task's work. Absent input and "checked, and fine" were the same branch.
#
# Every workflow that runs these three modes ends in a draft pull request or a release, and neither
# exists without a commit, so an empty branch is never an honest success for them. The read-only
# roles (business-analysis, research) run plain preflight only and are unaffected — pinned below.
printf '\n-- empty branch --\n'
root="$(make_fixture empty-branch)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"

# The bug: every one of these used to exit 0 on a branch whose HEAD is the base commit.
expect_fail "readiness refuses a branch with zero commits over its base" \
  "branch.has-own-commits" run_in "$wt" "$PF" --readiness
expect_fail "and the evidence step cannot seal it" \
  "branch.has-own-commits" run_in "$wt" "$PF" --record-gate-evidence
expect_fail "and handoff cannot verify it" \
  "branch.has-own-commits" run_in "$wt" "$PF" --verify-gate-evidence

# Not an equality test. The base moving on after the fork leaves HEAD != base tip, yet the branch
# still carries nothing of its own — HEAD is an ancestor of the base.
git -C "$root" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "main moved on"
expect_fail "an empty branch is refused even after its base moved ahead" \
  "branch.has-own-commits" run_in "$wt" "$PF" --readiness

# Guards that pass both ways: the modes with no gate to seal keep accepting a fresh, empty task.
expect_ok "plain preflight still accepts an empty branch (setup runs before any work)" \
  run_in "$wt" "$PF"
if grep -q -- '--readiness\|--record-gate-evidence\|--verify-gate-evidence' \
  "$REPO_ROOT/.xezar/workflows/business-analysis.yaml" "$REPO_ROOT/.xezar/workflows/research.yaml"; then
  bad "read-only roles never reach the empty-branch refusal" "business-analysis or research now runs a gated preflight mode"
else
  ok "read-only roles never reach the empty-branch refusal"
fi

# The control: one real commit and readiness passes again.
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "the task's work"
expect_ok "a branch with a real commit over its base passes readiness" run_in "$wt" "$PF" --readiness

# --- 7c. The gates judge committed work only (#320) ----------------------------------------------
#
# The evidence step refuses to seal a dirty tree, and readiness used to let one through: four tasks
# in one day paid for a complete gate run — typecheck, vitest, unit, build, package — before the
# seal said "the task tree has uncommitted changes". Readiness now asks the sealer's own question
# first. `gates` below is a stub that only records that it started: the point is WHICH command runs,
# and the ordering pin in §7 (readiness before gates, no onFail) is what makes that the workflow's.
printf '\n-- dirty tree --\n'
root="$(make_fixture dirty-tree)"
wt="$(add_worktree "$root" "$RUN_A")"
PF="$root/.xezar/checks/worktree-preflight.sh"
printf 'export const seed = 4;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "the task's work"
gates_ran="$root/.local/gates-ran"
readiness_then_gates() { run_in "$wt" "$PF" --readiness && : > "$gates_ran"; }

# An edit the author step never committed: the dogfooding-note case (4ac055cb).
printf 'export const seed = 5;\n' > "$wt/seed.ts"
rm -f "$gates_ran"
expect_fail "readiness refuses a tree with an uncommitted edit" \
  "gitstate.committed" readiness_then_gates
[ ! -e "$gates_ran" ] \
  && ok "and no gate command starts after that refusal" \
  || bad "and no gate command starts after that refusal" "the stub gates ran on a dirty tree"
expect_fail "the refusal says what to do, not only what is wrong" \
  "then re-run readiness and the gates" run_in "$wt" "$PF" --readiness
git -C "$wt" checkout -q -- seed.ts

# A new file the author never added counts too — `git add` is the step that gets forgotten.
printf 'export const extra = 1;\n' > "$wt/extra.ts"
expect_fail "readiness refuses a tree with an untracked new file" \
  "extra.ts" run_in "$wt" "$PF" --readiness

# Guards that pass both ways: plain preflight runs on trees that are rightly mid-work, and the
# read-only roles never run readiness at all.
expect_ok "plain preflight still accepts a dirty tree" run_in "$wt" "$PF"
if grep -q -- '--readiness' \
  "$REPO_ROOT/.xezar/workflows/business-analysis.yaml" "$REPO_ROOT/.xezar/workflows/research.yaml"; then
  bad "read-only roles never reach the dirty-tree refusal" "business-analysis or research now runs --readiness"
else
  ok "read-only roles never reach the dirty-tree refusal"
fi

# The control: commit it, and readiness passes and the gates start.
git -C "$wt" add extra.ts
git -C "$wt" -c user.email=t@t -c user.name=t commit -qm "the forgotten file"
rm -f "$gates_ran"
expect_ok "a committed tree passes readiness" readiness_then_gates
[ -e "$gates_ran" ] \
  && ok "and the gates start on it" \
  || bad "and the gates start on it" "the stub gates never ran on a clean, committed tree"

# --- 8. Manifest safety ------------------------------------------------------------------------------
printf '\n-- manifest --\n'
root="$(make_fixture manifest)"
# A crafted run id must be refused outright, not sanitised: `..` segments would let a manifest
# escape the evidence root.
expect_fail "a path-traversing task id is refused" "" \
  bash -c ". '$root/.xezar/checks/lib/common.sh'; valid_task_id '../../etc'"
expect_fail "an absolute task id is refused" "" \
  bash -c ". '$root/.xezar/checks/lib/common.sh'; valid_task_id '/etc/passwd'"
expect_ok "an ordinary run id is accepted" \
  bash -c ". '$root/.xezar/checks/lib/common.sh'; valid_task_id '$RUN_A'"

# Two runs must never share an evidence file. Writing one must leave the other untouched.
node "$SCRIPT_DIR/lib/manifest.mjs" "$WORK/collide/$RUN_A/manifest.json" --init "runId=$RUN_A"
node "$SCRIPT_DIR/lib/manifest.mjs" "$WORK/collide/$RUN_B/manifest.json" --init "runId=$RUN_B"
a_id="$(node "$SCRIPT_DIR/lib/manifest.mjs" "$WORK/collide/$RUN_A/manifest.json" --get runId)"
[ "$a_id" = "$RUN_A" ] && ok "one task's manifest does not overwrite another's" \
  || bad "one task's manifest does not overwrite another's" "run A now reads '$a_id'"

# A symlinked evidence directory would redirect the write out of the evidence root, or onto
# another task. The run id validation guards the path's shape; this guards what is on disk.
mkdir -p "$WORK/elsewhere"
ln -s "$WORK/elsewhere" "$WORK/collide/linked"
expect_fail "a symlinked evidence directory is refused, not followed" \
  "symlinked evidence directory" \
  node "$SCRIPT_DIR/lib/manifest.mjs" "$WORK/collide/linked/manifest.json" --init "runId=$RUN_A"
[ -e "$WORK/elsewhere/manifest.json" ] && bad "nothing is written through the symlink" "the file was created anyway" \
  || ok "nothing is written through the symlink"

ln -s "$WORK/elsewhere/hijack.json" "$WORK/collide/$RUN_B/manifest.json.link"
expect_fail "a symlinked manifest file is refused too" \
  "symlinked manifest file" \
  node "$SCRIPT_DIR/lib/manifest.mjs" "$WORK/collide/$RUN_B/manifest.json.link" --set "pr=1"

# The handoff skill tells an agent how to find the manifest without the printed line. That
# derivation must land exactly where worktree-setup.sh writes — a worktree is FOUR levels below
# the primary checkout, and counting `..` by hand got it wrong once already.
root="$(make_fixture manifest-path)"
wt="$(add_worktree "$root" "$RUN_A")"
derived="$(cd "$wt" && printf '%s/.local/xezar-tasks/%s/manifest.json' \
  "$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd -P)" \
  "$(basename "$(git rev-parse --show-toplevel)")")"
expected="$(cd "$wt" && . "$root/.xezar/checks/lib/common.sh" && resolve_task_paths && task_manifest_path)"
[ "$derived" = "$expected" ] && ok "the handoff skill's manifest derivation matches where setup writes" \
  || bad "the handoff skill's manifest derivation matches where setup writes" "derived '$derived' vs '$expected'"
# Anchor both globs to the fixture. An unanchored `*/.ai/*` matches a `.ai/` ANYWHERE in the
# absolute path, so it false-fails whenever this suite is itself run from a Xezar worktree —
# whose path is `<primary>/.local/xezar/worktrees/<runId>`. Anchoring keeps the real assertion
# (evidence must not land inside the worktree) and adds the worktree prefix explicitly.
wt_phys="$(cd "$wt" && pwd -P)"
root_phys="$(cd "$root" && pwd -P)"
case "$derived" in
  "$wt_phys"/*|"$root_phys"/.ai/*) bad "the derived manifest path does not land under .ai/" "$derived" ;;
  *) ok "the derived manifest path does not land under .ai/" ;;
esac

m="$WORK/m.json"
node "$SCRIPT_DIR/lib/manifest.mjs" "$m" --init "runId=$RUN_A" "branch=xez/aaaaaaaa"
node "$SCRIPT_DIR/lib/manifest.mjs" "$m" --push-json 'checks={"name":"repo-gates","result":"pass"}'
node "$SCRIPT_DIR/lib/manifest.mjs" "$m" --push-json 'checks={"name":"reuse","result":"pass"}'
got="$(node "$SCRIPT_DIR/lib/manifest.mjs" "$m" --get runId)"
[ "$got" = "$RUN_A" ] && ok "the manifest round-trips a value" || bad "the manifest round-trips a value" "got '$got'"
count="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).checks.length)' "$m")"
[ "$count" = "2" ] && ok "repeated writes append instead of replacing" || bad "repeated writes append instead of replacing" "checks length $count"

# --- 9. Dependency freshness ----------------------------------------------------------------------------
printf '\n-- dependency freshness --\n'
root="$(make_fixture deps)"
wt="$(add_worktree "$root" "$RUN_A")"
printf 'lockfileVersion: 9\n' > "$wt/package-lock.json"
printf '{"name":"fx","packageManager":"npm@11.11.0"}\n' > "$wt/package.json"
mkdir -p "$wt/packages/a" && printf '{"name":"a"}\n' > "$wt/packages/a/package.json"

deps_check() { ( cd "$wt" && . "$root/.xezar/checks/lib/common.sh" && resolve_task_paths && "$@" ); }

# `examples/` does not exist in this fixture. Under `set -o pipefail` a naive find would make
# the whole fingerprint fail; it must simply be skipped.
expect_ok "the fingerprint works when examples/ is absent" \
  bash -c "cd '$wt' && . '$root/.xezar/checks/lib/common.sh' && resolve_task_paths && test -n \"\$(deps_fingerprint)\""

expect_fail "dependencies are stale before any install" "" deps_check deps_are_fresh
expect_ok "stamping marks them current" deps_check write_deps_stamp
expect_ok "a stamped tree reports fresh" deps_check deps_are_fresh

printf 'lockfileVersion: 9\nchanged: true\n' > "$wt/package-lock.json"
expect_fail "a lockfile change invalidates freshness" "" deps_check deps_are_fresh
deps_check write_deps_stamp >/dev/null

mkdir -p "$wt/patches" && printf 'diff --git a b\n' > "$wt/patches/pkg.patch"
expect_fail "a new patch file invalidates freshness" "" deps_check deps_are_fresh
deps_check write_deps_stamp >/dev/null

printf 'diff --git a b\n+changed\n' > "$wt/patches/pkg.patch"
expect_fail "an edited patch invalidates freshness" "" deps_check deps_are_fresh
deps_check write_deps_stamp >/dev/null

printf 'registry=https://example.invalid\n' > "$wt/.npmrc"
expect_fail "an .npmrc change invalidates freshness" "" deps_check deps_are_fresh
deps_check write_deps_stamp >/dev/null

printf '{"name":"a","dependencies":{"x":"1"}}\n' > "$wt/packages/a/package.json"
expect_fail "a workspace package.json change invalidates freshness" "" deps_check deps_are_fresh
deps_check write_deps_stamp >/dev/null

rm -rf "$wt/node_modules"
expect_fail "removing node_modules invalidates freshness" "" deps_check deps_are_fresh

# --- 9a. Workspace packages resolve to the task's OWN copy (#286) ---------------------------------
# A task worktree lives INSIDE the primary checkout (`.local/xezar/worktrees/<runId>`), so node's
# node_modules lookup does not stop at a worktree that lacks a workspace link: it walks on up to
# the primary's node_modules, whose link points at the PRIMARY's source — whatever branch and
# uncommitted edits that checkout has. A check run there judges code the branch does not contain.
# The fixture reproduces exactly that layout: the fixture root plays the primary checkout.
printf '\n-- workspace links resolve inside the task --\n'
root="$(make_fixture deps-links)"
wt="$(add_worktree "$root" "$RUN_A")"
printf 'lockfileVersion: 9\n' > "$wt/package-lock.json"
printf '{"name":"fx","workspaces":["packages/a"]}\n' > "$wt/package.json"
mkdir -p "$wt/packages/a" && printf '{"name":"@fx/a"}\n' > "$wt/packages/a/package.json"
mkdir -p "$root/packages/a" "$root/node_modules/@fx"
printf '{"name":"@fx/a"}\n' > "$root/packages/a/package.json"
ln -s ../../packages/a "$root/node_modules/@fx/a"

# node_modules exists and carries a matching stamp — the old freshness test is satisfied — but the
# task's own link is missing, so every import of @fx/a from the task lands in the primary's copy.
deps_check write_deps_stamp >/dev/null
expect_fail "a stamped tree whose workspace link is missing is not fresh" "" deps_check deps_are_fresh
expect_fail "a missing workspace link names the checkout it would borrow from" \
  "$root/node_modules/@fx/a" deps_check deps_resolve_in_task

# A link that exists but points at the primary's copy is the same bug by another route.
mkdir -p "$wt/node_modules/@fx" && ln -s "$root/packages/a" "$wt/node_modules/@fx/a"
expect_fail "a workspace link into another checkout is refused" \
  "not this task's" deps_check deps_resolve_in_task
expect_fail "and that tree is not fresh either" "" deps_check deps_are_fresh

# Controls: the link npm writes (relative, into the task's own tree) passes both checks.
rm "$wt/node_modules/@fx/a" && ln -s ../../packages/a "$wt/node_modules/@fx/a"
expect_ok "the task's own workspace link resolves inside the task" deps_check deps_resolve_in_task
expect_ok "and the stamped tree is fresh again" deps_check deps_are_fresh

# A repository with no workspaces has nothing to resolve; that is a pass, not an unknown.
printf '{"name":"fx"}\n' > "$wt/package.json"
expect_ok "a repository without workspaces has nothing to borrow" deps_check deps_resolve_in_task

# An unreadable root manifest is not "no workspaces": the check cannot know, so it says so.
printf '{not json\n' > "$wt/package.json"
expect_fail "an unreadable package.json fails the check instead of passing it" \
  "cannot read" deps_check deps_resolve_in_task


# --- 9b. worktree-setup.sh, driven for real -------------------------------------------------------
printf '\n-- worktree setup --\n'
# A stubbed npm keeps this deterministic and offline: the point is what the script DOES with the
# install result, not that npm works. `git fetch` has no origin to reach in a fixture, so the
# base-freshness report degrades to "unknown" — also exercised here.
stub_npm() {
  local dir="$1" code="$2"
  mkdir -p "$dir"
  cat > "$dir/npm" <<STUB
#!/usr/bin/env bash
[ "\$1" = "--version" ] && { echo "11.11.0"; exit 0; }
echo "stub npm \$*"
exit $code
STUB
  chmod +x "$dir/npm"
}

root="$(make_fixture setup)"
wt="$(add_worktree "$root" "$RUN_A")"
SETUP="$root/.xezar/checks/worktree-setup.sh"
manifest="$root/.local/xezar-tasks/$RUN_A/manifest.json"
printf 'lockfileVersion: 9\n' > "$wt/package-lock.json"
printf '{"name":"fx","packageManager":"npm@11.11.0"}\n' > "$wt/package.json"

stub_npm "$WORK/bin-ok" 0
setup_in() { ( cd "$wt" && env -u XEZ_TASK_ID -u DOGFOOD_ALLOW_ROOT_BOOTSTRAP PATH="$1:$PATH" "$SETUP" ); }

expect_ok "a first setup succeeds on a fresh worktree" setup_in "$WORK/bin-ok"
[ -f "$manifest" ] && ok "setup writes the task manifest to the primary checkout" \
  || bad "setup writes the task manifest to the primary checkout" "no file at $manifest"
got="$(node "$SCRIPT_DIR/lib/manifest.mjs" "$manifest" --get branch)"
[ "$got" = "xez/${RUN_A:0:8}" ] && ok "the manifest records the run's own branch" \
  || bad "the manifest records the run's own branch" "got '$got'"
[ -f "$wt/node_modules/.xezar-deps-stamp" ] && ok "a successful install is stamped" \
  || bad "a successful install is stamped" "no stamp written"

# Re-running must be safe: `onFail` retries reset only the steps between the retry target and the
# failure, so setup is skipped on a loop-back — but a resumed or hand-run setup must not damage
# what the first one wrote.
node "$SCRIPT_DIR/lib/manifest.mjs" "$manifest" --set "pr=123"
out="$(setup_in "$WORK/bin-ok" 2>&1)"
if printf '%s' "$out" | grep -q "install skipped"; then ok "a second setup skips the install"; else bad "a second setup skips the install" "$(printf '%s' "$out" | tail -5)"; fi
count="$(ls -1 "$root/.local/xezar-tasks" | wc -l | tr -d ' ')"
[ "$count" = "1" ] && ok "re-running setup keeps exactly one manifest" \
  || bad "re-running setup keeps exactly one manifest" "$count evidence directories"
got="$(node "$SCRIPT_DIR/lib/manifest.mjs" "$manifest" --get pr)"
[ "$got" = "123" ] && ok "re-running setup preserves values the run already recorded" \
  || bad "re-running setup preserves values the run already recorded" "pr is now '$got'"

# A failed install must not leave a stamp claiming the tree is current — that would let the next
# `--fast` gate run skip the install it still needs and judge an empty node_modules.
root="$(make_fixture setup-fail)"
wt="$(add_worktree "$root" "$RUN_A")"
SETUP="$root/.xezar/checks/worktree-setup.sh"
printf 'lockfileVersion: 9\n' > "$wt/package-lock.json"
printf '{"name":"fx","packageManager":"npm@11.11.0"}\n' > "$wt/package.json"
stub_npm "$WORK/bin-fail" 1
expect_fail "a failed install fails the setup step" \
  "npm ci failed" setup_in "$WORK/bin-fail"
[ -f "$wt/node_modules/.xezar-deps-stamp" ] \
  && bad "a failed install records no freshness stamp" "a stamp was written anyway" \
  || ok "a failed install records no freshness stamp"

# And setup refuses outright where the preflight refuses: no install, no manifest, in the
# primary checkout.
expect_fail "setup aborts in the primary checkout without installing" \
  "the preflight failed" \
  env -u XEZ_TASK_ID -u DOGFOOD_ALLOW_ROOT_BOOTSTRAP PATH="$WORK/bin-ok:$PATH" bash -c "cd '$root' && '$SETUP'"
[ -d "$root/.local/xezar-tasks" ] \
  && bad "an aborted setup writes no evidence" "an evidence directory was created" \
  || ok "an aborted setup writes no evidence"

# #286: an install that leaves a workspace package resolving from the primary checkout must fail
# setup loudly, and must not stamp the tree current. The stub npm installs nothing, which is the
# worst case: every workspace import from this task would silently read the primary's source.
root="$(make_fixture setup-links)"
wt="$(add_worktree "$root" "$RUN_A")"
SETUP="$root/.xezar/checks/worktree-setup.sh"
printf 'lockfileVersion: 9\n' > "$wt/package-lock.json"
printf '{"name":"fx","packageManager":"npm@11.11.0","workspaces":["packages/a"]}\n' > "$wt/package.json"
mkdir -p "$wt/packages/a" && printf '{"name":"@fx/a"}\n' > "$wt/packages/a/package.json"
mkdir -p "$root/packages/a" "$root/node_modules/@fx"
printf '{"name":"@fx/a"}\n' > "$root/packages/a/package.json"
ln -s ../../packages/a "$root/node_modules/@fx/a"
expect_fail "setup refuses an install whose workspace package resolves outside the task" \
  "$root/node_modules/@fx/a" setup_in "$WORK/bin-ok"
[ -f "$wt/node_modules/.xezar-deps-stamp" ] \
  && bad "a borrowed workspace package records no freshness stamp" "a stamp was written anyway" \
  || ok "a borrowed workspace package records no freshness stamp"

# Source-specific tooling/document assertions replaced by xezar-contract.test.mjs.
# --- 17. Interrupted authorized merge: recovery, and everything it must still refuse ------------
#
# The whole section works on REAL interrupted merges: a fixture is given two conflicting commits,
# `git merge` is run and left mid-conflict, and the actual scripts are driven against that state.
# A simulated MERGE_HEAD would prove nothing about the case this exists for.
printf '\n-- interrupted merge recovery --\n'

root="$(make_fixture merge-recovery)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
PF="$CHECKS/worktree-preflight.sh"
MR="$CHECKS/merge-recovery.sh"

# A branch that conflicts with this run's branch on the same file.
git -C "$root" -c user.email=t@t -c user.name=t branch -q incoming main
git -C "$root" worktree add -q "$WORK/incoming-wt" incoming >/dev/null 2>&1
printf 'export const seed = 2;\n' > "$WORK/incoming-wt/seed.ts"
git -C "$WORK/incoming-wt" -c user.email=t@t -c user.name=t commit -qam "incoming change"
INCOMING_SHA="$(git -C "$WORK/incoming-wt" rev-parse HEAD)"

printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "our change"
HEAD_BEFORE="$(git -C "$wt" rev-parse HEAD)"

# The ordinary preflight is clean here, and that is the baseline the exception must not widen.
expect_ok "the strict preflight passes before any merge starts" run_in "$wt" "$PF"

# Recording an intent is refused unless the checkout is clean and validated.
expect_fail "record-intent refuses an unresolvable incoming ref" \
  "does not resolve to a commit" run_in "$wt" "$MR" record-intent \
  --incoming "no-such-ref" --authorization "issue #115 comment 1" --scope "merge incoming into this branch"
expect_fail "record-intent requires an authorization reference" \
  "missing --authorization" run_in "$wt" "$MR" record-intent --incoming "$INCOMING_SHA" --scope "x"

expect_ok "an authorized merge intent is recorded before the merge" \
  run_in "$wt" "$MR" record-intent --incoming "$INCOMING_SHA" \
  --authorization "issue #115 comment 5590641157" --scope "merge the incoming branch into this run's branch"

expect_fail "a second intent cannot silently replace the first" \
  "already recorded" run_in "$wt" "$MR" record-intent --incoming "$INCOMING_SHA" \
  --authorization "some other reference" --scope "something else"

# Now interrupt an authorized merge: run it, let it conflict, and stop there.
git -C "$wt" -c user.email=t@t -c user.name=t merge --no-commit incoming >/dev/null 2>&1
[ -e "$root/.git/worktrees/$RUN_A/MERGE_HEAD" ] && ok "the fixture is genuinely mid-merge (MERGE_HEAD exists)" \
  || bad "the fixture is genuinely mid-merge (MERGE_HEAD exists)" "no MERGE_HEAD under .git/worktrees/$RUN_A"

# 1. The normal preflight must STILL refuse. The exception is opt-in and nothing else changed.
expect_fail "the strict preflight still refuses a merge in progress" \
  "[gitstate.clean]" run_in "$wt" "$PF"

# 2. The recovery check admits this one merge, because it matches the record.
expect_ok "the recovery check admits the merge that was recorded" run_in "$wt" "$PF" --merge-recovery
expect_ok "merge-recovery check is the same check" run_in "$wt" "$MR" check

# 3. It says out loud that it checked identity and not authority.
recovery_text="$(run_in "$wt" "$MR" check 2>&1)"
printf '%s' "$recovery_text" | grep -qi "carried, not verified" \
  && ok "the recovery output states that authority is carried, never verified" \
  || bad "the recovery output states that authority is carried, never verified" "$recovery_text"

# 4. An unresolved merge may not be committed. This is the rule that must not move.
expect_fail "committing an unresolved merge is refused" \
  "still unmerged" run_in "$wt" "$MR" commit -m "merge"

# 4b. THE ORDINARY GUARD MUST NOT BE THE WAY OUT OF A MERGE.
#
# `worktree-git.sh` says in its own usage text that it requires a clean git state and refuses a
# merge in progress, and until now nothing drove it in one — the mid-merge cases all exercised
# `merge-recovery.sh`, and the ordinary guard was only ever run on clean trees. A documented
# refusal that no test executes is a comment.
#
# This matters beyond tidiness. If the ordinary guard ever started tolerating a merge in progress,
# the entire scoped-recovery path becomes optional: an agent could finish an interrupted merge with
# the everyday verb, skipping the recorded intent and the parent proof that make the recovery
# auditable. Both states are driven — unresolved, and fully resolved — because it is the *second*
# one that a well-meaning relaxation would allow.
WG_MERGE="$CHECKS/worktree-git.sh"
expect_fail "the ordinary guarded commit refuses an UNRESOLVED merge in progress" \
  "gitstate" run_in "$wt" "$WG_MERGE" commit -m "merge"

merge_probe_ours="$(git -C "$wt" rev-parse HEAD)"
printf 'export const seed = 4;\n' > "$wt/seed.ts"
git -C "$wt" add seed.ts
expect_fail "the ordinary guarded commit refuses a RESOLVED merge too — recovery is the only route" \
  "gitstate" run_in "$wt" "$WG_MERGE" commit -m "merge"

# The refused attempts must have changed nothing: still mid-merge, still on the same commit.
[ -f "$wt/.git/MERGE_HEAD" ] || [ -f "$(git -C "$wt" rev-parse --git-dir)/MERGE_HEAD" ] \
  && ok "a refused ordinary commit leaves the merge in progress" \
  || bad "a refused ordinary commit leaves the merge in progress" "MERGE_HEAD disappeared"
[ "$(git -C "$wt" rev-parse HEAD)" = "$merge_probe_ours" ] \
  && ok "a refused ordinary commit advances no history" \
  || bad "a refused ordinary commit advances no history" "HEAD moved after a refusal"

# 5. The guarded commit, on the merge 4b resolved and staged.
#
# The conflict was resolved in 4b, because refusing a RESOLVED merge is the case that matters
# there. Nothing needs re-resolving here; what this step adds is the commit itself.
#
# Capture the two parents the merge MUST produce, before it produces them. Asserting identity
# afterwards is only meaningful against values read beforehand — a count alone cannot tell a
# correct merge from a merge of the wrong two commits.
E2E_WT="$wt"
E2E_OURS="$(git -C "$wt" rev-parse HEAD)"
E2E_THEIRS="$(git -C "$wt" rev-parse MERGE_HEAD 2>/dev/null || printf '')"
merge_commit_output="$(run_in "$wt" env GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t "$MR" commit -m "merge incoming" 2>&1)"
merge_commit_rc=$?
[ "$merge_commit_rc" -eq 0 ] && ok "the guarded commit finishes a fully resolved merge" \
  || bad "the guarded commit finishes a fully resolved merge" "$merge_commit_output"

# 6. And normal certification resumes: no exception is left switched on.
expect_ok "the strict preflight passes again once the merge is committed" run_in "$wt" "$PF"
merged_parents="$(git -C "$wt" rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')"
[ "$merged_parents" = "3" ] && ok "the resulting commit really has both recorded parents" \
  || bad "the resulting commit really has both recorded parents" "parent count field = $merged_parents"

# --- 17a. Everything the recovery path must refuse -----------------------------------------------
printf '\n-- interrupted merge recovery: refusals --\n'

# Each case rebuilds a fresh interrupted merge, doctors ONE thing, and must be refused.
# Write an intent file DIRECTLY, bypassing the recorder.
#
# The refusal cases below are about what the recovery CHECK admits, and each needs an intent whose
# fields are deliberately wrong. They cannot go through `merge-intent.mjs record`, because it now
# refuses to write while a merge is in flight — which is the F1 fix, asserted in its own case. This
# models a hand-edited file, and a hand-edited agent-writable JSON file is explicitly outside what
# any of this guarantees; what must hold is that the CHECK still refuses it.
write_intent_file() {
  local path="$1" body="$2"
  mkdir -p "$(dirname "$path")"
  printf '%s' "$body" | node -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      const intent = JSON.parse(raw);
      intent.schemaVersion = 1;
      intent.kind = "xezar.merge-intent";
      intent.recordedAt = new Date().toISOString();
      require("node:fs").writeFileSync(process.argv[1], `${JSON.stringify(intent, null, 2)}\n`);
    });' "$path"
}

setup_interrupted_merge() {
  local name="$1"
  local r
  r="$(make_fixture "$name")"
  git -C "$r" -c user.email=t@t -c user.name=t branch -q incoming main
  git -C "$r" worktree add -q "$WORK/$name-inc" incoming >/dev/null 2>&1
  printf 'export const seed = 2;\n' > "$WORK/$name-inc/seed.ts"
  git -C "$WORK/$name-inc" -c user.email=t@t -c user.name=t commit -qam "incoming"
  printf '%s' "$r"
}

# (a) No intent was ever recorded — the merge nobody wrote down.
root="$(setup_interrupted_merge no-intent)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "ours"
git -C "$wt" -c user.email=t@t -c user.name=t merge --no-commit incoming >/dev/null 2>&1
expect_fail "an interrupted merge with no recorded intent is refused" \
  "[merge.intent-recorded]" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery
expect_fail "and the message refuses to authorize the merge retroactively" \
  "writing one now would authorize the merge with itself" \
  run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (b) The intent belongs to a DIFFERENT run.
write_intent_file "$root/.local/xezar-tasks/$RUN_A/merge-intent.json" "$(node -e '
  const [wt, branch, rootCommit, head, incoming] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    runId: "ffffffff-0000-4000-8000-00000000000f", worktree: wt, branch,
    repoRootCommit: rootCommit, expectedHeadSha: head, expectedIncomingSha: incoming,
    incomingRef: "incoming", authorizationReference: "ref", authorizationScope: "scope",
  }));
' "$wt" "xez/$(printf '%s' "$RUN_A" | cut -c1-8)" "$(git -C "$wt" rev-list --max-parents=0 HEAD | tail -1)" \
  "$(git -C "$wt" rev-parse HEAD)" "$(git -C "$wt" rev-parse incoming)")" >/dev/null
expect_fail "an intent recorded by another run does not admit this merge" \
  "identity.run" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (c) The intent names a different incoming parent.
write_intent_file "$root/.local/xezar-tasks/$RUN_A/merge-intent.json" "$(node -e '
  const [runId, wt, branch, rootCommit, head] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    runId, worktree: wt, branch, repoRootCommit: rootCommit,
    expectedHeadSha: head, expectedIncomingSha: "0000000000000000000000000000000000000000",
    incomingRef: "elsewhere", authorizationReference: "ref", authorizationScope: "scope",
  }));
' "$RUN_A" "$wt" "xez/$(printf '%s' "$RUN_A" | cut -c1-8)" "$(git -C "$wt" rev-list --max-parents=0 HEAD | tail -1)" \
  "$(git -C "$wt" rev-parse HEAD)")" >/dev/null
expect_fail "an unexpected incoming parent is refused" \
  "parents.incoming" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (d) The intent names a different HEAD — the tree moved under the recorded merge.
write_intent_file "$root/.local/xezar-tasks/$RUN_A/merge-intent.json" "$(node -e '
  const [runId, wt, branch, rootCommit, incoming] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    runId, worktree: wt, branch, repoRootCommit: rootCommit,
    expectedHeadSha: "1111111111111111111111111111111111111111", expectedIncomingSha: incoming,
    incomingRef: "incoming", authorizationReference: "ref", authorizationScope: "scope",
  }));
' "$RUN_A" "$wt" "xez/$(printf '%s' "$RUN_A" | cut -c1-8)" "$(git -C "$wt" rev-list --max-parents=0 HEAD | tail -1)" \
  "$(git -C "$wt" rev-parse incoming)")" >/dev/null
expect_fail "an unexpected HEAD parent is refused" \
  "parents.head" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (e) A different repository entirely, proved by the root commit.
write_intent_file "$root/.local/xezar-tasks/$RUN_A/merge-intent.json" "$(node -e '
  const [runId, wt, branch, head, incoming] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    runId, worktree: wt, branch, repoRootCommit: "2222222222222222222222222222222222222222",
    expectedHeadSha: head, expectedIncomingSha: incoming,
    incomingRef: "incoming", authorizationReference: "ref", authorizationScope: "scope",
  }));
' "$RUN_A" "$wt" "xez/$(printf '%s' "$RUN_A" | cut -c1-8)" "$(git -C "$wt" rev-parse HEAD)" \
  "$(git -C "$wt" rev-parse incoming)")" >/dev/null
expect_fail "an intent from a different repository is refused" \
  "identity.repo" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (f) A malformed intent file is a refusal, never an admission.
printf 'not json\n' > "$root/.local/xezar-tasks/$RUN_A/merge-intent.json"
expect_fail "a malformed intent file admits nothing" \
  "not valid JSON" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (g) A DIFFERENT git operation, with a perfectly valid merge intent on disk.
root="$(setup_interrupted_merge other-op)"
wt="$(add_worktree "$root" "$RUN_B")"
CHECKS="$root/.xezar/checks"
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "ours"
write_intent_file "$root/.local/xezar-tasks/$RUN_B/merge-intent.json" "$(node -e '
  const [runId, wt, branch, rootCommit, head, incoming] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    runId, worktree: wt, branch, repoRootCommit: rootCommit,
    expectedHeadSha: head, expectedIncomingSha: incoming,
    incomingRef: "incoming", authorizationReference: "ref", authorizationScope: "scope",
  }));
' "$RUN_B" "$wt" "xez/$(printf '%s' "$RUN_B" | cut -c1-8)" "$(git -C "$wt" rev-list --max-parents=0 HEAD | tail -1)" \
  "$(git -C "$wt" rev-parse HEAD)" "$(git -C "$wt" rev-parse incoming)")" >/dev/null
# A cherry-pick, not a merge. Every identity field still matches; the OPERATION does not.
git -C "$wt" -c user.email=t@t -c user.name=t cherry-pick incoming >/dev/null 2>&1
expect_fail "a cherry-pick is refused even with a valid merge intent on disk" \
  "operation.merge-in-progress" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery
git -C "$wt" cherry-pick --abort >/dev/null 2>&1

# (h) The recovery mode never widens the OTHER assertions. A wrong branch still fails.
root="$(setup_interrupted_merge wrong-branch)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
git -C "$wt" checkout -q -b "xez/deadbeef"
expect_fail "recovery mode still refuses a branch this run does not own" \
  "[branch.owned-by-run]" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (i) And it still refuses the primary checkout.
expect_fail "recovery mode still refuses the primary checkout" \
  "[isolation.not-primary-checkout]" run_in "$root" "$CHECKS/worktree-preflight.sh" --merge-recovery

# (k) F1 — THE ORDERING INVARIANT, AT THE RECORDER. An intent must be impossible to write once the
#     merge it claims to authorize is already under way. The refusal used to live only in the shell
#     wrapper, so the same authorization written straight through the library produced a record that
#     matched every identity predicate — because it had been copied out of the state it authorized.
root="$(setup_interrupted_merge post-hoc-intent)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "ours"

# The valid pre-merge control first: on a clean tree the library accepts.
premerge_intent="$(node -e '
  const [runId, wt, branch, rootCommit, head, incoming] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    runId, worktree: wt, branch, repoRootCommit: rootCommit,
    expectedHeadSha: head, expectedIncomingSha: incoming, incomingRef: "incoming",
    authorizationReference: "ref", authorizationScope: "scope",
  }));
' "$RUN_A" "$wt" "xez/$(printf '%s' "$RUN_A" | cut -c1-8)" \
  "$(git -C "$wt" rev-list --max-parents=0 HEAD | tail -1)" \
  "$(git -C "$wt" rev-parse HEAD)" "$(git -C "$wt" rev-parse incoming)")"
expect_ok "the library records an intent on a clean tree (the valid pre-merge control)" \
  node "$CHECKS/lib/merge-intent.mjs" record --path "$root/.local/xezar-tasks/$RUN_A/premerge.json" \
  --json "$premerge_intent"

# Now start the merge, and try to write the same authorization after the fact.
git -C "$wt" -c user.email=t@t -c user.name=t merge --no-commit incoming >/dev/null 2>&1
expect_fail "the WRAPPER refuses to record an intent once a merge is under way" \
  "already in progress" run_in "$wt" "$CHECKS/merge-recovery.sh" record-intent \
  --incoming incoming --authorization "after the fact" --scope "retroactive"
expect_fail "and the LIBRARY refuses it too — the invariant is in the mechanism, not one caller" \
  "already under way" node "$CHECKS/lib/merge-intent.mjs" record \
  --path "$root/.local/xezar-tasks/$RUN_A/merge-intent.json" --json "$premerge_intent"
expect_fail "so a post-hoc intent admits nothing" \
  "[merge.intent-recorded]" run_in "$wt" "$CHECKS/worktree-preflight.sh" --merge-recovery
git -C "$wt" merge --abort >/dev/null 2>&1

# Another git operation blocks the recorder for the same reason.
git -C "$wt" -c user.email=t@t -c user.name=t cherry-pick incoming >/dev/null 2>&1
expect_fail "a cherry-pick in flight also blocks recording an intent" \
  "already under way" node "$CHECKS/lib/merge-intent.mjs" record \
  --path "$root/.local/xezar-tasks/$RUN_A/other.json" --json "$premerge_intent"
git -C "$wt" cherry-pick --abort >/dev/null 2>&1

# A worktree whose state cannot be read is refused rather than recorded blind.
expect_fail "an unreadable worktree state is refused, never assumed clean" \
  "cannot be shown that no merge" node "$CHECKS/lib/merge-intent.mjs" record \
  --path "$root/.local/xezar-tasks/$RUN_A/blind.json" \
  --json "$(printf '%s' "$premerge_intent" | node -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      const i = JSON.parse(raw); i.worktree = "/nonexistent/not-a-worktree";
      process.stdout.write(JSON.stringify(i));
    });')"

# (l) F2 — the guarded commit proves what it actually wrote.
#
# PROMOTED TO BEHAVIOUR, 2026-09-09 (issue #116, accepted P3 review-A carry-over). This used to be
# three regexes over `merge-recovery.sh`'s own source text. Source text is the weakest possible
# evidence for a runtime property: it passes when the code is renamed, when the branch containing
# it is unreachable, and when the string appears only in a comment. Reviewer A's independent probes
# already demonstrated the real behaviour; the point of this block is that the MAINTAINED suite now
# demonstrates it too, on the actual resulting commit.
#
# The end-to-end merge in §17 is the subject. Its two parents were read BEFORE the commit, so what
# follows compares identities rather than counting fields.
if [ -n "${E2E_WT:-}" ] && [ -n "${E2E_OURS:-}" ] && [ -n "${E2E_THEIRS:-}" ]; then
  e2e_head="$(git -C "$E2E_WT" rev-parse HEAD)"
  [ "$e2e_head" != "$E2E_OURS" ] \
    && ok "HEAD actually moved: the guarded commit produced a new commit" \
    || bad "HEAD actually moved" "HEAD is still $E2E_OURS after a reported successful commit"

  e2e_parents="$(git -C "$E2E_WT" rev-list --parents -n 1 HEAD | cut -d' ' -f2-)"
  e2e_p1="$(printf '%s' "$e2e_parents" | cut -d' ' -f1)"
  e2e_p2="$(printf '%s' "$e2e_parents" | cut -d' ' -f2)"
  e2e_n="$(printf '%s' "$e2e_parents" | wc -w | tr -d ' ')"
  [ "$e2e_n" = "2" ] \
    && ok "the resulting HEAD has exactly two parents" \
    || bad "the resulting HEAD has exactly two parents" "parents = [$e2e_parents]"
  # Identity, not just arity. A merge of the wrong two commits also has two parents.
  if [ "$e2e_p1" = "$E2E_OURS" ] && [ "$e2e_p2" = "$E2E_THEIRS" ]; then
    ok "the two parents are exactly the ours/theirs pair recorded before the merge"
  else
    bad "the two parents are exactly the ours/theirs pair recorded before the merge" \
      "expected [$E2E_OURS $E2E_THEIRS], got [$e2e_parents]"
  fi
  # The merge really is finished: no operation is still in flight afterwards.
  [ -e "$(git -C "$E2E_WT" rev-parse --git-path MERGE_HEAD)" ] \
    && bad "no merge is left in progress after the guarded commit" "MERGE_HEAD still exists" \
    || ok "no merge is left in progress after the guarded commit"

  # THE NO-OP. Running the guarded commit again, with nothing left to commit, must not invent a
  # second commit and must not report a fresh success. A retry that assumes the previous attempt
  # did nothing is how duplicate history gets written.
  noop_before="$(git -C "$E2E_WT" rev-parse HEAD)"
  noop_out="$(run_in "$E2E_WT" env GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t \
    GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t "$MR" commit -m "merge incoming" 2>&1)"
  noop_after="$(git -C "$E2E_WT" rev-parse HEAD)"
  [ "$noop_before" = "$noop_after" ] \
    && ok "re-running the guarded commit writes no second commit" \
    || bad "re-running the guarded commit writes no second commit" "HEAD moved $noop_before -> $noop_after"
  # It must also not report success. The observed refusal is `merge.matches-recorded-intent`:
  # the merge is finished, so the recorded intent no longer matches the state, and the guard
  # declines rather than committing again. Which predicate refuses is an implementation detail;
  # what is asserted is that a repeat does not come back green.
  if printf '%s' "$noop_out" | grep -q 'PREFLIGHT FAILED\|REFUSED\|refused'; then
    ok "the repeated guarded commit refuses rather than reporting a second success"
  else
    bad "the repeated guarded commit refuses rather than reporting a second success" "$noop_out"
  fi
else
  bad "the end-to-end merge exposed its pre-merge parents" \
    "NOT RUN: E2E_OURS/E2E_THEIRS were not captured — a check that could not run is not a pass"
fi

# NO AUTOMATIC ROLLBACK. A refusal must leave the interrupted merge exactly as it found it: the
# resolution work is the operator's, and discarding it is a leader decision, never a side effect of
# a failed check. Driven on a fresh fixture with a deliberately wrong intent.
root="$(setup_interrupted_merge no-rollback)"
wt="$(add_worktree "$root" "$RUN_A")"
# The conflict has to be real: the run's branch must change the SAME file the incoming branch
# changed, and the merge must be left mid-conflict. A clean fast-forward would leave no merge to
# preserve and the case would assert nothing.
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "our change"
git -C "$wt" -c user.email=t@t -c user.name=t merge --no-commit incoming >/dev/null 2>&1
if [ -e "$(git -C "$wt" rev-parse --git-path MERGE_HEAD)" ]; then
  ok "the no-rollback fixture is genuinely mid-merge"
  nr_head_before="$(git -C "$wt" rev-parse HEAD)"
  nr_merge_before="$(git -C "$wt" rev-parse MERGE_HEAD)"
  nr_status_before="$(git -C "$wt" status --porcelain | sort)"
  # No intent was ever recorded, so the check must refuse this merge.
  nr_out="$(run_in "$wt" "$MR" check 2>&1)"
  nr_rc=$?
  [ "$nr_rc" -ne 0 ] \
    && ok "an unrecorded interrupted merge is refused" \
    || bad "an unrecorded interrupted merge is refused" "$nr_out"
  [ "$(git -C "$wt" rev-parse HEAD)" = "$nr_head_before" ] \
    && ok "after the refusal HEAD is untouched" \
    || bad "after the refusal HEAD is untouched" "HEAD moved during a refusal"
  [ -e "$(git -C "$wt" rev-parse --git-path MERGE_HEAD)" ] \
    && [ "$(git -C "$wt" rev-parse MERGE_HEAD)" = "$nr_merge_before" ] \
    && ok "after the refusal the merge is still in progress — nothing was aborted" \
    || bad "after the refusal the merge is still in progress" "MERGE_HEAD was cleared by a refusal"
  [ "$(git -C "$wt" status --porcelain | sort)" = "$nr_status_before" ] \
    && ok "after the refusal the working tree is byte-for-byte unchanged" \
    || bad "after the refusal the working tree is byte-for-byte unchanged" "the refusal mutated the tree"
else
  bad "the no-rollback fixture is genuinely mid-merge" \
    "NOT RUN: the fixture did not reach a conflicted merge — a check that could not run is not a pass"
fi

# The incompatible-argument negative: `--amend` cannot produce the recorded merge. Git refuses it
# during a merge, and pinning that here means the guard no longer rests on an unasserted external.
root="$(setup_interrupted_merge amend-refusal)"
wt="$(add_worktree "$root" "$RUN_B")"
CHECKS="$root/.xezar/checks"
printf 'export const seed = 3;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "ours"
run_in "$wt" "$CHECKS/merge-recovery.sh" record-intent --incoming incoming \
  --authorization "ref" --scope "scope" >/dev/null 2>&1
git -C "$wt" -c user.email=t@t -c user.name=t merge --no-commit incoming >/dev/null 2>&1
printf 'export const seed = 4;\n' > "$wt/seed.ts"
git -C "$wt" add seed.ts
expect_fail "an --amend commit is refused, and the refusal is pinned rather than assumed" \
  "" run_in "$wt" env GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \
  "$CHECKS/merge-recovery.sh" commit --amend -m "rewrite"

# (j) Nothing in the recovery path offers an abort or a reset.
expect_ok "no recovery script ever aborts, resets or cleans" \
  node -e '
    const { readFileSync } = require("node:fs");
    const bad = [];
    for (const f of process.argv.slice(1)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (/^\s*(#|\/\/)/.test(line)) continue;            // prose about not doing it is fine
        if (/git\s+(-C\s+\S+\s+)?(merge\s+--abort|rebase\s+--abort|reset|clean\s+-|checkout\s+--force)/.test(line)) {
          bad.push(`${f}: ${line.trim()}`);
        }
      }
    }
    if (bad.length) { console.error(`a destructive escape hatch appeared:\n${bad.join("\n")}`); process.exit(1); }
  ' "$SCRIPT_DIR/merge-recovery.sh" "$SCRIPT_DIR/worktree-preflight.sh" "$SCRIPT_DIR/lib/merge-intent.mjs"

# --- 18. The shared resumed-completion entry point ------------------------------------------------
printf '\n-- resumed completion --\n'

root="$(make_fixture resume)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
RC="$CHECKS/resume-complete.sh"

expect_ok "resume-complete has help" run_in "$wt" "$RC" --help
expect_fail "resume-complete rejects an unsupported flag by name" \
  "Supported: --dry-run" run_in "$wt" "$RC" --nope

# With no sealed evidence, a dry run must say the gates would re-run — and change nothing.
out="$(run_in "$wt" "$RC" --dry-run 2>&1)"
printf '%s' "$out" | grep -q "would re-run" \
  && ok "a resume with no sealed evidence reports the gates as a required stage" \
  || bad "a resume with no sealed evidence reports the gates as a required stage" "$out"
[ ! -d "$root/.local/xezar-tasks/$RUN_A/gates" ] \
  && ok "a dry run writes no gate attempt" \
  || bad "a dry run writes no gate attempt" "gates/ exists after --dry-run"

# A BLOCKED file stops a resume before any gate cost is paid.
mkdir -p "$root/.local/xezar-tasks/$RUN_A"
printf 'an unresolved scope question\n' > "$root/.local/xezar-tasks/$RUN_A/BLOCKED"
expect_fail "a resume stops on a BLOCKED file" \
  "unresolved decision" run_in "$wt" "$RC" --dry-run
rm "$root/.local/xezar-tasks/$RUN_A/BLOCKED"

# Seal a real passing attempt, then confirm reuse is accepted for the SAME revision.
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
expect_ok "the fixture attempt seals" run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence
out="$(run_in "$wt" "$RC" --dry-run 2>&1)"
printf '%s' "$out" | grep -q "would be reused" \
  && ok "verified compatible evidence is reused instead of re-run" \
  || bad "verified compatible evidence is reused instead of re-run" "$out"

# A DEPENDENCY change on resume invalidates that reuse, with NOTHING else moved.
#
# Isolating that dimension needs care. Almost every input `deps_fingerprint` hashes — the
# lockfile, the workspace manifests, the patches — is also a tracked file, so touching one moves
# the TREE fingerprint too and the refusal would come from the wrong assertion. `.npmrc` is the
# one that is routinely git-ignored, because it can carry a registry token; it is ignored in this
# fixture for that reason, so writing it changes what npm would resolve from and changes nothing
# else the checks look at.
git -C "$wt" check-ignore -q .npmrc \
  && ok "the fixture ignores .npmrc, so this case isolates the dependency inputs" \
  || bad "the fixture ignores .npmrc, so this case isolates the dependency inputs" "not ignored"
tree_before="$(run_in "$wt" bash -c '. .xezar/checks/lib/common.sh; resolve_task_paths >/dev/null; tree_fingerprint')"
printf 'registry=https://example.invalid/\n' > "$wt/.npmrc"
tree_after="$(run_in "$wt" bash -c '. .xezar/checks/lib/common.sh; resolve_task_paths >/dev/null; tree_fingerprint')"
[ "$tree_before" = "$tree_after" ] \
  && ok "and the tree fingerprint is unchanged, so only the dependency inputs moved" \
  || bad "and the tree fingerprint is unchanged, so only the dependency inputs moved" "$tree_before then $tree_after"
out="$(run_in "$wt" "$RC" --dry-run 2>&1)"
printf '%s' "$out" | grep -q "would re-run" \
  && ok "a dependency change on resume invalidates the reuse" \
  || bad "a dependency change on resume invalidates the reuse" "$out"
printf '%s' "$out" | grep -q "dependencies installed here" \
  && ok "and the refusal names the dependencies, not some other input" \
  || bad "and the refusal names the dependencies, not some other input" "$out"
rm -f "$wt/.npmrc"

# A resume never opens or updates a pull request, and never names another task's.
expect_ok "the resume entry point contains no pull-request action" \
  node -e '
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    const bad = text.split("\n").filter((l) => !/^\s*#/.test(l) && /\bgh\s+pr\b|git\s+push/.test(l));
    if (bad.length) { console.error(`resume-complete performs a publication action:\n${bad.join("\n")}`); process.exit(1); }
  ' "$SCRIPT_DIR/resume-complete.sh"

# A dirty tree is refused BEFORE the gates run, because sealing would refuse it afterwards anyway.
printf 'uncommitted\n' > "$wt/scratch.ts"
expect_fail "a resume refuses to run the gates over an uncommitted tree" \
  "uncommitted changes" run_in "$wt" "$RC" --force-gates
rm "$wt/scratch.ts"

# --- 18a. The resume helper, DRIVEN — default mode, real gates, real seals ---------------------------
#
# WHY THIS EXISTS, and why `--dry-run` was not enough. The first version of §18 covered no-evidence,
# BLOCKED, same-revision reuse, a dependency change, a dirty tree and the absence of PR actions —
# every one of them through `--dry-run` or `--help`. So the reuse-ACCEPTED path, the one that ends
# `RESUME COMPLETE`, never executed in the suite at all, and the dimension that separates reuse from
# a false pass — did the revision move since the seal? — was never exercised.
#
# It had moved. `verify --require-current` compared the gate list, the dependencies and the newest
# attempt, and nothing about the caller's own revision, so a source-only repair commit after sealing
# was answered ELIGIBLE and the gates were skipped for a head they had never seen.
#
# These cases run the helper with NO FLAGS against a fixture whose `repo-gates.sh` is a mini one:
# same recording library, same seal path, same eligibility code, trivial commands. A green result
# here is a statement about the HELPER, never a production gate pass.
printf '\n-- resumed completion: driven end to end --\n'

# A stand-in for repo-gates.sh: the real gate-record library, one trivial gate. `DOGFOOD_FIXTURE_GATE`
# decides whether it passes, so a failing newest attempt can be produced on demand.
write_mini_gates() {
  cat > "$1/.xezar/checks/repo-gates.sh" <<'MINI'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/gate-record.sh"
GATE_NAMES=("mini gate")
GATE_COMMANDS=("true")
gate_list_json() { printf '[{"name":"mini gate","command":"true"}]'; }
gate_list_id() { gate_list_json | shasum -a 256 | cut -d' ' -f1; }
LIST=0; AS_JSON=0
for arg in "$@"; do
  case "$arg" in
    --list) LIST=1 ;;
    --json) AS_JSON=1 ;;
    --fast) ;;
    *) printf 'mini-gates: unknown argument "%s"\n' "$arg" >&2; exit 2 ;;
  esac
done
if [ "$LIST" -eq 1 ]; then
  if [ "$AS_JSON" -eq 1 ]; then
    printf '{"commandListId":"%s","gates":%s}\n' "$(gate_list_id)" "$(gate_list_json)"
  else
    printf 'commandListId  %s\n' "$(gate_list_id)"
  fi
  exit 0
fi
resolve_task_paths || exit 1
cd "$TASK_CWD" || exit 1
GATE_BASE_REF="main"
GATE_BASE_SHA="$(git merge-base HEAD main 2>/dev/null || printf '')"
export GATE_BASE_REF GATE_BASE_SHA
gate_attempt_begin '["mini gate"]' "$(gate_list_id)" || exit 1
gate_run "mini gate" bash -c "${DOGFOOD_FIXTURE_GATE:-true}"
result="$(gate_attempt_complete)"; rc=$?
printf 'recorded %s\n' "$result"
[ "$rc" -eq 0 ] && [ "$result" = "passed" ] && exit 0
exit 1
MINI
  chmod +x "$1/.xezar/checks/repo-gates.sh"
}

root="$(make_fixture resume-driven)"
write_mini_gates "$root"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "mini gates" >/dev/null 2>&1
wt="$(add_worktree_with_work "$root" "$RUN_A")"
RC="$root/.xezar/checks/resume-complete.sh"
MANIFEST="$root/.local/xezar-tasks/$RUN_A/manifest.json"
GATES_ROOT="$root/.local/xezar-tasks/$RUN_A/gates"
# `deps_are_fresh` needs a stamp, or every case reports stale deps for an unrelated reason.
run_in "$wt" bash -c '. .xezar/checks/lib/common.sh; resolve_task_paths >/dev/null; write_deps_stamp'

# 1. No evidence yet: the default run must execute the gates and seal.
expect_ok "a default resume with no evidence runs the gates and seals" run_in "$wt" "$RC"
head_x="$(git -C "$wt" rev-parse HEAD)"
sealed_head="$(node "$root/.xezar/checks/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.headSha)"
[ "$sealed_head" = "$head_x" ] && ok "and the seal names the head it actually ran at" \
  || bad "and the seal names the head it actually ran at" "sealed $sealed_head, head $head_x"
attempts_x="$(ls "$GATES_ROOT/$head_x" | wc -l | tr -d ' ')"

# 2. Nothing moved: valid reuse must NOT repeat the gates.
expect_ok "an unchanged revision reuses the seal" run_in "$wt" "$RC"
[ "$(ls "$GATES_ROOT/$head_x" | wc -l | tr -d ' ')" = "$attempts_x" ] \
  && ok "and no second attempt was recorded — reuse really avoided the repeat" \
  || bad "and no second attempt was recorded — reuse really avoided the repeat" \
       "attempt count moved from $attempts_x"

# 3. THE B1 CASE. A source-only commit, dependencies and gate list untouched. The gates MUST run
#    again and seal the new head; reusing here would certify a revision nothing tested.
printf 'export const seed = 99;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "source-only repair"
head_y="$(git -C "$wt" rev-parse HEAD)"
[ "$head_y" != "$head_x" ] && ok "the fixture really moved to a new head" \
  || bad "the fixture really moved to a new head" "head did not change"
expect_ok "a source-only commit after sealing forces the gates to run again" run_in "$wt" "$RC"
[ "$(node "$root/.xezar/checks/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.headSha)" = "$head_y" ] \
  && ok "and the new seal certifies the NEW head, not the old one" \
  || bad "and the new seal certifies the NEW head, not the old one" \
       "seal says $(node "$root/.xezar/checks/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.headSha), head is $head_y"
[ -d "$GATES_ROOT/$head_y" ] && ok "and a real gate attempt exists at the new head" \
  || bad "and a real gate attempt exists at the new head" "no attempt directory for $head_y"

# The old seal's own eligibility must now be refused, with a reason naming the revision.
out="$(run_in "$wt" node "$root/.xezar/checks/lib/gate-results.mjs" verify \
  --manifest "$MANIFEST" --repo "$root" --run-id "$RUN_A" \
  --current-head "$head_x" --current-tree-fingerprint "deliberately-wrong" --require-current 2>&1)"
printf '%s' "$out" | grep -q "but the seal certifies" \
  && ok "a mismatched revision is refused with a reason that names it" \
  || bad "a mismatched revision is refused with a reason that names it" "$out"

# 4. A dirty tree must refuse BEFORE any gate cost.
printf 'uncommitted\n' > "$wt/scratch.ts"
expect_fail "a default resume refuses an uncommitted tree" "uncommitted changes" run_in "$wt" "$RC"
rm "$wt/scratch.ts"

# 5. A newest FAILED attempt must not be stepped over: the helper re-executes rather than reusing.
before_fail="$(ls "$GATES_ROOT/$head_y" | wc -l | tr -d ' ')"
run_in "$wt" env DOGFOOD_FIXTURE_GATE="exit 1" "$root/.xezar/checks/repo-gates.sh" >/dev/null 2>&1
expect_ok "a newest FAILED attempt makes the resume re-run the gates rather than reuse" run_in "$wt" "$RC"
[ "$(ls "$GATES_ROOT/$head_y" | wc -l | tr -d ' ')" -gt "$((before_fail + 1))" ] \
  && ok "and both the failure and the new pass are on disk" \
  || bad "and both the failure and the new pass are on disk" "attempts did not grow past the failure"

# 6. An INTERRUPTED newest attempt (attempt.json, no result.json) must refuse reuse too.
interrupted="$GATES_ROOT/$head_y/9999-interrupted"
mkdir -p "$interrupted/logs"
node -e '
  const fs = require("node:fs");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify({ ...src, sequence: 9999, complete: false, result: "incomplete" }, null, 2));
' "$(node "$root/.xezar/checks/lib/manifest.mjs" "$MANIFEST" --get gateEvidence.resultPath)" "$interrupted/attempt.json"
out="$(run_in "$wt" "$RC" --dry-run 2>&1)"
printf '%s' "$out" | grep -q "would re-run" \
  && ok "an interrupted newest attempt refuses reuse" \
  || bad "an interrupted newest attempt refuses reuse" "$out"
rm -rf "$interrupted"

# 7. A gate list the caller cannot measure is UNKNOWN, never a match.
out="$(run_in "$wt" node "$root/.xezar/checks/lib/gate-results.mjs" verify \
  --manifest "$MANIFEST" --repo "$root" --run-id "$RUN_A" --require-current 2>&1)"
printf '%s' "$out" | grep -q "not observed by the caller" \
  && ok "an unobserved revision is refused, not assumed to match" \
  || bad "an unobserved revision is refused, not assumed to match" "$out"

# 8. N-a: a dry run that found a required stage must not exit 0.
printf 'export const seed = 100;\n' > "$wt/seed.ts"
git -C "$wt" -c user.email=t@t -c user.name=t commit -qam "another repair"
expect_fail "a dry run that found a required stage exits non-zero" \
  "A required stage is outstanding" run_in "$wt" "$RC" --dry-run

# --- 19. Read-only evidence initialization ----------------------------------------------------------
printf '\n-- read-only evidence init --\n'

root="$(make_fixture readonly-init)"
CHECKS="$root/.xezar/checks"
SETUP="$CHECKS/worktree-setup.sh"

expect_ok "worktree-setup has help" run_in "$root" "$SETUP" --help
expect_fail "worktree-setup names the flags it supports" \
  "Supported: --allow-root | --readonly-init | --help" run_in "$root" "$SETUP" --bogus

# In the primary checkout with no XEZ_TASK_ID there is no identity, and none may be invented.
out="$(cd "$root" && env -u XEZ_TASK_ID "$SETUP" --readonly-init 2>&1)"
rc=$?
[ "$rc" -eq 3 ] && ok "an unresolvable identity reports unavailable (exit 3), not a guess" \
  || bad "an unresolvable identity reports unavailable (exit 3), not a guess" "exit $rc"
printf '%s' "$out" | grep -q "NOT guessed from the checkout" \
  && ok "and it says explicitly that a directory is not derived from the root basename" \
  || bad "and it says explicitly that a directory is not derived from the root basename" "$out"
[ ! -d "$root/.local/xezar-tasks/$(basename "$root")" ] \
  && ok "no directory named after the checkout was created" \
  || bad "no directory named after the checkout was created" "a basename-derived directory exists"

# With an identity, it writes the manifest and installs NOTHING.
out="$(cd "$root" && env XEZ_TASK_ID="$RUN_B" "$SETUP" --readonly-init 2>&1)"
rc=$?
[ "$rc" -eq 0 ] && ok "read-only init succeeds when the run id is known" \
  || bad "read-only init succeeds when the run id is known" "exit $rc: $out"
[ -f "$root/.local/xezar-tasks/$RUN_B/manifest.json" ] \
  && ok "read-only init writes the manifest in the primary checkout" \
  || bad "read-only init writes the manifest in the primary checkout" "no manifest"
[ ! -d "$root/node_modules" ] && ok "read-only init installs no dependencies" \
  || bad "read-only init installs no dependencies" "node_modules appeared"
printf '%s' "$out" | grep -q "never installs anything" \
  && ok "and it says so, rather than leaving the reader to infer it" \
  || bad "and it says so, rather than leaving the reader to infer it" "$out"

# The read-only wording must not overclaim: it is a readiness statement, not a ban on execution.
printf '%s' "$out" | grep -q "READINESS statement" \
  && ok "the no-install statement is scoped as readiness, not as a claim reviewers cannot run anything" \
  || bad "the no-install statement is scoped as readiness, not as a claim reviewers cannot run anything" "$out"

# --- 20. Guard diagnostics, supported flags and malformed configuration --------------------------------
printf '\n-- guard diagnostics --\n'

root="$(make_fixture diagnostics)"
wt="$(add_worktree "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
PF="$CHECKS/worktree-preflight.sh"

# Every refusal names its predicate, and the verdict block restates the state it judged.
git -C "$wt" checkout -q -b "xez/notmine"
out="$(run_in "$wt" "$PF" 2>&1)"
printf '%s' "$out" | grep -q "\[branch.owned-by-run\]" \
  && ok "a wrong-branch refusal is tagged branch.owned-by-run" \
  || bad "a wrong-branch refusal is tagged branch.owned-by-run" "$out"
printf '%s' "$out" | grep -q "CWD           $wt" \
  && ok "the refusal restates the actual CWD it checked" \
  || bad "the refusal restates the actual CWD it checked" "$out"
printf '%s' "$out" | grep -q "run           $RUN_A" \
  && ok "the refusal restates the resolved run id" \
  || bad "the refusal restates the resolved run id" "$out"
printf '%s' "$out" | grep -q "most of these fail in the right one" \
  && ok "the refusal warns that a wrong operation is not always a wrong directory" \
  || bad "the refusal warns that a wrong operation is not always a wrong directory" "$out"
git -C "$wt" checkout -q "xez/$(printf '%s' "$RUN_A" | cut -c1-8)"

# The guarded write no longer asserts a cause it did not establish.
expect_ok "worktree-git no longer claims every refusal is a wrong CWD" \
  node -e '
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    if (/no git %s was attempted\. The CWD this ran in is not/.test(text)) {
      console.error("worktree-git.sh still asserts a wrong CWD for every preflight failure");
      process.exit(1);
    }
    if (!/predicate tags above say WHICH assertion failed/.test(text)) {
      console.error("worktree-git.sh does not point the reader at the predicate tags");
      process.exit(1);
    }
  ' "$SCRIPT_DIR/worktree-git.sh"

# Supported flags and help, on every guard a skill tells an agent to run.
for guard in worktree-preflight.sh worktree-setup.sh worktree-git.sh merge-recovery.sh resume-complete.sh; do
  expect_ok "$guard --help exits 0" run_in "$wt" "$CHECKS/$guard" --help
  expect_fail "$guard names its supported arguments when given a bad one" \
    "Supported" run_in "$wt" "$CHECKS/$guard" --definitely-not-a-flag
done

# A malformed project config is a diagnosis, not a stack trace.
root="$(make_fixture catalog-bad-config)"
printf '{ "baseBranch": "main",\n' > "$root/.xezar/config.json"
out="$(node "$SCRIPT_DIR/catalog-check.mjs" "$root" 2>&1)"
rc=$?
[ "$rc" -ne 0 ] && ok "a malformed config still fails the catalog check" \
  || bad "a malformed config still fails the catalog check" "exit 0"
printf '%s' "$out" | grep -q "CATALOG CHECK FAILED" \
  && ok "and it fails in the checker's own format, not as a raw SyntaxError" \
  || bad "and it fails in the checker's own format, not as a raw SyntaxError" "$out"
printf '%s' "$out" | grep -q "is not valid JSON" \
  && ok "and it names the file and the parse problem" \
  || bad "and it names the file and the parse problem" "$out"
printf '%s' "$out" | grep -qi "at Object\.\|node:internal" \
  && bad "no node stack frames leak into the diagnosis" "$out" \
  || ok "no node stack frames leak into the diagnosis"

# The documented base-branch fallback, both halves, driven for real.
root="$(make_fixture base-absent)"
printf '{\n  "worktreeRetention": 0\n}\n' > "$root/.xezar/config.json"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "config without baseBranch"
wt="$(add_worktree "$root" "$RUN_A")"
out="$(run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh" 2>&1)"
printf '%s' "$out" | grep -q "BASE_BRANCH   main" \
  && ok "an absent baseBranch falls back to main, and the resolved value is printed" \
  || bad "an absent baseBranch falls back to main, and the resolved value is printed" "$out"

root="$(make_fixture base-blank)"
printf '{\n  "baseBranch": "   ",\n  "worktreeRetention": 0\n}\n' > "$root/.xezar/config.json"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "blank baseBranch"
wt="$(add_worktree "$root" "$RUN_A")"
out="$(run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh" 2>&1)"
printf '%s' "$out" | grep -q "BASE_BRANCH   main" \
  && ok "a BLANK baseBranch falls back to main too — the documented second case" \
  || bad "a BLANK baseBranch falls back to main too — the documented second case" "$out"

root="$(make_fixture base-broken)"
printf '{ not json\n' > "$root/.xezar/config.json"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "broken config"
wt="$(add_worktree "$root" "$RUN_A")"
expect_fail "an UNPARSEABLE config is a hard failure, never a silent main" \
  "cannot establish isolation" run_in "$wt" "$root/.xezar/checks/worktree-preflight.sh"

expect_ok "the blank-base fallback is documented where the code implements it" \
  node -e '
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    if (!/present and BLANK/.test(text)) {
      console.error("lib/common.sh does not document the blank baseBranch case its code implements");
      process.exit(1);
    }
  ' "$SCRIPT_DIR/lib/common.sh"

# The catalog comment must describe what the catalog checker actually validates.
expect_ok "the catalog checker does not claim a reachability rule it does not implement" \
  node -e '
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    if (/every skill must be reachable, so a renamed/.test(text)) {
      console.error("catalog-check.mjs still claims a reachability check that no loop performs");
      process.exit(1);
    }
  ' "$SCRIPT_DIR/catalog-check.mjs"

# And a skill named by no workflow is still accepted, because that is correct here.
root="$(make_fixture orphan-skill)"
mkdir -p "$root/.xezar/skills" "$root/.xezar/workflows"
cp "$REPO_ROOT/.xezar/workflows/code-review.yaml" "$root/.xezar/workflows/"
cp "$REPO_ROOT/.xezar/skills/xezar-code-review.md" "$root/.xezar/skills/"
printf -- '---\nname: xezar-orphan\ndescription: named by no workflow, launched from the composer\n---\n\nbody\n' \
  > "$root/.xezar/skills/xezar-orphan.md"
expect_ok "a skill named by no workflow is accepted, as the comment now says" \
  node "$SCRIPT_DIR/catalog-check.mjs" "$root"

# --- 21. Fixture scratch placement ---------------------------------------------------------------------
printf '\n-- fixture scratch --\n'

# The routing rule itself, exercised through the shared helper rather than restated here.
expect_ok "a fixture directory lands under the primary .local/xezar-tests/" \
  bash -c '
    set -uo pipefail
    . "$1/lib/common.sh"
    MAIN_ROOT="$2"
    dir="$(fixture_scratch_dir "probe-$$" "infra-tests self check")" || exit 1
    case "$dir" in
      "$MAIN_ROOT"/.local/xezar-tests/probe-*) ;;
      *) echo "landed at $dir"; exit 1 ;;
    esac
    [ -f "$dir/OWNER" ] || { echo "no OWNER marker"; exit 1; }
    grep -q "cleanup is best effort" "$dir/OWNER" || { echo "OWNER does not disclaim guaranteed cleanup"; exit 1; }
    fixture_scratch_remove "$dir"
  ' _ "$SCRIPT_DIR" "$MAIN_ROOT"

# A traversing id must be refused rather than sanitised into something that looks safe.
expect_fail "a traversing fixture id is refused, not cleaned up into a safe-looking one" \
  "not a single safe path segment" \
  bash -c '
    set -uo pipefail
    . "$1/lib/common.sh"
    MAIN_ROOT="$2"
    fixture_scratch_dir "../../escape" "probe"
  ' _ "$SCRIPT_DIR" "$MAIN_ROOT"

# --- Destructive-cleanup safety, proved on a SYNTHETIC victim -----------------------------------
#
# `fixture_scratch_remove` is the one helper that runs `rm -rf`, and it was the one that skipped the
# isolation proof every other helper performs. Its check was a shell PREFIX pattern, `"$root"/?*`,
# and `?*` matches `..` — so `"$root/../../VICTIM"` passed and was deleted, while the function's own
# comment promised a refusal. Every case below runs inside a synthetic tree built for it; no real
# path is ever passed to a destructive call.
syn="$WORK/cleanup-safety"
mkdir -p "$syn/.local/xezar-tests/owned" "$syn/VICTIM"
printf 'do not delete me\n' > "$syn/VICTIM/keep.txt"
printf 'owned\n' > "$syn/.local/xezar-tests/owned/file.txt"
ln -s "$syn/VICTIM" "$syn/.local/xezar-tests/link-out" 2>/dev/null

# The probe's entry code, written ONCE so the assertion below observes the same lines the
# destructive call runs. Anything else would be asserting a copy.
#
# THE DEFECT THIS CLOSES. The subprocess used to inherit the suite's working directory — the real
# checkout — and only its ARGUMENTS were synthetic. A relative target such as `xezar-tests/owned`
# therefore resolved against the real repository. It happened to be harmless because no such path
# exists there, and "the name is absent from the real checkout" is not containment: it is luck that
# changes the moment a directory with that name appears. Containment has to be a property of where
# the process STANDS.
#
# So the probe enters its synthetic sandbox first and FAILS CLOSED if it cannot. The `cd` is scoped
# to this subprocess: the suite itself never changes directory, so nothing else can be redirected.
CLEANUP_PROBE_ENTRY='
  set -uo pipefail
  cd "$2" || { printf "cleanup probe: could not enter the synthetic sandbox %s — refusing to run\n" "$2" >&2; exit 1; }
  . "$1/lib/common.sh"
  MAIN_ROOT="$2"
'
cleanup_probe() {
  bash -c "$CLEANUP_PROBE_ENTRY"'fixture_scratch_remove "$3"' _ "$SCRIPT_DIR" "$syn" "$1"
}
# Same entry, but it reports where it is standing instead of deleting anything.
cleanup_probe_pwd() {
  bash -c "$CLEANUP_PROBE_ENTRY"'pwd -P' _ "$SCRIPT_DIR" "$syn"
}

expect_fail "traversal out of the scratch root is refused BEFORE the removal" \
  "is not under" cleanup_probe "$syn/.local/xezar-tests/../../VICTIM"
[ -f "$syn/VICTIM/keep.txt" ] && ok "and the synthetic victim still exists" \
  || bad "and the synthetic victim still exists" "the traversal deleted it"

expect_fail "an EMPTY path is refused" "refusing an EMPTY path" cleanup_probe ""
expect_fail "a RELATIVE path is refused" "refusing a RELATIVE path" cleanup_probe "xezar-tests/owned"
expect_fail "the scratch ROOT itself is refused — it is shared by every run" \
  "the scratch ROOT itself" cleanup_probe "$syn/.local/xezar-tests"
expect_fail "a symlink escaping the root is refused without following it" \
  "it is a symlink" cleanup_probe "$syn/.local/xezar-tests/link-out"
[ -f "$syn/VICTIM/keep.txt" ] && ok "and the symlink's target was not removed" \
  || bad "and the symlink's target was not removed" "the target was deleted through the link"

# A final `.` or `..` names a directory rather than the target the caller meant, and `<root>/x/..`
# reads as "inside the root" while pointing at its parent. `rm` refuses these itself; refusing them
# here means the one helper that deletes does not lean on an external tool's behaviour.
expect_fail "a final \".\" segment is refused before anything is removed" \
  "names a directory rather than a target" cleanup_probe "$syn/.local/xezar-tests/owned/."
expect_fail "a final \"..\" segment is refused before anything is removed" \
  "names a directory rather than a target" cleanup_probe "$syn/.local/xezar-tests/owned/.."
[ -d "$syn/.local/xezar-tests/owned" ] && ok "and the owned directory was not touched by either" \
  || bad "and the owned directory was not touched by either" "it was removed"

expect_ok "an owned directory inside the root IS removed" cleanup_probe "$syn/.local/xezar-tests/owned"
[ ! -d "$syn/.local/xezar-tests/owned" ] && ok "and it is really gone" \
  || bad "and it is really gone" "the directory survived"
expect_ok "removing it again succeeds — cleanup is idempotent, as a trap handler needs" \
  cleanup_probe "$syn/.local/xezar-tests/owned"

# A sibling of the scratch root — the shape a miscomputed caller path actually takes.
#
# THIS CASE USED TO NAME THE REAL `$MAIN_ROOT/packages`. It passed, because the guard refuses it —
# but a destructive probe must never be aimed at a path whose survival depends on the guard being
# correct. That is the one test that cannot be allowed to fail: if the guard ever regressed, the
# suite itself would delete this repository's source. A negative control for a destructive helper
# belongs on a synthetic victim, exactly like the cases above it, so a regression is reported rather
# than performed. `$syn/packages` is created here for that purpose and nothing else.
mkdir -p "$syn/packages"
printf 'synthetic stand-in for a real source tree\n' > "$syn/packages/keep.txt"
expect_fail "a sibling of the scratch root is refused" \
  "is not under" cleanup_probe "$syn/packages"
[ -f "$syn/packages/keep.txt" ] && ok "and the synthetic stand-in survived the refusal" \
  || bad "and the synthetic stand-in survived the refusal" "the probe deleted it"

# --- The containment invariant, OBSERVED rather than parsed ------------------------------------
#
# This replaces a source-scanning check that inspected each probe's argument text. That check was
# not safety: it permitted any bare relative name, so `packages`, `docs`, `src` and `node_modules`
# all passed it while resolving against the real checkout. A parser that reads what the tests SAY
# cannot establish where a process actually stands.
#
# What is asserted instead is the thing that matters and can be seen: the probe's own working
# directory, reported by the same entry code the destructive call uses.
probe_pwd="$(cleanup_probe_pwd)"
syn_canon="$(cd "$syn" && pwd -P)"
[ -n "$probe_pwd" ] && [ "$probe_pwd" = "$syn_canon" ] \
  && ok "the destructive probe runs INSIDE the synthetic sandbox, not the real checkout" \
  || bad "the destructive probe runs INSIDE the synthetic sandbox, not the real checkout" \
       "probe stood in '${probe_pwd:-<none>}', expected '$syn_canon'"

# And it must fail closed rather than fall back to the inherited directory.
expect_fail "a probe whose sandbox is missing refuses instead of running where it happened to start" \
  "could not enter the synthetic sandbox" \
  bash -c "$CLEANUP_PROBE_ENTRY"'fixture_scratch_remove "$3"' _ "$SCRIPT_DIR" "$syn/no-such-sandbox" "anything"

# Where a RELATIVE name would land. The guard refuses relative paths outright — asserted separately
# below — so this observes the second line of defence: if that refusal ever regressed, the name
# would still resolve inside the sandbox rather than against the real checkout. Resolution only, no
# deletion, using the same entry code the destructive call uses.
mkdir -p "$syn/relative-victim"
resolved_relative="$(bash -c "$CLEANUP_PROBE_ENTRY"'cd "$(dirname "$3")" && printf "%s/%s" "$(pwd -P)" "$(basename "$3")"' \
  _ "$SCRIPT_DIR" "$syn" "relative-victim")"
case "$resolved_relative" in
  "$syn_canon"/*) ok "a RELATIVE probe name resolves inside the sandbox, not against the real checkout" ;;
  *) bad "a RELATIVE probe name resolves inside the sandbox, not against the real checkout" \
       "it resolved to '${resolved_relative:-<none>}'" ;;
esac

# Evidence and fixture scratch are different roots and neither is inside the other.
expect_ok "evidence and fixture scratch are independent paths" \
  bash -c '
    set -uo pipefail
    . "$1/lib/common.sh"
    MAIN_ROOT="$2"
    TASK_ID="aaaaaaaa-0000-4000-8000-000000000001"
    ev="$(task_evidence_dir)"
    fx="$(fixture_scratch_root)"
    case "$ev" in "$fx"/*) echo "evidence is inside the fixture scratch: $ev"; exit 1 ;; esac
    case "$fx" in "$ev"/*) echo "fixture scratch is inside the evidence dir: $fx"; exit 1 ;; esac
    [ "$ev" = "$fx" ] && { echo "they are the same directory"; exit 1; }
    exit 0
  ' _ "$SCRIPT_DIR" "$MAIN_ROOT"

# Sealed evidence survives a reclaimed worktree, which is the reason for the split.
root="$(make_fixture reclaimed)"
wt="$(add_worktree_with_work "$root" "$RUN_A")"
CHECKS="$root/.xezar/checks"
drive "$wt" "$CHECKS" "$LIST_ID" "$REQUIRED_ALL" "${ALL_PASS[@]}" > /dev/null
run_in "$wt" "$CHECKS/worktree-preflight.sh" --record-gate-evidence >/dev/null 2>&1
sealed_head="$(git -C "$wt" rev-parse HEAD)"
git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1
[ -f "$root/.local/xezar-tasks/$RUN_A/manifest.json" ] \
  && ok "the sealed manifest survives the worktree being reclaimed" \
  || bad "the sealed manifest survives the worktree being reclaimed" "manifest gone with the directory"
expect_ok "and its attempt history is still readable afterwards" \
  node "$CHECKS/lib/gate-results.mjs" history \
  --gates-root "$root/.local/xezar-tasks/$RUN_A/gates" --head "$sealed_head"

# Source-specific tooling/document assertions replaced by xezar-contract.test.mjs.
# --- 24b. The integration boundary, DRIVEN against a mocked GitHub ---------------------------------
#
# `integration-preflight.sh` is the only check in this repository whose subject is a REMOTE state,
# so it is the only one that could not otherwise be tested without touching the real GitHub. It
# reaches GitHub through exactly one indirection — `$DOGFOOD_GH` — which exists so this section can
# substitute a stub. Nothing here contacts github.com, and nothing here mutates any real object.
#
# Every case runs with the working directory set to its OWN synthetic repository, never this one:
# the script reads `git remote get-url origin` and the project config from its CWD, so a case run
# from the real checkout would be reading the real repository's identity and proving nothing about
# the fixture it claims to test.
printf '\n-- the integration boundary (mocked GitHub) --\n'

# Synthetic policy exercises the general hosted-check machinery, independently of Xezar's one named CI job.
INTEG="$WORK/integration-fixture.sh"
cp "$SCRIPT_DIR/integration-preflight.sh" "$INTEG"
mkdir -p "$WORK/lib"
cp "$SCRIPT_DIR/lib/common.sh" "$WORK/lib/common.sh"
cp "$SCRIPT_DIR/lib/project-policy.mjs" "$WORK/lib/project-policy.mjs"
node -e 'const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8");s=s.replace(/^PROJECT_CHECKS=.*$/m,"PROJECT_CHECKS=(verify reuse fixture-extra actionlint \"integration / integration\")").replace(/^SKIP_ALLOWED=.*$/m,"SKIP_ALLOWED=(\"integration / integration\")");fs.writeFileSync(p,s)' "$INTEG"
chmod +x "$INTEG"
GOOD_HEAD="1111111111111111111111111111111111111111"
OTHER_HEAD="2222222222222222222222222222222222222222"
BASE_SHA="3333333333333333333333333333333333333333"

# The stub. `gh api <path>` becomes a lookup of a file named after the path. A `.fail` file is an
# API error with its own body and a non-zero exit; a missing file is a 404. That distinction is the
# whole point — "not found" and "could not ask" must never collapse into one answer.
make_gh_stub() {
  local dir="$1"
  mkdir -p "$dir/responses"
  cat > "$dir/gh" <<'STUB'
#!/usr/bin/env bash
# Offline stand-in for `gh`. Serves recorded bodies; never opens a socket.
[ "${1:-}" = "api" ] || { printf 'stub gh: only `api` is implemented, got "%s"\n' "${1:-}" >&2; exit 64; }
path="${2:-}"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/responses"
# The RAW path, query and all, is recorded so a case can assert what was actually asked for. G1
# (#186 review): a stub that silently discards the query cannot tell "the request carried
# `filter=all`" from "the request forgot it and got the whole history anyway".
printf '%s\n' "$path" >> "$dir/requests.log"
# A query string selects a representation of the same resource, not a different one, so it is not
# part of the key. `?per_page=100` (F-A7) must not need its own recorded body.
base="${path%%\?*}"
key="$(printf '%s' "$base" | tr '/' '_')"
# …but `filter` is the one parameter that changes WHICH runs come back. When a case records a
# `.filtered` body, that body is what GitHub's DEFAULT (`filter=latest`) would return, and a request
# that does not ask for `filter=all` receives it. That is how a fixture can prove the query matters.
case "$path" in
  *filter=all*) : ;;
  *) [ -f "$dir/$key.filtered" ] && key="$key.filtered" ;;
esac
if [ -f "$dir/$key.fail" ]; then cat "$dir/$key.fail" >&2; exit 1; fi
if [ -f "$dir/$key" ]; then cat "$dir/$key"; exit 0; fi
printf 'gh: Not Found (HTTP 404)\n' >&2
exit 1
STUB
  chmod +x "$dir/gh"
}

# A fixture repository with an origin remote, plus a fully satisfied set of stub responses. Each
# case then breaks exactly ONE thing, so a refusal can only be caused by what the case changed.
integ_fixture() {
  local name="$1" root
  root="$(make_fixture "integ-$name")" || return 1
  git -C "$root" remote add origin "git@github.com:qodeca/xezar.git"
  local stub="$root/.stub"
  make_gh_stub "$stub"
  local r="$stub/responses"
  printf '{"labels":[],"state":"open","merged":false,"draft":false,"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
    "$GOOD_HEAD" "$BASE_SHA" > "$r/repos_qodeca_xezar_pulls_9"
  printf '{"sha":"%s"}\n' "$BASE_SHA" > "$r/repos_qodeca_xezar_commits_main"
  # F-PROT-01: the legacy endpoint is deliberately ABSENT, so the stub 404s it exactly as the real
  # repository does — while the effective ruleset below says main IS protected.
  # Shaped from the real response for this repository (ruleset 18814916): a `pull_request` rule
  # carrying `required_approving_review_count: 0`, plus the required contexts. F-A6's fixture used
  # to omit the pull_request rule entirely AND seed an approving review, so it agreed with the bug.
  printf '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},
    {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
    > "$r/repos_qodeca_xezar_rules_branches_main"
  # F-A1: these are the names the check-runs API actually returns for this repository, verified
  # against run 34294613991. `integration` is reported as `integration / integration` because a
  # nested/reusable workflow renders as `<caller> / <job>`. A fixture that used the bare job id
  # would agree with the bug rather than catch it.
  # F-A7 (#180): the real endpoint carries `started_at` on every run, so the baseline fixture does
  # too. Several cases below deliberately DROP it to prove the ordering fails closed without it.
  printf '{"total_count":5,"check_runs":[
    {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
    {"name":"reuse","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
    {"name":"fixture-extra","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
    {"name":"actionlint","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
    {"name":"integration / integration","status":"completed","conclusion":"skipped","started_at":"2026-09-10T13:00:00Z"}]}\n' \
    > "$r/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
  # PRODUCTION SHAPE: no GitHub review at all. This workflow is solo, the same account authors
  # every PR, and GitHub forbids approving your own — PRs #118, #119 and #120 all merged with zero
  # reviews. The review that counts is the independent report named in the authority record.
  printf '[]\n' > "$r/repos_qodeca_xezar_pulls_9_reviews"
  printf '[]\n' > "$r/repos_qodeca_xezar_pulls_9_comments"
  # The authority record carries the review that actually applies here: an independent Xezar PASS
  # report plus explicit leader acceptance. That is the route this project uses, and it is why a
  # GitHub approval is not the thing to look for when policy requires none.
  printf 'Authorized: merge PR #9 at %s into main.\nIndependent review: PASS (Xezar report, leader accepted).\n' \
    "$GOOD_HEAD" > "$root/AUTHORITY.md"
  printf '%s' "$root"
}

# Run the preflight with the fixture as the CWD and the fixture's stub as `gh`.
integ_run() {
  local root="$1"; shift
  ( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" \
      --repo qodeca/xezar --pr 9 --base main \
      --expected-head "$GOOD_HEAD" --authority "$root/AUTHORITY.md" "$@" 2>&1 )
}
integ_expect_ok() {
  local label="$1" root="$2"; shift 2
  local out; out="$(integ_run "$root" "$@")"
  if [ $? -eq 0 ]; then ok "$label"; else bad "$label" "expected exit 0"; printf '%s\n' "$out" | tail -12; fi
}
integ_expect_refusal() {
  local label="$1" root="$2" needle="$3"; shift 3
  local out; out="$(integ_run "$root" "$@")"
  if [ $? -eq 0 ]; then
    bad "$label" "expected a refusal, got exit 0"; printf '%s\n' "$out" | tail -12
  elif ! printf '%s' "$out" | grep -qF "$needle"; then
    bad "$label" "refused, but not for [$needle]"; printf '%s\n' "$out" | tail -12
  else ok "$label"; fi
}

# 0. THE POSITIVE CONTROL. Without it, every refusal below could be produced by a script that
#    refuses unconditionally, and the section would prove nothing at all.
root="$(integ_fixture happy)"
integ_expect_ok "a fully satisfied target passes the integration preflight" "$root"

# 1. Missing authority — the case that must read as a PROPOSAL, not as an error to retry past.
root="$(integ_fixture noauth)"; rm -f "$root/AUTHORITY.md"
integ_expect_refusal "a missing authority record refuses" "$root" "authority.missing"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -qi 'proposal' \
  && ok "the missing-authority refusal names it a proposal awaiting a decision" \
  || bad "the missing-authority refusal names it a proposal awaiting a decision" "$out"

# 2. An authority record that exists but does not pin this head is not an authorization.
root="$(integ_fixture authscope)"
printf 'Authorized: merge PR #9 at %s into main.\n' "$OTHER_HEAD" > "$root/AUTHORITY.md"
integ_expect_refusal "an authority record naming a different head refuses" "$root" "authority.head"

# 3. Stale head — the anti-race.
root="$(integ_fixture stalehead)"
printf '{"labels":[],"state":"open","merged":false,"draft":false,"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
  "$OTHER_HEAD" "$BASE_SHA" > "$root/.stub/responses/repos_qodeca_xezar_pulls_9"
integ_expect_refusal "a head that moved since review refuses" "$root" "head.moved"

# 4. No such PR — distinct from an unreachable API (case 7).
root="$(integ_fixture nopr)"; rm -f "$root/.stub/responses/repos_qodeca_xezar_pulls_9"
integ_expect_refusal "a pull request that does not exist refuses" "$root" "pr.missing"

# 5. Moved base. `--expected-head` cannot pin the base, which is exactly why this is its own case.
root="$(integ_fixture movedbase)"
printf '{"sha":"%s"}\n' "$OTHER_HEAD" > "$root/.stub/responses/repos_qodeca_xezar_commits_main"
integ_expect_refusal "a base that moved past the tested combination refuses" "$root" "base.moved"

# 6. Already merged: a completed prior outcome. A retry must not read this as work to redo.
root="$(integ_fixture merged)"
printf '{"state":"closed","merged":true,"draft":false,"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
  "$GOOD_HEAD" "$BASE_SHA" > "$root/.stub/responses/repos_qodeca_xezar_pulls_9"
integ_expect_refusal "an already-merged PR refuses instead of merging twice" "$root" "pr.already-merged"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -qi 'do not retry' \
  && ok "the already-merged refusal tells a retry to stop, so no duplicate merge or comment follows" \
  || bad "the already-merged refusal tells a retry to stop" "$out"

# 7. An API error is UNAVAILABLE, never absence.
root="$(integ_fixture apierror)"
printf 'gh: Internal Server Error (HTTP 500)\n' > "$root/.stub/responses/repos_qodeca_xezar_pulls_9.fail"
integ_expect_refusal "an API failure reports pr.unreadable, not pr.missing" "$root" "pr.unreadable"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'UNAVAILABLE' \
  && ok "an unreadable precondition is reported as UNAVAILABLE and still stops the merge" \
  || bad "an unreadable precondition is reported as UNAVAILABLE" "$out"

# 8. A required check that failed.
root="$(integ_fixture checkfail)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"failure"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a failing required check refuses" "$root" "checks.failed"

# 9. Pending is pending. Rounding it up to a pass is the failure mode.
root="$(integ_fixture pending)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"in_progress","conclusion":null},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a pending required check refuses rather than rounding up to a pass" "$root" "checks.pending"

# 10. THE PROJECT CONTRACT IS WIDER THAN THE BRANCH RULE. The ruleset enforces verify + reuse only;
#     a green pair does not waive fixture-extra. This is the distinction F-PROT-01's follow-up names.
root="$(integ_fixture branchsubset)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"failure"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "passing only the branch-enforced subset does not waive the project's checks" \
  "$root" "fixture-extra"

# 10a. F-A1 (2026-09-09 review). The canonical list carried the bare job id `integration` while the
#      API reports `integration / integration`. The happy fixture above is the positive control for
#      the corrected name — it passes only because the list now matches what GitHub returns.
#
#      The direction of the original bug was a FALSE REFUSAL: a check that had passed was reported
#      absent, blocking integration on a green build. It was never a false pass, and nothing here
#      claims it was a security hole.
root="$(integ_fixture realname-absent)"
printf '{"total_count":4,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "the real check name missing entirely still refuses" "$root" "checks.absent"

root="$(integ_fixture realname-success)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration / integration","status":"completed","conclusion":"success"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_ok "the real check name concluding success is accepted" "$root"

root="$(integ_fixture realname-failure)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration / integration","status":"completed","conclusion":"failure"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "the real check name concluding failure refuses" "$root" "checks.failed"

# The bare job id must NOT satisfy the requirement. This is the guard against "fixing" F-A1 by
# loosening the comparison: substring matching would accept this, and would also let `verify` be
# satisfied by some future `verify-something-else`. Exact names only.
root="$(integ_fixture realname-bare-id)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration","status":"completed","conclusion":"success"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "the bare job id does not satisfy the real check name" "$root" "checks.absent"

# A skip is permitted for the credential-gated check and for nothing else.
root="$(integ_fixture disallowed-skip)"
printf '{"total_count":5,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"skipped"},
  {"name":"reuse","status":"completed","conclusion":"success"},
  {"name":"fixture-extra","status":"completed","conclusion":"success"},
  {"name":"actionlint","status":"completed","conclusion":"success"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a check that is not permitted to skip refuses when it skips" "$root" "checks.skipped"

# And the permitted skip is reported as its own word, never folded into "all green".
root="$(integ_fixture skip-reported)"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'SKIPPED (credential-gated' \
  && ok "the credential-gated skip is reported as a skip, not as a pass" \
  || bad "the credential-gated skip is reported as a skip" "$out"

# 10a2. F-A7 (2026-09-10, #180). SEVERAL RUNS OF ONE NAME ON ONE COMMIT.
#
# `gh run rerun` creates a NEW check run instead of mutating the old one, and one SHA reachable from
# two refs gets an independent run per ref — so a required name routinely has two or three runs with
# different outcomes. The shipped code read the FIRST one the API returned and stopped, and the
# endpoint documents no ordering, so an older `success` could answer for a newer `failure`. That is
# a FALSE PASS, the direction this whole file exists to prevent.
#
# Every fixture below puts the run that the OLD code would have picked FIRST in the array, because a
# case whose array order agrees with the fix proves nothing about the bug.
#
# `verify` is the name under test throughout; the other four stay green so a refusal can only come
# from what the case changed.
# `total_count` is computed rather than written, so a case that adds a run cannot leave a stale count
# behind and get refused for truncation instead of for the thing it is testing. Parsing here also
# means a malformed case body fails loudly in the fixture rather than quietly inside the script.
integ_verify_runs() { # <fixture root> <JSON for the `verify` runs, comma-separated> [.filtered suffix]
  node -e '
    const fs = require("fs");
    const list = JSON.parse("[" + process.argv[2] + `,
      {"name":"reuse","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
      {"name":"fixture-extra","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
      {"name":"actionlint","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
      {"name":"integration / integration","status":"completed","conclusion":"skipped","started_at":"2026-09-10T13:00:00Z"}]`);
    // Every real run carries an id and an app; a case that does not care about either gets the same
    // GitHub Actions app id this repository actually reports (15368) and a stable synthetic id, so
    // the cross-provider refusal (G3) fires only for the cases that deliberately mix sources.
    list.forEach((r, i) => {
      if (r.id === undefined) r.id = 500000000 + i;
      if (r.app === undefined) r.app = { id: 15368 };
      if (r.app === null) delete r.app;
    });
    fs.writeFileSync(process.argv[1], JSON.stringify({ total_count: list.length, check_runs: list }) + "\n");
  ' "$1/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs${3:-}" "$2" \
    || bad "fixture body for $1" "integ_verify_runs could not build the check-runs JSON"
}

# THE BUG ITSELF. An older green listed first, a newer red second. Merging on this is exactly what
# #180 reports, and the old `$1==n{print; exit}` read the green and passed.
#
# G2 (#186 review): the refusal has to name WHICH run failed, so this case carries real-shaped ids
# and asserts the deciding id — a count of alternatives is not an identity, and an operator
# diagnosing a red gate should not have to reconstruct the selection by hand.
root="$(integ_fixture dup-older-green-masks-newer-red)"
integ_verify_runs "$root" '
  {"id":102890959295,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:11:54Z",
   "html_url":"https://github.com/qodeca/xezar/actions/runs/34481135370/job/102890959295"},
  {"id":102887870384,"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z",
   "html_url":"https://github.com/qodeca/xezar/actions/runs/34481135370/job/102887870384"}'
integ_expect_refusal "an older green does not mask a newer red run of the same name" "$root" "checks.failed"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'newest of 2 runs' \
  && ok "the refusal says the verdict came from the newest of several runs of that name" \
  || bad "the refusal names the run it read" "$out"
printf '%s' "$out" | grep -q 'run 102887870384 started 2026-09-10T13:23:14Z' \
  && ok "the refusal names the deciding run id and its start, not just how many there were" \
  || bad "the refusal names the deciding run id and its start" "$out"
printf '%s' "$out" | grep -qF 'job/102887870384' \
  && ok "the refusal carries a link to the run an operator has to open" \
  || bad "the refusal carries the deciding run URL" "$out"
# …and it must name the RED one, not merely some id. A refusal quoting the green run would send the
# operator to a page that shows a pass.
printf '%s' "$out" | grep -q 'run 102890959295' \
  && bad "the refusal points at the failing run, not the superseded green one" "$out" \
  || ok "the refusal points at the failing run, not the superseded green one"

# The same obligation on the other two refusal shapes: pending and ambiguous must be locatable too.
root="$(integ_fixture identity-pending)"
integ_verify_runs "$root" '
  {"id":102893493207,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:32:07Z"},
  {"id":102895908183,"name":"verify","status":"in_progress","conclusion":null,"started_at":"2026-09-10T13:46:03Z"}'
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'run 102895908183 started 2026-09-10T13:46:03Z is in_progress' \
  && ok "a pending refusal names the run that has not finished" \
  || bad "a pending refusal names the unfinished run" "$out"

root="$(integ_fixture identity-tie)"
integ_verify_runs "$root" '
  {"id":102893493207,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"},
  {"id":102895908183,"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:39:16Z"}'
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'run 102893493207 .* concluded success' \
  && printf '%s' "$out" | grep -q 'run 102895908183 .* concluded failure' \
  && ok "an ambiguous tie names both tied runs and what each concluded" \
  || bad "an ambiguous tie names both tied runs" "$out"

# A pass says which run it read too. Silence about the selection is what let #180 hide for so long.
root="$(integ_fixture identity-success)"
integ_verify_runs "$root" '
  {"id":102887870384,"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z"},
  {"id":102895908183,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:46:03Z"}'
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'check verify: success (newest of 2 runs of that name) — run 102895908183' \
  && ok "a passing check names the run that certified it and says it superseded another" \
  || bad "a passing check names the run that certified it" "$out"

# The other direction, and the reason "every run must be green" was rejected: a re-run after a real
# failure is a workflow this project uses (#177), and it has to be able to clear the gate.
root="$(integ_fixture dup-newer-green-supersedes-red)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"}'
integ_expect_ok "a newer green re-run supersedes an older red run of the same name" "$root"

# Two greens are still green. A guard: it passes with and without the fix, and exists so a future
# "all runs must be green" rewrite does not quietly land as the same shape.
root="$(integ_fixture dup-both-green)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:11:54Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"}'
integ_expect_ok "two successful runs of one name still pass" "$root"

# An unfinished run of a name is `pending` even when a finished green run of the same name exists,
# and even when the green one is listed first. `in_progress` is what commit 46553b91 actually had.
root="$(integ_fixture dup-green-then-in-progress)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:32:07Z"},
  {"name":"verify","status":"in_progress","conclusion":null,"started_at":"2026-09-10T13:39:16Z"}'
integ_expect_refusal "a green run does not answer for an unfinished run of the same name" "$root" "checks.pending"

# …including when the unfinished run is the OLDER one. It can still go red, and waiting is a
# refusal that clears by itself.
root="$(integ_fixture dup-older-in-progress)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"},
  {"name":"verify","status":"queued","conclusion":null,"started_at":"2026-09-10T13:11:54Z"}'
integ_expect_refusal "an older unfinished run still holds the name pending" "$root" "checks.pending"

# THE REAL COMMIT. `46553b9151f9e916a219e38534b0085b07608642` as #180 recorded it: three runs of one
# name — an older failure, a later success, and one still in flight — listed newest-first, which is
# the order that endpoint happened to return. Pending, because a run is unfinished.
root="$(integ_fixture dup-real-46553b91)"
integ_verify_runs "$root" '
  {"name":"verify","status":"in_progress","conclusion":null,"started_at":"2026-09-10T13:39:16Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:32:07Z"},
  {"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z"}'
integ_expect_refusal "the real three-run commit from #180 refuses while a run is in flight" "$root" "checks.pending"

# …and once that in-flight run finishes green, the same commit merges. Two greens newer than one
# red is precisely the re-run workflow, and it must not be a permanent block.
root="$(integ_fixture dup-real-46553b91-settled)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:32:07Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"}'
integ_expect_ok "the same commit passes once every run of that name has finished green" "$root"

# --- and the four ways the ordering has to fail CLOSED --------------------------------------------
#
# Without a readable order there is no "newest", so there is no answer — and no answer is a refusal.
root="$(integ_fixture dup-missing-timestamp)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success"},
  {"name":"verify","status":"completed","conclusion":"failure"}'
integ_expect_refusal "two runs with no started_at refuse instead of picking one" "$root" "checks.ambiguous"

root="$(integ_fixture dup-unparseable-timestamp)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success","started_at":"not-a-date"},
  {"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z"}'
integ_expect_refusal "an unparseable started_at refuses instead of sorting around it" "$root" "checks.ambiguous"

# A tie only matters when it changes the answer, so a tie whose runs DISAGREE refuses…
root="$(integ_fixture dup-tie-disagree)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"},
  {"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:39:16Z"}'
integ_expect_refusal "two runs tied as newest with different outcomes refuse" "$root" "checks.ambiguous"

# …while a tie whose runs agree is decided, because no order could change it. This is the line that
# keeps the fail-closed rule from becoming a second false refusal.
root="$(integ_fixture dup-tie-agree)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:39:16Z"}'
integ_expect_ok "two runs tied as newest that agree are not ambiguous" "$root"

# A single run needs no order at all, so it is read without a timestamp — the baseline behaviour
# this change must not have broken.
root="$(integ_fixture single-no-timestamp)"
integ_verify_runs "$root" '
  {"name":"verify","status":"completed","conclusion":"success"}'
integ_expect_ok "one run of a name is read without needing a started_at" "$root"

# A body whose shape is not what the API documents is UNREADABLE, and must not be reported as
# `absent` — absent claims the response was read and named no such run.
root="$(integ_fixture checkruns-malformed)"
printf '{"check_runs":"not-a-list"}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "an unexpected check-runs shape reports unreadable, not absent" "$root" "checks.unreadable"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'UNAVAILABLE' \
  && ok "an unreadable check list is UNAVAILABLE rather than a named refusal" \
  || bad "an unreadable check list is UNAVAILABLE" "$out"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'checks.absent' \
  && bad "an unreadable check list is not reported as absent" "$out" \
  || ok "an unreadable check list is not reported as absent"

# A run whose name is not a string is the same class of surprise. `total_count` is correct here, so
# the case can only be refused for the name.
root="$(integ_fixture checkruns-bad-name)"
printf '{"total_count":1,"check_runs":[{"name":123,"status":"completed","conclusion":"success"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a check run with a non-string name reports unreadable" "$root" "checks.unreadable"

# PAGINATION. The check-runs endpoint pages; a single request returns one page. Under "newest wins"
# a run left on page two is not a missing detail — it may BE the newest run, and what stayed behind
# is an older one that may be green. `total_count` is what the endpoint says exists, and a response
# carrying fewer runs than that has not been read.
root="$(integ_fixture checkruns-truncated)"
printf '{"total_count":9,"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:11:54Z"},
  {"name":"reuse","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"fixture-extra","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"actionlint","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped","started_at":"2026-09-10T13:00:00Z"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a check-runs page that is missing runs the endpoint reports refuses" "$root" "checks.unreadable"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'did not all fit in one page' \
  && ok "the truncated-page refusal says the newest run may not have been read" \
  || bad "the truncated-page refusal names pagination" "$out"

# …and a body that does not say how many runs exist cannot be shown to be complete either.
root="$(integ_fixture checkruns-no-total)"
printf '{"check_runs":[
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:11:54Z"},
  {"name":"reuse","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"fixture-extra","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"actionlint","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped","started_at":"2026-09-10T13:00:00Z"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a check-runs body with no total_count refuses rather than assuming it is whole" "$root" "checks.unreadable"

# The query string is a representation of the same resource, so the stub answers `?per_page=100`
# from the recorded body — which is only true because the happy fixture still passes above. This
# case pins the reason directly: a stub that keyed on the query would 404 and report UNAVAILABLE.
root="$(integ_fixture checkruns-per-page)"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'could not read check runs' \
  && bad "the paged request still reaches the recorded check-runs body" "$out" \
  || ok "the paged request still reaches the recorded check-runs body"

# --- G1 (#186 review): THE REQUEST IS PART OF THE POLICY -------------------------------------------
#
# The endpoint's DEFAULT is `filter=latest`, which reduces the set by COMPLETION time and by check
# suite — a different rule from "every run, ordered by started_at". Measured on the real commit
# `46553b91…`: the default answers 6 runs and `filter=all` answers 10. A response already narrowed
# by someone else cannot evidence a policy about all of them.
#
# This is the case the previous round could not have: the stub now serves a `.filtered` body to any
# request that does not ask for `filter=all`, so the fixture tests the QUERY and not merely that a
# request arrived somewhere. The two bodies are built to disagree in the one direction that matters
# — the hidden run is NEWER by `started_at` and RED, which is exactly the mismatch between ordering
# by completion and ordering by start.
root="$(integ_fixture filter-all-required)"
# The whole history: a green that started early and a red that started later.
integ_verify_runs "$root" '
  {"id":102883935449,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"id":102887870384,"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:20:00Z"}'
# What a default (`filter=latest`) request sees: the red one is gone, because it COMPLETED first.
integ_verify_runs "$root" '
  {"id":102883935449,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"}' \
  ".filtered"
integ_expect_refusal "a required check is judged on the whole history, not the default filtered view" \
  "$root" "checks.failed"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'run 102887870384' \
  && ok "the run the default filter hides is the one the refusal names" \
  || bad "the hidden run is the one the refusal names" "$out"
# And the request itself is asserted, so a future edit cannot drop the parameter and stay green on
# fixtures that happen to record only one body.
grep -q 'check-runs?filter=all&per_page=100' "$root/.stub/responses/requests.log" \
  && ok "the check-runs request explicitly asks for filter=all and per_page=100" \
  || bad "the check-runs request asks for filter=all" "$(cat "$root/.stub/responses/requests.log" 2>&1)"

# The control for that mechanism: the stub really does serve a different body when `filter=all` is
# missing. Without this, the case above could pass because the `.filtered` body was never used.
root="$(integ_fixture filter-stub-control)"
integ_verify_runs "$root" '
  {"id":1,"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:20:00Z"}'
integ_verify_runs "$root" '
  {"id":2,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"}' \
  ".filtered"
out="$( cd "$root" && "$root/.stub/gh" api "repos/qodeca/xezar/commits/${GOOD_HEAD}/check-runs?per_page=100" )"
printf '%s' "$out" | grep -q '"conclusion":"success"' \
  && ok "the stub serves the narrowed body to a request that omits filter=all" \
  || bad "the stub serves the narrowed body without filter=all" "$out"
out="$( cd "$root" && "$root/.stub/gh" api "repos/qodeca/xezar/commits/${GOOD_HEAD}/check-runs?filter=all&per_page=100" )"
printf '%s' "$out" | grep -q '"conclusion":"failure"' \
  && ok "the stub serves the whole history to a request that asks for filter=all" \
  || bad "the stub serves the whole history with filter=all" "$out"

# --- G3 (#186 review): EQUAL NAMES FROM DIFFERENT SOURCES ------------------------------------------
#
# Grouping keys on the display name, and GitHub can pin an expected APP per required context while
# this script reads only names. Under newest-wins a newer green from an unrelated app would then
# certify the required provider's red. No such collision has been observed on this repository —
# every run is app 15368 — so the bounded correction is to refuse the group rather than to build a
# policy engine or to claim an equivalence the script cannot deliver.
root="$(integ_fixture provider-mixed)"
integ_verify_runs "$root" '
  {"id":701,"app":{"id":15368},"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:00:00Z"},
  {"id":702,"app":{"id":99999},"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:20:00Z"}'
integ_expect_refusal "a newer green from a different app cannot certify another app's failure" \
  "$root" "checks.ambiguous"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'run 701 .* from app 15368' \
  && printf '%s' "$out" | grep -q 'run 702 .* from app 99999' \
  && ok "the cross-provider refusal names both runs and the app each came from" \
  || bad "the cross-provider refusal names the apps" "$out"

# A run whose source cannot be read at all is the same answer, for the same reason.
root="$(integ_fixture provider-unreadable)"
integ_verify_runs "$root" '
  {"id":703,"app":null,"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:00:00Z"},
  {"id":704,"app":{"id":15368},"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:20:00Z"}'
integ_expect_refusal "a run with no readable source makes the group undecidable" "$root" "checks.ambiguous"

# The control: one app across the group decides normally, so the refusal above is caused by the
# mixture and not by the check existing. Every fixture in this section relies on that.
root="$(integ_fixture provider-single-source)"
integ_verify_runs "$root" '
  {"id":705,"app":{"id":15368},"name":"verify","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:00:00Z"},
  {"id":706,"app":{"id":15368},"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:20:00Z"}'
integ_expect_ok "two runs from the same app are decided by the newest as usual" "$root"

# A single run is never a cross-provider question, so it needs no app at all — the same reasoning
# that lets one run be read without a started_at.
root="$(integ_fixture provider-single-run)"
integ_verify_runs "$root" '
  {"id":707,"app":null,"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"}'
integ_expect_ok "one run of a name is read without needing a readable source" "$root"

# --- G-OTHER (#186 review): a delimiter inside a field must not forge a verdict ---------------------
#
# The resolved record is tab-separated, so a `conclusion` of "success<TAB>…" would be read back as
# `success` by `cut -f3`. Real conclusions are an enum, so this can only ever be an unexpected shape.
#
# The tab is written ESCAPED (`\\t` reaches the file as the two characters `\t`), which is the only
# way to express it: a raw tab inside a JSON string is invalid JSON, so `JSON.parse` would reject the
# body before any field was read and the case would pass for the wrong reason.
root="$(integ_fixture conclusion-delimiter)"
printf '{"total_count":1,"check_runs":[{"id":1,"app":{"id":15368},"name":"verify","status":"completed","conclusion":"success\\tforged","started_at":"2026-09-10T13:00:00Z"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).check_runs[0].conclusion;
  process.exit(c === "success\tforged" ? 0 : 1)' \
  "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs" \
  && ok "the delimiter fixture is valid JSON carrying a real tab, so it tests the field and not the parser" \
  || bad "the delimiter fixture parses to a conclusion containing a tab" "see the recorded body"
integ_expect_refusal "a conclusion carrying a tab is an unexpected shape, not a success" "$root" "checks.unreadable"

# Count metadata that cannot be true is refused in both directions, not only when it is too large.
root="$(integ_fixture count-impossible)"
printf '{"total_count":0,"check_runs":[{"id":1,"app":{"id":15368},"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a total_count smaller than the runs returned is refused as unreadable" "$root" "checks.unreadable"

# THE SECOND COPY OF THE SAME DEFECT, in the same file: a context the BRANCH RULES enforce that the
# project list does not name was resolved by the identical first-match-wins lookup. `external-gate`
# is added to the ruleset here so that branch of the code is actually reached — the standard fixture
# enforces only names PROJECT_CHECKS already covers, so it never runs.
root="$(integ_fixture branch-required-dup)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"external-gate"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '{"total_count":7,"check_runs":[
  {"id":60000001,"app":{"id":15368},"name":"external-gate","status":"completed","conclusion":"success","started_at":"2026-09-10T13:11:54Z"},
  {"id":60000002,"app":{"id":15368},"name":"external-gate","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:23:14Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"reuse","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"fixture-extra","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"actionlint","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped","started_at":"2026-09-10T13:00:00Z"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_refusal "a branch-enforced context is judged by its newest run too" "$root" "checks.branch-required"

# The positive control for that path, so the case above cannot be passing because the branch-rule
# branch refuses everything it sees.
root="$(integ_fixture branch-required-dup-ok)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"external-gate"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '{"total_count":7,"check_runs":[
  {"id":60000003,"app":{"id":15368},"name":"external-gate","status":"completed","conclusion":"failure","started_at":"2026-09-10T13:11:54Z"},
  {"id":60000004,"app":{"id":15368},"name":"external-gate","status":"completed","conclusion":"success","started_at":"2026-09-10T13:23:14Z"},
  {"name":"verify","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"reuse","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"fixture-extra","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"actionlint","status":"completed","conclusion":"success","started_at":"2026-09-10T13:00:00Z"},
  {"name":"integration / integration","status":"completed","conclusion":"skipped","started_at":"2026-09-10T13:00:00Z"}]}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_commits_${GOOD_HEAD}_check-runs"
integ_expect_ok "a branch-enforced context whose newest run is green passes" "$root"

# 10b. N-A2/N-A3 (2026-09-09 review). --issue is a plain number, and closure keywords are the ones
#      people actually write.
root="$(integ_fixture issue-malformed)"
out="$( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" --repo qodeca/xezar --pr 9 \
        --base main --expected-head "$GOOD_HEAD" --authority "$root/AUTHORITY.md" --issue "12abc3" 2>&1 )"
printf '%s' "$out" | grep -q 'args.issue' \
  && ok "an --issue value that merely ends in a digit refuses" \
  || bad "an --issue value that merely ends in a digit refuses" "$out"
out="$( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" --repo qodeca/xezar --pr 9 \
        --base main --expected-head "$GOOD_HEAD" --authority "$root/AUTHORITY.md" --issue '.*' 2>&1 )"
printf '%s' "$out" | grep -q 'args.issue' \
  && ok "a regex wildcard as --issue refuses instead of reaching a pattern" \
  || bad "a regex wildcard as --issue refuses" "$out"

# Capitalised "Closes #116" is the spelling people write, and it authorized closure all along.
root="$(integ_fixture issue-closes-case)"
printf 'Authorized: merge PR #9 at %s into main. Closes #116.\n' "$GOOD_HEAD" > "$root/AUTHORITY.md"
integ_expect_ok "a capitalised \"Closes #116\" in the record authorizes that closure" "$root" --issue 116
# …but only for the issue it names.
integ_expect_refusal "closure of a DIFFERENT issue is still refused" "$root" "authority.issue" --issue 117
# …and a record with no closure wording authorizes none.
root="$(integ_fixture issue-no-authority)"
integ_expect_refusal "a record that says nothing about closure authorizes none" "$root" "authority.issue" --issue 116
# Passing no --issue closes nothing and must stay ordinary — this campaign's PRs are Relates-only.
integ_expect_ok "omitting --issue closes nothing and is the ordinary supported case" "$root"

# 11. F-PROT-01 ITSELF. The legacy protection endpoint 404s in the happy fixture and the target
#     still passes, because effective rules are what is read. The 404 must be reported as saying
#     nothing — if it were ever read as "unprotected", this line is where that would show.
root="$(integ_fixture protection404)"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'says NOTHING about protection' \
  && ok "a legacy protection 404 is reported as saying nothing, not as 'unprotected' (F-PROT-01)" \
  || bad "a legacy protection 404 is reported as saying nothing" "$out"
printf '%s' "$out" | grep -q 'effective branch rules require' \
  && ok "the effective ruleset is what the required contexts are read from" \
  || bad "the effective ruleset is what the required contexts are read from" "$out"

# 12. A permission failure on the effective rules is UNAVAILABLE — not "no rules", which would turn
#     a missing scope into a licence to merge.
root="$(integ_fixture rulesperm)"
printf 'gh: Must have admin rights to Repository. (HTTP 403)\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main.fail"
integ_expect_refusal "a permission failure reading branch rules is unavailable, never 'none'" \
  "$root" "rules.permission"

# 13. Review state, DERIVED FROM POLICY (F-A6, 2026-09-09 review).
#
# The happy fixture above is the positive control: effective policy requires 0 approving reviews,
# the PR has none, and it PASSES. The previous version of this section asserted the opposite — it
# required an approval unconditionally — which made every normal pull request in this workflow
# unmergeable. That is what F-A6 reported, and this block is what stops it recurring.
#
# The repair is not a waiver, and the cases below are what prove that: where policy requires
# approvals they are enforced, and unreadable policy is never read as zero.

# Policy requires 2, none present -> refused.
root="$(integ_fixture reviews-required-insufficient)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":2}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
integ_expect_refusal "policy requiring approvals is enforced when none are present" "$root" "review.insufficient"

# Policy requires 2, one present -> still refused. A partial count is not a satisfied count.
root="$(integ_fixture reviews-required-partial)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":2}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '[{"user":{"login":"r1"},"state":"APPROVED","commit_id":"%s"}]\n' "$GOOD_HEAD" \
  > "$root/.stub/responses/repos_qodeca_xezar_pulls_9_reviews"
integ_expect_refusal "one approval does not satisfy a policy requiring two" "$root" "review.insufficient"

# Policy requires 2, two present at the expected head -> accepted.
root="$(integ_fixture reviews-required-satisfied)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":2}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '[{"user":{"login":"r1"},"state":"APPROVED","commit_id":"%s"},
  {"user":{"login":"r2"},"state":"APPROVED","commit_id":"%s"}]\n' "$GOOD_HEAD" "$GOOD_HEAD" \
  > "$root/.stub/responses/repos_qodeca_xezar_pulls_9_reviews"
integ_expect_ok "a satisfied approval requirement is accepted" "$root"

# STALE. An approval given on an earlier commit is not an approval of the revision being merged.
root="$(integ_fixture reviews-stale)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '[{"user":{"login":"r1"},"state":"APPROVED","commit_id":"%s"}]\n' "$OTHER_HEAD" \
  > "$root/.stub/responses/repos_qodeca_xezar_pulls_9_reviews"
integ_expect_refusal "an approval of an earlier commit does not count for this head" "$root" "review.stale"

# DISMISSED counts as neither an approval nor an objection — the stale-approval bug in another form.
root="$(integ_fixture reviews-dismissed)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '[{"user":{"login":"r1"},"state":"APPROVED","commit_id":"%s"},
  {"user":{"login":"r1"},"state":"DISMISSED","commit_id":"%s"}]\n' "$GOOD_HEAD" "$GOOD_HEAD" \
  > "$root/.stub/responses/repos_qodeca_xezar_pulls_9_reviews"
integ_expect_refusal "a dismissed review no longer approves" "$root" "review.insufficient"

# COMMENTED must not overwrite a reviewer's approving state.
root="$(integ_fixture reviews-commented)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
printf '[{"user":{"login":"r1"},"state":"APPROVED","commit_id":"%s"},
  {"user":{"login":"r1"},"state":"COMMENTED","commit_id":"%s"}]\n' "$GOOD_HEAD" "$GOOD_HEAD" \
  > "$root/.stub/responses/repos_qodeca_xezar_pulls_9_reviews"
integ_expect_ok "a later COMMENTED review does not cancel an approval" "$root"

# THE STRICTEST APPLICABLE RULE WINS. Two pull_request rules can apply to one branch; taking the
# first or the last read would silently drop the stricter requirement.
root="$(integ_fixture reviews-two-rules)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},
  {"type":"pull_request","parameters":{"required_approving_review_count":2}},
  {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"reuse"}]}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
integ_expect_refusal "the strictest of several applicable rules is the one enforced" "$root" "review.insufficient"

# The legacy endpoint, when it IS present, is applicable policy and must not be ignored.
root="$(integ_fixture reviews-legacy-strict)"
printf '{"required_pull_request_reviews":{"required_approving_review_count":1}}\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_branches_main_protection"
integ_expect_refusal "a stricter legacy protection policy is honoured when the endpoint exists" \
  "$root" "review.insufficient"

# UNAVAILABLE POLICY IS NOT ZERO. This is the line between "derive the requirement" and "assume the
# permissive answer", and it is the one that would turn a missing scope into a licence to merge.
root="$(integ_fixture reviews-policy-unavailable)"
printf 'gh: Must have admin rights to Repository. (HTTP 403)\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main.fail"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'review.policy-unknown' \
  && ok "an unreadable review policy is UNKNOWN, never zero" \
  || bad "an unreadable review policy is UNKNOWN, never zero" "$out"
printf '%s' "$out" | grep -q 'UNAVAILABLE' \
  && ok "and the run stops as INCOMPLETE rather than passing" \
  || bad "the run stops as INCOMPLETE rather than passing" "$out"

# Malformed policy is also not zero: a pull_request rule whose count cannot be read is unknown.
root="$(integ_fixture reviews-policy-malformed)"
printf '[{"type":"pull_request","parameters":{"required_approving_review_count":"two"}}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_rules_branches_main"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -q 'rules.malformed' \
  && ok "an unparseable review count is malformed, not zero" \
  || bad "an unparseable review count is malformed, not zero" "$out"

# A changes-requested review blocks at ANY required count, including zero: policy sets a floor on
# approvals, it never turns an outstanding objection into a non-event.
root="$(integ_fixture changesreq)"
printf '[{"user":{"login":"r1"},"state":"APPROVED"},{"user":{"login":"r2"},"state":"CHANGES_REQUESTED"}]\n' \
  > "$root/.stub/responses/repos_qodeca_xezar_pulls_9_reviews"
integ_expect_refusal "an outstanding changes-requested review refuses" "$root" "review.changes-requested"

# 14. A draft PR. Marking it ready is a separate authorized act, not a step to take here.
root="$(integ_fixture draft)"
printf '{"labels":[],"state":"open","merged":false,"draft":true,"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
  "$GOOD_HEAD" "$BASE_SHA" > "$root/.stub/responses/repos_qodeca_xezar_pulls_9"
integ_expect_refusal "a draft PR refuses" "$root" "pr.draft"

# 15. Targets are never guessed, and `main` is never a base here.
root="$(integ_fixture args)"
out="$( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" --pr 9 --base main \
        --expected-head "$GOOD_HEAD" --authority "$root/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'args.repo' \
  && ok "an omitted --repo refuses instead of inferring a repository" \
  || bad "an omitted --repo refuses" "$out"
out="$( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" --repo qodeca/xezar --pr 9 \
        --base main --expected-head "1111111" --authority "$root/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'args.expected-head' \
  && ok "an abbreviated head SHA refuses; only a full 40-character identity is accepted" \
  || bad "an abbreviated head SHA refuses" "$out"
out="$( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" --repo qodeca/xezar --pr 9 \
        --base release --expected-head "$GOOD_HEAD" --authority "$root/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'base.forbidden' \
  && ok "merging into a nonconfigured branch refuses; releases are the user's alone" \
  || bad "merging into a nonconfigured branch refuses" "$out"
out="$( cd "$root" && DOGFOOD_GH="$root/.stub/gh" "$INTEG" --repo someone/else --pr 9 --base main \
        --expected-head "$GOOD_HEAD" --authority "$root/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'repo.mismatch' \
  && ok "a --repo that is not this checkout's origin refuses" \
  || bad "a --repo that is not this checkout's origin refuses" "$out"

# 16. Issue closure is a separate grant. An authority record that merges but says nothing about an
#     issue must not be read as authorizing its closure.
root="$(integ_fixture issueclose)"
integ_expect_refusal "closing an issue the record does not name refuses" "$root" "authority.issue" --issue 116
printf 'Authorized: merge PR #9 at %s into main, and closes #116.\n' "$GOOD_HEAD" > "$root/AUTHORITY.md"
integ_expect_ok "an explicitly authorized issue closure is accepted" "$root" --issue 116

# 17. THE STATED LIMIT. A pass must not read as permission — the one sentence that keeps this
#     script a source of facts rather than a source of authority.
root="$(integ_fixture limits)"
out="$(integ_run "$root")"
printf '%s' "$out" | grep -qi 'not permission' \
  && ok "a passing verdict states that it is an observation and not permission" \
  || bad "a passing verdict states that it is not permission" "$out"
printf '%s' "$out" | grep -qi 'Authority is carried, never verified' \
  && ok "the verdict says authority is carried, never verified here" \
  || bad "the verdict says authority is carried, never verified here" "$out"

# 18. The skill's own refusals, as written. These are prose assertions and are labelled as such:
#     they prove the rule is STATED, never that a run obeyed it.
# Project guidance/BA/stage contracts are validated by xezar-contract.test.mjs.
# --- 24c. The root-sync boundary, DRIVEN on synthetic roots ----------------------------------------
#
# `root-sync-preflight.sh` is the gate on the one Worktree OFF assignment in this repository, so its
# subject is a REAL primary checkout. Every case below therefore builds its OWN synthetic "primary"
# under the fixture scratch and points the script at that. **Nothing here targets, reads as, or
# mutates the actual primary checkout** — a negative control that proved a guard by aiming it at the
# real root would be the accident, not the evidence.
#
# What is NOT claimed: none of this proves Xezar's in-memory manager lease. No script an agent runs
# can read or acquire it, and a flag an agent writes would prove only that it wrote a flag. Lease
# acquisition is qualified by engine-level fixtures and launch topology (migration M2's real
# RunManager evidence, still valid while the pinned runtime is unchanged). What is proved here is
# the checkable half: the topologies that certainly hold NO lease are refused.
printf '\n-- the root-sync boundary (synthetic roots) --\n'

RSP="$SCRIPT_DIR/root-sync-preflight.sh"

# A synthetic "primary checkout" with a main branch, an authorized target one commit ahead, and
# an authority record naming that target.
rootsync_fixture() {
  local name="$1" root
  root="$(make_fixture "rootsync-$name")" || return 1
  # A target commit that IS a descendant of main, created on a side branch so main can be
  # fast-forwarded onto it exactly as the real assignment would.
  git -C "$root" -c user.email=t@t -c user.name=t checkout -q -b upstream
  printf 'export const seed = 9;\n' > "$root/seed.ts"
  git -C "$root" -c user.email=t@t -c user.name=t commit -qam "upstream advance"
  git -C "$root" -c user.email=t@t -c user.name=t checkout -q main
  printf '%s' "$root"
}
rootsync_target() { git -C "$1" rev-parse upstream; }
# The record goes where the real one goes: the ignored `.local/` evidence area. Writing it into
# the tracked tree would leave the root dirty, which the check correctly refuses — the first draft
# of this fixture did exactly that and was caught by its own positive control.
rootsync_authorize() {
  mkdir -p "$1/.local"
  printf 'Authorized: fast-forward main to %s in the primary checkout.\n' "$2" > "$1/.local/AUTHORITY.md"
}
# A legitimate Worktree OFF launch carries a bound run id, so the default helper supplies one. The
# unset/empty/malformed identities are their OWN cases (N-A4) and set the variable themselves.
rootsync_run() {
  local root="$1"; shift
  ( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
      --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" "$@" 2>&1 )
}

# 0. THE POSITIVE CONTROL. Without it every refusal below could come from a script that refuses
#    unconditionally, and the section would prove nothing.
root="$(rootsync_fixture happy)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$(rootsync_run "$root")"; rc=$?
[ "$rc" -eq 0 ] && ok "a clean synthetic root with a fast-forwardable authorized target passes" \
  || { bad "a clean synthetic root with a fast-forwardable authorized target passes" "exit $rc"; printf '%s\n' "$out" | tail -12; }
# And it must refuse to overclaim: the lease disclaimer is part of the passing output.
printf '%s' "$out" | grep -q 'DOES NOT PROVE THE MANAGER LEASE' \
  && ok "the passing verdict states it does not prove the manager lease" \
  || bad "the passing verdict states it does not prove the manager lease" "$out"
printf '%s' "$out" | grep -qi 'Authority is carried, never verified' \
  && ok "the root-sync verdict says authority is carried, never verified" \
  || bad "the root-sync verdict says authority is carried, never verified" "$out"

# 1. THE RULE THAT MATTERS MOST. A linked worktree of the synthetic root must be refused, even
#    though every other argument is correct — which is what stops a Worktree ON run from "reaching"
#    the root by moving into it.
root="$(rootsync_fixture worktree)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
wt="$(add_worktree "$root" "$RUN_A")"
out="$( cd "$wt" && "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'launch.worktree' \
  && ok "a run executing in a linked worktree is refused" \
  || bad "a run executing in a linked worktree is refused" "$out"
printf '%s' "$out" | grep -qi 'cannot acquire one by changing its working directory' \
  && ok "the refusal explains that moving is not acquiring a lease" \
  || bad "the refusal explains that moving is not acquiring a lease" "$out"

# 2. The resume fallback: a run id at the ROOT whose own worktree directory still exists. That run
#    is standing at the root without being the root assignment.
root="$(rootsync_fixture fallback)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
mkdir -p "$root/.local/xezar/worktrees/$RUN_A"
out="$( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'launch.fallback' \
  && ok "a resumed run that fell back to the root is refused" \
  || bad "a resumed run that fell back to the root is refused" "$out"
# The same run id WITHOUT a worktree directory is the legitimate Worktree OFF shape and must pass.
rm -rf "$root/.local/xezar/worktrees/$RUN_A"
out="$( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
rc=$?
[ "$rc" -eq 0 ] && ok "the same run id with no worktree directory is accepted as a Worktree OFF launch" \
  || { bad "the same run id with no worktree directory is accepted" "exit $rc"; printf '%s\n' "$out" | tail -8; }
printf '%s' "$out" | grep -qi 'not proof of a lease' \
  && ok "and that acceptance is explicitly labelled as not proof of a lease" \
  || bad "that acceptance is labelled as not proof of a lease" "$out"

# 2b. N-A4 (2026-09-09 review). The fallback test needs a run id to ask its question against, and
#     when the id was missing the block was skipped SILENTLY — the script could still print OK,
#     folding an unasked question into a pass. An unobserved precondition is not a satisfied one.
root="$(rootsync_fixture identity-unset)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$( cd "$root" && unset XEZ_TASK_ID && "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
rc=$?
[ "$rc" -ne 0 ] && ok "an unset run id refuses rather than passing on an unasked question" \
  || { bad "an unset run id refuses" "exit 0 with the identity check skipped"; printf '%s\n' "$out" | tail -8; }
printf '%s' "$out" | grep -q 'identity.unbound' \
  && ok "the unset-identity refusal names its own predicate" \
  || bad "the unset-identity refusal names its own predicate" "$out"
printf '%s' "$out" | grep -qi 'INCOMPLETE, not passed' \
  && ok "the unset-identity refusal calls the check INCOMPLETE rather than failed or passed" \
  || bad "the unset-identity refusal calls the check INCOMPLETE" "$out"

root="$(rootsync_fixture identity-empty)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$( cd "$root" && XEZ_TASK_ID="" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'identity.unbound' \
  && ok "an empty run id is treated as unset, not as satisfied" \
  || bad "an empty run id is treated as unset" "$out"

root="$(rootsync_fixture identity-malformed)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$( cd "$root" && XEZ_TASK_ID="not-a-run-id" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'identity.malformed' \
  && ok "a malformed run id refuses; the fallback question cannot be evaluated against it" \
  || bad "a malformed run id refuses" "$out"

# THE POSITIVE HALF. A valid bound identity with no worktree directory is the legitimate launch and
# must still pass — the repair must not make a correct root assignment unusable.
root="$(rootsync_fixture identity-valid)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
rc=$?
[ "$rc" -eq 0 ] && ok "a valid bound run id with no worktree directory still passes" \
  || { bad "a valid bound run id still passes" "exit $rc"; printf '%s\n' "$out" | tail -8; }
printf '%s' "$out" | grep -q 'NOT proof of a lease' \
  && ok "and that acceptance is still labelled as not proof of a lease" \
  || bad "that acceptance is labelled as not proof of a lease" "$out"

# N-A5: the header must not assert that standing at the root proves the lease.
grep -qi 'holds that manager.s in-memory root lease \*because it actually runs there\*' "$RSP" \
  && bad "the header no longer claims that running at the root proves the lease" \
       "the contradictory claim is back in $RSP" \
  || ok "the header no longer claims that running at the root proves the lease"
grep -qi 'CONSEQUENCE of a' "$RSP" \
  && ok "the header keeps the honest distinction between launch topology and lease acquisition" \
  || bad "the header keeps the honest distinction" "the corrected wording is missing from $RSP"

# 3. Disabled locking removes the serialization the assignment depends on.
root="$(rootsync_fixture nolock)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$( cd "$root" && XEZ_DISABLE_REPO_LOCK=1 "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$(rootsync_target "$root")" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'lease.locking-disabled' \
  && ok "a run with repository locking disabled is refused" \
  || bad "a run with repository locking disabled is refused" "$out"

# 4. Wrong root: the run is in one synthetic checkout and names another.
rootA="$(rootsync_fixture wrongA)"; rootB="$(rootsync_fixture wrongB)"
rootsync_authorize "$rootA" "$(rootsync_target "$rootA")"
out="$( cd "$rootA" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$rootB" --expected-branch main \
        --expected-target "$(rootsync_target "$rootA")" --authority "$rootA/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'root.identity' \
  && ok "a run whose location is not the named root is refused" \
  || bad "a run whose location is not the named root is refused" "$out"

# 5. Dirty target. Synchronization never carries someone's uncommitted work along.
root="$(rootsync_fixture dirty)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
printf 'export const seed = 99;\n' > "$root/seed.ts"
out="$(rootsync_run "$root")"
printf '%s' "$out" | grep -q 'root.dirty' \
  && ok "a dirty root is refused" || bad "a dirty root is refused" "$out"

# 6. Wrong branch.
root="$(rootsync_fixture branch)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
git -C "$root" -c user.email=t@t -c user.name=t checkout -q -b sidetrack
out="$(rootsync_run "$root")"
printf '%s' "$out" | grep -q 'root.branch' \
  && ok "a root on an unexpected branch is refused" || bad "a root on an unexpected branch is refused" "$out"

# 7. NOT A FAST-FORWARD. This is the one that would rewrite the root's history, so it must never
#    be reachable. A divergent commit is built on a branch that is not a descendant of main.
root="$(rootsync_fixture diverged)"
git -C "$root" -c user.email=t@t -c user.name=t checkout -q -b sideline main
printf 'export const seed = 77;\n' > "$root/seed.ts"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "divergent"
divergent="$(git -C "$root" rev-parse sideline)"
git -C "$root" -c user.email=t@t -c user.name=t checkout -q main
printf 'export const seed = 78;\n' > "$root/seed.ts"
git -C "$root" -c user.email=t@t -c user.name=t commit -qam "main advances too"
rootsync_authorize "$root" "$divergent"
out="$( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "$divergent" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'target.not-fast-forward' \
  && ok "a target that is not a descendant of the root's HEAD is refused" \
  || bad "a target that is not a descendant of the root's HEAD is refused" "$out"

# 8. Authority: missing, and present but naming a different target.
root="$(rootsync_fixture noauth)"
out="$(rootsync_run "$root")"
printf '%s' "$out" | grep -q 'authority.missing' \
  && ok "a missing root-sync authority record is refused" || bad "a missing root-sync authority record is refused" "$out"
printf '%s' "$out" | grep -qi 'proposal' \
  && ok "the missing root-sync authority is named a proposal awaiting a decision" \
  || bad "the missing root-sync authority is named a proposal" "$out"
root="$(rootsync_fixture authscope)"
rootsync_authorize "$root" "0000000000000000000000000000000000000000"
out="$(rootsync_run "$root")"
printf '%s' "$out" | grep -q 'authority.target' \
  && ok "an authority record naming a different target is refused" \
  || bad "an authority record naming a different target is refused" "$out"

# 9. Targets are fixed in advance, never chosen during the run.
root="$(rootsync_fixture args)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
out="$( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
        --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'args.expected-target' \
  && ok "an omitted --expected-target refuses; the target is fixed before the run" \
  || bad "an omitted --expected-target refuses" "$out"
out="$( cd "$root" && XEZ_TASK_ID="$RUN_A" "$RSP" --expected-root "$root" --expected-branch main \
        --expected-target "abc1234" --authority "$root/.local/AUTHORITY.md" 2>&1 )"
printf '%s' "$out" | grep -q 'args.expected-target' \
  && ok "an abbreviated target SHA refuses" || bad "an abbreviated target SHA refuses" "$out"

# 10. The script is read-only. Driving every case above must not have moved any synthetic root.
root="$(rootsync_fixture readonly)"; rootsync_authorize "$root" "$(rootsync_target "$root")"
before_head="$(git -C "$root" rev-parse HEAD)"
before_status="$(git -C "$root" status --porcelain | sort)"
rootsync_run "$root" >/dev/null 2>&1
[ "$(git -C "$root" rev-parse HEAD)" = "$before_head" ] \
  && ok "the root-sync preflight moves no branch pointer" \
  || bad "the root-sync preflight moves no branch pointer" "HEAD moved during a read-only check"
[ "$(git -C "$root" status --porcelain | sort)" = "$before_status" ] \
  && ok "the root-sync preflight leaves the working tree untouched" \
  || bad "the root-sync preflight leaves the working tree untouched" "the check mutated the tree"

# 11. The workflow must stay launchable. A `command:` step before the agent would run the preflight
#     before the agent exists — and the preflight needs an authority record the agent is the one to
#     establish. That ordering is unlaunchable: it refuses every time for a prerequisite that cannot
#     be met before it runs. This is the pre-agent-manifest trap, asserted so it cannot come back.
# Root workflow shape and local guidance are validated by the real project loader tests.
# --- 25. The suite did not touch the real repository --------------------------------------------------
#
# THE BACKSTOP. Every case above builds its own throwaway repository, and the whole point is that
# none of it reaches the checkout the suite is running in. That was an assumption until a fixture
# path arrived empty: `git -C ""` does not fail, it stays where it is, and a RELATIVE worktree path
# then resolved against the task's own worktree. The result was a real worktree of the PRIMARY
# repository, on a real `xez/<id8>` branch, sitting inside the task tree — which knip then scanned,
# failing a gate for a reason that had nothing to do with any code under review.
#
# The guards in `make_fixture`, `add_worktree` and `run_in` make that specific path impossible.
# This asserts the OUTCOME instead, so a future variation of the same mistake is caught here rather
# than by a confused gate three steps later.
printf '\n-- the suite left the real repository alone --\n'

# --- The guards, which are the actual prevention ------------------------------------------------
# Each is the exact input that caused the incident, or a variant of it. They run before the
# invariant below because prevention is the protection; the invariant is only the proof.
expect_fail "an EMPTY fixture root is refused rather than aimed at the current checkout" \
  "refusing an EMPTY" add_worktree "" "$RUN_A"
expect_fail "a RELATIVE fixture root is refused — it would resolve against the CWD" \
  "refusing a RELATIVE" add_worktree ".local/xezar/worktrees" "$RUN_A"
expect_fail "a fixture root outside this run's scratch is refused" \
  "outside this run" add_worktree "$MAIN_ROOT" "$RUN_A"
mkdir -p "$WORK/not-a-repo"
expect_fail "a non-repository fixture root is refused — every git -C there walks up to the real repo" \
  "is not a repository" add_worktree "$WORK/not-a-repo" "$RUN_A"
expect_fail "an empty run_in directory is refused rather than run in the real checkout" \
  "an empty or missing directory means the real checkout" run_in "" true

# The decisive guard: whatever the path looked like, the REPOSITORY it resolves to must not be this
# project's. Containment in the scratch already refuses `$REPO_ROOT` outright, so that rule is
# widened for this one probe — in a subshell, changing nothing — to leave the common-directory
# comparison as the only rule that can still refuse it. Read-only: it inspects, it never mutates.
common_dir_probe() (
  # A subshell, so widening the containment rule here cannot escape into the real run.
  WORK_CANON="$(dirname "$REPO_ROOT")"
  assert_isolated_fixture_root "$REPO_ROOT" "probe"
)
expect_fail "a path resolving to the REAL repository is refused by the common-directory rule" \
  "resolves to the REAL repository" common_dir_probe

# --- The invariant: this RUN changed nothing ----------------------------------------------------
#
# Not "the repository contains no fixture-shaped ref" — a fixture branch from the earlier incident
# is deliberately PRESERVED, and demanding its absence would be demanding that history be erased.
# The question is whether THIS run moved anything.
AFTER_FIXTURE_REFS="$(fixture_ref_snapshot "$MAIN_ROOT")"
AFTER_FIXTURE_REGS="$(fixture_registration_snapshot "$MAIN_ROOT")"
AFTER_NESTED="$(nested_worktree_snapshot "$REPO_ROOT")"

# Disclose the footprint that was already there. Carried, named, and not counted as this run's.
if [ -n "$BASELINE_FIXTURE_REFS" ]; then
  printf '  note pre-existing fixture-namespace refs, preserved and NOT created by this run:\n'
  printf '%s\n' "$BASELINE_FIXTURE_REFS" | sed 's/^/         /'
else
  printf '  note the fixture ref namespace was empty before this run\n'
fi

ref_delta="$(snapshot_delta "$BASELINE_FIXTURE_REFS" "$AFTER_FIXTURE_REFS")"
[ -z "$ref_delta" ] \
  && ok "this run created, moved and deleted no ref in the fixture namespace" \
  || bad "this run created, moved and deleted no ref in the fixture namespace" \
       "$(printf '%s' "$ref_delta" | tr '\n' ' ')"

reg_delta="$(snapshot_delta "$BASELINE_FIXTURE_REGS" "$AFTER_FIXTURE_REGS")"
[ -z "$reg_delta" ] \
  && ok "this run added and removed no worktree registration in the real repository" \
  || bad "this run added and removed no worktree registration in the real repository" \
       "$(printf '%s' "$reg_delta" | tr '\n' ' ')"

nested_delta="$(snapshot_delta "$BASELINE_NESTED" "$AFTER_NESTED")"
[ -z "$nested_delta" ] \
  && ok "the running checkout gained and lost no nested worktree" \
  || bad "the running checkout gained and lost no nested worktree" \
       "$(printf '%s' "$nested_delta" | tr '\n' ' ')"

# An ACTIVE nested fixture checkout is never acceptable, baseline or not: it is a second checkout of
# this project inside the task tree, which knip scans and which breaks gates for unrelated reasons.
# This is the one assertion that does not tolerate a pre-existing value.
active_fixture=""
for id in "$RUN_A" "$RUN_B"; do
  [ -d "$REPO_ROOT/.local/xezar/worktrees/$id" ] && [ -e "$MAIN_ROOT/.git/worktrees/$id" ] &&
    active_fixture="$active_fixture $id"
done
[ -z "$active_fixture" ] \
  && ok "no fixture worktree is live inside the running checkout" \
  || bad "no fixture worktree is live inside the running checkout" \
       "active:$active_fixture — a nested checkout of the real repo, registered and on disk"

# --- Negative cases, in SYNTHETIC OUTER repositories --------------------------------------------
#
# The comparator has to be shown catching a leak, and the only honest way to show that is to create
# one — so it is created in a throwaway repository built for the purpose. The real project is never
# deliberately mutated to test a check that exists to stop it being mutated.
printf '\n-- the leak detector, proved against synthetic leaks --\n'

outer="$WORK/outer-repo"
mkdir -p "$outer"
git init -q -b main "$outer"
printf 'seed\n' > "$outer/seed.txt"
git -C "$outer" -c user.email=t@t -c user.name=t add -A
git -C "$outer" -c user.email=t@t -c user.name=t commit -q -m "outer init"

# A branch in the fixture namespace that is PRESERVED history: present before and after, unchanged.
git -C "$outer" branch -q "xez/$FIXTURE_ID8_A" main
outer_before_refs="$(fixture_ref_snapshot "$outer")"
outer_before_regs="$(fixture_registration_snapshot "$outer")"

[ -n "$outer_before_refs" ] \
  && ok "a preserved historical fixture branch is VISIBLE in the baseline" \
  || bad "a preserved historical fixture branch is VISIBLE in the baseline" "baseline was empty"
[ -z "$(snapshot_delta "$outer_before_refs" "$(fixture_ref_snapshot "$outer")")" ] \
  && ok "and an unchanged preserved branch is NOT reported as a new leak" \
  || bad "and an unchanged preserved branch is NOT reported as a new leak" "reported a delta with nothing changed"

# 1. A NEW ref in the fixture namespace.
git -C "$outer" branch -q "xez/$FIXTURE_ID8_B" main
delta="$(snapshot_delta "$outer_before_refs" "$(fixture_ref_snapshot "$outer")")"
printf '%s' "$delta" | grep -q "xez/$FIXTURE_ID8_B" \
  && ok "a NEW fixture ref is caught" \
  || bad "a NEW fixture ref is caught" "delta was: $delta"

# 2. A MOVED ref — same name, different commit. The name-only check would have missed this.
printf 'moved\n' > "$outer/seed.txt"
git -C "$outer" -c user.email=t@t -c user.name=t commit -qam "second"
git -C "$outer" branch -qf "xez/$FIXTURE_ID8_B" main
delta="$(snapshot_delta "$outer_before_refs" "$(fixture_ref_snapshot "$outer")")"
[ -n "$delta" ] && ok "a MOVED fixture ref is caught, because the snapshot carries the SHA" \
  || bad "a MOVED fixture ref is caught, because the snapshot carries the SHA" "no delta reported"

# 3. A DELETED ref.
after_two="$(fixture_ref_snapshot "$outer")"
git -C "$outer" branch -qD "xez/$FIXTURE_ID8_B"
delta="$(snapshot_delta "$after_two" "$(fixture_ref_snapshot "$outer")")"
printf '%s' "$delta" | grep -q '^<' \
  && ok "a DELETED fixture ref is caught" \
  || bad "a DELETED fixture ref is caught" "delta was: $delta"

# 4. A NEW worktree registration.
git -C "$outer" worktree add -q -b "xez/$FIXTURE_ID8_B" "$outer/wt-$RUN_B" main 2>/dev/null
mkdir -p "$outer/.git/worktrees/$RUN_B" 2>/dev/null
delta="$(snapshot_delta "$outer_before_regs" "$(fixture_registration_snapshot "$outer")")"
printf '%s' "$delta" | grep -q "$RUN_B" \
  && ok "a NEW worktree registration is caught" \
  || bad "a NEW worktree registration is caught" "delta was: $delta"

# 5. Scope. Another agent legitimately advancing an UNRELATED branch must not fail this suite, and
#    must not need a global lock to avoid doing so.
scope_before="$(fixture_ref_snapshot "$outer")"
git -C "$outer" branch -q "xez/deadbeef" main
# An unrelated branch ADVANCING, which is what a concurrent agent actually does.
printf 'concurrent\n' > "$outer/other.txt"
# Only the one file: `add -A` would pick up the nested worktree directory created above and warn
# about an embedded repository, which is noise rather than a finding.
git -C "$outer" -c user.email=t@t -c user.name=t add other.txt
git -C "$outer" -c user.email=t@t -c user.name=t commit -q -m "concurrent work"
git -C "$outer" branch -qf "xez/deadbeef" HEAD
[ -z "$(snapshot_delta "$scope_before" "$(fixture_ref_snapshot "$outer")")" ] \
  && ok "an unrelated branch and an advancing main are invisible to the fixture-scoped check" \
  || bad "an unrelated branch and an advancing main are invisible to the fixture-scoped check" \
       "a concurrent agent would fail this suite"

# Run the maintained actual-repository checks once. They never invoke this suite.
expect_ok "Actual repository catalog, changelog and contracts" bash "$SCRIPT_DIR/repository-checks.sh"

expect_ok "Parallel gate ordering, evidence and owned cancellation" node --test "$SCRIPT_DIR/gate-parallel.test.mjs"

# --- Verdict ---------------------------------------------------------------------------------------------
printf '\n================ INFRA TESTS ================\n'
printf 'passed %d, failed %d\n' "$pass" "$fail"
if [ "$fail" -eq 0 ]; then
  printf 'ALL INFRA TESTS PASSED\n'
  exit 0
fi
printf 'FAILED:\n'
printf '  - %s\n' "${failures[@]}"
exit 1
