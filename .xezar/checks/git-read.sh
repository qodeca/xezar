#!/usr/bin/env bash
# The only git entry point exposed to a read-only kit role (#863).
#
# This is semantic least privilege, not an OS read-only boundary: the caller chooses only a
# reading operation and that operation's deliberately small option grammar. Trusted workflow
# acquisition populates origin/<base> and origin/pr/<n> before the agent starts; fetch is never an
# operation here. The OS boundary that makes the whole process tree read-only is tracked in #879.
set -uo pipefail

usage() {
  printf 'usage: git-read.sh <diff|log|show|rev-parse|status|merge-base|ls-files|cat-file|blame|describe|rev-list|diff-tree> [args...]\n' >&2
  exit 2
}

refuse() {
  printf 'git-read.sh: refused: %s\n' "$1" >&2
  exit 1
}

is_uint() {
  [ -n "$1" ] && case "$1" in *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

safe_format() {
  case "$1" in
    oneline | short | medium | full | fuller | reference | email | raw | \
      '%H' | '%h' | '%s' | '%cI' | '%H %s' | '%h %s') return 0 ;;
    *) return 1 ;;
  esac
}

safe_path() {
  case "$1" in
    '' | /* | .. | ../* | */.. | */../*) return 1 ;;
    *) return 0 ;;
  esac
}

[ "$#" -ge 1 ] || usage
operation="$1"
shift

case "$operation" in
  diff | log | show | rev-parse | status | merge-base | ls-files | cat-file | blame | \
    describe | rev-list | diff-tree) ;;
  *) refuse "operation '$operation' is not allowlisted" ;;
esac

git_bin="$(command -v git 2>/dev/null || true)"
[ -n "$git_bin" ] || refuse "git is unavailable"
case "$git_bin" in /*) ;; *) refuse "git did not resolve to an absolute path" ;; esac

validated=()
after_separator=0
expect_number=""
for argument in "$@"; do
  # An argument array would not execute these as shell syntax, but refusing them keeps the wrapper's
  # contract narrow and makes a future implementation unable to accidentally reinterpret them.
  case "$argument" in
    *';'* | *'&'* | *'|'* | *'<'* | *'>'* | *'`'* | *'$'* | *'('* | *')'* | \
      *$'\n'* | *$'\r'*)
      refuse "shell composition or redirection is not accepted ('$argument')"
      ;;
  esac

  if [ -n "$expect_number" ]; then
    is_uint "$argument" || refuse "$expect_number requires a non-negative integer"
    validated+=("$argument")
    expect_number=""
    continue
  fi

  if [ "$after_separator" -eq 1 ]; then
    safe_path "$argument" || refuse "path '$argument' escapes the repository"
    validated+=("$argument")
    continue
  fi

  if [ "$argument" = "--" ]; then
    after_separator=1
    validated+=("$argument")
    continue
  fi

  if [[ "$argument" == --* ]]; then
    allowed=0
    case "$operation:$argument" in
      diff:--stat | diff:--name-only | diff:--name-status | diff:--no-color | diff:--cached | \
      log:--stat | log:--name-only | log:--name-status | log:--oneline | log:--follow | \
      log:--first-parent | log:--abbrev-commit | log:--no-color | \
      show:--stat | show:--name-only | show:--name-status | show:--oneline | \
      show:--abbrev-commit | show:--no-color | \
      rev-parse:--verify | rev-parse:--short | rev-parse:--abbrev-ref | \
      rev-parse:--show-toplevel | rev-parse:--show-prefix | rev-parse:--git-common-dir | \
      rev-parse:--is-inside-work-tree | rev-parse:--path-format=absolute | \
      status:--short | status:--porcelain | status:--porcelain=v1 | status:--branch | \
      merge-base:--is-ancestor | merge-base:--fork-point | merge-base:--all | merge-base:--octopus | \
      ls-files:--cached | ls-files:--modified | ls-files:--deleted | ls-files:--others | \
      ls-files:--exclude-standard | ls-files:--stage | ls-files:--error-unmatch | \
      blame:--porcelain | blame:--line-porcelain | blame:--show-stats | blame:--first-parent | \
      describe:--tags | describe:--always | describe:--first-parent | describe:--exact-match | \
      describe:--all | describe:--long | \
      rev-list:--count | rev-list:--first-parent | rev-list:--all | rev-list:--objects | \
      rev-list:--oneline | rev-list:--abbrev-commit | rev-list:--no-color | \
      diff-tree:--stat | diff-tree:--name-only | diff-tree:--name-status | \
      diff-tree:--no-color | diff-tree:--root | diff-tree:--no-commit-id | diff-tree:--cc)
        allowed=1
        ;;
      status:--untracked-files=no | status:--untracked-files=normal | status:--untracked-files=all)
        allowed=1
        ;;
      rev-parse:--short=*)
        is_uint "${argument#--short=}" && allowed=1
        ;;
      describe:--abbrev=*)
        is_uint "${argument#--abbrev=}" && allowed=1
        ;;
      describe:--match=?* | describe:--exclude=?*)
        allowed=1
        ;;
      log:--format=* | show:--format=*)
        safe_format "${argument#--format=}" && allowed=1
        ;;
    esac
    [ "$allowed" -eq 1 ] || refuse "option '$argument' is not allowlisted for $operation"
    validated+=("$argument")
    continue
  fi

  if [[ "$argument" == -* ]] && [ "$argument" != "-" ]; then
    allowed=0
    case "$operation:$argument" in
      diff:-p | diff:-w | diff:-M | diff:-C | \
      log:-p | log:-w | log:-M | log:-C | \
      show:-p | show:-w | show:-M | show:-C | \
      cat-file:-e | cat-file:-t | cat-file:-s | cat-file:-p | \
      blame:-w | \
      diff-tree:-p | diff-tree:-w | diff-tree:-M | diff-tree:-C | diff-tree:-r | diff-tree:-m)
        allowed=1
        ;;
      log:-n | show:-n | rev-list:-n)
        allowed=1
        expect_number="$argument"
        ;;
      diff:-U* | log:-U* | show:-U* | diff-tree:-U*)
        is_uint "${argument#-U}" && allowed=1
        ;;
      diff:-M* | diff:-C* | log:-M* | log:-C* | show:-M* | show:-C* | \
      diff-tree:-M* | diff-tree:-C*)
        score="${argument#-?}"
        case "$score" in '' | *[!0-9%]*) ;; *) allowed=1 ;; esac
        ;;
      diff:-S?* | diff:-G?* | log:-S?* | log:-G?* | show:-S?* | show:-G?* | \
      diff-tree:-S?* | diff-tree:-G?*)
        allowed=1
        ;;
      log:-[0-9]* | show:-[0-9]* | rev-list:-[0-9]*)
        is_uint "${argument#-}" && allowed=1
        ;;
    esac
    [ "$allowed" -eq 1 ] || refuse "option '$argument' is not allowlisted for $operation"
    validated+=("$argument")
    continue
  fi

  safe_path "$argument" || refuse "argument '$argument' escapes the repository"
  validated+=("$argument")
done
[ -z "$expect_number" ] || refuse "$expect_number requires a non-negative integer"

# Do not inherit repository selectors, executable paths or config injection from the caller.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
unset GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_EXEC_PATH GIT_EXTERNAL_DIFF
unset GIT_NAMESPACE GIT_INDEX_FILE GIT_SHALLOW_FILE GIT_CEILING_DIRECTORIES
unset GIT_DISCOVERY_ACROSS_FILESYSTEM
export GIT_PAGER=cat
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_ATTR_NOSYSTEM=1
export GIT_OPTIONAL_LOCKS=0

fixed=(
  --no-pager
  --no-replace-objects
  --literal-pathspecs
  -c diff.external=
  -c core.pager=cat
  -c core.hooksPath=/dev/null
  -c core.fsmonitor=
  -c 'diff.*.textconv='
)
case "$operation" in
  diff | log | show | diff-tree)
    exec "$git_bin" "${fixed[@]}" "$operation" --no-ext-diff --no-textconv "${validated[@]}"
    ;;
  blame)
    exec "$git_bin" "${fixed[@]}" blame --no-textconv "${validated[@]}"
    ;;
  *)
    exec "$git_bin" "${fixed[@]}" "$operation" "${validated[@]}"
    ;;
esac
