#!/usr/bin/env bash
# Bind a handoff Git WRITE to the checkout the preflight just validated.
#
# Why this exists.
# `xezar-handoff-draft-pr.md` used to run the preflight in one shell call and the commit and
# push in later, separate calls. Nothing connected them. A step in between — a read-only
# inspection of the primary checkout is the ordinary case — moves the shell's CWD, and the
# write then lands wherever the shell happens to be. That is what pilot A hit (Cezar-era
# run `38ecfe9c`, 2026-09; the run id and its branch are unchanged historical records):
# `git push -u origin HEAD` ran with the CWD in the PRIMARY checkout, on `main`.
# It did no damage only because `main` was already in sync; a `main` carrying one
# local commit would have been pushed.
#
# What it does. Exactly two verbs, `commit` and `push`, and nothing else. It is deliberately
# NOT a git wrapper: an escape hatch that forwarded arbitrary subcommands would re-open the
# hole it closes.
#
#   1. Run the real `worktree-preflight.sh` IN THE CALLER'S CWD. A stale CWD fails there —
#      the primary checkout, `main`/`main`, another run's worktree (identity conflict),
#      an unregistered tree. Fail closed: no preflight pass, no write.
#   2. Re-derive the checkout the preflight just judged and perform the write with
#      `git -C "$TASK_CWD"`, so the write cannot drift to a different directory even if the
#      caller's CWD is not what it seemed.
#   3. Push a NAMED branch ref, never a bare `HEAD`. With no target argument the branch name
#      means "this run's branch, or nothing". A review response may name the one destination
#      authorized by this run's DELIVERED record, with its expected remote tip pinned there.
#
# Usage:
#   worktree-git.sh commit [args for `git commit`...]   e.g. -m "fix: ..."
#   worktree-git.sh push                                takes no arguments
#   worktree-git.sh push <delivered-branch>             only the DELIVERED-record target
#
# Exit 0 only when the preflight passed AND the git write succeeded.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
  printf 'usage: worktree-git.sh commit [git commit args...]\n'
  printf '       worktree-git.sh push\n'
  printf '       worktree-git.sh push <delivered-branch>\n'
  printf '       worktree-git.sh --help\n\n'
  printf 'Exactly two verbs. Every other git subcommand is refused: an escape hatch that forwarded\n'
  printf 'arbitrary arguments would re-open the hole this closes.\n\n'
  printf 'An interrupted authorized merge is finished through .xezar/checks/merge-recovery.sh,\n'
  printf 'not here — this guard requires a clean git state and will refuse a merge in progress.\n'
}

VERB="${1:-}"
case "$VERB" in
  commit | push) shift ;;
  --help | -h)
    usage
    exit 0
    ;;
  "")
    usage >&2
    exit 2
    ;;
  *)
    printf 'worktree-git: refusing "%s". Supported: commit | push | --help. Only those two verbs are\n' "$VERB" >&2
    printf 'guarded here; this is not a git wrapper.\n' >&2
    usage >&2
    exit 2
    ;;
esac

# --- 1. The preflight, in the caller's CWD -------------------------------------------------
# Run in strict mode on purpose: --allow-root exists for read-only workflows, and a WRITE is
# never read-only. The primary checkout must fail here even when the surrounding workflow is
# one that may legitimately read it.
#
# The refusal below used to assert a cause: "the CWD this ran in is not this run's worktree". A
# stale CWD is one reason the preflight fails and it is not the common one — a branch that is not
# this run's, an in-flight merge, a broken ignore rule and every evidence predicate all fail in
# exactly the right directory. Naming the wrong cause sent readers to check the wrong thing, so
# the message now points at the predicate tags the preflight printed instead of guessing.
if ! "$SCRIPT_DIR/worktree-preflight.sh"; then
  printf '\nworktree-git: the preflight refused this checkout, so no git %s was attempted.\n' "$VERB" >&2
  printf 'The predicate tags above say WHICH assertion failed. A wrong CWD is only one of them:\n' >&2
  printf '  isolation.*  the checkout is not this run'"'"'s worktree (this IS the wrong-CWD family)\n' >&2
  printf '  branch.*     right directory, wrong branch\n' >&2
  printf '  gitstate.*   right directory and branch, but a git operation is in flight\n' >&2
  printf '  ignore.*     right directory, but autosave would commit something it must not\n' >&2
  printf 'Read the tag before moving anything.\n' >&2
  exit 1
fi

# --- 2. The checkout the preflight just judged ---------------------------------------------
if ! resolve_task_paths; then
  printf 'worktree-git: the preflight passed but the checkout could not be re-resolved — refusing to write.\n' >&2
  exit 1
fi

