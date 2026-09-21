## 🔧 Changed

- 🔧 **An MCP refusal now outranks an unknown argument, and an argument error says what the action
  takes.** A `project_config` action that is always refused (connecting a provider, the project
  registry, applying skill updates, …) answers its refusal even when the call also carries a key the
  tool does not know, instead of `Unrecognized key` – the refusal still dispatches nothing, never
  offers an approval route and never echoes an argument. An unknown key on any other call now also
  reports what the call was missing (`set_provider_enabled needs provider`) and ends with
  `Accepted for <action>: … (required); … (optional).`, read from the tool's own argument table.
  `leader_events` `status` and `read` accept an `operationId` and ignore it rather than refusing
  it; they still file no receipt. `set_provider_enabled`'s `provider` and `enabled` arguments exist
  from 0.17.0; on 0.16.0 the action was refused and had neither argument. (#819)
