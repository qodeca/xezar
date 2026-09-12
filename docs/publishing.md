# Publishing Xezar

Xezar ships as one public npm package, **`@qodeca/xezar`**, published from
[`qodeca/xezar`](https://github.com/qodeca/xezar). It provides two commands, `xezar` and `xez`.

Nothing publishes automatically. There is no preview channel, no `develop` channel and no
nightly: the only path to the registry is the `Release` workflow, which a maintainer dispatches
by hand.

---

## How publishing is authenticated

**There is no npm token in this repository, and there is not meant to be one.**

Publishing uses npm **trusted publishing** (OIDC). GitHub Actions mints a short-lived identity
token for the release job, and npm checks it against a *trusted publisher* configured on the
package — which names this repository *and this workflow file* by name. Nothing long-lived
exists to expire, leak, or be copied out of CI, and a publish from any other workflow is
rejected rather than quietly accepted.

`packages/xezar/src/release/publishing-surface.test.ts` fails the build if `NPM_TOKEN` or
`NODE_AUTH_TOKEN` reappears in any workflow, or if `id-token: write` is granted anywhere but
the release job.

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

Recommended alongside it: add a required reviewer to the `production` environment at
<https://github.com/qodeca/xezar/settings/environments>, so every publish pauses for a human
before it touches the registry.

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

1. Land everything you want in the release on `main`, with a green CI run. **The MCP mutation
   gate is no longer part of this path** (#377): it runs weekly against `main` in its own
   scheduled workflow, `.github/workflows/mutation.yml`, and a release does not wait on it. Look
   at the last scheduled run if you want the current score before you cut; a survivor there is a
   weak test to fix in its own PR, not a reason to hold a release that passed the full canonical
   gate and QA. Why it moved, and how the sharded run still enforces the same 80 % floor:
   [coverage-gaps.md § 10.8](testing/coverage-gaps.md#108-the-scheduled-gate-stryker-over-the-mcp-code).
2. Go to **Actions → Release → Run workflow**, pick the branch (`main`, or a `release/*`
   maintenance branch) and the bump:

   | Bump | What it publishes |
   |---|---|
   | `patch` / `minor` / `major` | Increments from the version in `packages/xezar/package.json` |
   | `existing` | The version already committed in `packages/xezar/package.json` |

3. The job then, in order: installs, runs `typecheck` + `npm test` + `test:unit`, builds, runs
   the packaged-CLI E2E (`test:package` — it packs the real tarball, installs it into an
   isolated consumer and runs the CLI from it), publishes to npm with `--tag latest` and
   `--provenance`, and creates the `v<version>` GitHub Release at the released commit.
4. For `patch`/`minor`/`major` it also opens a `release/v<version>` PR carrying the manifest
   bump, because `main` is PR-only. Merge it so the trunk matches the registry. That PR is opened
   by the Actions bot, so its CI sits at **action_required** until a maintainer approves the run
   (`gh run list --branch release/v<version>`, then approve it in the Actions tab or with
   `gh api -X POST repos/qodeca/xezar/actions/runs/<id>/approve`). Nothing is wrong; GitHub holds
   bot-authored workflow runs by default. Until this PR lands, the trunk still names the previous
   version while the registry serves the new one.

### Releasing from Xezar

The steps above can run as **one Xezar task** in this repository's kit. In the cockpit pick the
`release` workflow, keep Worktree **ON**, and type the brief:

```text
bump: patch          # or minor / major; add `dry-run: true` to stop before the dispatch
```

The task writes the `# <version> (<date>)` changelog section from the PRs merged into `main`
since the last `v*` tag (no hand-written brief; every stray `# Unreleased` section is folded in),
runs the canonical gates, merges the changelog PR, dispatches this Release workflow once for that
bump, verifies npm / the tag / the GitHub Release, and approves and merges the bot's
`release/v<version>` PR. All the waiting happens in the task's last step, because Xezar kills
every non-final agent step at 30 minutes (#22). Nothing publishes outside the dispatched Release
run, and the task never pushes to `main` or touches your primary checkout.

Two things stay with you afterwards: run the `root-sync` workflow (Worktree **OFF**) with the
bump merge commit as its target so your checkout matches the trunk, and `npm install -g
@qodeca/xezar@<version>` locally. The manual path above remains valid and is what the task
automates; `.xezar/skills/xezar-release-publish.md` lists exactly which commands it runs.

### What a green run means

A green `Release` run means the package **is on the registry**. `scripts/release.mjs` exits
non-zero when it has no credential rather than degrading to a dry run, so a misconfigured
trusted publisher fails the job loudly instead of producing a green run that published nothing.

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

---

## Recovering from a partial failure

**Published versions are immutable.** Never try to republish the same version, and never
`npm unpublish` to "retry" — unpublishing is allowed only within 72 hours, is refused outright
once anything depends on the version, and permanently burns the version number either way.

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
| Nothing published; the job failed before `Publish release` | Fix the cause and re-dispatch the same bump. Nothing to undo. |
| `npm error 404` or an auth error at the publish step | npm rejected the identity — the package is not missing. The trusted publisher is absent, does not match, or lacks the `npm publish` permission. Check owner/repo/**workflow filename**/environment and the **Allowed actions** tick at <https://www.npmjs.com/package/@qodeca/xezar/access>, and that the job still has `id-token: write`. |
| Published, but no tag / no GitHub Release | Do **not** re-run the workflow — it would try to publish the same version again. Create the Release by hand at the released commit: `gh release create v<version> --target <sha> --title "v<version>" --notes "..."`. |
| Published, but `latest` points at the wrong version | `npm dist-tag add @qodeca/xezar@<good-version> latest`. Moving a tag is safe; deleting a version is not. |
| Published a broken build | Publish the FIX as a new patch version and move `latest` to it. Optionally `npm deprecate @qodeca/xezar@<bad> "broken; use <good>"`. |
| The version-bump PR was not opened | Bump `version` in `packages/contract`, `packages/api-client` and `packages/xezar` by hand on a branch, and open the PR yourself. |

Whatever the state, inspect the registry **before** re-dispatching. The workflow does not check
whether a version already exists; npm will reject the duplicate with `E403`, but only after the
job has already rebuilt everything.
