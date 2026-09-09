#!/usr/bin/env bash
# Read-only verification of a Xezar run's sealed gate evidence — including another run's.
#
# It answers two questions, and keeps them apart on purpose:
#
#   historical validity  Was this a real, complete, passing gate run at the revision it names?
#                        Decided from the record, its digests and the repository's own Git
#                        objects. It survives the worktree being reclaimed, because the branch
#                        and the commit do.
#   reusable here        May THIS environment lean on it instead of re-running the gates?
#                        A newer attempt, a changed gate list or a different dependency tree
#                        all make the answer "no" WITHOUT making the history any less true.
#                        An input this machine could not measure is "unknown", never "yes".
#   currently eligible   Only with `--require-current`. May this seal certify work being handed
#                        off RIGHT NOW? A newer failed, interrupted or malformed attempt, a tie,
#                        a seal that is no longer the newest word, or an unmeasurable input all
#                        make it INELIGIBLE and the exit status non-zero — while the sealed
#                        history stays exactly as VERIFIED as it was. Historical truth and
#                        present eligibility are different questions and are answered apart.
#
# What it never does: change a checkout, install anything, write into the author's worktree,
# rewrite history, or regenerate a file. It reads. Missing Git objects or a seal it does not
# understand return "unavailable" — never a pass.
#
# It is an auditor's tool, not an authorisation. A local record is an assertion by whoever ran
# the gates; it proves nothing about permission, about a lease, or about whether a reviewer
# accepted the work. CI is the separate corroboration.
#
# Usage:
#   .xezar/checks/verify-evidence.sh <runId> [--require-current] [--json]
#   .xezar/checks/verify-evidence.sh --list
#
# Exit: 0 verified · 1 failed or refused · 2 usage · 3 unavailable in this environment.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

resolve_task_paths || {
  printf 'verify-evidence: not inside a git checkout, so the primary checkout cannot be located\n' >&2
  exit 2
}

RUN_ID=""
JSON=""
REQUIRE_CURRENT=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON="--json" ;;
    --require-current) REQUIRE_CURRENT="--require-current" ;;
    --list)
      root="$MAIN_ROOT/.local/xezar-tasks"
      [ -d "$root" ] || { printf 'no task evidence under %s\n' "$root"; exit 0; }
      for dir in "$root"/*/; do
        [ -f "$dir/manifest.json" ] || continue
        id="$(basename "$dir")"
        sealed="$(node "$SCRIPT_DIR/lib/manifest.mjs" "$dir/manifest.json" --get gateEvidence.headSha 2>/dev/null)"
        printf '%-40s %s\n' "$id" "${sealed:-<no sealed evidence>}"
      done
      exit 0
      ;;
    --*)
      printf 'verify-evidence: unknown argument "%s"\n' "$arg" >&2
      exit 2
      ;;
    *) RUN_ID="$arg" ;;
  esac
done

# Default to the run we are standing in, so an agent can audit its own evidence without
# knowing its id by heart.
[ -n "$RUN_ID" ] || RUN_ID="${TASK_ID:-}"
if [ -z "$RUN_ID" ]; then
  printf 'verify-evidence: no run id given and none could be derived from this checkout\n' >&2
  exit 2
fi
# The same refusal the rest of the machinery uses: a run id is one safe path segment or it is
# not a run id. It is never sanitised into one.
if ! valid_task_id "$RUN_ID"; then
  printf 'verify-evidence: "%s" is not a valid run id\n' "$RUN_ID" >&2
  exit 2
fi

MANIFEST="$MAIN_ROOT/.local/xezar-tasks/$RUN_ID/manifest.json"
if [ ! -f "$MANIFEST" ]; then
  printf 'verify-evidence: no manifest for run %s at %s\n' "$RUN_ID" "$MANIFEST" >&2
  exit 3
fi

# The reuse-compatibility inputs, measured HERE. They never affect historical validity.
#
# Measured through `--list --json` and parsed as JSON, not scraped with awk from a human table
# whose column positions nothing pins. A probe that fails leaves the value EMPTY on purpose, and
# an empty value is reported as "could not measure" rather than quietly reading as agreement —
# an auditor on a machine where the probe breaks must not be told the evidence is reusable here
# when nothing was compared.
command_list_id="$(
  "$SCRIPT_DIR/repo-gates.sh" --list --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      try {
        const id = JSON.parse(raw).commandListId;
        if (typeof id === "string") process.stdout.write(id);
      } catch { /* an unparsable probe is an unknown input, never a match */ }
    });' 2>/dev/null
)"

# The revision this checkout is actually on, observed the same way every other caller observes it.
#
# The strict verifier requires these under `--require-current`, and this auditor was not supplying
# them — so `--require-current` here answered INELIGIBLE for a reason that had nothing to do with
# the evidence ("you did not look"), and every INELIGIBLE it reported became vacuous: a genuinely
# stale seal and a perfectly current one produced the same verdict for the same wrong reason.
#
# Measured, never assumed, and an unmeasurable value is left EMPTY on purpose — the verifier reports
# an unobserved revision as unknown rather than as agreement, which is the same contract the command
# list and the dependency fingerprint already follow. Historical validity is untouched by all of it.
current_head="$(git -C "$TASK_CWD" rev-parse HEAD 2>/dev/null || printf '')"
current_tree_fingerprint="$(tree_fingerprint 2>/dev/null || printf '')"

node "$SCRIPT_DIR/lib/gate-results.mjs" verify \
  --manifest "$MANIFEST" \
  --repo "$MAIN_ROOT" \
  --run-id "$RUN_ID" \
  --command-list-id "$command_list_id" \
  --deps-fingerprint "$(deps_fingerprint)" \
  --current-head "$current_head" \
  --current-tree-fingerprint "$current_tree_fingerprint" \
  $REQUIRE_CURRENT \
  $JSON
