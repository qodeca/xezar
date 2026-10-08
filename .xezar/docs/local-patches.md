# Local patches – keeping kit edits visible to an upgrade

`.xezar/onboarding.json` records, for every file this setup installed, a SHA-256 digest and an
**origin**: `copied` (the kit file as it ships), `adapted` (the kit file with this project's values
filled in), `generated` (written for this project; the kit has no source file) or
`owner-file-appended` (an owner file with one kit block appended). An upgrade uses that record to
tell an untouched file, which it may replace, from one this project changed, which it must merge.

So a file that changes in place without a record is a trap: its digest says "untouched", and an
upgrade that believes it overwrites the change. `.xezar/checks/manifest-drift.mjs` closes the trap.
It runs in `repository-checks.sh`, so every gate run re-hashes every recorded file.

## What the manifest tracks

The setup's machinery: every file installed from the kit, including the leader guide. It does
**not** track the project's own documents, which the pipeline's roles edit in normal work:
`AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`, `SECURITY.md`, the
`CLAUDE.md` files, the designs index and the campaign folders. Nor does it track the project's
configuration – `.xezar/config.json`, `.xezar/pipeline/config.json`,
`.xezar/pipeline/labels.json` and `.xezar/routing.json` – which routing changes, new gate
commands, label changes and design-module status updates edit as ordinary work; the security
scan's trust boundary and `route.mjs --check` guard those instead. Nor does it track a file the
project already had that the setup merged into without a kit block (`.mcp.json`,
`.codex/config.toml`, the root `.gitignore`), or any gitignored file. A manifest that still lists
one of these documents, configuration files or merged files (written by an earlier 3.1.0 build)
is not failed for it: the drift check ignores that entry. `.xezar/onboarding.json` and `.xezar/LOCAL-PATCHES.md` never list themselves.

For an `owner-file-appended` file, only the block from `<!-- xezar:kit:start -->` to
`<!-- xezar:kit:end -->`, both markers included, is the kit's and is hashed. The rest is the owner's.

## The register – `.xezar/LOCAL-PATCHES.md`

One file per project, created with its first entry. Each entry is one heading and five fields:

```markdown
## LP-3 – skip ci-watch for conflict repairs
- Files: .xezar/checks/ci-watch.sh, .xezar/workflows/address-review-findings.yaml
- Reason: conflict repairs do not merge the base, so ci-watch waits forever
- Upstream: qodeca/xezar-skills#54
- Since: 2026-09-25
- Confirmed: yes
```

- The heading is `## LP-<n> – <title>`, with an en dash or a hyphen. Ids are unique, and a removed
  id is never used again.
- All five fields are required, once each: `Files` (comma-separated repository paths – one entry
  may cover several files), `Reason` (one line), `Upstream` (`<owner>/<repo>#<n>` for the issue
  that would make the patch unnecessary, or `local only`), `Since` (`YYYY-MM-DD`), `Confirmed`
  (`yes` or `no`).
- Other text between entries is ignored, so the file can carry an introduction.

## Recording a local patch

1. Change the file.
2. Add a register entry, or add the path to an existing entry's `Files`.
3. In `.xezar/onboarding.json`, add `"patch": "LP-<n>"` to that file's entry. Leave its `sha256`
   and `origin` as they are: they describe what was installed, which is the base an upgrade
   merges from. A patched file is not re-hashed; the register entry is its record.
4. Commit all three together, so a reviewer sees the change and its reason in one pull request.

**Confirmed.** An entry an agent or the upgrade drafted says `Confirmed: no`, and the check fails
until the owner reads it and changes it to `yes`. Only the owner makes that change.

**Owner content is not a patch.** A rule added to the leader guide through `xez-add-rule` is the
owner's own words in the guide's owner section; that skill refreshes the guide's recorded digest
in the same commit instead of adding a register entry.

**Removing a kit file on purpose.** A deletion is a local patch like any other: delete the file,
add a register entry listing it, and add `"patch": "LP-<n>"` to its manifest entry, which stays
in the manifest. The check then accepts the absence, and an upgrade keeps the file removed
instead of adding it back as new.

**Undoing a patch.** Restore the kit's file, remove the `patch` key, and remove the path from the
entry (the whole entry when it was the last path). An upgrade that finds the change already
upstream drafts this removal for you.

## What the check says

`drift-status=pass`, `fail` or `not-applicable`, then one `drift=<path> origin=<origin>
reason=<reason>` line per problem. Exit 0 for pass or not-applicable, 1 for fail, 2 when the
manifest or the register cannot be parsed.

| Reason | Meaning | What to do |
|---|---|---|
| `hash-mismatch` | The file changed and nothing records why (also: a link, or a path leaving the repository). | Record it as a local patch, or restore the file. |
| `missing` | The manifest lists a file the tree does not have, and its entry carries no `patch`. | Restore it, or record the removal as a local patch (above). |
| `unregistered-patch` | The entry names `LP-<n>`, but the register has no such entry or it does not list this file. | Add the entry or the path. |
| `unconfirmed-patch` | The entry says `Confirmed: no`. | The owner reads it and sets `yes`. |
| `register-without-manifest` | The register lists a path whose manifest entry does not carry that patch (`origin=none`: no entry at all). | Add the `patch` key, or remove the path from the register. |

A manifest without `manifestVersion` (written before 3.1.0) records no digest anybody can trust,
so the check prints `not-applicable` and passes until the 3.1.0 upgrade rewrites the manifest.
