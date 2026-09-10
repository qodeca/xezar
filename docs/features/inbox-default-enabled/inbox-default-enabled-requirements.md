# Inbox enabled by default — business requirements

Date: 9 September 2026  
Business stakeholder: Marcin Obel  
Status: Draft — reported requirement, with scope to clarify before implementation.

## Reported requirement

After learning that Inbox is a separate section, currently disabled by default, which collects agents' suggestions for further work, Marcin said: “myślę, że to jest coś, co powinno być w ogóle domyślnie włączone” (“I think this is something that should be enabled by default”).

The reported requirement is to enable the existing Inbox by default. Keep it as a separate section, consistent with the current UI. The conversation has not yet established whether this means making the section visible by default only, or also asking agents to collect follow-up suggestions by default. Do not infer the second decision from the first.

**Rationale — interpretation:** making suggestions for further work easier to discover may help users notice useful next steps. This is an interpretation of the request, not an independently confirmed business objective.

## Verified current behavior

The following repository sources were read on the date above. They describe current behavior, not the approved scope of a default change.

| Source | Observation |
| --- | --- |
| `README.md`, views and environment-variable tables | Inbox is opt-in and hidden by default. Enabling it both shows the view and asks agents to leave follow-ups. Per-task Notes are independent and work either way. As of 10 September 2026 the mechanism is no longer the env var alone: `followups` is a stored tri-state key in `~/.xezar/config.json`, set from Settings → Resources (`packages/web/src/routes/settings/resources-section.tsx`), and the stored value wins over `XEZ_FOLLOWUPS` with no restart. Absent inherits the env; explicit `null` clears back to it. |
| `packages/web/src/routes/inbox.tsx` | Inbox is a separate route/view. When disabled, a direct visit explains that it is off. Runnable suggestions offer Run, which starts a task and opens its task view. Dismiss removes an entry. Entries already started are hidden from the pending Inbox. Not every entry is necessarily runnable. |
| `packages/xezar/src/todos.ts` | Suggestions are stored in `todos.json`. Dismiss deletes the entry. Starting a suggestion records its task ID and retains the entry as an audit trail, while the UI hides it. |

## Additional conversation context

Inbox was described in the conversation as a simple backlog of agents' suggestions for further work. This describes the existing suggestions collection and its Run/Dismiss flow, as verified in the sources above; it does not add a full backlog-management feature. Marcin's question about GitHub was exploratory. No decision was made to import or synchronize GitHub issues into Inbox.

## Scope and boundaries

- Change the default of the existing Inbox capability once the visibility-versus-collection question is resolved; retain a separate Inbox section.
- Preserve the existing meaning of Run and Dismiss. Enabling Inbox is not permission to execute suggestions automatically.
- Keep per-task Notes independent.
- Do not expand Inbox into a full backlog product or introduce prioritization. GitHub issue import or synchronization is not agreed and is outside this draft's requested default-enablement change.
- This is a separate feature from the Tasks view redesign. It does not add tentative backlog ideas to Planned and does not block continued Tasks analysis.
- This deliverable is analysis and documentation only. It does not change code, configuration, defaults, or agent prompts, and includes no commit or push.

## Open business decisions

1. **Visibility versus collection:** should only the Inbox section be visible by default, or should agents also be asked to produce follow-up suggestions by default? If visibility only is intended, clarify how the user should understand a visible section while collection remains off.
2. **Explicit opt-out:** define how deliberate disabling should behave under the new default. Which existing explicit choices must remain respected, and how should a user turn Inbox off? No override of an explicit opt-out is agreed here. *(The mechanism this decision would attach to now exists: a stored `followups: false` is an explicit opt-out, set from Settings → Resources and outranking the env var. The business decision is still open; the "how does a user turn it off" half is answered.)*
3. **Existing installations:** should the new default apply to existing installations as well as new ones? Distinguish an unset preference from an explicit choice; upgrade behavior is not yet agreed. *(The technical distinction this asks for is built and enforced: absent, explicit `null` and an explicit value are three different states in the stored schema. Only the policy question remains.)*

The team can select the technical implementation after these outcomes are clear. The implementable route is no longer a change to an environment variable's default or a new flag: it is the schema default of the stored `followups` key in `packages/xezar/src/workspace/config.ts`. `.env.example` already documents the new precedence, and `AGENTS.md` § Zero config now names "an env var gaining a stored config key that supersedes it" as a case its documentation rule covers.

## Acceptance criteria to finalize

The following criteria express the reported direction and existing behavior to preserve. Default collection, opt-out, and upgrade outcomes must be filled in from the open decisions before implementation acceptance.

| ID | Scenario | Expected result |
| --- | --- | --- |
| AC-01 | Open the application under the agreed default conditions. | Inbox is available as its own section without the previous manual enablement step, subject to the agreed opt-out and installation policy. |
| AC-02 | Complete a task under the new default. | Whether agents are asked to leave suggestions follows the explicit collection decision; visibility alone is not treated as that decision. |
| AC-03 | Run an existing runnable suggestion. | A task is created and opened through the existing flow; the started suggestion leaves the pending Inbox and retains its existing audit record. |
| AC-04 | Dismiss a suggestion. | The entry is removed through the existing behavior. |
| AC-05 | Use per-task Notes with Inbox enabled or disabled. | Notes remain independently available. |
| AC-06 | Start with an explicit opt-out or upgrade an existing installation. | Behavior matches the separately agreed opt-out and upgrade policy; no policy is silently invented. The opt-out is a stored `followups: false`, which outranks `XEZ_FOLLOWUPS` and needs no restart; an unset preference and an explicit `null` must stay distinguishable from it. |
| AC-07 | Review the delivered scope. | Inbox remains a separate suggestions section. No full backlog, prioritization, automatic execution of suggestions, or expansion of Planned to tentative ideas is introduced. |

## Readiness

This draft records the request faithfully but is not ready for implementation until the default's scope, explicit opt-out, and existing-installation behavior are settled. The separate Tasks requirements and their latest decisions remain unchanged.
