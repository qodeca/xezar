import { AuditTrail, type AuditChannel, type AuditScope } from '../mcp/audit-trail.ts';
import type { AutomationDefinition } from './types.ts';

/**
 * The automation door of the audit trail (#306, part 2) — spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 4 (`automation` row) and § 9.
 *
 * One NEW record per run the automation runner launches, written beside the receipt transition
 * (`ProjectAutomationScheduler.launch`) and linked to it through `actor.receiptId`. The receipt is
 * reserved BEFORE launch, so the id in the record is always the id of a receipt that exists.
 *
 *   - launched → `applied`, `resource: { kind: 'run', id }`;
 *   - a refusal known to come before any run exists (`AutomationLaunchRefusal`) → `refused` with its
 *     code, `resource: { kind: 'automation', id }`;
 *   - any other launch error may have come after a run was created → no record, one warning.
 * A duplicate receipt, a held lease, a disabled capability, a filter miss and a preview launch
 * nothing and write nothing. The manual "check now" is ALSO recorded by the door that received it
 * (`automation.checkExecute` from `ui` or `mcp`); the runs it launches are this door's records.
 *
 * The digest covers `{ automationId, revision, event }` only — never the candidate's title, body,
 * author, labels, URL or the rendered task (§ 9).
 */

export const AUTOMATION_LAUNCH_ACTION = 'automation.launch';

/** A launch refused before any run exists — a bad step list or an unknown workflow. Its message is unchanged. */
export class AutomationLaunchRefusal extends Error {
  constructor(
    readonly code: 'invalid_steps' | 'unknown_workflow',
    message: string,
  ) {
    super(message);
    this.name = 'AutomationLaunchRefusal';
  }
}

export interface AutomationAudit {
  /** Both resolve once the record is written or dropped with its one warning; neither ever rejects. */
  launched(definition: AutomationDefinition, event: string, receiptId: string, runId: string): Promise<void>;
  failed(definition: AutomationDefinition, event: string, receiptId: string, error: unknown): Promise<void>;
}

/** One trail per project per process, so the one warning is per project. */
const channels = new Map<string, AuditChannel<'automation'> | null>();

/** The recorder for one project's automation runner. Never throws; an `undefined` scope records nothing. */
export function automationAudit(scope: AuditScope | undefined, warn?: (message: string) => void): AutomationAudit {
  const channel = (): AuditChannel<'automation'> | undefined => {
    if (!scope) return undefined;
    const key = JSON.stringify([scope.projectId, scope.dataDir]);
    if (!channels.has(key)) {
      try {
        channels.set(key, new AuditTrail(scope, warn ? { warn } : {}).channel('automation'));
      } catch {
        channels.set(key, null);
      }
    }
    return channels.get(key) ?? undefined;
  };
  const op = (definition: AutomationDefinition, event: string, receiptId: string) => ({
    action: AUTOMATION_LAUNCH_ACTION,
    actor: { receiptId },
    payload: { automationId: definition.id, revision: definition.revision, event },
  });
  return {
    async launched(definition, event, receiptId, runId) {
      await channel()?.record(op(definition, event, receiptId), { outcome: 'applied', resource: { kind: 'run', id: runId } });
    },
    async failed(definition, event, receiptId, error) {
      const audit = channel();
      if (!audit) return;
      if (error instanceof AutomationLaunchRefusal) {
        await audit.record(op(definition, event, receiptId), {
          outcome: 'refused',
          reason: error.code,
          resource: { kind: 'automation', id: definition.id },
        });
      } else {
        audit.skip('launch_failed');
      }
    },
  };
}
