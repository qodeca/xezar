#!/usr/bin/env bash
# Write a verdict role's machine-readable packet, atomically, from stdin.
#
# Why this exists (#849 D). `code-review`, `design-review` and `qa` run with a `bashAllowlist`
# and no `Edit`/`Write` tool. Under Claude Code's `--permission-mode dontAsk` a shell redirect
# (`… > "${XEZ_HANDOFF_FILE}.verdict.json.tmp"`) is refused even into a directory passed with
# `--add-dir`, and a command that expands `${XEZ_HANDOFF_FILE}` matches no `Bash(<prefix>:*)`
# rule at all — both measured live against claude 2.1.278. So the skills' "write the .tmp, then
# `mv` it onto the final name" could not be done from those roles' shells. This script is the one
# write the allowlist grants for it: one entry, `bash .xezar/checks/verdict-packet.sh`, whose only
# target is `${XEZ_HANDOFF_FILE}.verdict.json`.
#
# Usage:
#   jq -n '{…}' | bash .xezar/checks/verdict-packet.sh
#   bash .xezar/checks/verdict-packet.sh < packet.json
#
# It writes `${XEZ_HANDOFF_FILE}.verdict.json.tmp`, checks that it parses as one JSON object, and
# renames it onto `${XEZ_HANDOFF_FILE}.verdict.json`. It validates nothing the engine validates
# (ids, bounds, labels): the engine stays the one judge of the packet, and refuses a bad one.
#
# Exit 0 when the packet is in place, 1 on a refusal (no XEZ_HANDOFF_FILE, empty or non-JSON
# input), 2 on usage.
set -uo pipefail

case "${1:-}" in
  "") ;;
  --help | -h)
    sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    printf 'verdict-packet: takes no arguments; the packet is read from stdin\n' >&2
    exit 2
    ;;
esac

if [ -z "${XEZ_HANDOFF_FILE:-}" ]; then
  printf 'verdict-packet: XEZ_HANDOFF_FILE is not set, so there is no verdict path to write\n' >&2
  exit 1
fi

final="${XEZ_HANDOFF_FILE}.verdict.json"
tmp="${final}.tmp"

if ! cat > "$tmp"; then
  printf 'verdict-packet: could not write %s\n' "$tmp" >&2
  rm -f "$tmp"
  exit 1
fi
if [ ! -s "$tmp" ]; then
  printf 'verdict-packet: stdin was empty; nothing written\n' >&2
  rm -f "$tmp"
  exit 1
fi
if ! node -e '
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (v === null || typeof v !== "object" || Array.isArray(v)) process.exit(1);
' "$tmp" 2>/dev/null; then
  printf 'verdict-packet: stdin is not one JSON object; nothing written\n' >&2
  rm -f "$tmp"
  exit 1
fi
if ! mv -f "$tmp" "$final"; then
  printf 'verdict-packet: could not rename %s onto %s\n' "$tmp" "$final" >&2
  rm -f "$tmp"
  exit 1
fi
printf 'verdict-packet: wrote %s\n' "$final"
