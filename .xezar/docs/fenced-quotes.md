# Fenced quotes from repository files

Documentation sometimes copies a maintained file so the reader can see the exact bytes under
discussion. Put a source marker immediately before such a fenced block:

    <!-- from: path/to/file -->
    ```text
    exact file bytes
    ```

`path/to/file` is relative to the repository root. The block content, including its final newline,
must byte-match the file. An absolute path, a `..` segment, a path that resolves outside the
repository, or a missing file fails the repository check. Missing sources never skip: the marker
exists specifically to catch a quote copied from a file that is absent on the current branch.

For a focused excerpt, append an inclusive line range:

    <!-- from: path/to/file#L10-L14 -->

The selected source lines retain their line endings and are compared byte for byte. The start must
not exceed the end, and both lines must exist.

The marker is optional. Unmarked fences remain ordinary examples and are not compared. Markers
inside another fenced block are also ordinary example text. Opening and closing fences may use
three or more backticks or tildes; a closing fence must use the same character and at least the
opening length.

The check scans maintained Markdown under `docs/` and `.xezar/docs/`, root `*.md`, and
`designs/**/README.md`. It does not scan `.local/`, `node_modules/`, or `changelog.d/`.

This excerpt is checked against the task-agent guard in the maintained hook script:

<!-- from: .xezar/checks/leader-context.sh#L30-L43 -->
```sh
# A xezar task agent, even one running in the primary checkout with Worktree off.
[ -z "${XEZ_HANDOFF_FILE:-}" ] || silent
[ -z "${XEZ_TODOS_FILE:-}" ] || silent
[ -z "${XEZ_TASK_ID:-}" ] || silent

# A task worktree, by path or by git registration.
case "$PWD" in */.local/xezar/worktrees/*) silent ;; esac
case "$REPO_ROOT" in */.local/xezar/worktrees/*) silent ;; esac
git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$git_dir" ] && [ "$git_dir" = "$common_dir" ] || silent

# Without the guide there is nothing to load.
[ -f "$GUIDE" ] || silent
```
