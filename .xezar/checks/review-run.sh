#!/usr/bin/env bash
# The only way a review or QA step runs the change it judges (DECISIONS.md, D13).
#
# A review step (code-review, security-review, architecture-review, qa, design-review,
# acceptance-verification) holds no Edit and no Write, and its `bashAllowlist` is the kit's reading
# set plus this script. So it may RUN the pull request – check its head out in this run's own
# worktree, install, run the tests and the build, start a dev server – but it has no git or gh
# command that commits, pushes, resets or moves to another branch. Running a PR's code means
# running whatever that code does, so the allowlist is not the boundary; the boundary is the check
# before the verdict: `verdict-write.sh` runs `finish`, which fails when the worktree's tracked
# files or its HEAD differ from the head that was reviewed, and then the verdict is refused. Build caches, installed dependencies and
# gitignored output do not count.
#
# Usage:
#   review-run.sh checkout <pr-number>        check the PR's head out, detached, in THIS worktree,
#                                             and record it as the reviewed head (once per run)
#   review-run.sh install                     install dependencies here (deps-restore.sh)
#   review-run.sh run <program> [<args>…]     run one project command here, in the foreground
#   review-run.sh start <name> <program> […]  start one long-running command (a dev server) in the
#                                             background; its log is <evidence>/review/<name>.log
#   review-run.sh stop [<name>]               stop one started command, or all of them
#   review-run.sh verify-unchanged            exit 0 only when the tracked tree equals the
#                                             reviewed head (below); prints review-tree=<status>
#   review-run.sh finish                      stop everything started, then verify-unchanged –
#                                             verdict-write.sh runs this before a packet
#
# Which copy runs. A checkout replaces the tracked `.xezar/checks/` with the PR head's own copies:
# old ones, missing ones, or ones the PR changed. So a review step never runs a kit script from
# there. The kit step copies the primary checkout's scripts to `.local/xezar/cache/kit/checks/`
# (outside the tracked tree), and a review step's `bashAllowlist` names only those copies, this
# script included: `bash .local/xezar/cache/kit/checks/review-run.sh`. Everything it calls in turn
# (`deps-restore.sh`, `lib/common.sh`) is beside it. Git overwrites an ignored file on checkout, so
# a head that tracks a file under `.local/xezar/cache/kit/` is refused: the checkout is undone and
# the copies are made again from the primary checkout.
#
# The reviewed head: the one `checkout` recorded; without a checkout, HEAD must be the run's own
# branch with no commit of its own (an ancestor of the base branch, local or origin).
#
# Refused as <program>: git and gh (their writing subcommands are exactly what a reviewer may not
# run – read through git-read.sh and gh pr view/diff instead), sudo/su, and every shell or wrapper
# that would run another program unseen (bash, sh, zsh, dash, env, eval, exec, xargs, nohup,
# command, timeout, nice, and the Windows shells and launchers cmd, powershell, pwsh, wsl, winpty,
# git-bash, start, mintty, git-cmd, refused on every OS) – any case, either path separator, with or
# without .exe/.cmd/.bat/.com; a short 8.3 name is refused. Never
# the project's main checkout: this script refuses to run there.
#
# The name list is a courtesy, not the boundary: `node -e`, `python3 -c`, `make`, a test suite or
# an npm lifecycle script can start git or gh all the same. So what `install`, `run` and `start`
# start gets NO git or gh credentials: GH_TOKEN and GITHUB_TOKEN (and the enterprise pair) are set
# to a value GitHub refuses, GH_CONFIG_DIR is an empty directory, git's credential helpers are
# reset, askpass and terminal prompts fail, SSH has no agent and no ssh command. A git or gh the
# child starts therefore cannot push, merge or label. What it does NOT stop: the child is still
# arbitrary code with the operator's user rights, so a program written to do it can read a
# credential store (the keychain, ~/.config/gh) directly. That residue is accepted in D13.
#
# The reviewed head is recorded in <evidence>/review/head, which a child can rewrite as well. So
# verify-unchanged also asks GitHub – with this script's own credentials, which the child never
# had – whether the recorded head is a commit of the recorded pull request. A head the review made
# up locally is not, and is refused; so is a checkout whose head record was removed.
#
# A sandbox that cannot write git. A checkout writes the worktree's own git directory and the
# primary checkout's shared one (objects, refs), and both live outside the task worktree. A backend
# that confines a reading step to the worktree plus the run's own folders – engine 0.19.0 runs a
# Codex step with no Edit and no Write in `workspace-write` with exactly those writable roots –
# cannot write them, so `checkout` probes both first and, when either is closed, exits 3 with
# `review-run=confined` instead of failing half-way. Nothing of the PR can run in that step: judge
# from the diff and report every check that needed running as not run (an evidence limit).
#
# Exit: the command's own status for `run`; 0 ok, 1 refused or changed, 2 usage, 3 confined
# (`checkout` only: this step's sandbox cannot write git, so the PR cannot be checked out here).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

