# PDF native command queue binding candidate

## Scope

A test-only PDF rotation-command persistence adapter now uses the existing native-job enqueue transaction. It is not registered in `app.ts`, HTTP routes, worker enabled types or production migrations. `command-queue.candidate.sql` is explicitly installed only in disposable tests. `NODE_ENV=test` and `unsafeTestOnly:true` are both required; calls and the transaction callback recheck the gate. This does not enable a PDF runtime.

## Trusted state and one transaction

The PDF adapter accepts a session credential, artifact revision, idempotency key and `{version:1,action:'rotatePages',operations}`. It does not accept owner/session identifiers, tenant mappings, runtime identities or execution tickets. The parser-free `validatePdfRotationOperations` snapshots plain enumerable data properties, validates page/angle/count/duplicate-page constraints, and freezes the operations before any await. No PDF parser runs here.

The existing `runFileTransaction(...,'files:write',...)` derives current session, deployment, owner and authorization version, applies RLS and rechecks authority at commit. The raw enqueue primitive is private and rejects job principals. A dedicated test binding entry authenticates for itself rather than taking a caller-supplied principal. Generic and PDF paths share job policy defaults/validation, owner advisory lock, file-format/current-artifact check, quota, native-job insertion and outbox insertion. Generic public inputs and its original hash stay unchanged.

PDF uses the canonical command JSON SHA-256 in its job request hash, alongside type `pdf.rotate` and artifact ID. The immutable-to-business-role command row is inserted in the same transaction as job and outbox. Any command failure rolls everything back. Prior job replay verifies both job request hash and its existing command; missing or mismatching commands are conflicts, not automatically repaired. At quota, an accepted key can still replay without consuming a new slot.

The candidate table has composite deployment/owner/job FK, FORCE RLS using the existing transaction settings, a canonical-text SHA-256 check and basic command shape checks. Test provisioning grants the restricted business role only SELECT and INSERT, no UPDATE/DELETE; PUBLIC receives no access. Full canonical schema verification is performed again by the reader. This is not protection against a privileged database owner rewriting every related record.

## Recovery is metadata, not authority

A fresh process can reauthenticate and read the stored command. Read revalidates owner, live file/current base revision, command schema/canonical text/digest, and the matching native-job request hash. It returns only job metadata, command and digest. It creates no native lease, execution handle, runtime grant, approval or signature.

Future dispatch still needs a real native-job claim, permitted PDF profile/runtime, appropriate job-bound file lease (`editorId=jobId`), operation/output binding and the existing T06 job idempotency key `job_<jobId>`. Native T06 commit atomically completes the job. None of that execution wiring is supplied by command persistence. The existing session-side PDF receipt reader excludes job commits and must not be presented as job recovery.

## Why not reuse the live-editor journal directly

`command_journal` stores envelopes, but no PDF tool descriptor is registered in the current request factory. Its authority and approval transitions are tied to a live editor's session, generation and original lease. Applying a command moves it to `unknown_outcome` and requires reporting the edited generation. Its receipt verification explicitly requires `revision_commits.job_id IS NULL`. Merely linking its command ID to a native job would leave lease handoff, approval state and job receipt semantics undefined. This candidate therefore binds a separate native-job command domain; it does not bypass or reinterpret a live-editor approval record.

## Verification and limits

Tests use a real isolated PostgreSQL 17 database and existing restricted runtime roles, synthetic PDFs and local object storage. They cover concurrent duplicate enqueue, changed-operation conflict, fresh Node-process database reread, B/admin rejection, session revocation, unscoped RLS invisibility, denied business UPDATE, invalid commands, triggered insert rollback, missing binding refusal, privileged command-only tampering detection, quota replay and absent candidate-table rollback. Full generic durable-job and output-commit/API regressions are included in the handoff evidence; Redis dispatch is not covered here.

This remains a candidate, not a production migration or end-user PDF editing feature. No real OS isolation or browser/desktop acceptance was performed. Local execution was Debian 13 x86_64; Ubuntu x86_64 and openEuler x86_64 remain target-platform work, with ARM excluded.
