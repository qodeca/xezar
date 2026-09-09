# Worktree and setup discipline

Every writing task owns .local/xezar/worktrees/<runId>, on xez/<first8>. Xezar owns creation/retention. Do not adopt a branch, use a peer checkout, or fall back to root after reclaim. Bootstrap copies only allowlisted maintained kit files after validating primary repository/task/branch; it refuses symlinks and conflicting existing files. It never copies the current root application's dirty changes. Run preflight before every write and on continuation; errors show actual CWD and predicate.

Setup checks Node >=20/npm and npm ci freshness, then writes task context. Freshness covers package-lock.json, npm-shrinkwrap.json, package.json, .npmrc, patches, workspace manifests and Node/npm versions. Never copy node_modules or credentials. Read-only initialization makes only evidence context; code execution needs an independently prepared isolated checkout. No fabricated run ID.

Use worktree-git.sh commit/push with current CWD and task identity; it binds named ref and refuses merge-in-progress. Reuse original task/PR for corrections. Missing ownership needs deliberate recorded migration, not an incidental duplicate. Results that must survive retention live under primary .local/xezar-tasks. No archive-before-reclaim mechanism is presumed necessary; preserve non-rebuildable evidence explicitly.

Source snapshots are recorded as .local/xezar-kit/snapshot.json in the ignored task runtime tree. Bootstrap never refreshes an existing task snapshot. If a future tracked revision already has differing assets, it refuses instead of overwriting: use that revision's own kit or a deliberately reconciled later task, not a hidden update. No generic product seeding behavior has been added.
