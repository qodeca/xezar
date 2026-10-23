#!/usr/bin/env bash
# The only way a reading role writes a file.
#
# Before a verdict packet is written, a review that ran the change must pass `review-run.sh finish`
# (D13): a verdict from a review that changed the tree is refused.
#
# A reading step carries a `bashAllowlist` of command prefixes and no Edit or Write tool, so it
# cannot redirect into a file or run `mv`. It still has three things it must write: the verdict
# packet the engine reads when the step settles, the `BLOCKED` file that stops readiness, and its
# own evidence. Each goes through this script, which reads the content on stdin and writes only
# where that kind of file belongs – never into the author's tree.
#
# Usage:
#   verdict-write.sh packet            stdin → ${XEZ_HANDOFF_FILE}.verdict.json (atomic, ≤ 40 KB, JSON;
#                                      taskId and stepId stamped from XEZ_TASK_ID and XEZ_STEP_ID,
#                                      recordedAt from this machine's clock)
#   verdict-write.sh blocked           stdin → <evidence dir>/BLOCKED
#   verdict-write.sh evidence <name>   stdin → <evidence dir>/<name> (.md .txt .log .json .csv .png .jpg .jpeg)
#   verdict-write.sh                   any of the three, as one JSON request on stdin:
#     {"kind":"packet","packet":{…}}   {"kind":"blocked","text":"…"}   {"kind":"evidence","name":"notes.md","text":"…"}
#
# Use the last form from a pipe: the engine's shared read-only lock (Codex, Qwen Code) allows one pipe
# only into an argument-free `bash <script>`, so `jq -n '{kind:"packet",packet:{…}}' | bash
# .xezar/checks/verdict-write.sh` passes on every runner and `… | verdict-write.sh packet` does not.
#
# <evidence dir> is this run's primary `.local/xezar/tasks/<runId>/`, resolved by lib/common.sh.
# Phase records (upper-case names) are not written here: `phase-record.sh set` owns them.
#
# A packet that says `review-run=confined` is refused unless `review-run.sh checkout` recorded a confined
# checkout in <evidence dir>/review/checkout in this run (#151).
#
# Exit 0 on success, 1 on a refusal, 2 on usage.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

PACKET_MAX_BYTES=40960
EVIDENCE_MAX_BYTES=1048576
# Files the run itself owns in the evidence directory; a reader never overwrites them.
RESERVED_NAMES="manifest.json merge-intent.json blocked"

usage() {
  echo "usage: verdict-write.sh packet | blocked | evidence <name>   (content on stdin)" >&2
  echo "       verdict-write.sh                                    (one JSON request on stdin)" >&2
  exit 2
}

refuse() {
  echo "verdict-write.sh: refused: $*" >&2
  exit 1
}

# Write at most <max> bytes of stdin to <target> through a fresh temporary file in the same
# directory, then rename it, so a reader never sees half a file. `mktemp` creates the file itself,
# so a name planted in advance, or a symlink, is never written through.
atomic_from_stdin() {
  local target="$1" max="$2" tmp size
  [ -L "$target" ] && refuse "$target is a symlink"
  mkdir -p "$(dirname "$target")" || refuse "cannot create $(dirname "$target")"
  tmp="$(mktemp "$target.XXXXXX")" || refuse "cannot create a temporary file beside $target"
  head -c $((max + 1)) >"$tmp" || { rm -f "$tmp"; refuse "could not read stdin"; }
  size="$(wc -c <"$tmp" | tr -d ' ')"
  if [ "$size" -gt "$max" ]; then
    rm -f "$tmp"
    refuse "the content is over $max bytes"
  fi
  printf '%s' "$tmp"
}

evidence_dir() {
  resolve_task_paths >/dev/null 2>&1 || true
  [ -n "${TASK_ID:-}" ] || refuse "no task id: this is not a task run"
  [ -z "${TASK_ID_CONFLICT:-}" ] || refuse "$TASK_ID_CONFLICT"
  task_evidence_dir || refuse "cannot resolve the evidence directory"
}

