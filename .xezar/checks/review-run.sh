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
#   review-run.sh prepare                     the workflow check step before the agent (#160): checkout
#                                             $XEZ_PR_NUMBER, or print review-run=no-pr and exit 0 when the
#                                             run names no PR. A later `checkout` of the same PR at the same
#                                             head confirms it ("already checked out")
#   review-run.sh install                     install dependencies here (deps-restore.sh)
#   review-run.sh run <program> [<args>…]     run one project command here, in the foreground
#                                             with no stdin; after 300 s (XEZ_REVIEW_RUN_SECONDS) it is
#                                             stopped with all it started: review-run=timeout, exit 124 (#172)
#   review-run.sh start <name> [--port <n>] <program> […]
#                                             start one long-running command (a dev server) in the
#                                             background; its log is <evidence>/review/<name>.log
#                                             `prepare` and `start` first stop what an ended run's
#                                             `start` left running (#166; stop_ended_runs below).
#                                             With --port: refused when the port is already in use,
#                                             exports PORT=<n> to the command (#226), then waits
#                                             until the command listens there (#217, below)
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
# `checkout` records its outcome in <evidence>/review/checkout – `ok exit=0 …` or `confined exit=3 …` –
# and verdict-write.sh refuses a verdict that claims `review-run=confined` without a `confined`
# record, so a review cannot report an exit 3 it never ran (#151).
#
# A busy port (#217). Another project's server, left running on the same machine, can hold the
# port a review's app wants. The app then fails to bind, and the browser reaches the OTHER app: one
# QA step saw another project's todos. `stop_ended_runs` cannot help – that server is no run of this
# project. So `start --port <n>` refuses before it launches anything when something already answers
# on localhost:<n>, and names its pid and folder where this machine shows them. After launch it waits
# up to 120 s (XEZ_REVIEW_START_SECONDS) until the port answers and prints `review-listening=<n>`;
# it stops the command and refuses when the command ends first, when the time runs out, or when the
# listener this machine shows is not the command or one of its children. Open only the port that
# line names.
#
# Exit: the command's own status for `run`, or 124 when it ran out of time; 0 ok, 1 refused or changed, 2 usage, 3 confined
# (`checkout` only: this step's sandbox cannot write git, so the PR cannot be checked out here).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

refuse() {
  echo "review-run.sh: refused: $*" >&2
  # A refused prepare stops the run before the agent: say what the leader should make of it (#160).
  [ "${PREPARING:-0}" = 1 ] && echo "review-run.sh: this is the prepare check step, not a verdict – no review ran; re-run the review, or report this refusal" >&2
  exit 1
}

usage() {
  echo "usage: review-run.sh checkout <pr> | prepare | install | run <program> [<args>…] | start <name> [--port <n>] <program> [<args>…] | stop [<name>] | verify-unchanged | finish" >&2
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

# How long `run` lets one command take (#172). XEZ_REVIEW_RUN_SECONDS is for the operator and the
# tests; a review step's shell cannot set it.
RUN_LIMIT="${XEZ_REVIEW_RUN_SECONDS:-300}"
printf '%s' "$RUN_LIMIT" | grep -Eq '^[1-9][0-9]{0,5}$' || refuse "XEZ_REVIEW_RUN_SECONDS=\"$RUN_LIMIT\" is not a number of seconds"
# How long `start --port` waits for the port to answer (#217); the same rule as above.
START_LIMIT="${XEZ_REVIEW_START_SECONDS:-120}"
printf '%s' "$START_LIMIT" | grep -Eq '^[1-9][0-9]{0,5}$' || refuse "XEZ_REVIEW_START_SECONDS=\"$START_LIMIT\" is not a number of seconds"

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

# Stop one started command and everything it started (#223): `start` gives it its own process
# group, so a wrapper's child – the `node` server under `npm start` – is stopped with it instead
# of living on as an orphan that holds the port.
stop_one() {
  local pidfile="$1" pid
  pid="$(cat "$pidfile" 2>/dev/null)" || return 0
  # The group may outlive its leader: a wrapper that exited leaves its server in the group.
  if printf '%s' "$pid" | grep -Eq '^[1-9][0-9]*$' && { kill -0 "$pid" 2>/dev/null || kill -0 -- "-$pid" 2>/dev/null; }; then
    stop_tree "$pid"
  fi
  rm -f "$pidfile"
}

# Stop a command and everything it started. `run_limited` and `start` give the command its own process group,
# so a signal to the group reaches its children as well. On Windows (Git Bash, Cygwin) a native
# program is not in that group: taskkill /T stops its Windows process tree.
stop_tree() {
  local pid="$1" winpid
  case "${OSTYPE:-}" in
    msys* | cygwin*)
      winpid="$(cat "/proc/$pid/winpid" 2>/dev/null)"
      [ -n "$winpid" ] && taskkill //F //T //PID "$winpid" >/dev/null 2>&1
      ;;
  esac
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  sleep 2
  kill -KILL -- "-$pid" 2>/dev/null
  kill -KILL "$pid" 2>/dev/null
}

