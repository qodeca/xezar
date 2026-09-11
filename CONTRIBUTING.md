# Contributing to xezar

Thank you for helping. This page is the whole path from an idea to a merged change.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the shape.
- Found a security problem? Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## The loop

1. Fork the repository (or branch, if you have write access) and branch off `main`.
2. Install and build: `npm install`, then `npm run build`. You need Node 20+ and `git`.
3. Make your change, with a test for any change in behaviour.
4. Run the fast checks locally:

   ```bash
   npm run typecheck
   npm test
   ```

   CI runs the full gate on your pull request (`npm run test:unit`, `npm run build`,
   `npm run test:package` and the browser suite), so you do not have to.
   `XEZ_DRY_RUN=1` replaces the agent CLIs with a mock, so you can exercise the cockpit without any agent login.
5. Open a pull request against `main`.

## Commits and pull requests

Commit messages and pull-request titles follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. Pull requests are squash-merged, so the title becomes the commit on `main`.

A good pull-request body says what changed, why, how you verified it, and whether it is risky. The template asks for exactly that. Put `Closes #<n>` in the body when it fixes an issue. For a user-visible change you may add a line under `# Unreleased` in [CHANGELOG.md](CHANGELOG.md); a maintainer will write it otherwise.

## You do not need the `om-*` skills

[SDLC.md](SDLC.md) names `om-*` agent skills (`om-fix`, `om-code-review`, `om-approve-merge-pr`, …) as the actor at each stage. They are this project's internal automation. They are not in this repository, and an outside contributor does not need them. The human path through the same stages is:

| SDLC stage | What you do |
|---|---|
| Intake, triage | Open an issue, or comment on an existing one. |
| Claim | Comment on the issue that you are working on it. |
| Implement, PR | Follow the loop above and open a pull request. |
| Review loop | A maintainer reviews; you push fixes to the same branch. |
| QA, merge | A maintainer applies the labels, runs any manual QA and squash-merges. |

You never apply labels yourself.

## Deeper reading

- [AGENTS.md](AGENTS.md) – how the code is organised and the rules each area keeps.
- [SDLC.md](SDLC.md) – the full delivery process, labels and the QA gate.
- [CODE_REVIEW.md](CODE_REVIEW.md) – what reviewers check.
- [BACKWARD_COMPATIBILITY.md](BACKWARD_COMPATIBILITY.md) – the public surfaces a change must not break silently.