# The JSON form: take the kind and name from the request, and hand the content on as stdin, so
# every check below applies to it unchanged.
if [ $# -eq 0 ]; then
  request="$(head -c $((EVIDENCE_MAX_BYTES + 4096)))" || refuse "could not read stdin"
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$request" || refuse "stdin is not one JSON request object"
  # jq on native Windows ends every line with CR (#122): under Git Bash or Cygwin the kind and name
  # lose it through drop_jq_cr, and the text, which must stay byte-exact, comes through
  # jq_string_bytes (both lib/common.sh; elsewhere both reads are today's).
  j_kind="$(jq -r 'if (.kind | type) == "string" then .kind else "" end' <<<"$request" | drop_jq_cr)"
  case "$j_kind" in
    packet)
      jq -e '(.packet | type) == "object"' >/dev/null <<<"$request" || refuse "a packet request needs a packet object"
      exec bash "$SCRIPT_DIR/verdict-write.sh" packet < <(jq -c '.packet' <<<"$request")
      ;;
    blocked)
      jq -e '(.text | type) == "string"' >/dev/null <<<"$request" || refuse "a blocked request needs a string text"
      exec bash "$SCRIPT_DIR/verdict-write.sh" blocked < <(jq_string_bytes '.text' <<<"$request")
      ;;
    evidence)
      jq -e '(.text | type) == "string" and (.name | type) == "string"' >/dev/null <<<"$request" || refuse "an evidence request needs a string name and text"
      exec bash "$SCRIPT_DIR/verdict-write.sh" evidence "$(jq -r '.name' <<<"$request" | drop_jq_cr)" < <(jq_string_bytes '.text' <<<"$request")
      ;;
    *) usage ;;
  esac
fi

kind="$1"
shift

