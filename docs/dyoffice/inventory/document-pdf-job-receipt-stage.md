# PDF job receipt reconciliation (unregistered candidate)

This read-only control-plane slice reconciles an existing `pdf.rotate` job's T06
save receipt using a current authenticated owner session. It neither runs PDF
code nor accepts fixture output as execution approval. No HTTP route, worker
registration, retry, upload, commit, compensation or cleanup is added.

## Authorization and evidence

`createPdfJobReceiptRecovery` freezes a session credential and captures file/job
UUIDs before awaiting. Existing PrincipalTransactions validates current session
and rechecks authorization at transaction completion. File read and write policy
are both required. A new owner session may reconcile a completed job whose original
session is logged out; it does not revive the completed job's credential.

A scoped live-file-only SHARE lock precedes the existing `loadFile` statement.
This matters when a concurrent commit changes current_revision: a joined query
waiting for that file can otherwise encounter an EPQ-updated head against its old
statement snapshot and spuriously return 404. The separate lock lets the next
statement see the committed head. Shared file queries are unchanged. No job lock
is taken after the file lock, avoiding inversion with real job commits.

One plain MVCC join checks succeeded PDF job/result revision, fixed `job_<id>`
receipt key, historical job epoch/claim-hash/lease/transaction evidence, upload's
historical session/authVersion/editor/epoch, base and lease epoch, committed PDF
upload, non-restore save provenance and matching SHA-256/size. The exact T06 hash
of `{fileId,uploadId,baseRevision,leaseEpoch,sourceCommandId:null}` is recomputed.
This is not the native job command hash. Completion clears current claim fields;
historical receipt evidence is not compared to a current token, transaction ID or
current time.

The only successful projection is
`{state:'committed',revision:{fileId,revision,sha256,size}}`. Missing, pending,
cancelled or inconsistent evidence is `unresolved`, not commit failure. Current
authorization and inaccessible/deleted/purging-file failures remain errors.
A historical revision need not equal today's head. Reclaimed revisions are excluded;
the database itself prohibits reclaiming any live file revision, without test bypass.

## Real test scope

The focused suite uses isolated PostgreSQL with existing restricted roles, local
object storage, self-generated PDF bytes, real worker claim/job lease/upload and
RevisionService commit. No fake broker approval or execution permission is added.

- Actual COMMIT then injected lost response; fresh owner-session reconciliation.
- Injected failure before COMMIT with actual rollback; pending evidence unresolved.
- Cross-owner/admin/logged-out rejection and cross-file/job non-disclosure.
- Receipt hash/epoch, upload editor/authVersion, revision SHA/result binding damage.
- Later real owner save, historical receipt, live-reclaim guard and trash rejection.
- Cancelled job unresolved, without replay.
- Both lookup-first and commit-first actual lock orders, covering the EPQ regression.
- Session expiry during observed file-lock wait; final authorization denies receipt.
- Real trash committing during observed lookup lock wait; receipt denied.

Fault injection wraps actual queries and is not a real network-outage test.
Authenticated nonzero count/head/job/quota snapshots check reconciliation writes;
fixture setup and concurrent saves naturally write. Existing job/output/route and
session-receipt suites are included in the associated regression evidence.

## Limits

A T06 receipt does not prove rotation execution, artifact provenance, isolation or
permission for a future action. Database evidence is not proof against a privileged
migration owner. Revocation may occur immediately after transaction completion.
Unresolved must never cause replay, re-prepare or guessed cleanup. Actual isolated
execution-to-save wiring and production registration remain absent.

Current environment: Debian x86_64. Target Ubuntu x86_64 and openEuler x86_64,
browser/desktop parity and RustFS are not tested by this slice.
