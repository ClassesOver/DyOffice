# PDF claim-bound command reader candidate

## Real role boundary

This slice connects the existing PostgreSQL worker claim to the persisted PDF rotation command without granting worker table access. `createJobWorkerStore.claim` and `claim_native_job` remain unchanged. The new `command-claim.candidate.sql` is test-installed only after the queue candidate. It is not a production migration or registry entry.

`read_pdf_claim_command(deployment, jobId, epoch, claimHash)` is SECURITY DEFINER under the existing disposable non-superuser/non-BYPASSRLS migration owner. Its search_path is exactly `pg_catalog`; all repository tables and functions are schema-qualified using the installer-owned schema. PUBLIC execution is revoked. Tests grant only EXECUTE to the restricted worker role, not SELECT/INSERT/UPDATE on the command table or access to `lock_job_principal`. Auth and business roles cannot call the reader. Runtime roles cannot create objects in the application schema. No permissions are changed on a production environment.

The native process receives no database pool or credential. The reader is a trusted control-plane component running with the worker connection. It is not the business/API role disguised as a worker.

## Authentication, locking and command binding

The wrapper captures strictly `{jobId,epoch,token}` before awaiting. Deployment comes from trusted service configuration. It hashes the claim token, checks worker-role admission and invokes only the candidate function in a bounded transaction (1-second lock timeout, 2-second statement timeout). Errors are generalized. No caller-supplied owner, session, file, command, tenant or runtime identity is accepted.

SQL invokes the existing `lock_job_principal(...,false)` to validate the running claim, current session/user/authVersion and expiry. It derives job, owner, session and artifact from the locked database job, then locks personal role, file, source revision and command rows. After potentially waiting on those rows it invokes the same running-only check again; it never uses the succeeded-receipt `final=true` exception. It rejects changed head, deleted/purging/purged files, reclaimed source revisions, wrong format/type and missing command. The command digest is recomputed and compared with the native job's compact JS-canonical request hash; SQL `jsonb::text` is deliberately not used as a substitute encoding.

The wrapper repeats strict canonical command-schema/digest checks and validates the returned fact projection. SQL/credential secrets and object storage keys are not returned. Remaining validity subtracts the whole client round-trip and a conservative margin.

## What the result does not prove

The result is a point-in-time observation of a running claim, current source and persisted command. It is obtained before acquiring an edit lease, so it intentionally contains no edit-lease epoch, execution handle, signed ticket or runtime grant. Another transaction may revoke it immediately after return. Future execution still needs a real job-bound edit lease, verified PDF runtime approval/isolation, rechecks before and after execution, output/stop evidence and T06 job-bound commit. Production PDF execution stays disabled.

## Verified behavior

The fixtures import synthetic PDF files through real file services, enqueue commands through the real shared transaction and claim jobs through the actual restricted worker API. They do not insert fabricated running jobs. Final reader tests plus queue tests passed 17/17 on PostgreSQL17/local objects; server TypeScript checks passed. An independent read-only audit found no blocker; final independent integration run is recorded separately by the PR coordinator.

Coverage includes one winner under concurrent claims, bound command/source facts, worker table and bottom-function denials, auth/business reader denial, PUBLIC ACL/owner/search_path audit, schema creation denial, mismatched job/token/epoch/extra identity, stale claim after reclaim, cancellation, disabled user, revoked session, command/request-hash tampering, malformed persisted operations, current-head change despite a successful worker renewal, and production-mode refusal.

Both claim and session expiry tests observe a real command-row lock wait in `pg_stat_activity`. They release the blocking row within the 1-second lock timeout after the 650ms authority deadline and assert the direct SQL error is `28000`, not a lock/statement timeout. Thus the tests exercise post-wait authority rejection rather than merely a generic timeout failure.

No Redis, RustFS, browser/desktop or real OS isolation was exercised. Host: Debian13 x86_64. Ubuntu x86_64 and openEuler x86_64 are untested target platforms; ARM is excluded.
