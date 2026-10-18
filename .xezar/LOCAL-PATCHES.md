# Local patches

Deliberate local changes to kit files. Format: the kit's `upgrade/CONTRACT.md` §2.

## LP-1 – keep the project's own issue and pull request templates
- Files: .github/ISSUE_TEMPLATE/bug_report.yml, .github/ISSUE_TEMPLATE/config.yml, .github/ISSUE_TEMPLATE/feature_request.yml, .github/pull_request_template.md
- Reason: the templates name this product's backends, version commands, design folder and risk surfaces; the kit's generic copies would drop that detail
- Upstream: local only
- Since: 2026-10-05
- Confirmed: yes

## LP-2 – keep the gate worker's MSYS=noglob out of the gate command
- Files: .xezar/checks/lib/gate-parallel.mjs, .xezar/checks/lib/windows-process.mjs
- Reason: on Windows the worker passed MSYS=noglob to every gate command, so Git's sh split quoted paths with a space and npm test failed in every local gate run (#1078)
- Upstream: qodeca/xezar-skills#216
- Since: 2026-10-17
- Confirmed: yes

## LP-3 – route this project's DeepSeek lanes through Qwen Code
- Files: .xezar/checks/route.mjs, .xezar/routing.schema.json, .xezar/docs/routing.md, .xezar/docs/leader-guide.md
- Reason: the engine runs claude, codex and qwen only (#1046), and qwen holds a reading step read-only (#1044); the kit still names the two backends removed in 0.30.0
- Upstream: local only
- Since: 2026-10-16
- Confirmed: yes

## LP-4 – drop the two backends removed in 0.30.0 from the kit text
- Files: .xezar/checks/gh-write.sh, .xezar/checks/verdict-write.sh, .xezar/checks/local-tree.sh, .xezar/docs/parallel-tasks.md, .xezar/docs/ui-operations.md, .xezar/docs/recovery.md
- Reason: the engine runs claude, codex and qwen only since 0.30.0 (#1041); these kit files still described the two removed backends as current (push paths, attach steps, the read-only lock, a leader-state file name and an old recovery note). The same fix belongs upstream so a later kit upgrade does not bring the old text back.
- Upstream: qodeca/xezar-skills#231
- Since: 2026-10-18
- Confirmed: yes
