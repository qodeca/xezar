#!/usr/bin/env bash
# The only way a reading role writes to the tracker.
#
# A reading step's `bashAllowlist` is a list of command prefixes, and a prefix limits the program,
# never what it does: `gh pr comment` also takes `--edit-last`, `--delete-last`, `-R <any repo>`
# and `-F <any local file>`, and `gh pr edit` can add `qa-approved` or remove `do-not-merge`. So a
# reading step is not allowed those commands. It is allowed this script, which does two things,
# always on this checkout's own `origin` repository:
#
#   gh-write.sh comment pr|issue <number>            post a NEW comment; the text comes on stdin
#   gh-write.sh label pr|issue <number> --add <l>… --remove <l>…
#   gh-write.sh                                      either one, as one JSON request on stdin:
#     {"action":"comment","kind":"pr","number":12,"body":"…"}
#     {"action":"label","kind":"pr","number":12,"add":["…"],"remove":["…"]}
#
# Use the last form from a pipe: the engine's shared read-only lock (pi, Codex) allows one pipe
# only into an argument-free `bash <script>`, so `jq -n '{…,body:"…"}' | bash
# .xezar/checks/gh-write.sh` passes on every runner and `… | gh-write.sh comment pr 12` does not.
# Keep every `$` out of the command: Claude Code denies a command holding one in a reading step,
# so the text goes in the filter as a JSON string (`\u0024` for a dollar sign), never `--arg`.
#
# A label change never adds an approval label and never removes a label that blocks a merge: those
# are the labels `lib/project-policy.mjs` trusts, and a reviewer that could move them would be
# passing the merge gate on its own word. Build the request with `jq -n`, never a heredoc or
# `printf`, which no reading step's allowlist holds.
#
# ONE EXCEPTION, SCOPED TO THE REVIEWER'S OWN VERDICT (DECISIONS.md, D13). A JSON label request on a
# pull request that carries `"verdict":{"role":"qa"|"design-review","head":"<40-char sha>"}` may add
# that role's approval label and lift that role's own gate label, and nothing else:
#   qa             add qa-approved,     remove needs-qa
#   design-review  add design-approved, remove needs-design
# and only when `head` is the PR's current head, this worktree reviewed exactly that head
# (`review-run.sh checkout`), and its tracked files are unchanged (`review-run.sh verify-unchanged`).
# The role is not the request's word: it must be the `verdictRole` the engine froze for THIS step
# – the run's workflow definition in the engine's runs index (`.local/xezar/runs.json`, one JSON
# array at the top of the engine's data directory), found by the run id (this worktree's directory
# name) and XEZ_STEP_ID (a Continue's `continue-N` step answers with the step that owns its
# session, as the engine's `takeStepVerdict` does). A code-review step declares `code-review`, and security, architecture or
# acceptance steps declare no qa or design-review role, so they move no approval label; anything
# unreadable is refused. A gate label is lifted only together with its approval label, in the
# same request: `remove:["needs-qa"]` without `add:["qa-approved"]` is refused.
#
# Exit: gh's own status on a run, 1 on a refusal, 2 on usage.
set -uo pipefail

# Labels a reader may never add, and labels it may never remove (lib/project-policy.mjs).
NEVER_ADD="qa-approved qa-self-verified design-approved skip-qa skip-design"
NEVER_REMOVE="blocked do-not-merge qa qa-failed design design-failed needs-qa needs-design"
# What a verdict-scoped request may add and remove, per role (D13).
VERDICT_ADD_qa="qa-approved"
VERDICT_REMOVE_qa="needs-qa"
VERDICT_ADD_design_review="design-approved"
VERDICT_REMOVE_design_review="needs-design"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
COMMENT_MAX_BYTES=65536
# Never taken from the environment: bash imports every exported variable as a shell variable.
verdict_role=""
verdict_head=""
verdict_used=""
verdict_added=""
verdict_removed=""
from_json=""

usage() {
  echo "usage: gh-write.sh comment pr|issue <number>   (text on stdin)" >&2
  echo "       gh-write.sh label pr|issue <number> [--add <label>]… [--remove <label>]…" >&2
  echo "       gh-write.sh                               (one JSON request on stdin)" >&2
  exit 2
}

refuse() {
  echo "gh-write.sh: refused: $*" >&2
  exit 1
}

# This request's own label for ADD or REMOVE, from its verdict role.
own_label() {
  local var="VERDICT_${1}_${verdict_role//-/_}"
  printf '%s' "${!var:-}"
}

