# Frozen contract fixtures

Files in this directory are byte-level API contracts, not illustrative samples. Their sibling
tests parse them through the strict producer Zod schema, compare canonical pretty-printed JSON with
the committed bytes, and pin the bytes to an independently reviewed SHA-256 digest.

`agent-quota.expected.json` is anchored by SHA-256
`967b5b4c67401ad7c0fd49808d6526cae0fc4e430fd1038d709b05427f35d930`. A deliberate fixture
change updates this README anchor and the test constant together.

Readers of `agent-quota` answers use `agentQuotaResponseSchema`, the tolerant consumer schema.
It strips unknown object keys and accepts unknown `notReported` names while enforcing null pairing
for the known facts. Producers and fixture checks use `agentQuotaProducerResponseSchema`, which
rejects unknown keys and names. New keys are additive; an older consumer must not reject a newer
response merely because it carries facts that version does not know yet.

For `agent-quota.expected.json`, the `claude` / `qodeca-priv` row is intentionally `unknown`.
The S0 check succeeded but returned no quota percentage lines, so it proved neither available
capacity (`ok`) nor exhaustion (`out`). Treating a successful read with no quota facts as `ok`
would turn “could not determine” into a routing promise.

An account is never `status: "ok"` when any reported `shortWindow`, `weeklyWindow`, or
`modelWindows[]` entry has `usedPercent` greater than or equal to 100.
