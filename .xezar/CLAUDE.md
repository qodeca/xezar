# The `.xezar/` kit

This folder is the project's task pipeline: workflows (`workflows/`), the scripts every gate runs
(`checks/`), the role skills task agents follow (`skills/`), the leader's and the kit's own pages
(`docs/`), routing (`routing.json`, read only through `checks/route.mjs`), and the pipeline
configuration (`pipeline/`). It is committed and reviewed like source. Runtime state never lives
here: it goes under `.local/xezar/`.

Rules for anyone working in it, leader or task agent:

- **Every change here goes through a pull request**, and the security scan routes it to a
  security reviewer: these files decide what every run trusts. The only direct pushes are the
  campaign notes under `campaigns/`, `docs/leader-guide.md` and `unattended.json`.
- **Never stop a process by command-line pattern.** `pkill -f` and its relatives match every peer
  agent on this machine. Stop only a process ID you started yourself.
- **The committed config carries no machine-sized limits.** `config.json` travels to every
  checkout, so a parallelism or memory ceiling belongs to the machine's own settings, never here.
- **A task never edits the kit to make its own gate pass.** A kit defect is reported and fixed in
  its own pull request.
- **No personal identity in a committed file** — no email, real name, home folder or absolute
  path. Login IDs in `routing.json` rotations are the one exception.