has_word() {
  case " $2 " in *" $1 "*) return 0 ;; esac
  return 1
}

# The verdictRole the engine declared for this step, or nothing. Read from the run's frozen workflow
# definition, never from the request or from a workflow file in the tree under review.
# A Continue runs under a synthetic step id (`continue-N`) that no definition step names, so the
# role is resolved the way the engine's own `takeStepVerdict` resolves it: the run's record step
# with that id, then the record step that owns the same session (its id names the definition
# step), and when no step owns the session, the definition's last agent step (one with no
# `command`). A run with no `workflowDef` yields nothing, and the request is refused.
step_verdict_role() {
  resolve_task_paths >/dev/null 2>&1 || return 1
  [ -n "${TASK_ID:-}" ] && [ -z "${TASK_ID_CONFLICT:-}" ] && [ -n "${XEZ_STEP_ID:-}" ] || return 1
  node -e '
    const fs = require("node:fs");
    const [index, id, stepId] = process.argv.slice(1);
    const raw = JSON.parse(fs.readFileSync(index, "utf8"));
    const runs = Array.isArray(raw) ? raw : (raw.runs ?? []);
    const run = runs.find((r) => r.id === id);
    const defSteps = run?.workflowDef?.steps;
    if (!Array.isArray(defSteps)) process.exit(0);
    let step = defSteps.find((s) => s.id === stepId);
    if (step === undefined) {
      const record = (Array.isArray(run.steps) ? run.steps : []).find((s) => s.id === stepId);
      if (record?.kind !== "agent") process.exit(0);
      const session = typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : undefined;
      const owner = session === undefined ? undefined : run.steps.find((s) => s.sessionId === session);
      step = defSteps.find((s) => s.id === owner?.id) ?? [...defSteps].reverse().find((s) => !s.command);
    }
    if (typeof step?.verdictRole === "string") process.stdout.write(step.verdictRole);
  ' "$MAIN_ROOT/.local/xezar/runs.json" "$TASK_ID" "$XEZ_STEP_ID" 2>/dev/null
}

# owner/repo of `origin`, from an https or ssh GitHub URL. Anything else is refused: the target
# repository is never taken from an argument.
origin_repo() {
  local url slug
  url="$(git remote get-url origin 2>/dev/null)" || refuse "this checkout has no origin remote"
  case "$url" in
    https://github.com/*) slug="${url#https://github.com/}" ;;
    git@github.com:*) slug="${url#git@github.com:}" ;;
    ssh://git@github.com/*) slug="${url#ssh://git@github.com/}" ;;
    *) refuse "origin is not a GitHub repository" ;;
  esac
  slug="${slug%.git}"
  printf '%s' "$slug" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || refuse "origin does not name owner/repo"
  printf '%s' "$slug"
}

# The JSON form becomes the same arguments, so one set of checks below covers both forms.
json_body=""
if [ $# -eq 0 ]; then
  request="$(head -c $((COMMENT_MAX_BYTES + 4096)))" || refuse "could not read stdin"
  [ "${#request}" -le $((COMMENT_MAX_BYTES + 4095)) ] || refuse "the request is too large"
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$request" || refuse "stdin is not one JSON request object"
  # jq on native Windows ends every line with CR (#122): under Git Bash or Cygwin a token loses it
  # through drop_jq_cr, and the body, free text that must stay byte-exact, comes through
  # jq_string_bytes (both lib/common.sh; elsewhere both reads are today's).
  field() { jq -r --arg k "$1" 'if (.[$k] | type) == "string" or (.[$k] | type) == "number" then .[$k] | tostring else "" end' <<<"$request" | drop_jq_cr; }
  j_action="$(field action)"
  set -- "$j_action" "$(field kind)" "$(field number)"
  case "$j_action" in
    comment)
      jq -e '(.body | type) == "string"' >/dev/null <<<"$request" || refuse "a comment request needs a string body"
      json_body="$(jq_string_bytes '.body' <<<"$request")"
      ;;
    label)
      jq -e '[(.add // []), (.remove // [])] | all(type == "array" and all(.[]; type == "string"))' >/dev/null <<<"$request" ||
        refuse "add and remove must be lists of label names"
      while IFS= read -r l; do [ -n "$l" ] && set -- "$@" --add "$l"; done < <(jq -r '(.add // [])[]' <<<"$request" | drop_jq_cr)
      while IFS= read -r l; do [ -n "$l" ] && set -- "$@" --remove "$l"; done < <(jq -r '(.remove // [])[]' <<<"$request" | drop_jq_cr)
      if jq -e 'has("verdict")' >/dev/null <<<"$request"; then
        verdict_role="$(jq -r 'if (.verdict | type) == "object" and (.verdict.role | type) == "string" then .verdict.role else "" end' <<<"$request" | drop_jq_cr)"
        verdict_head="$(jq -r 'if (.verdict | type) == "object" and (.verdict.head | type) == "string" then .verdict.head else "" end' <<<"$request" | drop_jq_cr)"
        case "$verdict_role" in qa | design-review) ;; *) refuse "verdict.role must be qa or design-review" ;; esac
        printf '%s' "$verdict_head" | grep -Eq '^[0-9a-f]{40}$' || refuse "verdict.head must be the full 40-character sha you reviewed"
        declared="$(step_verdict_role)" || declared=""
        [ "$declared" = "$verdict_role" ] ||
          refuse "this step declares verdictRole ${declared:-none} in the run's workflow, so a $verdict_role verdict is not its to give (D13)"
      fi
      ;;
  esac
  from_json=1