# `run` with a time limit (#172): one hung command – a browser script that never ends – held a review
# for 12 minutes, and `timeout` is a refused program, so the reviewer could not limit it. The command
# runs in the background in its own process group (`set -m`) with no stdin, so a prompt cannot wait
# for an answer, and this script waits for it. After RUN_LIMIT seconds it stops the command and all it
# started, prints `review-run=timeout after <n>s` and exits 124: the reviewer reports that check as
# not run. No `timeout` binary is used: macOS has none, and the refusal above stays whole.
run_limited() {
  local pid waited=0 status
  set -m
  "$@" </dev/null &
  pid=$!
  set +m
  # Its own group no longer gets a cancel sent to this script's group, so pass the cancel on.
  trap 'stop_tree "$pid"; exit 143' TERM INT HUP
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$RUN_LIMIT" ]; then
      stop_tree "$pid"
      wait "$pid" 2>/dev/null
      echo "review-run=timeout after ${RUN_LIMIT}s"
      echo "review-run.sh: \"$1\" did not end within ${RUN_LIMIT}s and was stopped with what it started – report this check as not run" >&2
      exit 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
  status=$?
  return "$status"
}

# The folder a process runs in, or nothing when this machine does not show it.
process_cwd() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}

# Exit 0 when something answers on localhost:<port>, over IPv4 or IPv6 (#217).
port_answers() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    let left = 2, hit = false;
    for (const host of ["127.0.0.1", "::1"]) {
      const s = net.connect({ host, port });
      let done = false;
      const end = (ok) => { if (done) return; done = true; hit ||= ok; s.destroy(); if (--left === 0) process.exit(hit ? 0 : 1); };
      s.setTimeout(1000);
      s.on("connect", () => end(true));
      s.on("error", () => end(false));
      s.on("timeout", () => end(false));
    }
  ' "$1" 2>/dev/null
}

# The pids listening on TCP <port>, one per line, where this machine shows them: lsof, then ss. On
# Windows (Git Bash) netstat names a Windows pid, which only names the holder.
port_pids() {
  case "${OSTYPE:-}" in
    msys* | cygwin*)
      netstat -ano 2>/dev/null | tr -d '\r' | awk -v p=":$1" '$1 == "TCP" && $4 == "LISTENING" && substr($2, length($2) - length(p) + 1) == p { print $5 }' | sort -u
      return
      ;;
  esac
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}

# "pid <p> in <folder>" for each listener on <port>, or a plain "a process this machine does not show".
port_holders() {
  local pids p out=""
  pids="$(port_pids "$1")"
  for p in $pids; do out="${out:+$out, }pid $p in $(process_cwd "$p" || true)"; done
  printf '%s' "${out:-a process this machine does not show}" | sed 's/ in $//; s/ in ,/,/g'
}