case "$kind" in
  packet)
    [ $# -eq 0 ] || usage
    [ -n "${XEZ_HANDOFF_FILE:-}" ] || refuse "XEZ_HANDOFF_FILE is not set: a packet belongs to a workflow step"
    # The engine refuses a packet whose ids are not this task's and step's, so the ids are stamped
    # here from the step's environment, never typed by the reviewer; a packet naming others is refused.
    # recordedAt is stamped here too, from the clock (#172): a reading step cannot run `date`, and a
    # typed time was hours off. A typed recordedAt is replaced, not refused – it is a wrong time, not
    # another run.
    [ -n "${XEZ_TASK_ID:-}" ] && [ -n "${XEZ_STEP_ID:-}" ] || refuse "XEZ_TASK_ID or XEZ_STEP_ID is not set: a packet belongs to a workflow step"
    # A review that ran the change (review-run.sh keeps its state under <evidence>/review/) records a
    # verdict only when it left the tree as it found it: `finish` stops what it started and fails
    # when HEAD or a tracked file changed (D13). A review that ran nothing has no shell that writes.
    if dir="$(evidence_dir 2>/dev/null)" && [ -d "$dir/review" ]; then
      bash "$SCRIPT_DIR/review-run.sh" finish >&2 || refuse "the review changed HEAD or a tracked file, so its verdict is void (review-run.sh finish)"
    fi
    target="${XEZ_HANDOFF_FILE}.verdict.json"
    tmp="$(atomic_from_stdin "$target" "$PACKET_MAX_BYTES")" || exit 1
    # A verdict that names a confined checkout must rest on one: `review-run.sh checkout` records
    # its outcome, and a claim with no `confined` record is an exit 3 nobody ran (#151).
    if grep -q 'review-run=confined' "$tmp"; then
      record=""
      dir="$(evidence_dir 2>/dev/null)" && [ -f "$dir/review/checkout" ] && record="$(head -c 200 "$dir/review/checkout")"
      case "$record" in
        confined\ exit=3*) ;;
        "") rm -f "$tmp"; refuse "the verdict says review-run=confined, but this run has no checkout record: run \`bash .local/xezar/cache/kit/checks/review-run.sh checkout <pr>\` alone, with no pipe, and quote the line it prints" ;;
        *) rm -f "$tmp"; refuse "the verdict says review-run=confined, but this run's checkout recorded \"${record%%$'\n'*}\"" ;;
      esac
    fi
    if ! stamp="$(node -e '
      const fs = require("fs"), [file, taskId, stepId] = process.argv.slice(1);
      let p; try { p = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.log("the packet is not valid JSON"); process.exit(1); }
      if (p === null || typeof p !== "object" || Array.isArray(p)) { console.log("the packet is not a JSON object"); process.exit(1); }
      for (const [k, v] of [["taskId", taskId], ["stepId", stepId]])
        if (p[k] !== undefined && p[k] !== v) { console.log("the packet names " + k + " " + JSON.stringify(p[k]) + ", not the running " + JSON.stringify(v)); process.exit(1); }
      // The engine refuses a finding id or fingerprint over 64 characters, and drops the whole packet
      // with it (#178): twice a reviewer wrote the title as the fingerprint. An over-long one is
      // replaced by the first 16 hex characters of its sha256 – the same text always gives the same
      // value, so a fingerprint stays stable across reports – and a note says so. An empty or
      // non-string one is refused: there is nothing stable to hash.
      const notes = [];
      if (p.findings !== undefined && !Array.isArray(p.findings)) { console.log("the findings field of the packet is not a list"); process.exit(1); }
      for (const [i, f] of (p.findings ?? []).entries()) {
        if (f === null || typeof f !== "object" || Array.isArray(f)) { console.log("finding " + (i + 1) + " is not a JSON object"); process.exit(1); }
        for (const k of ["id", "fingerprint"]) {
          if (f[k] === undefined && k === "fingerprint") continue;
          if (typeof f[k] !== "string" || f[k] === "") { console.log("finding " + (i + 1) + " has no " + k + " the engine accepts: a non-empty string of at most 64 characters"); process.exit(1); }
          if (f[k].length > 64) {
            const short = require("crypto").createHash("sha256").update(f[k]).digest("hex").slice(0, 16);
            notes.push("verdict-write.sh: note: finding " + (i + 1) + " " + k + " had " + f[k].length + " characters, over the 64 the engine allows; replaced by " + short + ", the start of its sha256");
            f[k] = short;
          }
        }
      }
      fs.writeFileSync(file, JSON.stringify({ ...p, taskId, stepId, recordedAt: new Date().toISOString() }) + "\n");
      for (const n of notes) console.log(n);
    ' "$tmp" "$XEZ_TASK_ID" "$XEZ_STEP_ID" 2>/dev/null)"; then
      rm -f "$tmp"
      refuse "${stamp:-the packet could not be read}"
    fi
    mv -f "$tmp" "$target" || refuse "could not rename the packet into place"
    [ -z "$stamp" ] || printf '%s\n' "$stamp"
    echo "verdict-write.sh: wrote $target"
    ;;
  blocked)
    [ $# -eq 0 ] || usage
    dir="$(evidence_dir)" || exit 1
    tmp="$(atomic_from_stdin "$dir/BLOCKED" "$EVIDENCE_MAX_BYTES")" || exit 1
    mv -f "$tmp" "$dir/BLOCKED" || refuse "could not write BLOCKED"
    echo "verdict-write.sh: wrote $dir/BLOCKED"
    ;;
  evidence)
    [ $# -eq 1 ] || usage
    name="$1"
    case "$name" in
      *[!A-Za-z0-9._-]* | "" | .* ) refuse "\"$name\" is not a plain file name" ;;
    esac
    [ "${#name}" -le 64 ] || refuse "\"$name\" is longer than 64 characters"
    # Phase records are upper-case names with no dot or hyphen (`PLAN`, `SELF_REVIEW`). On a
    # case-insensitive disk `plan` IS `PLAN`, so an evidence name must carry a dot or a hyphen.
    case "$name" in
      *.* | *-*) ;;
      *) refuse "\"$name\" needs a dot or a hyphen (e.g. notes.md); bare names are phase records, written by phase-record.sh set" ;;
    esac
    lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    # Evidence is a record, never a program: a reading step with no Write tool must not get a
    # script into a folder it can then run (#166). A courtesy like review-run.sh's name list, not
    # the boundary – but it keeps the evidence folder holding only what a reader opens.
    case "$lower" in
      *.md | *.txt | *.log | *.json | *.csv | *.png | *.jpg | *.jpeg) ;;
      *) refuse "\"$name\" is not an evidence file: name it .md, .txt, .log, .json, .csv, .png, .jpg or .jpeg" ;;
    esac
    case " $RESERVED_NAMES " in *" $lower "*) refuse "\"$name\" is a file the run itself owns" ;; esac
    dir="$(evidence_dir)" || exit 1
    tmp="$(atomic_from_stdin "$dir/$name" "$EVIDENCE_MAX_BYTES")" || exit 1
    mv -f "$tmp" "$dir/$name" || refuse "could not write $name"
    echo "verdict-write.sh: wrote $dir/$name"
    ;;
  *) usage ;;
esac
