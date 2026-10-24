# Publishing Xezar

Xezar ships as one public npm package, **`@qodeca/xezar`**, published from
[`qodeca/xezar`](https://github.com/qodeca/xezar). It provides two commands, `xezar` and `xez`.

Nothing publishes automatically. There is no preview channel, no `develop` channel and no
nightly: the only path to the registry is the `Release` workflow, dispatched by a maintainer or,
after the owner's go, by the release agent (`SDLC.md` § Deviations from the core). Either way the
publish job waits for a person's approval on the `production` environment. `develop` is a branch, not a channel: it is the default branch every pull request
targets, and `main` holds released work only (`SDLC.md`).

---

## How publishing is authenticated

**There is no npm token in this repository, and there is not meant to be one.**

Publishing uses npm **trusted publishing** (OIDC). GitHub Actions mints a short-lived identity
token for the release job, and npm checks it against a *trusted publisher* configured on the
package — which names this repository *and this workflow file* by name. Nothing long-lived
exists to expire, leak, or be copied out of CI, and a publish from any other workflow is
rejected rather than quietly accepted.

The workflow has two jobs, so the publish rights never meet third-party code:

| Job | Permissions | What it runs |
|---|---|---|
| `build` | `contents: read` | `npm ci`, the gate, the build, `test:package`, then `node scripts/release.mjs <bump> --pack-destination <dir>`: stamps the manifests, restamps the documentation footers and packs the tarball. Uploads the tarball, its `SHA256SUMS`, the four stamped manifests and the restamped documentation pages as the `release-package` artifact. |
| `publish` | environment `production`; `id-token: write`, `contents: write`, `pull-requests: write` | Installs nothing and runs no package script. Downloads `release-package`, re-checks the SHA-256, runs `npm publish <tarball> --provenance`, creates the tag and GitHub Release, then opens the version-bump PR. |

`packages/xezar/src/release/publishing-surface.test.ts` fails the build if `NPM_TOKEN` or
`NODE_AUTH_TOKEN` reappears in any workflow, if `id-token: write` is granted anywhere but
the release workflow's `publish` job, if that job starts installing or running package code, or if
a `run:` script interpolates an expression instead of reading it from `env`.

### One-time setup (repository owner)

On <https://www.npmjs.com/package/@qodeca/xezar/access>, under **Trusted Publisher**, add a
GitHub Actions publisher:

| Field | Value |
|---|---|
| Organization or user | `qodeca` |
| Repository | `xezar` |
| Workflow filename | `release.yml` |
| Environment name | `production` |
| Allowed actions | tick **Allow `npm publish`** |

**Tick the `npm publish` box.** It is off by default, and a publisher without it may only
`npm stage publish` — which this workflow does not use. Leaving it off fails the release at the
publish step with `npm error 404 … could not be found or you do not have permission`, naming the
package as if it did not exist. Every field above produces that same 404 when it is wrong, so
read the error as "npm rejected this identity", never as "the package is missing".

npm marks these fields **fixed once the connection is created**: correcting a typo means deleting
the publisher and adding it again, so check them before saving.

The workflow filename is matched exactly, so **renaming `.github/workflows/release.yml` breaks
publishing** until the publisher is updated. That is the point: the authorisation is tied to one
named file, not to the repository as a whole.

The `production` environment
(<https://github.com/qodeca/xezar/settings/environments>) has a required reviewer, so every
publish pauses for a person before it touches the registry, and its deployment branches are
limited to `main` and `release/*.x` – maintenance branches such as `release/0.30.x`. The Actions
bot's `release/v<version>` version-bump branches do not match, so the publish job cannot run from
one of them. Keep both settings if you recreate the environment.

Release tags are protected by the tag ruleset "release tags: never moved or deleted": once a
`v*` tag exists, nobody but a repository admin can move or delete it. Creating a tag is not
limited, because the Release workflow creates its tag through the GitHub API and GitHub does not
accept the GitHub Actions app as a bypass actor in a repository ruleset.

### The bootstrap exception

Trusted publishing cannot perform a package's **first** publish: npm has nowhere to attach a
publisher until the package exists. `@qodeca/xezar@0.10.1` was therefore published once by a
maintainer from a logged-in machine (`npm login`, then `node scripts/release.mjs existing`).

The trusted publisher was **not** created at that point, and this document said it had been. The
gap stayed invisible for as long as nothing used it — the first dispatched release, `0.10.2`,
failed at the publish step against an empty publisher form, twice, before anyone looked. If you
bootstrap another package here, configure the publisher as a step of the bootstrap and dispatch a
release to prove it, rather than recording an intention. `0.10.2` onward goes through the
workflow with no credential stored anywhere.

If you ever need to publish by hand again, `scripts/release.mjs` accepts a local `npm login`
session as well — it fails only when it has *neither* an OIDC endpoint nor a token.

## Cutting a release

1. Land everything you want in the release on `develop`, with a green CI run. Merge the changelog
   pull request into `develop`, then promote it: cut `promote/v<version>` at the changelog merge
   commit and merge it into `main` with a merge commit (never squash). Work merged into `develop`
   after the changelog commit waits for the next release. The release skill
   (`.xezar/skills/xezar-release-publish.md`) carries the exact commands.

   Before you promote, run the generic-instructions guard
   (`packages/xezar/src/release/generic-instructions.test.ts`) and the `check:pack`
   packed-archive scan (the last leg of `npm run build`) on the release candidate – the changelog
   merge commit you are about to promote. Both must be green. Put their results, the candidate SHA
   and the fresh archive-scan output in the body of the promotion pull request
   (`promote/v<version>`), the one that carries that commit into `main`.

   The nightly mutation gate is not part of this path, and a release does not wait on it. Read
   the latest run of `.github/workflows/mutation.yml`, or the open `mutation-nightly` issue, if
   you want the current score before you cut. A survivor is a weak test to fix in its own PR, not
   a reason to hold a release that passed the full canonical gate and QA.

   History: the mutation gate ran as the `release` / `release-prep` workflows' first check step
   until 2026-09-12, then moved to a nightly run against the default branch (#377), because a
   nearly four-hour measurement whose only repair is a stronger test in somebody else's PR must
   not hold a finished release. The nightly workflow holds no npm credential and no publish
   command, and `packages/xezar/src/release/publishing-surface.test.ts` keeps it that way. Why it
   moved, and the unchanged 80 % floor:
   [coverage-gaps.md § 10.8](testing/coverage-gaps.md#108-the-nightly-gate-stryker-over-the-mcp-code).
   The `check:pack` scan was added by [PR #481](https://github.com/qodeca/xezar/pull/481), merged
   2026-09-16.
2. Go to **Actions → Release → Run workflow**, pick the branch (`main`, or a
   `release/<major>.<minor>.x` maintenance branch – never `develop`) and the bump:

   | Bump | What it publishes |
   |---|---|
   | `patch` / `minor` / `major` | Increments from the version in `packages/xezar/package.json` |
   | `existing` | The version already committed in `packages/xezar/package.json` |

3. The `build` job then, in order: installs, runs `typecheck` + `npm test` + `test:unit`, builds,
   runs the packaged-CLI E2E (`test:package` — it packs the real tarball, installs it into an
   isolated consumer and runs the CLI from it), stamps the version and packs the release tarball.
   Stamping covers the four manifests and every "Describes xezar X." footer in `docs/` outside
   the dated records (`packages/xezar/src/release/doc-footers.ts` names the pages; the footer
   unit test holds them to the manifest version).
   The `publish` job (it waits for the `production` approval) publishes
   exactly that tarball to npm with `--tag latest` and `--provenance`, and right after that
   creates the `v<version>` tag and GitHub Release at the released commit. The run summary lists
   each of the three – npm, tag and Release, bump PR – with what its own step really did.
4. For `patch`/`minor`/`major` it then opens a `release/v<version>` PR carrying the manifest
   bump and the restamped documentation footers in one commit, because `main` is PR-only. The
   tag already exists at this point, so a failure here leaves only the PR to open by hand. Merge it with a merge commit so `main` matches the registry. That PR is opened
   by the Actions bot, so its CI sits at **action_required** until a maintainer approves the run
   (`gh run list --branch release/v<version>`, then approve it in the Actions tab or with
   `gh api -X POST repos/qodeca/xezar/actions/runs/<id>/approve`). Nothing is wrong; GitHub holds
   bot-authored workflow runs by default. Until this PR lands, `main` still names the previous
   version while the registry serves the new one.
5. Back-merge: cut `backmerge/v<version>` from `main`, merge the current `develop` into it (GitHub's
   merges API, so no local commit), and merge it into `develop` with a merge commit. Proof:
   `git rev-list --count origin/develop..origin/main` is 0. Every merge into `main` – promotion,
   bump or hotfix – is followed by one, or the next promotion is out of date.

A **hotfix** ships one urgent fix without the unreleased work on `develop`, and only with the
owner's explicit authorization. It is made by hand – the kit's `hotfix` workflow targets
`develop` and is not used here (`SDLC.md` § Deviations from the core): a `hotfix/<name>` branch
from `main` carrying the fix and its
folded changelog section, merged into `main` with a merge commit, then steps 2–5 with
`bump=patch`. The release skill carries the commands.

### What a green run means

A green `Release` run means the package **is on the registry**. The `publish` job runs a plain
`npm publish` of the packed tarball, which fails when npm rejects the identity, so a misconfigured
trusted publisher fails the job loudly instead of producing a green run that published nothing.
Run by hand, `scripts/release.mjs` likewise exits non-zero when it has no credential rather than
degrading to a dry run; its `--pack-destination` mode (the one the `build` job uses) publishes
nothing and says so (`published=false`, `packed=true`).

To rehearse locally without publishing, pass the flag explicitly:

```bash
npm run build
node scripts/release.mjs existing --dry-run
```

---

## Verifying a release

```bash
npm view @qodeca/xezar version              # the version just published
npm view @qodeca/xezar dist-tags            # latest -> that version
npm view @qodeca/xezar repository.url       # https://github.com/qodeca/xezar

npm install -g @qodeca/xezar@<version>
which xezar xez
xezar --version
xezar serve                                 # opens the cockpit
```

The GitHub Release tag (`v<version>`) must point at the commit the tarball was built from; the
release body states that commit.

### The tag is there, but `npm` still shows the old version

That is normal, not a failed release, and it has two separate causes worth knowing before you go
looking for a fault.

**npm can keep serving the previous version for a while.** The tag and the GitHub release appear
first, and `npm view @qodeca/xezar version` catches up afterwards – from about five minutes (0.30.0)
to around a quarter of an hour in the cases observed here. Wait a few minutes and ask again before
concluding that nothing published.

**After a bump release, the manifests and the documentation footers keep naming the previous
version on purpose.** A
`patch`/`minor`/`major` run stamps the version during the release run instead of committing it
beforehand, so the commit the tag points at can still hold the previous number. The version-bump
pull request brings the repository in line afterwards. Until that lands, "`main` says 0.17.0 and
the registry says 0.18.0" is the expected middle state – the 0.18.0 tag is exactly that: its
`package.json` reads `0.17.0`. A `bump=existing` release has no such window, because the version is
already committed.

So a green release run and an existing tag are the evidence that it published. Check those first,
and read the registry, `main` and (after the back-merge) `develop` as things that catch up rather
than as the verdict.

---

## Recovering from a partial failure

**Published versions are immutable.** Never try to republish the same version, and never
`npm unpublish` to "retry". npm's
[unpublish policy](https://docs.npmjs.com/policies/unpublish) allows it within 72 hours of
publishing when no other package in the public registry depends on it, and after that only when
no package depends on it, it had fewer than 300 downloads in the last week and it has a single
owner. Either way the version number is burned: a `package@version` that was used once can never
be published again.

First, find out what actually happened:

```bash
npm view @qodeca/xezar versions --json      # is the version on the registry?
npm view @qodeca/xezar dist-tags            # did `latest` move?
gh release view v<version> -R qodeca/xezar  # was the Release created?
git ls-remote --tags origin | grep v<version>
```

Then:

| State | Do this |
|---|---|
| Nothing published; the `build` job failed, or `publish` failed before its `Publish release` step | Fix the cause and re-dispatch the same bump. Nothing to undo. |
| `npm error 404` or an auth error at the publish step | npm rejected the identity — the package is not missing. The trusted publisher is absent, does not match, or lacks the `npm publish` permission. Check owner/repo/**workflow filename**/environment and the **Allowed actions** tick at <https://www.npmjs.com/package/@qodeca/xezar/access>, and that the job still has `id-token: write`. |
| Published, but no tag / no GitHub Release | Do **not** re-run the workflow — it would try to publish the same version again. Create the Release by hand at the released commit: `gh release create v<version> --target <sha> --title "v<version>" --notes "..."`. |
| Published, but `latest` points at the wrong version | `npm dist-tag add @qodeca/xezar@<good-version> latest`. Moving a tag is safe; deleting a version is not. |
| Published a broken build | Publish the FIX as a new patch version and move `latest` to it. Optionally `npm deprecate @qodeca/xezar@<bad> "broken; use <good>"`. |
| The version-bump PR was not opened (the tag and Release exist) | Bump `version` in `packages/contract`, `packages/api-client`, `packages/web` and `packages/xezar` by hand on a branch — the four manifests `scripts/release.mjs` and `.github/workflows/release.yml` stamp — change every "Describes xezar X." footer the release restamps to the new version (the footer unit test, `packages/xezar/src/release/guide-footer-version.test.ts`, lists any you miss), and open the PR yourself. |

Whatever the state, inspect the registry **before** re-dispatching. The workflow does not check
whether a version already exists; npm will reject the duplicate with `E403`, but only after the
job has already rebuilt everything.
