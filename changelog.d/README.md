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

Every bullet ends with its pull request's number in brackets, `(#668)`, as in the example. When
the bullet also cites an issue, the pull request's number comes last: `(#443, #1123)`. Add the
number as soon as the pull request exists. The fragment check does not look for it, but the
release fold copies each bullet verbatim, and the release step's verification then fails when a
merged pull request's number is missing from the new section. A change that breaks a surface in `../BACKWARD_COMPATIBILITY.md`
also gets a bullet under `## 💥 Breaking`, even when its main entry sits in another group.

Why fragments: `CHANGELOG.md` is append-only at the top, so every open pull request edits the same
lines and the first merge makes every other pull request conflict — and a content conflict stops
GitHub from running CI on it at all. No two branches ever touch the same fragment bytes.

Do not edit `# Unreleased` in `CHANGELOG.md` directly; add a fragment here instead. At release
time every fragment is folded into the new `# <version> (<date>)` section and the files are deleted
in the same commit, so a fragment is never left unfolded. This `README.md` is not a fragment.
