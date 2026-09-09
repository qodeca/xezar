# Kit/runtime upgrades

Pin source revision, installed runtime/version and built artifact identity before qualification; do not change a build while testing it. Check catalog against actual workflow/config schemas and real loaders, not assumed composer defaults. Per-step pins override selection; this kit deliberately inherits the chosen backend/model. Standalone skills are allowed.

Compare default-path guarantees, stage order, two local retry limits, all callers/continuations, evidence schema/fingerprints, current eligibility, ignores, bootstrap snapshot behavior, integration policy, root lock and recovery. Preserve local improvements and active task snapshots; record rationale and rollback target. Do not lower gates to repair adaptation. Historical observations are candidates to requalify, not proof of current bugs. No automatic source watcher or new scheduler.
