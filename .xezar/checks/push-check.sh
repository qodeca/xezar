#!/usr/bin/env bash
# The one check a repair passes before its fix reaches GitHub (#54).
#
# Why this exists.
# `address-review-findings` used to push the fix to the pull request's branch from inside the
# agent step, BEFORE the gates ran. The gates then checked this run's own, unchanged branch – a
# no-op – so code nobody had gated landed on the PR. Now the repair commits on its own branch
# (moved onto the PR head), the gates and the seal run on that exact commit, and the handoff
# pushes it through this script, which refuses unless ALL of these hold:
#
#   a) HEAD is the sealed, checked commit: `verify-evidence.sh --require-current` answers
#      ELIGIBLE, and the sealed sha equals HEAD.                              [push.sealed-head]
#   b) the target is the PR's own head branch: the PR, read live with `gh pr view`, is OPEN,
#      its head is in this repository (not a fork), and the branch being pushed is its
#      headRefName.                             [push.pr-open] [push.pr-same-repo] [push.pr-head-branch]
#   c) the target is not a protected branch: never HEAD, main, master, release/*, the
#      project's base branch (`.xezar/config.json`) or the PR's own base branch. [push.protected-ref]
#   d) no bare force push: a plain push (git itself refuses anything but a fast-forward), or
#      `--force-with-lease=refs/heads/<branch>:<40-hex sha>` naming the exact ref being
#      pushed. `--force`, `-f`, a bare `--force-with-lease`, a short-ref lease or a `+` refspec
#      is refused.                                                            [push.no-bare-force]
#
# The refspec is built here, never taken from the caller: `<HEAD sha>:refs/heads/<branch>`, to
# `origin`, and the pull request is looked up in origin's own repository. After the push, a LIVE
# `git ls-remote` must show the sealed sha at the branch tip.                 [push.remote-tip]
#
# What it does not do (SECURITY.md, D12, #54): it does not stop two runs repairing the same PR at
# once, and a process running as the same OS user can still push by other means. It keeps a
# repair from pushing unchecked code, to the wrong PR, or onto a protected branch.
#
# Usage:
#   push-check.sh --pr <number> --branch <PR head branch> [--force-with-lease=refs/heads/<branch>:<sha>] [--dry-run]
#   push-check.sh --help
#
# Exit: 0 pushed (or, with --dry-run, every check passed) · 1 refused · 2 usage.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
  printf 'usage: push-check.sh --pr <number> --branch <PR head branch> [--force-with-lease=refs/heads/<branch>:<sha>] [--dry-run]\n'
  printf '       push-check.sh --help\n\n'
  printf 'Pushes this run'"'"'s sealed HEAD to the PR'"'"'s own head branch, and nothing else.\n'
  printf 'Refuses an unsealed or changed HEAD, a closed or fork PR, a branch other than the PR head,\n'
  printf 'a protected branch (HEAD, main, master, release/*, the base branches) and a bare force push.\n'
}

refuse() {
  local tag="$1"
  shift
  printf 'push-check: refused [%s] %s\n' "$tag" "$*" >&2
  printf 'push-check: report this refusal; never push the repair another way.\n' >&2
  exit 1
}

usage_error() {
  printf 'push-check: %s\n' "$*" >&2
  usage >&2
  exit 2
}

PR=""
TARGET=""
LEASE=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --pr)
      [ "$#" -ge 2 ] || usage_error "--pr needs a number"
      PR="$2"
      shift 2
      ;;
    --pr=*)
      PR="${1#--pr=}"
      shift
      ;;
    --branch)
      [ "$#" -ge 2 ] || usage_error "--branch needs the PR's head branch name"
      TARGET="$2"
      shift 2
      ;;
    --branch=*)
      TARGET="${1#--branch=}"
      shift
      ;;
    --force-with-lease=*)
      LEASE="${1#--force-with-lease=}"
      shift
      ;;
    --force | -f | --force-with-lease | --force-if-includes | --force-if-includes=* | +*)
      refuse push.no-bare-force "\"$1\" is a bare force push. Push a fast-forward, or pass --force-with-lease=refs/heads/<branch>:<the exact 40-character sha expected there>."
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      usage_error "unknown argument \"$1\". This is not a git wrapper: the refspec and the remote are fixed."
      ;;
  esac