# The preflight already refuses both of these. Asserting them again costs nothing and means a
# future edit to the preflight cannot silently widen what may be written to.
if [ "$IS_WORKTREE" -ne 1 ]; then
  printf 'worktree-git: %s is not a Xezar worktree — refusing to write.\n' "$TASK_CWD" >&2
  exit 1
fi
case "$BRANCH" in
  main | main | HEAD)
    printf 'worktree-git: HEAD is "%s" — refusing to write to the integration or release branch.\n' "$BRANCH" >&2
    exit 1
    ;;
esac

printf 'worktree-git: %s in %s on %s\n' "$VERB" "$TASK_CWD" "$BRANCH"

# The one cross-branch form is intercepted before the original zero-argument push path. Keeping
# that case below byte-for-byte unchanged is deliberate: adding review delivery must not alter the
# established task-branch command, flags, upstream behavior or refusal for every other argument.
if [ "$VERB" = "push" ] && [ "$#" -eq 1 ]; then
  target_branch="$1"
  delivery_record="$(task_evidence_dir)/DELIVERED"
  if [ ! -f "$delivery_record" ]; then
    printf 'worktree-git: refusing delivery push to "%s": this run has no DELIVERED record.\n' "$target_branch" >&2
    exit 1
  fi
  delivered_branch="$(sed -n 's/^branch:[[:space:]]*\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$delivery_record" | head -n 1)"
  delivered_head="$(sed -n 's/^head:[[:space:]]*\([0-9a-fA-F]\{40\}\)[[:space:]]*$/\1/p' "$delivery_record" | head -n 1)"
  delivered_base="$(sed -n 's/^base:[[:space:]]*\([0-9a-fA-F]\{40\}\)[[:space:]]*$/\1/p' "$delivery_record" | head -n 1)"
  if [ -z "$delivered_branch" ] || [ -z "$delivered_head" ] || [ -z "$delivered_base" ]; then
    printf 'worktree-git: refusing delivery push: %s must contain branch, head and base.\n' "$delivery_record" >&2
    exit 1
  fi
  if [ "$target_branch" != "$delivered_branch" ]; then
    printf 'worktree-git: refusing unauthorized delivery target "%s"; this run records only "%s".\n' "$target_branch" "$delivered_branch" >&2
    exit 1
  fi
  if ! git -C "$TASK_CWD" check-ref-format --branch "$target_branch" >/dev/null 2>&1; then
    printf 'worktree-git: refusing invalid delivery branch name "%s".\n' "$target_branch" >&2
    exit 1
  fi
  if [ "$delivered_head" != "$HEAD_SHA" ]; then
    printf 'worktree-git: refusing delivery head %s: this task is checked out at %s.\n' "$delivered_head" "$HEAD_SHA" >&2
    exit 1
  fi
  if ! git -C "$TASK_CWD" merge-base --is-ancestor "$delivered_base" "$delivered_head" 2>/dev/null; then
    printf 'worktree-git: refusing delivery: head %s is not descended from recorded base %s.\n' "$delivered_head" "$delivered_base" >&2
    exit 1
  fi
  remote_tip="$(git -C "$TASK_CWD" ls-remote origin "refs/heads/$target_branch" 2>/dev/null | awk '{print $1}' | head -n 1)"
  if [ -z "$remote_tip" ]; then
    printf 'worktree-git: refusing delivery: origin/%s has no readable current tip.\n' "$target_branch" >&2
    exit 1
  fi
  if [ "$remote_tip" != "$delivered_base" ]; then
    printf 'worktree-git: refusing delivery: origin/%s is at %s, not recorded base %s; it advanced concurrently.\n' "$target_branch" "$remote_tip" "$delivered_base" >&2
    exit 1
  fi

  # No force option and no caller-supplied refspec reaches git. The source and destination are
  # the validated record values; an advancement after the check also makes this normal
  # fast-forward-only push fail.
  git -C "$TASK_CWD" push origin "$delivered_head:refs/heads/$target_branch"
  exit $?
fi

# --- 3. The write ---------------------------------------------------------------------------
case "$VERB" in
  commit)
    git -C "$TASK_CWD" commit "$@"
    exit $?
    ;;
  push)
    if [ "$#" -ne 0 ]; then
      printf 'worktree-git: `push` takes no arguments (got: %s). The refspec is fixed to this run'"'"'s branch.\n' "$*" >&2
      exit 2
    fi
    # A fully qualified refspec, both sides named. `HEAD` is never sent, and no argument the
    # caller supplies can redirect the destination.
    git -C "$TASK_CWD" push -u origin "refs/heads/$BRANCH:refs/heads/$BRANCH"
    exit $?
    ;;
esac