refuse() {
  echo "review-run.sh: refused: $*" >&2
  exit 1
}

usage() {
  echo "usage: review-run.sh checkout <pr> | install | run <program> [<args>…] | start <name> <program> [<args>…] | stop [<name>] | verify-unchanged | finish" >&2
  exit 2
}

[ $# -ge 1 ] || usage
sub="$1"
shift

resolve_task_paths || refuse "cannot resolve this checkout"
[ "$IS_WORKTREE" -eq 1 ] || refuse "this is the project's main checkout; a review runs code only in its own task worktree"
evidence="$(task_evidence_dir)" || refuse "no run identity for this worktree, so there is nowhere to record the reviewed head"
state="$evidence/review"
mkdir -p "$state" || refuse "cannot create $state"
cd "$TASK_CWD" || exit 1

REFUSED_PROGRAMS="git gh sudo su bash sh zsh dash ksh fish env eval exec xargs nohup command timeout nice cmd powershell pwsh wsl winpty git-bash start mintty git-cmd"

check_program() {
  local program="${1:-}" base
  [ -n "$program" ] || usage
  # One spelling per program on every OS: a backslash is a path separator (Windows), case is
  # folded (Windows and a case-insensitive macOS volume), and a Windows program extension is
  # dropped, so `C:\...\BASH.EXE` is `bash`. `\134` is the backslash, in octal (#122).
  base="$(printf '%s' "$program" | LC_ALL=C tr '\134A-Z' '/a-z')"
  base="${base##*/}"
  case "$base" in *.exe | *.cmd | *.bat | *.com) base="${base%.*}" ;; esac
  [ -n "$base" ] || refuse "\"$program\" names no program"
  case "$base" in *~[0-9]*) refuse "\"$program\" is a short (8.3) name; name the program in full" ;; esac
  case " $REFUSED_PROGRAMS " in *" $base "*) refuse "\"$base\" is not a command a review step runs (see the header of review-run.sh)" ;; esac
}

valid_name() {
  printf '%s' "${1:-}" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$' || refuse "\"${1:-}\" is not a name (lower-case letters, digits and -)"
}

# Withhold git and gh credentials from every command this script starts for the review.
no_credentials() {
  local empty="$state/no-credentials"
  mkdir -p "$empty/gh" || refuse "cannot create $empty"
  export GH_TOKEN="xezar-review-has-no-credentials" GITHUB_TOKEN="xezar-review-has-no-credentials"
  export GH_ENTERPRISE_TOKEN="xezar-review-has-no-credentials" GITHUB_ENTERPRISE_TOKEN="xezar-review-has-no-credentials"
  export GH_CONFIG_DIR="$empty/gh" GH_PROMPT_DISABLED=1
  export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false SSH_ASKPASS_REQUIRE=never GCM_INTERACTIVE=never
  export GIT_SSH_COMMAND=false GIT_SSH=false
  # An empty credential.helper, set from the environment, clears every helper the system, global
  # and repository config list (the macOS keychain, the git credential manager).
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
  unset SSH_AUTH_SOCK
}

tracked_changes() {
  git status --porcelain --untracked-files=no 2>/dev/null
}

stop_one() {
  local pidfile="$1" pid
  pid="$(cat "$pidfile" 2>/dev/null)" || return 0
  if printf '%s' "$pid" | grep -Eq '^[1-9][0-9]*$' && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$pidfile"
}

verify_unchanged() {
  local head recorded changes pr known
  head="$(git rev-parse HEAD 2>/dev/null)" || { echo "review-tree=fail"; echo "review-run.sh: HEAD cannot be read" >&2; return 1; }
  if [ -f "$state/head" ]; then
    recorded="$(cat "$state/head")"
    if [ "$head" != "$recorded" ]; then
      echo "review-tree=fail"
      echo "review-run.sh: HEAD is $head, and the reviewed head was $recorded – the review moved or committed" >&2
      return 1
    fi
    pr="$(cat "$state/pr" 2>/dev/null)"
    known=""
    printf '%s' "$pr" | grep -Eq '^[1-9][0-9]{0,9}$' &&
      known="$(gh pr view "$pr" --json headRefOid,commits --jq '.headRefOid, .commits[].oid' 2>/dev/null)"
    if ! printf '%s\n' "$known" | grep -Fqx -- "$recorded"; then
      echo "review-tree=fail"
      echo "review-run.sh: the recorded head $recorded is not a commit of PR #${pr:-?} on GitHub – the head record was rewritten, or GitHub could not be asked" >&2
      return 1
    fi
  elif [ -f "$state/pr" ]; then
    echo "review-tree=fail"
    echo "review-run.sh: PR #$(cat "$state/pr") was checked out and its head record is gone – the review removed it" >&2
    return 1
  else
    if ! git merge-base --is-ancestor HEAD "refs/heads/$BASE_BRANCH" 2>/dev/null &&
       ! git merge-base --is-ancestor HEAD "refs/remotes/origin/$BASE_BRANCH" 2>/dev/null; then
      echo "review-tree=fail"
      echo "review-run.sh: HEAD $head has commits the base branch does not, and no head was checked out for review – the review committed" >&2
      return 1
    fi
  fi
  changes="$(tracked_changes)"
  if [ -n "$changes" ]; then
    echo "review-tree=fail"
    printf 'review-run.sh: the review changed tracked files:\n%s\n' "$changes" >&2
    return 1
  fi
  echo "review-tree=unchanged head=$head"
}

