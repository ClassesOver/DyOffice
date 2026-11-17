# PDF trusted input snapshot candidate

This test-only service composes the existing real PDF claim-to-edit-lease controller and FileService. It is not a parser, native runtime, execution grant, sealed memfd, production route or T06 output pipeline. Trusted object-store configuration is supplied at construction, never by the document.

## Actual path

1. Capture only jobId/epoch/token before awaiting; the existing controller validates those values and derives all owner/session/file/base facts from PostgreSQL.
2. Prepare the actual job-bound edit lease and command observation.
3. Call FileService.readFile with the frozen job credential and SQL-derived file/base revision. Its existing transaction checks the job and resolves the persisted object key, size and SHA; readVerified verifies real storage bytes inside that transaction.
4. Immediately make a private Buffer copy and independently match actual length/SHA to the initial SQL-derived facts.
5. Repeat real claim/lease/command verification. Require the same command digest and every fact, including lease epoch. A renewed/replaced lease cannot silently substitute for the first observation.
6. Return only observation metadata and copyBytes(), which returns a fresh copy on each call. No internal buffer or credential is exposed.

The minimum of each observation call-start plus its already-reduced remaining duration bounds local lifetime, including I/O time. Cancellation and test-only gates are checked around awaits and copying. Integer remaining time must be positive. A later observation cannot extend an earlier deadline. Failure never releases a possibly shared lease.

## Authority and isolation limits

There are separate transactions. Permission, head or command state can change after the last check. copyBytes() checks only known local cancellation, gate and deadline, not fresh database authority; previously downloaded bytes are not retroactively revoked. Before execution and commit, real fresh authorization is still mandatory. No tenant, runtime digest or session-binding mapping is invented. Unified runtime authority remains PPTX-only and a certified PDF backend is absent. No parser is started, no execution handle or grant is issued, and no output upload/revision/commit occurs here. Real lease preparation can create/renew edit_leases, so this is not a zero-database-write claim.

## Evidence

Real isolated PostgreSQL and local object storage tests cover six cases: real job-authorized bytes and nonzero uploads/revisions/commits baseline unchanged; private-copy independence; revoked/pre-aborted requests cause no object reads; a verified object read crosses real claim expiry; corrupt object bytes and cancellation during I/O fail closed; real logout and T06 head advancement after download COMMIT reject; input mutation cannot change captured identity; local snapshot cancellation and production gate reject copies.

Storage wrappers inject corruption/delay/cancellation only for fault scheduling and retain the real readVerified call. A PrincipalTransactions proxy performs real logout/T06 operations only after the actual download transaction has committed, avoiding artificial lock deadlocks. These are not fake authorization results or proof of OS isolation. The head-change case writes exactly one revision through an independent authorized user operation; the preparation itself writes no output.

Initial four and expanded six tests passed. Final combined test counts and independent validation are recorded in the handoff and PR. A typecheck narrowing error on the first draft was corrected, then the full server typecheck passed. Full repository/browser/desktop acceptance was not run in this slice. Host exercised: Debian13 x86_64, PostgreSQL17, local object storage; Ubuntu/openEuler x86_64 remain untested, ARM excluded.
