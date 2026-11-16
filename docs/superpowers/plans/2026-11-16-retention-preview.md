# T05 read-only retention preview implementation plan

Goal: add a pure bounded classifier for a future retention preview, never an executor.
Architecture: explicit disabled-by-default policy and an already-authorized owner-scoped snapshot produce review candidates and blocked counts. The output is not authority to purge; a future caller must recheck session, file, jobs, uploads, leases and accounting transactionally using the existing purge path. No SQL, route, scheduler, storage calls or deletion are added.
Alternatives: automatic purge is unsafe without an approved retention policy and job credential design; bulk UI depends on unsettled confirmation and browser integration. A pure read-only preflight is independently testable without those choices.

- [x] Write tests: disabled policy, age boundary, wrong scope, active/uncertain state, bounded ordering, malformed timestamps, duplicate IDs, no input mutation.
- [x] Observe failing safe stub.
- [x] Implement standalone TypeScript classifier with bounded input/output and no imports or side effects.
- [x] Run tests and strict standalone TypeScript, inspect output and document limitations.

This is a preparatory slice only. No default retention duration is chosen, no automatic deletion is enabled and no physical space reclamation is claimed.