fi

[ $# -ge 3 ] || usage
action="$1"
kind="$2"
number="$3"
shift 3

case "$kind" in pr | issue) ;; *) usage ;; esac
printf '%s' "$number" | grep -Eq '^[1-9][0-9]{0,9}$' || refuse "\"$number\" is not a $kind number"
repo="$(origin_repo)" || exit 1

case "$action" in
  comment)
    [ $# -eq 0 ] || usage
    if [ -n "$from_json" ]; then
      body="$json_body"
    else
      body="$(head -c $((COMMENT_MAX_BYTES + 1)))" || refuse "could not read stdin"
    fi
    [ -n "$body" ] || refuse "the comment on stdin is empty"
    [ "${#body}" -le "$COMMENT_MAX_BYTES" ] || refuse "the comment is over $COMMENT_MAX_BYTES bytes"
    printf '%s' "$body" | gh "$kind" comment "$number" --repo "$repo" --body-file -
    ;;
  label)
    [ $# -ge 2 ] || usage
    args=()
    while [ $# -gt 0 ]; do
      flag="$1"
      label="${2:-}"
      [ -n "$label" ] || usage
      printf '%s' "$label" | grep -Eq '^[a-z0-9][a-z0-9-]{0,49}$' || refuse "\"$label\" is not a label name"
      case "$flag" in
        --add)
          if [ -n "$verdict_role" ] && [ "$label" = "$(own_label ADD)" ]; then
            verdict_used=1
            verdict_added=1
          elif has_word "$label" "$NEVER_ADD"; then
            refuse "\"$label\" is an approval label; a reviewer grants only its own, with a verdict request (D13)"
          fi
          args+=(--add-label "$label")
          ;;
        --remove)
          if [ -n "$verdict_role" ] && [ "$label" = "$(own_label REMOVE)" ]; then
            verdict_used=1
            verdict_removed=1
          elif has_word "$label" "$NEVER_REMOVE"; then
            refuse "\"$label\" blocks a merge; a reviewer lifts only its own gate label, with a verdict request (D13)"
          fi
          args+=(--remove-label "$label")
          ;;
        *) usage ;;
      esac
      shift 2
    done
    if [ -n "$verdict_used" ]; then
      [ "$kind" = pr ] || refuse "a verdict label goes on a pull request"
      [ -z "$verdict_removed" ] || [ -n "$verdict_added" ] ||
        refuse "\"$(own_label REMOVE)\" is lifted only together with \"$(own_label ADD)\" in the same request (D13)"
      current="$(gh pr view "$number" --repo "$repo" --json headRefOid --jq .headRefOid 2>/dev/null)" || current=""
      [ "$current" = "$verdict_head" ] || refuse "the PR's head is ${current:-unknown}, not the reviewed $verdict_head; the verdict is void"
      bash "$SCRIPT_DIR/review-run.sh" verify-unchanged >/dev/null || refuse "this worktree's tracked files or HEAD changed during the review"
      reviewed="$(git rev-parse HEAD 2>/dev/null)"
      [ "$reviewed" = "$verdict_head" ] || refuse "this worktree reviewed ${reviewed:-nothing}, not $verdict_head; check the PR out with review-run.sh checkout first"
    fi
    gh "$kind" edit "$number" --repo "$repo" "${args[@]}"
    ;;
  *) usage ;;
esac
