# Changelog fragments

One file per pull request, named for its number (`668.md`) or its branch
(`xez-668-changelog-fragments.md`). It holds the bullet lines that would otherwise go under
`# Unreleased` in `../CHANGELOG.md`, under the same `## <heading>` groups that file already uses:

```md
## 🐛 Fixes

- 🐛 **The lead sentence, in the changelog's voice.** One or two sentences of what and why.
  (#668)
```

The allowed headings are the changelog's own: `## Highlights`, `## 💥 Breaking`, `## 🔒 Security`,
`## ✨ Features`, `## 🐛 Fixes`, `## 🔧 Changed`, `## 📝 Specs & Documentation`,
`## 🚀 CI/CD & Infrastructure` and `## 👥 Contributors`. A fragment carries bullets and their
wrapped continuation lines and nothing else; a heading outside that set is refused.

Why fragments: `CHANGELOG.md` is append-only at the top, so every open pull request edits the same
lines and the first merge makes every other pull request conflict — and a content conflict stops
GitHub from running CI on it at all. No two branches ever touch the same fragment bytes.

`bash .xezar/checks/changelog-check.sh --fragments changelog.d` parses the fragments, and the
repository check runs it. Do not edit `# Unreleased` directly: `changelog-check.sh --diff-base`
refuses that on any branch, naming this directory. The `changelog` step of the `release` workflow
folds every fragment into the new `# <version> (<date>)` section and deletes the files in the same
commit, so a fragment is never left unfolded. This `README.md` is skipped by both.