done

[ -n "$PR" ] || usage_error "--pr is required"
[ -n "$TARGET" ] || usage_error "--branch is required"
printf '%s' "$PR" | grep -Eq '^[1-9][0-9]{0,9}$' || usage_error "--pr \"$PR\" is not a pull request number"

# --- d) the push form, judged before anything is read -------------------------------------
case "$TARGET" in
  +*) refuse push.no-bare-force "the branch \"$TARGET\" carries a + (a forced refspec). Name the branch alone." ;;
  refs/* | -*) usage_error "--branch takes the plain branch name, not \"$TARGET\"" ;;
esac
git check-ref-format "refs/heads/$TARGET" 2>/dev/null || usage_error "\"$TARGET\" is not a valid branch name"
if [ -n "$LEASE" ]; then
  lease_ref="${LEASE%%:*}"
  lease_sha="${LEASE#*:}"
  if [ "$lease_ref" = "$LEASE" ] || [ "$lease_ref" != "refs/heads/$TARGET" ] || ! printf '%s' "$lease_sha" | grep -Eq '^[0-9a-f]{40}$'; then
    refuse push.no-bare-force "--force-with-lease=$LEASE is not refs/heads/$TARGET:<the exact 40-character sha expected there>. A lease must name the fully qualified ref being pushed and the sha it must still hold."
  fi
fi

# --- the checkout: this run's worktree, as every write in the kit requires -----------------
if ! "$SCRIPT_DIR/worktree-preflight.sh"; then
  refuse push.preflight "the preflight refused this checkout (its predicate tags are above), so this is not a run's own worktree to push from."
fi
resolve_task_paths || refuse push.preflight "the checkout could not be resolved after the preflight."
[ -n "${TASK_ID:-}" ] || refuse push.preflight "no run id could be derived from this checkout."
[ -n "${HEAD_SHA:-}" ] || refuse push.sealed-head "HEAD could not be resolved."

# --- c) never a protected branch -----------------------------------------------------------
protected_ref() {
  case "$1" in
    HEAD | main | master | release/*) return 0 ;;
  esac
  [ -n "${BASE_BRANCH:-}" ] && [ "$1" = "$BASE_BRANCH" ] && return 0
  return 1
}
if protected_ref "$TARGET"; then
  refuse push.protected-ref "\"$TARGET\" is a protected branch (HEAD, main, master, release/*, or the project's base branch \"$BASE_BRANCH\"). A repair pushes only to a pull request's own head branch."
fi

# --- a) HEAD is exactly the sealed, checked commit ----------------------------------------
evidence_json="$("$SCRIPT_DIR/verify-evidence.sh" "$TASK_ID" --require-current --json 2>/dev/null)"
evidence_rc=$?
eligibility="$(printf '%s' "$evidence_json" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    try { const v = JSON.parse(raw).currentEligibility; if (typeof v === "string") process.stdout.write(v); } catch {}
  });' 2>/dev/null)"
if [ "$evidence_rc" -ne 0 ] || [ "$eligibility" != "ELIGIBLE" ]; then
  refuse push.sealed-head "verify-evidence.sh $TASK_ID --require-current did not answer ELIGIBLE (exit $evidence_rc, eligibility \"${eligibility:-none}\"). Run the gates and seal this exact commit first."
fi
sealed_sha="$(node "$SCRIPT_DIR/lib/manifest.mjs" "$(task_evidence_dir)/manifest.json" --get gateEvidence.headSha 2>/dev/null)"
if [ -z "$sealed_sha" ] || [ "$sealed_sha" != "$HEAD_SHA" ]; then
  refuse push.sealed-head "HEAD is $HEAD_SHA but the sealed commit is ${sealed_sha:-<none>}. Only the commit the gates checked may be pushed."
fi

# --- b) the PR's own head branch, read live ------------------------------------------------
# owner/repo of origin, from the configured URL (https or ssh GitHub forms). The PR is looked up
# in that repository, so the branch pushed to origin is the branch the PR reads.
origin_url="$(git -C "$TASK_CWD" config --get remote.origin.url 2>/dev/null)" || origin_url=""
case "$origin_url" in
  https://github.com/*) slug="${origin_url#https://github.com/}" ;;
  git@github.com:*) slug="${origin_url#git@github.com:}" ;;
  ssh://git@github.com/*) slug="${origin_url#ssh://git@github.com/}" ;;
  *) refuse push.pr-same-repo "origin (\"$origin_url\") is not a GitHub repository, so the PR cannot be matched to it." ;;
esac
slug="${slug%.git}"
printf '%s' "$slug" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || refuse push.pr-same-repo "origin does not name owner/repo."

pr_json="$(gh pr view "$PR" -R "$slug" --json state,headRefName,headRepositoryOwner,baseRefName,isCrossRepository 2>/dev/null)" ||
  refuse push.pr-open "gh pr view $PR -R $slug failed, so the PR could not be read live."
pr_fields="$(printf '%s' "$pr_json" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    let p;
    try { p = JSON.parse(raw); } catch { process.exit(1); }
    const s = (v) => (typeof v === "string" ? v.replace(/[\r\n]/g, " ") : "");
    process.stdout.write([
      `state=${s(p.state)}`,
      `head=${s(p.headRefName)}`,
      `owner=${s(p.headRepositoryOwner?.login)}`,
      `base=${s(p.baseRefName)}`,
      `cross=${p.isCrossRepository === false ? "false" : "not-false"}`,
    ].join("\n") + "\n");
  });' 2>/dev/null)" || refuse push.pr-open "gh pr view $PR returned no readable JSON."
field() { printf '%s\n' "$pr_fields" | sed -n "s/^$1=//p" | head -n 1; }
pr_state="$(field state)"
pr_head="$(field head)"
pr_owner="$(field owner)"
pr_base="$(field base)"
pr_cross="$(field cross)"

[ "$pr_state" = "OPEN" ] || refuse push.pr-open "PR #$PR is ${pr_state:-<unknown>}, not OPEN."
slug_owner="${slug%%/*}"
if [ "$pr_cross" != "false" ] || [ "$(printf '%s' "$pr_owner" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$slug_owner" | tr '[:upper:]' '[:lower:]')" ]; then
  refuse push.pr-same-repo "PR #$PR's head is not in $slug (a fork, or owner \"${pr_owner:-<unknown>}\"). A repair never pushes to another repository."
fi
[ "$pr_head" = "$TARGET" ] || refuse push.pr-head-branch "PR #$PR's head branch is \"${pr_head:-<unknown>}\", not \"$TARGET\"."
if [ -n "$pr_base" ] && [ "$TARGET" = "$pr_base" ]; then
  refuse push.protected-ref "\"$TARGET\" is PR #$PR's own base branch."
fi

# --- the push ------------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  printf 'push-check: every check passed; would push %s to %s refs/heads/%s (PR #%s)\n' "$HEAD_SHA" "$slug" "$TARGET" "$PR"
  exit 0
fi
if [ -n "$LEASE" ]; then
  git -C "$TASK_CWD" push --force-with-lease="$LEASE" origin "$HEAD_SHA:refs/heads/$TARGET" ||
    refuse push.rejected "git refused the push (the branch moved away from the leased sha)."
else
  git -C "$TASK_CWD" push origin "$HEAD_SHA:refs/heads/$TARGET" ||
    refuse push.rejected "git refused the push (not a fast-forward of the PR head, or the remote could not be reached). Never force it."
fi

remote_tip="$(git -C "$TASK_CWD" ls-remote origin "refs/heads/$TARGET" 2>/dev/null | awk '{print $1}' | head -n 1)"
[ "$remote_tip" = "$HEAD_SHA" ] || refuse push.remote-tip "origin's live tip for refs/heads/$TARGET is ${remote_tip:-<none>}, not the pushed $HEAD_SHA."
printf 'PUSHED: %s -> %s refs/heads/%s (PR #%s), sealed by run %s\n' "$HEAD_SHA" "$slug" "$TARGET" "$PR" "$TASK_ID"
