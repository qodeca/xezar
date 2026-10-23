# shellcheck shell=sh
# The ONE place that names the agent-browser release this repository installs: CI (`ui-e2e` in
# .github/workflows/ci.yml), the local test environment (scripts/test-env-up.sh) and the install
# snippets in docs/testing/agent-browser.md all read it. Sourced, never executed; POSIX sh only.
#
# A downloaded binary runs only when its SHA-256 matches the value below for its asset. To move
# the pin, change the version and every hash together, from the release's own asset digests:
#   gh release view v<version> --repo vercel-labs/agent-browser --json assets \
#     --jq '.assets[] | "\(.digest) \(.name)"'
# and re-compute at least one of them from a download you do not run.

AGENT_BROWSER_VERSION=0.39.1

# The pinned SHA-256 of one release asset. Non-zero for an asset this pin does not cover.
agent_browser_sha256() {
  case "$1" in
    agent-browser-darwin-arm64) echo cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef ;;
    agent-browser-darwin-x64) echo 339cb9aa6dfd404856cf938df34cd3b4779c61dfd57fc257be11b14fd1a885f9 ;;
    agent-browser-linux-arm64) echo 9d8fdc586056df65747927ae166157c83af91b52cea287175e5544afd2591d33 ;;
    agent-browser-linux-musl-arm64) echo c4959f3e193c5bc8f333613363f25f2eaceecafe25a0821843b271906474a20f ;;
    agent-browser-linux-musl-x64) echo 74507cdab98aa91bdc14346c545aff974640a225e43f8c3d6c23164f8c0f9bb9 ;;
    agent-browser-linux-x64) echo 6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc ;;
    agent-browser-win32-x64.exe) echo af1ff5f2afd5c187fb50ac3bbc1e7114baadc180d67cef63f644af9031be5049 ;;
    *) return 1 ;;
  esac
}

# The download URL of one asset of the pinned release.
agent_browser_url() {
  echo "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/$1"
}

# The SHA-256 of a file, in lowercase hex, with whichever tool this system has: GNU or BSD
# `sha256sum`, Perl's `shasum` (macOS, Git for Windows) or `openssl`. Non-zero when none works.
sha256_of() {
  _sha=
  if command -v sha256sum >/dev/null 2>&1; then
    _sha=$(sha256sum "$1" 2>/dev/null | awk '{print $1}')
  fi
  if [ -z "$_sha" ] && command -v shasum >/dev/null 2>&1; then
    _sha=$(shasum -a 256 "$1" 2>/dev/null | awk '{print $1}')
  fi
  if [ -z "$_sha" ] && command -v openssl >/dev/null 2>&1; then
    _sha=$(openssl dgst -sha256 -r "$1" 2>/dev/null | awk '{print $1}')
  fi
  _sha=$(printf '%s' "$_sha" | tr 'A-F' 'a-f')
  case "$_sha" in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ "${#_sha}" -eq 64 ] || return 1
  echo "$_sha"
}

# Zero only when <file> is exactly the pinned bytes of <asset>. Fails closed: an unknown asset,
# a missing file or no hashing tool all count as a mismatch.
agent_browser_verify() {
  _expected=$(agent_browser_sha256 "$1") || return 1
  [ -f "$2" ] || return 1
  _actual=$(sha256_of "$2") || return 1
  [ "$_actual" = "$_expected" ]
}
