import type { OnboardingStatus } from '@qodeca/xezar-contract';
import type { BackendCheck } from '../core/backend-detect.ts';
import {
  carriedCheck,
  readOnboardingRecord,
  type OnboardingRead,
  type OnboardingRecord,
} from './state.ts';

/**
 * Turn the record, the running identity and the host's own facts into the ONE answer the cockpit
 * and the MCP both read (#464 P2).
 *
 * Both consumers go through here on purpose. A person and a project leader looking at the same
 * project at the same moment must not be able to disagree about whether a check happened, and the
 * only way to guarantee that is one derivation rather than two that are "kept in step" (`AC-17`).
 */

/**
 * The pinned setup-template revision this engine bundles.
 *
 * It is the reviewed `xez-onboard` revision of the public `qodeca/xezar-skills` collection
 * (merged as `2c20c60`) that P1 delivered and P2 pins. It moves when the bundled templates move
 * and at no other time — which is what makes "the templates changed" a fact rather than a guess.
 * A user never sets it, never sees the field name, and has no file to author (§ Zero config).
 *
 * In user-facing copy this is "setup templates", never "kit" (OQ-5, and the release-hygiene rule
 * of #466: xezar's own internal vocabulary is not something a user adopts).
 */
export const BUNDLED_TEMPLATES_DIGEST = '2c20c60';

/** The bundled launch definition both the cockpit buttons and `task_create` name. */
export const ONBOARDING_WORKFLOW_ID = 'project-setup';

/** The three modes the skill contract names. The cockpit surfaces two of them; a leader gets all
 *  three, because a leader that cannot see `preview` cannot dispatch a report-only check. */
export const ONBOARDING_MODES = ['setup', 'preview', 'recheck'] as const;
export type OnboardingMode = (typeof ONBOARDING_MODES)[number];

/** The agent CLIs a setup task could run on. `gh` and `git` are in `detectEnvironment()`'s list
 *  too and are deliberately NOT here: neither can run an agent step. */
const AGENT_BACKENDS: ReadonlySet<BackendCheck['name']> = new Set([
  'claude',
  'codex',
  'opencode',
  'pi',
]);

/** The disabled reason, in the words `states.html` 2b specifies. */
export const NO_BACKEND_REASON =
  'Setup unavailable — no agent backend was found. Install Claude Code, Codex, OpenCode or pi, sign in, then open this page again.';

export function hasAgentBackend(checks: readonly BackendCheck[]): boolean {
  return checks.some((check) => AGENT_BACKENDS.has(check.name) && check.available);
}

/** The observed identity: what is running, and what it bundles. */
export function observedIdentity(engineVersion: string): {
  engineVersion: string;
  kitDigest: string;
} {
  return { engineVersion, kitDigest: BUNDLED_TEMPLATES_DIGEST };
}

export interface OnboardingStatusInput {
  observed: { engineVersion: string; kitDigest: string };
  /** `detectEnvironment()`'s answer. Passed in rather than fetched so a caller that already paid
   *  for it (the MCP's `discover_project`) does not shell out a second time. */
  checks: readonly BackendCheck[];
  localHandoff: boolean;
  /** The id of an ACTIVE check task for this project, when one exists. */
  checkingRunId?: string | null;
}

/**
 * Read the record and derive the wire answer. Writes nothing — see `state.ts`'s header.
 */
export async function onboardingStatus(
  dataDir: string,
  input: OnboardingStatusInput,
): Promise<OnboardingStatus> {
  return deriveOnboardingStatus(await readOnboardingRecord(dataDir), input);
}

/** The pure half — no disk, no processes. Every state test drives this directly. */
export function deriveOnboardingStatus(
  read: OnboardingRead,
  input: OnboardingStatusInput,
): OnboardingStatus {
  const { observed, localHandoff } = input;
  const record = read.record;
  const available = hasAgentBackend(input.checks);
  const checkingRunId = input.checkingRunId ?? null;

  const checked = carriedCheck(record);
  const checkCoversObserved = checked !== null && samePair(checked, observed);
  const offeredThisPair = offeredFor(record, observed);

  const state = deriveState({ read, checked, checkCoversObserved, checkingRunId });

  // The offer row appears only for a change we can actually evidence, that nobody has been shown
  // yet, and that nothing is already acting on. Every clause is a "no offer appears" row of
  // `states.html` § 4; dropping any one of them is how this becomes the nag owner decision Q3
  // was written to prevent.
  const offerPending = state === 'changed' && offeredThisPair === null && checkingRunId === null;

  return {
    state,
    // `recorded` means a readable record exists. A corrupt one is NOT provenance, and an absent
    // one is not either — the difference between them is carried by `state`, not by this field.
    provenance: read.status === 'ok' ? 'recorded' : 'unknown',
    available,
    unavailableReason: available ? null : NO_BACKEND_REASON,
    localHandoff,
    offerPending,
    dismissed: state === 'changed' && offeredThisPair !== null,
    observed: { engineVersion: observed.engineVersion, kitDigest: observed.kitDigest },
    lastOffered: offeredThisPair,
    lastChecked: checked,
    checkingRunId,
    launch: { workflowId: ONBOARDING_WORKFLOW_ID, modes: [...ONBOARDING_MODES] },
  };
}

function samePair(
  a: { engineVersion: string; kitDigest: string },
  b: { engineVersion: string; kitDigest: string },
): boolean {
  return a.engineVersion === b.engineVersion && a.kitDigest === b.kitDigest;
}

/** The offer stamp, but only when it belongs to the pair that is running now. An offer made for
 *  a version nobody is on any more says nothing about this one. */
function offeredFor(
  record: OnboardingRecord | null,
  observed: { engineVersion: string; kitDigest: string },
): { engineVersion: string; kitDigest: string; at: string } | null {
  if (!record?.lastOfferedAt) return null;
  if (!samePair(record, observed)) return null;
  return {
    engineVersion: record.engineVersion,
    kitDigest: record.kitDigest,
    at: record.lastOfferedAt,
  };
}

function deriveState(input: {
  read: OnboardingRead;
  checked: { engineVersion: string; kitDigest: string } | null;
  checkCoversObserved: boolean;
  checkingRunId: string | null;
}): OnboardingStatus['state'] {
  // A running check outranks every other sentence: it is the only state whose honest answer is
  // "wait", and it is what stops two clicks starting two checks (`AC-13`).
  if (input.checkingRunId) return 'checking';
  // A record we can see and cannot trust. Never `never` — claiming "no setup has been recorded"
  // about a file we simply failed to read would be a statement we have no evidence for.
  if (input.read.status === 'corrupt') return 'unknown';
  if (!input.checked) return 'never';
  return input.checkCoversObserved ? 'set-up' : 'changed';
}
