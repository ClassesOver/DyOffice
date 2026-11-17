# T14 terminal abandonment prerequisite (no UI/HTTP mount)

This implements the narrow durable fencing protocol required before controlled
GUI assembly. It is not a local undo, a document rollback, or full T14 closure.

## Exact integration

- T13 #81: 6996c33536617cb2666c0ab85dd661859fc2105f. All 47 incremental
  files versus #73 were checked against remote blob SHAs before integration.
- T14 #82: 2e3a2261a7912d70ab24d3dcbc8498acd1e28c94.
- Migrations0001–0020 retain their exact #82 bytes. 0021 retains exact #81 bytes.
- 0022 is registered after0021 in loadMigrations. The initial experiment manually
  applied0022 after a base fixture; final integration tests REMOVE that manual
  application and exercise normal automatic migration. Do not conflate these.

## Contract

abandonCommand(envelope,digest) uses current owner/session/files:write authority
inside the existing principal/account/file/lease/command locking sequence. Only
trusted docs.replace_text.v1 live-editor commands may enter abandoned_uncommitted.
Pending, approved, unknown apply/undo and applied-uncommitted commands can be
fenced. Claims and immutable identities remain unchanged. No active lease is
required to fence one's own old command; it does not take over or alter a lease.

Committed commands cannot become abandoned: their exact durable receipt must
verify before returning. Repeated abandonment is idempotent. Existing propose/
cancel retries may return the terminal record but never create a new proposal or
apply effect. Old approve/apply/report/undo/bind/commit paths cannot resurrect it.

The binding row is retained. The SQL state guard preserves existing shape/NULL/
identity checks, and a binding trigger rejects new bindings for abandoned rows.
Its name orders it AFTER command_live_file, preserving file-before-command locks.
The T06 trigger still rejects anything other than applied_uncommitted, including
bound uploads whose caller omits or changes sourceCommandId. No object, upload,
binding or durable revision is deleted by abandonment.

## Evidence and limitations

A real PostgreSQL RED run reached the original0020 guard and failed with23514
“Command transition is irreversible”. Core unit tests also failed before the API
existed. Final tests cover both deterministic lock winners, lock-wait revocation,
cross-session/owner denial, stale epoch fencing, direct SQL claim/state attacks,
new binding attacks, and process exit before/after commit. A precommit crash rolls
back; a postcommit lost response observes the tombstone and cannot replay.

Fresh database migration and upgrade-from0021 use the real ledger. Upgrade checks
retain old migration digests and unchanged ACK/T05/T12/T13/commit-bound functions;
it does not purport to be a large production-data migration benchmark.

The first combined run had62/65 pass: one RustFS dependency was not started, and
two old HTTP tests sent Uint8Array as JSON through Fastify.inject after the #80
owned-byte fix. The test fetch shim now transmits Buffer bytes, matching actual
fetch binary bodies. Product serialization was not reverted to satisfy the shim.
The final run uses isolated PostgreSQL55447 and RustFS19047, serially.

Current HTTP routes and GUI do not expose this method. Recovery after refresh is
still separate work: receipt verification is bound to the original editorId;
a fresh page must not weaken that check or reuse an old editor's write authority.
An authenticated recovery/read protocol and explicit GUI state transitions must
be reviewed before entry assembly. No product route or automatic approval changed.

## Final registered integration result

- Real PostgreSQL + RustFS: **66/66 PASS, zero skips**, 124 seconds. Includes
  14 abandonment cases, v21→v22 and v19→v22 automatic upgrades, existing command
  journal/HTTP/T06 save tests and T13 persistent budget regression.
- Command-related unit tests: **51/51 PASS**.
- Full server strict TypeScript: **PASS**.
- Web boundary scanner: **1000 files, zero violations**.
- All isolated service wrappers exited and stopped their PostgreSQL/RustFS process.

The new terminal transition is a prerequisite protocol only. No abandonment HTTP
endpoint, refresh recovery endpoint or controlled-page UI is exposed here.