# Exit 0 when <pid> is <root> or one of its children, walking parent pids (Linux and macOS).
in_tree() {
  local p="$1" root="$2" i=0
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$i" -lt 64 ]; do
    [ "$p" = "$root" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    i=$((i + 1))
  done
  return 1
}

# After `start --port` launched <pid> (#217): wait until the port answers, then check that the
# listener this machine shows belongs to it. Stops <pid> and refuses on every other outcome.
await_listener() {
  local pid="$1" port="$2" name="$3" waited=0 pids p
  while ! port_answers "$port"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$state/$name.pid"
      refuse "\"$name\" ended before it listened on port $port – see $state/$name.log; the app was not reached, so report each check that needed it as not run"
    fi
    if [ "$waited" -ge "$START_LIMIT" ]; then
      stop_one "$state/$name.pid"
      refuse "\"$name\" did not listen on port $port within ${START_LIMIT}s and was stopped – see $state/$name.log; report each check that needed it as not run"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  case "${OSTYPE:-}" in msys* | cygwin*) ;; *)
    pids="$(port_pids "$port")"
    for p in $pids; do
      if ! in_tree "$p" "$pid"; then
        stop_one "$state/$name.pid"
        refuse "port $port answers, but its listener is $(port_holders "$port"), not \"$name\" (pid $pid) or one of its children – another app holds the port, so this one was not reached (#217)"
      fi
    done
    ;;
  esac
  echo "review-listening=$port name=$name"
}

