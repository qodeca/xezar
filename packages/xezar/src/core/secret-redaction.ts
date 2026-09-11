/**
 * Redact credentials before they are persisted to a run's NDJSON transcript
 * (#427). Tool-result output is written verbatim to disk and served back over
 * the API, so the moment an agent runs a command whose output contains a
 * secret (`printenv`, `cat ~/.aws/credentials`, …) that secret would land in
 * `.local/xezar/` — violating the "No secrets in state files" invariant
 * (AGENTS.md / CODE_REVIEW.md).
 *
 * Two complementary strategies:
 *   1. Value-based — the concrete values of the host's own secret-named env
 *      vars (GITHUB_TOKEN, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, …). If
 *      any of them appears in event text, it is scrubbed.
 *   2. Pattern-based — well-known token shapes (gh*, sk-*, AKIA*, AIza*,
 *      xox*-*) so secrets that never lived in xezar's own env are still caught.
 *
 * Zero-config: redaction is on by default; `XEZ_REDACT_SECRETS=0` opts out.
 */

export const REDACTED = '[REDACTED]';

/**
 * Names that look like a credential — the single source of truth for "is this
 * var a secret?", shared with `agent-env.ts` (#427 review). The two used to
 * carry near-identical but subtly different lists, so a var could be stripped
 * from the child env yet never collected for redaction (or vice versa). One
 * constant, one answer: what we refuse to forward is exactly what we scrub.
 */
export const SECRET_NAME_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|_KEY_|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|_AUTH$|_AUTH_|SESSION|COOKIE|PASSPHRASE)/i;

/** Names matched above whose value is NOT a secret (a socket path, a pid, a
 *  desktop-session id) — collecting them would scrub ordinary paths from the
 *  transcript for no benefit. */
const SECRET_VALUE_NAME_ALLOW: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SESSION_MANAGER',
  'SESSIONNAME',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_CLASS',
  'XDG_SESSION_DESKTOP',
]);

/**
 * Below this length a "secret" value is too common a word to redact safely.
 * Verified over-redaction at the old floor of 8 (#427 review): a dev box with
 * `POSTGRES_PASSWORD=postgres` turned `apt install postgresql-16` into
 * `apt install [REDACTED]ql-16` in the transcript. Real credentials (API keys,
 * PATs, AWS secrets) are 20+ chars, so 12 keeps the catch rate while putting
 * short dictionary words — the whole source of false positives — out of reach.
 * Pattern-based redaction below is unaffected: it matches token *shapes*, not
 * env values, and still catches short-but-real tokens.
 */
const MIN_SECRET_LEN = 12;

/**
 * Well-known credential shapes, independent of the host env.
 *
 * Case (#272): a shape matched in one case only let the same credential through in another. A
 * shape is case-insensitive (`i`) unless its prefix, matched in any case, collides with ordinary
 * text — those stay case-sensitive, and each says why. An AWS key id is upper-case letters and
 * digits only, so a lower-cased copy loses nothing; its any-case form is a separate, whole-token
 * pattern, because `asia`/`akia` open ordinary identifiers (`asiaPacificRegionConfig`).
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/gi, // GitHub PAT / OAuth / server / user / refresh
  // Case-sensitive: `GITHUB_PAT_…` in any case is also an env var NAME, which `printenv` prints.
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  // Case-sensitive: `SK-` in any case is the tail of `TASK-` / `RISK-` / `DISK-` issue keys and
  // branch names. The key body is already any case, so only an upper-cased prefix escapes.
  /sk-ant-[A-Za-z0-9-_]{20,}/g, // Anthropic
  /sk-[A-Za-z0-9-_]{20,}/g, // OpenAI & compatible
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
  /(?<![0-9A-Za-z])A[KS]IA[0-9A-Z]{16}(?![0-9A-Za-z])/gi, // either AWS key id, in any case
  /AIza[0-9A-Za-z_-]{35}/gi, // Google API key
  /ya29\.[0-9A-Za-z_-]+/gi, // Google OAuth access token
  /xox[baprs]-[0-9A-Za-z-]{10,}/gi, // Slack
  /glpat-[0-9A-Za-z_-]{20,}/gi, // GitLab PAT
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `encodeURIComponent`, except a lone surrogate (which it throws on) yields nothing to match. */
function urlEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Collect the concrete secret values present in `env` (deduped, longest
 *  first so a value that contains another is replaced whole). */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LEN) continue;
    if (SECRET_VALUE_NAME_ALLOW.has(name.toUpperCase())) continue;
    if (SECRET_NAME_RE.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Replace every known secret value / token shape in `text` with `[REDACTED]`.
 *
 * A known value matches in any case (#272 — a hex secret printed upper-cased is the same secret)
 * and in its URL-encoded form (a password inside a connection string). A non-string throws rather
 * than passing through; every caller either never hands one over or drops what it was writing.
 */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let out = text;
  let lowered: string | undefined;
  for (const value of secretValues) {
    const encoded = urlEncoded(value);
    for (const form of encoded === undefined || encoded === value ? [value] : [value, encoded]) {
      // Prefilter against the input: a replacement only removes text, so a form absent from the
      // input is absent from `out`. The exact check keeps the old match whatever `toLowerCase` does.
      lowered ??= text.toLowerCase();
      if (!text.includes(form) && !lowered.includes(form.toLowerCase())) continue;
      out = out.replace(new RegExp(escapeRegExp(form), 'gi'), REDACTED);
    }
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Deep-copy `value`, redacting every string leaf. Structure/keys are
 * preserved; only string values (and string keys are left untouched — keys are
 * event field names, never secrets) are scrubbed.
 */
export function redactDeep<T>(value: T, secretValues: readonly string[]): T {
  if (typeof value === 'string') {
    return redactSecrets(value, secretValues) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, secretValues)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, secretValues);
    }
    return out as T;
  }
  return value;
}
