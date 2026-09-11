// A stand-in for the GitHub CLI, answering the few `gh` calls the draft-PR, merge-state and
// ready-for-review paths make (#262). State lives in the JSON file named by FAKE_GH_STATE, so the
// test reads what "the forge" holds the same way the service does: through `gh`. Anything else is
// an error, so an unexpected call cannot pass silently.
//
// The service runs some `gh` calls in parallel (merge_state reads the PR, the repo and its branch
// protection at once), so every call takes a directory lock around its read-modify-write and
// replaces the file by rename. Without both, two overlapping writes tore the file or lost a call.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write('fake gh: FAKE_GH_STATE is not set\n');
  process.exit(2);
}
const lockPath = `${statePath}.lock`;
const deadline = Date.now() + 10_000;
for (;;) {
  try {
    mkdirSync(lockPath);
    break;
  } catch (error) {
    if (error.code !== 'EEXIST' || Date.now() > deadline) {
      process.stderr.write(`fake gh: cannot lock ${lockPath}: ${error.message}\n`);
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
const save = () => {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
  rmdirSync(lockPath);
};
const out = (value) => {
  save();
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  process.exit(0);
};
const fail = (message) => {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const find = (ref) => state.prs.find((pr) => String(pr.number) === String(ref) || pr.head === ref);
const url = (pr) => `https://github.com/${state.repo}/pull/${pr.number}`;
const [group, verb, ref] = args;

if (group === 'repo' && verb === 'view') out({ nameWithOwner: state.repo });

if (group === 'pr' && verb === 'create') {
  const head = flag('--head');
  const pr = {
    number: state.prs.length + 1,
    title: flag('--title') ?? '',
    head,
    base: flag('--base') ?? 'main',
    headSha: execFileSync('git', ['rev-parse', head], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    isDraft: args.includes('--draft'),
    state: 'OPEN',
    reviewDecision: state.reviewDecision ?? 'APPROVED',
    checks: state.checks ?? [{ name: 'test', conclusion: 'SUCCESS' }],
  };
  state.prs.push(pr);
  out(`${url(pr)}\n`);
}

if (group === 'pr' && verb === 'view') {
  const pr = find(ref);
  if (!pr) fail('GraphQL: Could not resolve to a PullRequest with the number of 0. (not found)');
  out({
    number: pr.number,
    title: pr.title,
    url: url(pr),
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.head,
    baseRefName: pr.base,
    headRefOid: pr.headSha,
    mergeable: 'MERGEABLE',
    mergeStateStatus: pr.isDraft ? 'DRAFT' : 'CLEAN',
    reviewDecision: pr.reviewDecision,
    statusCheckRollup: pr.checks,
  });
}

if (group === 'pr' && verb === 'ready') {
  const pr = find(ref);
  if (!pr) fail('GraphQL: Could not resolve to a PullRequest (not found)');
  if (!pr.isDraft) fail(`! Pull request ${state.repo}#${pr.number} is already "ready for review"`);
  pr.isDraft = false;
  out(`✓ Pull request ${state.repo}#${pr.number} is marked as "ready for review"\n`);
}

if (group === 'api' && verb === `repos/${state.repo}`) {
  out({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true, squash_merge_commit_title: 'PR_TITLE' });
}
if (group === 'api' && /\/protection\/required_status_checks$/.test(verb ?? '')) out(JSON.stringify(state.requiredChecks ?? ['test']));

fail(`fake gh: unsupported call: gh ${args.join(' ')}`);