# A step the leader cancels never reaches `finish`, so a command its `start` began lives on and
# holds its port (#166). Before this run prepares or starts anything, stop what an ENDED run left:
# one whose status in the engine's runs index is done, failed or cancelled. A pid is stopped only
# while it still runs in that run's own worktree, so a pid the system gave to another program is
# never signalled; a dead one only loses its pid file.
stop_ended_runs() {
  local index="$MAIN_ROOT/.local/xezar/runs.json" ended root pidfile id pid cwd wt fold=cat
  [ -r "$index" ] || return 0
  ended="$(node -e '
    const raw = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const r of Array.isArray(raw) ? raw : (raw.runs ?? []))
      if (["done", "failed", "cancelled"].includes(r?.status) && typeof r.id === "string") console.log(r.id);
  ' "$index" 2>/dev/null | drop_jq_cr)" || return 0
  [ -n "$ended" ] || return 0
  case "${OSTYPE:-}" in msys* | cygwin* | darwin*) fold="tr A-Z a-z" ;; esac
  while IFS= read -r root; do
    for pidfile in "$root"/*/review/*.pid; do
      [ -e "$pidfile" ] || continue
      id="${pidfile%/review/*}"
      id="${id##*/}"
      [ "$id" != "${TASK_ID:-}" ] && printf '%s\n' "$ended" | grep -Fqx -- "$id" || continue
      pid="$(cat "$pidfile" 2>/dev/null)"
      if ! printf '%s' "$pid" | grep -Eq '^[1-9][0-9]*$' || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pidfile"
        continue
      fi
      cwd="$(process_cwd "$pid" | $fold)"
      wt="$(printf '%s' "$MAIN_ROOT/.local/xezar/worktrees/$id" | $fold)"
      case "$cwd" in
        "$wt" | "$wt"/* | "$wt (deleted)" | "$wt"/*" (deleted)")
          stop_one "$pidfile"
          if kill -0 "$pid" 2>/dev/null; then
            echo "review-run.sh: could not stop pid $pid, which run $id started and left running when it ended – stop it by hand"
          else
            echo "review-run.sh: stopped $(basename "$pidfile" .pid) (pid $pid), which run $id started and left running when it ended"
          fi
          ;;
        *) echo "review-run.sh: run $id ended and left $pidfile, but pid $pid runs in ${cwd:-a folder this machine does not show}, not that run's worktree – left alone" ;;
      esac
    done
  done < <(task_evidence_roots)
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

checkout_pr() {
    printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,9}$' || refuse "\"$1\" is not a PR number"
    if [ -f "$state/head" ]; then
      # The workflow's `prepare` step may have checked this PR out already (#160): the same PR at
      # the same, unmoved head is that checkout confirmed, not a second one.
      if [ "$(cat "$state/pr" 2>/dev/null)" = "$1" ] && [ "$(cat "$state/head")" = "$(git rev-parse HEAD 2>/dev/null)" ]; then
        echo "review-head=$(cat "$state/head") pr=$1 already checked out"
        exit 0
      fi
      refuse "this run already reviews $(cat "$state/head"); one reviewed head per run"
    fi
    [ -z "$(tracked_changes)" ] || refuse "the worktree has tracked changes before the checkout"
    for gitdir in "$(git rev-parse --absolute-git-dir 2>/dev/null)" "$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)"; do
      probe=""
      [ -n "$gitdir" ] && probe="$(mktemp "$gitdir/xezar-review-probe.XXXXXX" 2>/dev/null)"
      if [ -z "$probe" ]; then
        printf 'confined exit=3 pr=%s\n' "$1" >"$state/checkout"
        echo "review-run=confined"
        echo "review-run.sh: this step cannot write ${gitdir:-the git directory}, which a checkout needs – its sandbox confines it to the worktree and the run's own folders (a Codex step with no Edit and no Write, on an engine without the prepare step of qodeca/xezar#1006). The PR cannot be checked out or run here: judge from the diff, and report every check that needed running as not run." >&2
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
    printf 'ok exit=0 pr=%s head=%s\n' "$1" "$head" >"$state/checkout"
    echo "review-head=$head pr=$1"
}

case "$sub" in
  checkout)
    [ $# -eq 1 ] || usage
    checkout_pr "$1"
    ;;
  prepare)
    # The workflow's check step, before the review agent (#160). The engine runs it outside any
    # agent sandbox and sets XEZ_PR_NUMBER when the run knows its pull request, so a step whose own
    # sandbox cannot write git (a Codex reading step) still reviews a checked-out head.
    [ $# -eq 0 ] || usage
    stop_ended_runs
    if [ -z "${XEZ_PR_NUMBER:-}" ]; then
      echo "review-run=no-pr"
      echo "review-run.sh: this run names no pull request, so nothing was checked out; the review judges what its task names" >&2
      exit 0
    fi
    PREPARING=1
    checkout_pr "$XEZ_PR_NUMBER"
    ;;
  install)
    [ $# -eq 0 ] || usage
    no_credentials
    bash "$SCRIPT_DIR/deps-restore.sh"
    ;;
  run)
    check_program "${1:-}"
    no_credentials
    run_limited "$@"
    ;;
  start)
    [ $# -ge 2 ] || usage
    valid_name "$1"
    name="$1"
    shift
    port=""
    if [ "$1" = "--port" ]; then
      port="${2:-}"
      printf '%s' "$port" | grep -Eq '^[1-9][0-9]{0,4}$' && [ "$port" -le 65535 ] || refuse "\"$port\" is not a port (1 to 65535)"
      shift 2
      [ $# -ge 1 ] || usage
    fi
    check_program "$1"
    stop_ended_runs
    if [ -f "$state/$name.pid" ] && kill -0 "$(cat "$state/$name.pid")" 2>/dev/null; then
      refuse "\"$name\" is already running"
    fi
    if [ -n "$port" ] && port_answers "$port"; then
      refuse "port $port is already in use by $(port_holders "$port") – not this run's app (#217). Never test what answers there: report each check that needed the app as not run, and name this line"
    fi
    no_credentials
    # The port goes to the command as PORT, which most dev servers read (#226): `env` is a refused
    # program, so this is the only way a review can move the app off a busy default port.
    [ -z "$port" ] || export PORT="$port"
    # Its own process group (#223), so `stop` and `finish` reach what it starts, as `run` does.
    set -m
    nohup "$@" >"$state/$name.log" 2>&1 </dev/null &
    started=$!
    set +m
    printf '%s\n' "$started" >"$state/$name.pid"
    echo "review-started=$name pid=$started log=$state/$name.log"
    [ -z "$port" ] || await_listener "$started" "$port" "$name"
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
