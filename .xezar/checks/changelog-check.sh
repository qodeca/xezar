#!/usr/bin/env bash
# Structural check for CHANGELOG.md. Exists because two fix PRs (#23, #26) each added their own
# `# Unreleased` section in different places, and the 0.11.1 release had to consolidate them by
# hand (issue #31). Nothing else in the repository looks at the heading structure.
#
# Refuses when:
#   - more than one `# Unreleased` heading exists;
#   - an `# Unreleased` heading sits BELOW a dated release heading `# <semver> (`, which breaks
#     the reverse-chronological order (newest first);
#   - with --require-version <v>: any `# Unreleased` heading remains, or the count of
#     `# <v> (` headings is not exactly one.
#
# Only top-level `# ` headings count. `## ...` group headings and prose that mention the word
# are ignored, and a fenced code block never contains a heading this check would read as one.
#
# Read-only. Exit 0 on pass, 1 on a structural failure, 2 on bad usage or a missing file.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: changelog-check.sh [--file <path>] [--require-version <semver>]

  --file <path>              the changelog to check (default: CHANGELOG.md in the CWD)
  --require-version <semver> also require exactly one "# <semver> (" heading and no "# Unreleased"
EOF
}

file="CHANGELOG.md"
require=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) [ $# -ge 2 ] || { usage >&2; exit 2; }; file="$2"; shift 2 ;;
    --require-version) [ $# -ge 2 ] || { usage >&2; exit 2; }; require="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'changelog-check: unknown argument %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$require" ] && ! printf '%s' "$require" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  printf 'changelog-check: --require-version wants a semver like 0.11.2, got "%s"\n' "$require" >&2
  exit 2
fi
if [ ! -f "$file" ]; then
  printf 'changelog-check: %s does not exist\n' "$file" >&2
  exit 2
fi

fail=0
say() { printf 'changelog-check: %s\n' "$1" >&2; fail=1; }

# Walk the top-level headings in file order, ignoring fenced code blocks. Every dated release
# heading raises `seen_dated`; an Unreleased heading after that point is out of order.
unreleased=0
in_fence=0
seen_dated=0
misplaced=0
version_count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '```'*) if [ "$in_fence" -eq 0 ]; then in_fence=1; else in_fence=0; fi; continue ;;
  esac
  [ "$in_fence" -eq 0 ] || continue
  case "$line" in
    '# '*) ;;
    *) continue ;;
  esac
  if printf '%s' "$line" | grep -Eq '^# Unreleased[[:space:]]*$'; then
    unreleased=$((unreleased + 1))
    [ "$seen_dated" -eq 0 ] || misplaced=1
    continue
  fi
  if printf '%s' "$line" | grep -Eq '^# [0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)? \('; then
    seen_dated=1
    if [ -n "$require" ] && printf '%s' "$line" | grep -Fq "# $require ("; then
      version_count=$((version_count + 1))
    fi
  fi
done < "$file"

[ "$unreleased" -le 1 ] || say "$file has $unreleased '# Unreleased' headings; fold them into one section"
[ "$misplaced" -eq 0 ] || say "$file has an '# Unreleased' heading below a dated release heading; Unreleased must be the first section"
if [ -n "$require" ]; then
  [ "$unreleased" -eq 0 ] || say "$file still has an '# Unreleased' heading; version $require must absorb it"
  [ "$version_count" -eq 1 ] || say "$file has $version_count '# $require (' headings; expected exactly one"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
if [ -n "$require" ]; then
  printf 'changelog-check: OK — one "# %s (" heading, no "# Unreleased"\n' "$require"
else
  printf 'changelog-check: OK — %d "# Unreleased" heading(s), in order\n' "$unreleased"
fi
