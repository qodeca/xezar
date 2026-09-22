# Audit trail

xezar keeps a per-project audit trail of who changed run state or configuration, and whether each attempt was applied or refused. It records only changes, never reads, and an entry is a record, not a permission — nothing in xezar consults it in place of an actual access check.

## Where it lives

Each project keeps its own trail at `<project>/.local/xezar/audit.ndjson` — the same working-files location in both layouts described in [Configuration reference](11-configuration-reference.md#to-find-where-the-files-live-in-each-layout). It is a plain NDJSON file, one JSON record per line, oldest first. There is no cockpit page or API route that displays it: read it from a shell on the machine running xezar, for example with `tail -f` or `jq`.

An older `mcp-audit.ndjson` file, written by xezar 0.14.0–0.15.0, is read-only from 0.16.0 on: xezar reads it only while `audit.ndjson` does not exist, prints one line the first time it does —

```text
xezar: mcp-audit.ndjson is deprecated; reading it read-only (removal not before 0.18.0)
```

— and never writes, renames or deletes it. The two files are never merged, so keep the old one only if you want to consult its earlier entries by hand; it will not be removed before 0.18.0.

## The four doors

Every record carries a UTC `ts`, a sequence number that grows by one per record, and an `actor` naming which door produced it:

| Door | Where a change comes from | `actor` |
| --- | --- | --- |
| `ui` | The cockpit's own HTTP routes | `{type: 'ui'}`, plus `proxyUser` when a hosted reverse proxy asserts one |
| `mcp` | A project leader's MCP tool calls | `{type: 'mcp'}` |
| `automation` | A GitHub automation that launched a run | `{type: 'automation', receiptId}` |
| `cli` | A headless `xezar` command | `{type: 'cli', command}` |

Only run-state changes and configuration writes are recorded, never a read. Whether an MCP call is recorded depends on the specific action, not on whether its tool is otherwise read-only, so a preview or dry-run call inside a mutating tool writes nothing. A record's outcome is either `applied` or `refused` with a short machine reason (`http_409`, `conflict`, `not_found`, and similar); an operation whose effect may have started and then failed is not recorded at all, and xezar instead prints one warning per project per process that the action continued without an audit record. A failed audit write never changes the operation's own result.

A hosted deployment behind a reverse proxy should set the `X-Xezar-User` header to the authenticated user so `ui`-door records can name who made a change — the bundled nginx site already does this. An unset header still records the change, just without a `proxyUser`.

## Rotation

A live `audit.ndjson` is rotated **before** an append would take it past 10,000,000 bytes, keeping five files in total: the live file plus `audit.ndjson.1` (newest) through `audit.ndjson.4` (oldest); a sixth generation is never created. Rotation writes a `rotated` marker as the new live file's first line, so a reader that expects only ordinary action lines should skip it. Sequence numbers are continuous across the whole retained set — reading the full history means reading `.4`, `.3`, `.2`, `.1`, then the live file, in that order. Every retained file, live one included, is kept at file mode `0600`.

## Redaction

An audit record never stores a value — only identifiers, resource kinds, sorted field names and a SHA-256 digest. Free text such as prompts, messages and titles, along with paths, URLs and a request's own credentials, is stripped before that digest is taken, so the digest shows *that* something changed and *which keys* changed, never *what it changed to*. A cockpit configuration write (Settings, agent config, the workspace pair, a project's tags or pinned port) therefore records only the top-level key names that changed.

A value that matches one of the host's own secret environment values, or a well-known token shape, is dropped from the record entirely rather than masked in place — including when it is written in a disguised form, such as literal `\uXXXX` JavaScript/JSON escape sequences instead of its normal characters. xezar decodes those escapes before checking, so a secret cannot hide from redaction just by being escaped.

## Limits, honestly

The audit trail is best effort and local: there is no cockpit viewer, no cryptographic chain between records, and nothing stops someone with shell access to the machine from editing or deleting `audit.ndjson` directly. Treat it as a diagnostic and compliance aid for changes made through xezar's own doors, not as tamper-evident storage.

## Related settings / env / config

- [`BACKWARD_COMPATIBILITY.md`](../../BACKWARD_COMPATIBILITY.md) § "Project state files" for the full record shape, every settlement reason, and the complete rotation and locking contract.
- [Projects](09-projects.md) and [Configuration reference](11-configuration-reference.md) for where `.local/xezar/` lives in the global and single-project layouts.
- [Project layout](../project-layout.md) for the surrounding `.local/xezar/` directory.

Next: [User guide index](README.md)

Describes xezar 0.18.0.
