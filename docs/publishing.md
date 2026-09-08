# Publishing Xezar

Xezar ships as one public npm package, **`@qodeca/xezar`**, published from
[`qodeca/xezar`](https://github.com/qodeca/xezar). It provides two commands, `xezar` and `xez`.

Nothing publishes automatically. There is no preview channel, no `develop` channel and no
nightly: the only path to the registry is the `Release` workflow, which a maintainer dispatches
by hand.

---

## One-time setup (repository owner)

Both steps need an account with publish rights on the `@qodeca` npm scope and admin on the
GitHub repository.

### 1. Create an npm automation token

1. Sign in at <https://www.npmjs.com/> and open
   **Account → Access Tokens → Generate New Token → Granular Access Token**.
2. Give it **Read and write** on packages, scoped to `@qodeca/*` (or to `@qodeca/xezar` alone).
3. Set an expiry you will actually renew, and copy the value once — npm never shows it again.

A *Granular Access Token* is preferred over a classic Automation token because it can be scoped
to this package only. Either works; both bypass 2FA, which is what a CI publish needs.

### 2. Store it as the `NPM_TOKEN` repository secret

<https://github.com/qodeca/xezar/settings/secrets/actions> → **New repository secret** →
name `NPM_TOKEN`, value the token.

Or from a terminal, without the value ever appearing in shell history or logs:

```bash
gh secret set NPM_TOKEN -R qodeca/xezar   # paste the token at the prompt, then press Ctrl-D
```

### 3. (Optional but recommended) Require an approval on the `production` environment

The release job runs in the `production` GitHub environment. Adding a required reviewer at
<https://github.com/qodeca/xezar/settings/environments> means every publish pauses for a human
before it touches the registry.

---

## Cutting a release

1. Land everything you want in the release on `main`, with a green CI run.
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
   bump, because `main` is PR-only. Merge it so the trunk matches the registry.

### What a green run means

A green `Release` run means the package **is on the registry**. `scripts/release.mjs` exits
non-zero when `NODE_AUTH_TOKEN` is empty rather than degrading to a dry run, so a missing
credential fails the job loudly instead of producing a green run that published nothing.

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
| Published, but no tag / no GitHub Release | Do **not** re-run the workflow — it would try to publish the same version again. Create the Release by hand at the released commit: `gh release create v<version> --target <sha> --title "v<version>" --notes "..."`. |
| Published, but `latest` points at the wrong version | `npm dist-tag add @qodeca/xezar@<good-version> latest`. Moving a tag is safe; deleting a version is not. |
| Published a broken build | Publish the FIX as a new patch version and move `latest` to it. Optionally `npm deprecate @qodeca/xezar@<bad> "broken; use <good>"`. |
| The version-bump PR was not opened | Bump `version` in `packages/contract`, `packages/api-client` and `packages/xezar` by hand on a branch, and open the PR yourself. |

Whatever the state, inspect the registry **before** re-dispatching. The workflow does not check
whether a version already exists; npm will reject the duplicate with `E403`, but only after the
job has already rebuilt everything.
