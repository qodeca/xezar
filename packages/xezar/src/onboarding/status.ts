import type { OnboardingIssueFiling, OnboardingOlderSetup, OnboardingStatus } from '@qodeca/xezar-contract';
import type { BackendCheck } from '../core/backend-detect.ts';
import type { InstallRecord } from './install-record.ts';
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
 * It is the `xez-onboard-opinionated` release of the public `qodeca/xezar-skills` collection
 * this engine supports: 3.2.1, tagged `v3.2.1` at `b86ddf0`. It moved from 3.0.3 (`ec856f8`)
 * because 3.2.0 is the first release that works with this engine: 0.30.0 removed two agent
 * backends, and the 3.0.3 routing defaults still sent most simple and mid-size work, and the last
 * reviewer of every review row, to them. It moves when the supported onboarding moves and at no
 * other time — which is what makes "the templates changed" a fact rather than a guess. A project
 * last checked against an older pin is offered one re-check, and the re-check runs the current
 * onboarding (`PROJECT_SETUP_WORKFLOW`) in recheck mode; it does not upgrade an older setup — that
 * is `MINIMUM_SETUP_VERSION`'s job. A finished project carries the onboarding's own install record,
 * `.xezar/onboarding.json`; this pin is only the engine's side of the pair.
 * A user never sets it, never sees the field name, and has no file to author (§ Zero config).
 *
 * In user-facing copy this is "setup templates", never "kit" (OQ-5, and the release-hygiene rule
 * of #466: xezar's own internal vocabulary is not something a user adopts).
 */
export const BUNDLED_TEMPLATES_DIGEST = 'b86ddf0';

/**
 * The oldest setup collection release this engine supports, compared against the install record's
 * `version`. 3.2.0 is the first `qodeca/xezar-skills` release that works with engine 0.30.0: an
 * older one routes tasks to the removed `pi` and OpenCode backends, and the engine refuses those
 * tasks. A re-check cannot fix that, so the answer carries the upgrade guide instead.
 */
export const MINIMUM_SETUP_VERSION = '3.2.0';

/** The public guide that upgrades a project's setup collection — a product capability, named so
 *  the cockpit and the MCP leader point at the same page. */
export const SETUP_UPGRADE_GUIDE_URL =
  'https://github.com/qodeca/xezar-skills/blob/main/upgrade/README.md';

/** `major.minor.patch` with an optional `-pre-release` and `+build`; nothing else parses. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  core: [number, number, number];
  preRelease: boolean;
}

/** A strict, small semver read. `null` for anything that is not `major.minor.patch`. */
export function parseSetupVersion(value: string): ParsedVersion | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    preRelease: match[4] !== undefined,
  };
}

/**
 * Whether `recorded` is a readable version strictly older than `minimum`. A pre-release counts as
 * lower than its own release (`3.2.0-rc.1` < `3.2.0`).
 *
 * Fail-open on purpose: an absent, empty or unparseable version answers `false`, because "we
 * could not read it" is no evidence that the setup is old, and a warning nobody can act on is a
 * nag. `status.test.ts` pins that empty case beside the populated ones, so "never loaded" and "not
 * old" cannot quietly become the same branch.
 */
export function isOlderSetupVersion(recorded: string | null, minimum: string = MINIMUM_SETUP_VERSION): boolean {
  if (!recorded) return false;
  const a = parseSetupVersion(recorded);
  const b = parseSetupVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]!;
  }
  return a.preRelease && !b.preRelease;
}

/** The wire answer's `olderSetup`, from the install record. */
export function olderSetupFor(installRecord: InstallRecord | null): OnboardingOlderSetup | null {
  const recorded = installRecord?.version ?? null;
  if (!isOlderSetupVersion(recorded)) return null;
  return {
    recordedVersion: recorded!,
    minimumVersion: MINIMUM_SETUP_VERSION,
    upgradeGuideUrl: SETUP_UPGRADE_GUIDE_URL,
  };
}

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
  'qwen',
]);

/** The disabled reason, in the words `states.html` 2b specifies. */
export const NO_BACKEND_REASON =
  'Setup unavailable — no agent backend was found. Install Claude Code, Codex or Qwen Code, sign in, then open this page again.';

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
  /** `discoverIssueFiling()`'s answer (#468). Required so no caller can forget it and report a
   *  capability nobody looked at. */
  issueFiling: OnboardingIssueFiling;
  /** `readInstallRecord()`'s answer: the committed `.xezar/onboarding.json` of a finished
   *  onboarding, or `null`. Required for the same reason as `issueFiling`. */
  installRecord: InstallRecord | null;
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

  const installed = input.installRecord !== null;
  const state = deriveState({ read, checked, checkCoversObserved, checkingRunId, installed });
  const olderSetup = olderSetupFor(input.installRecord);

  // The offer row appears only for a change we can actually evidence, that nobody has been shown
  // yet, and that nothing is already acting on. Every clause is a "no offer appears" row of
  // `states.html` § 4; dropping any one of them is how this becomes the nag owner decision Q3
  // was written to prevent.
  //
  // An older setup collection is the second piece of evidence (`olderSetup`): `state` stays
  // `set-up`, because setup did finish and a new enum value would break strict clients, and the
  // row offers the upgrade guide instead. It rides the SAME offered stamp, so Later hides it for
  // this engine/templates pair exactly as it hides a changed-identity offer. A running check is
  // `checking`, not `set-up`, so it never sits beside the row either.
  const offerable = state === 'changed' || (state === 'set-up' && olderSetup !== null);
  const offerPending = offerable && offeredThisPair === null && checkingRunId === null;

  return {
    state,
    // `recorded` means a readable record exists. A corrupt one is NOT provenance, and an absent
    // one is not either — the difference between them is carried by `state`, not by this field.
    // The committed install record is provenance too: it is the project's own record of a finished setup.
    provenance: read.status === 'ok' || installed ? 'recorded' : 'unknown',
    available,
    unavailableReason: available ? null : NO_BACKEND_REASON,
    localHandoff,
    offerPending,
    dismissed: offerable && offeredThisPair !== null,
    observed: { engineVersion: observed.engineVersion, kitDigest: observed.kitDigest },
    lastOffered: offeredThisPair,
    lastChecked: checked,
    checkingRunId,
    launch: { workflowId: ONBOARDING_WORKFLOW_ID, modes: [...ONBOARDING_MODES] },
    issueFiling: { ...input.issueFiling },
    olderSetup,
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
  installed: boolean;
}): OnboardingStatus['state'] {
  // A running check outranks every other sentence: it is the only state whose honest answer is
  // "wait", and it is what stops two clicks starting two checks (`AC-13`).
  if (input.checkingRunId) return 'checking';
  // A committed install record means setup finished, whether it ran from the cockpit or from
  // the skill directly. It outranks the engine's own scratch record: that one is disposable, and an
  // older check or an unreadable file there says nothing against a setup the project committed.
  // A record from an older setup collection is still `set-up`; `olderSetup` carries the warning.
  if (input.installed) return 'set-up';
  // A record we can see and cannot trust. Never `never` — claiming "no setup has been recorded"
  // about a file we simply failed to read would be a statement we have no evidence for.
  if (input.read.status === 'corrupt') return 'unknown';
  if (!input.checked) return 'never';
  return input.checkCoversObserved ? 'set-up' : 'changed';
}
