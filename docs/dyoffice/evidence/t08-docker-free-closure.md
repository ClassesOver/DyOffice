# T08 Docker-free execution and durable delivery

Date: 2026-11-16. Scope: T08 only; T09 spreadsheet editing and later production
release gates remain separate. T08 acceptance is complete; this file records observed evidence, not a
production deployment claim.

## Implementation

The Worker uses the original locked Rust XLSX engine, built directly with
Cargo/Rust 1.93.0. The checked executable is launched by systemd 255 with a
private root, dynamic nonroot UID, no capabilities, no inherited controller
credentials, private network, and CPU/memory/PID/file/protocol/wall limits.
Node performs bounded input/output through a directory descriptor validated
against the running unit PID, cgroup and invocation identity. Service-manager
wall limits remain active when the controller receives SIGKILL. Recovery only
removes private, expired preparation roots for the configured deployment after
confirming the corresponding unit has no process and is inactive/failed.

PostgreSQL remains authoritative for jobs and output completion. BullMQ messages
are hints. Claim epochs and purpose-bound edit leases fence duplicate and stale
attempts; output revision, receipt, outbox event and successful job state share
one database transaction. Cancellation, auth revocation and lost authority abort
native execution. Experimental Cookie APIs preserve Origin/CSRF and owner scope.

Migrations 11–12 add bootstrap readiness and revision delivery leases. A separate
restricted Worker role publishes opaque `{eventId}` revision hints, acknowledges
with an epoch/token, and periodically replays from SQL. Stable event IDs dedupe
pending Redis messages and reconstruct a lost queue. `published_at` is transport
acknowledgement, not downstream indexing completion. Search indexing belongs to
T16 and must authorize/idempotently process any hint it consumes.

## Observed verification

All below ran on independent host services without Docker: PostgreSQL17.12,
Redis7.0.15 and checksum-verified RustFS1.0.6. Native tests used the newly built
host executable, not the historical container build.

| Requirement | Evidence |
| --- | --- |
| Real Rust parsing, formula reads/recalculation, archive preservation | `test/sandbox/xlsx-native.test.mjs`; every original XML part compared |
| Kernel isolation, resource exhaustion, API survival, bounded output, admission | `test/sandbox/host-limits.test.mjs`, `test/host-native/process.test.mjs` |
| Controller SIGKILL cannot leave native execution running | Real separate controller killed; unit reaches `MainPID=0`, `Result=timeout` |
| Recovery does not remove live/fresh/foreign/symlink roots | `test/host-native/recovery.test.mjs` |
| All native isolation/file tests | 16/16 passed |
| Enqueue commit before delivery, Redis loss/reconnect, lost SQL locks, duplicate claims, cancel, stale versions, output rollback, committed output replay | `test/jobs/*.test.mjs`, 36/36 passed |
| Revision publication lost ack, duplicate pending messages, Redis queue loss | Real Redis tests in `revision-delivery.test.mjs` |
| Public API → daemon → Rust → validated output → atomic success; actual revision hint publication | `test/native-jobs/xlsx-executor.test.mjs`, 9/9 passed |
| Structural validation and immutable real object storage | `test/storage/*.test.mjs`, 21/21 passed |
| CI coverage and host provisioning shell syntax | 5/5 CI tests; `bash -n` passed |

Final regressions passed: Web API118/118, browser TLS session5/5, unit37/37,
legacy API32/32, tooling15/15; Web/Worker TypeScript passed. Browser dependency
scan covered553 files with zero violations. Compatibility baseline covered84
files with zero unexplained drift; only the reviewed sandbox test script change
updated apps/web/package.json metadata. Together with the suites above,289
tests passed (the5 CI tests are included in tooling15). CI configuration now uses host PostgreSQL, Redis and
pinned-checksum RustFS on Ubuntu24.04; the remote workflow has not been run in
this session. A fresh-context final reviewer found no Critical/Important issue;
its remaining minor item was updating current plan status/evidence.

Crash recovery evidence combines real controller SIGKILL/manager termination,
SQL lost-claim takeover, committed-output/controller-death replay, and daemon
startup/dispatch tests. A single daemon SIGKILL → restart → automatic reclaim
scenario was not executed; it is not represented as a passing test.

## Limits and operation

Use [host runtime instructions](../../../apps/web/worker/HOST-RUNTIME.md).
The trusted controller currently requires root to manage transient units; native
jobs run as dynamic nonroot users. `NODE_ENV=production` is still refused. XLSX
roundtrip preserves the unedited archive; this does not deliver the T09 browser
spreadsheet editor or edited/recalculated persistence. Historical T08a–e evidence
records earlier checkpoints and does not override the current host setup.
