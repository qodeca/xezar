# Frozen contract fixtures

Files in this directory are byte-level API contracts, not illustrative samples. Their sibling
tests parse them through the exported Zod schema and compare canonical pretty-printed JSON with the
committed bytes.

Consumers of these response shapes must ignore unknown object keys. New keys are additive; a
consumer must not reject a newer response merely because it carries facts this version does not
know yet.

For `agent-quota.expected.json`, the `claude` / `qodeca-priv` row is intentionally `unknown`.
The S0 check succeeded but returned no quota percentage lines, so it proved neither available
capacity (`ok`) nor exhaustion (`out`). Treating a successful read with no quota facts as `ok`
would turn “could not determine” into a routing promise.
