# Onboarding skill contract for P2

P1 provides `xez-onboard` in the public `qodeca/xezar-skills` collection.
P2 consumes its reviewed, pinned revision and bundles a fallback with the same
entrypoint, references and templates. This note defines that artifact boundary;
it does not implement a setup entry, update watcher, state writer or fallback.
Related: #464. The skill supports software, campaign/marketing, research and other
projects without requiring a software delivery process.

## Inputs

- Current project/task identity, assigned writable root and local/hosted capabilities.
- Mode: `setup`, `preview` or `recheck`; requested outcome, materials and constraints.
- Existing guidance and decisions, selected/available agent clients, Git metadata
  when present, detected check definitions and actual tool/schema availability.
- Engine identity and a pinned kit digest covering the skill and delivered companions.
- For re-checks: previous template bytes/provenance, current local bytes and new
  pinned defaults. Missing provenance remains unknown; never infer safe replacement.
- On resume: checkpoint, late answers, local/source digests, valid preview,
  applied/pending files and remaining checks. Do not restart from assumed defaults.

## Interactive questions

Ask only unresolved choices: domain (software, campaign/marketing, research or
other), intended outputs, independent versus leader operation, selected client if
ambiguous, base branch when Git exists, and default/custom/no team skills source.
Software pipeline customization is opt-in. QA/design questions apply only where
such gates are relevant; existing mandated policy cannot be weakened.

Use the existing `XEZ:ASK` contract with at most two options per question, a
recommendation and free-text answers. A domain question may name all four domains
while presenting only two plausible suggestions. Keep inspect/ask/preview/apply/
verify in the final interactive step. Unanswered required questions block dependent
writes; timeout is not an answer. Existing scope authorization need not be repeated.

## Write surface

Every edit gets a per-file preview bound to current input digests before applying.
Changes stay in the task worktree (or assigned non-Git directory), with custom
policy and unrelated bytes preserved. Refuse stale previews and path escapes.

- `.xezar/config.json`: only real supported engine choices, not copied defaults.
  Domain, outputs and operation mode are guidance, not invented engine keys.
- `.xezar/pipeline/config.json`: optional software delivery configuration, using
  `xez-setup-agent-pipeline` by name under onboarding's narrower authority.
  Missing descriptors/companions leave this optional portion explicitly incomplete.
- One appropriate project agent guidance file; adapt local evidence and link
  existing policy. Never install another project's kit or competing policy copies.
- Root `.gitignore`: `.local/` protection before local evidence/backups; report
  already tracked runtime files without silently untracking or deleting them.
- Chosen leader client only: `.mcp.json` for Claude Code, `.codex/config.toml`
  for Codex, `.pi/mcp.json` for pi. Merge targeted entries; preserve other servers.
  OpenCode leader setup needs a supported version-matched reference; do not guess.

Independent operation requires no MCP. Home configuration, trust, login, adapter
installation, leader attachment, labels and publication are outside skill writes.
Project snippets are only prepared files until the user integrates and activates them.

## Disposable offer state (P2-owned)

Path: `.local/xezar/onboarding-state.json`, through the project's data helpers.

```json
{
  "engineVersion": "<observed engine identity>",
  "kitDigest": "<observed pinned kit digest>",
  "lastOfferedAt": null,
  "lastCheckedAt": null
}
```

The two identities are non-empty strings. Timestamps are UTC ISO-8601 strings or
null and refer to that observed pair. On an identity change, reset both timestamps
for the new pair. This avoids treating a previous successful check as current.
Record offer time only after offering; record check time only after a successful
scoped check. Keep report-only versus applied status and template provenance in
the task result/checkpoint; the four-field state cannot encode those distinctions.

Absent/corrupt/read-only state must not block boot or ordinary tasks. First use
offers setup without inventing an upgrade baseline. A changed engine or kit offers
**Re-check / Later**; it never launches an agent or edits project files automatically.
Keep an offer timestamp when deferred so the same identity does not nag on restart.
Manual re-check remains available. Concurrent offers need serialized identity-aware
writes in P2; a stale task result cannot mark a newer identity successfully checked.
Downgrades and development identities are changes to inspect, not migration authority.

## Re-check and output

Same identity plus unchanged inputs after a completed check is a quiet no-op;
previous failure remains retryable. Compare previous/local/new templates, classify
additions, local changes, upstream removal and incompatibility, and preserve custom
content. Missing baselines or unavailable pinned sources prevent replacement.
Use `xez-apply-upgrade-notes` by name for an existing software pipeline's dry-run
operation diff; do not duplicate it, bootstrap a pipeline or silently change providers.
Descriptor changes outside this skill's write surface remain scoped follow-ups.

Re-read local and source digests before apply; changed inputs invalidate the preview.
After interruption, reconcile applied/failed/pending files instead of replaying blindly.
Partial failures and unavailable required checks cannot advance `lastCheckedAt`.
An explicitly report-only check can complete only its promised inspection scope;
its result must distinguish proposed changes and follow-ups from applied work.

Return changed files, actual passed/failed/unavailable/not-run checks, what was not
done and why, and a numbered list of remaining user actions: integrate, trust/login,
start the selected client, call a tool, attach using the supported control and verify
delivery. Omit inapplicable leader steps for independent operation. No snippet or
successful command alone proves connection, attachment, delivery or business acceptance.