case "$sub" in
  checkout)
    [ $# -eq 1 ] || usage
    printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,9}$' || refuse "\"$1\" is not a PR number"
    [ -f "$state/head" ] && refuse "this run already reviews $(cat "$state/head"); one reviewed head per run"
    [ -z "$(tracked_changes)" ] || refuse "the worktree has tracked changes before the checkout"
    for gitdir in "$(git rev-parse --absolute-git-dir 2>/dev/null)" "$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)"; do
      probe=""
      [ -n "$gitdir" ] && probe="$(mktemp "$gitdir/xezar-review-probe.XXXXXX" 2>/dev/null)"
      if [ -z "$probe" ]; then
        echo "review-run=confined"
        echo "review-run.sh: this step cannot write ${gitdir:-the git directory}, which a checkout needs – its sandbox confines it to the worktree and the run's own folders (a Codex step with no Edit and no Write, engine 0.19.0). The PR cannot be checked out or run here: judge from the diff, and report every check that needed running as not run." >&2
        exit 3
      fi
      rm -f "$probe"
    done
    before="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse HEAD)" || exit 1
    gh pr checkout "$1" --detach || refuse "gh pr checkout $1 --detach failed"
    if [ -n "$(git ls-files -- .local/xezar/cache/kit | head -1)" ]; then
      git checkout --quiet "$before" 2>/dev/null || echo "review-run.sh: could not return to $before" >&2
      trusted="$TASK_CWD/.local/xezar/cache/kit/checks"
      rm -rf "$trusted" && mkdir -p "$trusted" && cp -Rp "$MAIN_ROOT/.xezar/checks/." "$trusted/" ||
        echo "review-run.sh: the review's own scripts could not be copied again from $MAIN_ROOT/.xezar/checks" >&2
      refuse "PR #$1 tracks files under .local/xezar/cache/kit/, where this review's own scripts live, so its checkout replaced them; the checkout was undone and the scripts copied again from the primary checkout. Judge this PR from the diff and say that nothing of it could run"
    fi
    head="$(git rev-parse HEAD)" || exit 1
    want="$(gh pr view "$1" --json headRefOid --jq .headRefOid 2>/dev/null)" || want=""
    [ "$head" = "$want" ] || refuse "checked out $head, and the PR's head is ${want:-unknown}"
    printf '%s\n' "$head" >"$state/head"
    printf '%s\n' "$1" >"$state/pr"
    echo "review-head=$head pr=$1"
    ;;
  install)
    [ $# -eq 0 ] || usage
    no_credentials
    bash "$SCRIPT_DIR/deps-restore.sh"
    ;;
  run)
    check_program "${1:-}"
    no_credentials
    "$@"
    ;;
  start)
    [ $# -ge 2 ] || usage
    valid_name "$1"
    name="$1"
    shift
    check_program "$1"
    if [ -f "$state/$name.pid" ] && kill -0 "$(cat "$state/$name.pid")" 2>/dev/null; then
      refuse "\"$name\" is already running"
    fi
    no_credentials
    nohup "$@" >"$state/$name.log" 2>&1 </dev/null &
    printf '%s\n' "$!" >"$state/$name.pid"
    echo "review-started=$name pid=$! log=$state/$name.log"
    ;;
  stop)
    [ $# -le 1 ] || usage
    if [ $# -eq 1 ]; then
      valid_name "$1"
      stop_one "$state/$1.pid"
    else
      for pidfile in "$state"/*.pid; do [ -e "$pidfile" ] && stop_one "$pidfile"; done
    fi
    ;;
  verify-unchanged)
    [ $# -eq 0 ] || usage
    verify_unchanged
    ;;
  finish)
    [ $# -eq 0 ] || usage
    for pidfile in "$state"/*.pid; do [ -e "$pidfile" ] && stop_one "$pidfile"; done
    verify_unchanged
    ;;
  *) usage ;;
esac
