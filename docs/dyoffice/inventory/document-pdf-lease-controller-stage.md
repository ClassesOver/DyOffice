# PDF claim-to-edit-lease controller candidate

## Concrete service composition

The test-only controller constructs the existing restricted worker claim reader, business `createLeaseService`, and candidate native-authority verifier. It does not inject a fake executor, add a SQL function, register a route or change production worker/readiness policy. Candidate SQL is explicitly installed only in isolated tests. The worker pool is used only for claim/command and native-fact functions; real business `PrincipalTransactions` acquire the job-bound edit lease. Native processes receive neither pool nor credentials.

Before its first await the controller strictly captures only `{jobId,epoch,token}`. File/owner/session/source metadata come from the reader's real PostgreSQL facts. The sequence is:

1. Read and validate the persisted command and running claim.
2. Acquire the actual file edit lease with the job credential and `editorId=jobId`.
3. Form expected native facts from SQL-derived metadata and the returned actual lease epoch; verify them through existing `document_native_authority`.
4. Read the command again and require the same digest and every claim/source fact.
5. Reverify native authority and return a narrow observation.

The native verifier checks the persisted job/session/authVersion, current file revision, input digest/size, edit lease job/epoch/session/editor bindings and expiry. It reuses existing lock order and running-only final checks. The controller does not derive a tenant or runtime approval from these facts.

## Races, remaining time and cleanup

Each observation contributes a conservative monotonic deadline based on call start plus the adapter's already reduced remaining duration. The final result uses the minimum deadline minus elapsed time, never restarts an earlier TTL or extends it after renewal. Test-mode gates are checked after awaits. Only command, digest and verified fact metadata are returned; tokens and pools are excluded.

These are multiple transactions, not one atomic command-plus-lease grant. Revocation, head changes or command changes can happen immediately after a successful return. Before/after execution and T06 commit still require their own checks. No native runtime was started and no execution or stop evidence is asserted.

Failure deliberately does **not** auto-release. Concurrent preparations for the same job and claim epoch may share the same edit lease, so a failed caller must not cancel a successful caller's lease. An acquisition response can also be unknown, leaving no safe epoch to guess. The existing lease is bounded by its configured TTL and native claim expiry; any later explicit cleanup must use the exact original job credential, file and observed epoch, and never a user credential, takeover or a newly discovered epoch. Lease release would not prove OS process termination or resource-capacity release.

## Real verification scope

Fixtures import synthetic PDF bytes, persist commands with the shared enqueue transaction, claim with the real restricted worker API, and acquire/edit/query real PostgreSQL leases. They do not insert fabricated running-job or edit-lease rows and do not run fake native processes.

Tests cover same-claim concurrent idempotence, competing jobs for one file, user takeover remaining intact after controller failure, natural lease expiry and a new real epoch, session revocation, actual T06 head advancement despite claim renewal, old native claim rejection after reclaim, actual lease-row lock wait with a changed command, missing verifier failure preserving another successful same-claim lease, pre-await input capture, wrong-role pool rejection and production-mode refusal. The command-race test observes the business connection waiting on a lease row and mutates the command before the acquisition lock timeout.

The earlier reader permissions and queue persistence remain separate prerequisites. This controller does not wire a production PDF parser, runtime registry, grant issuer, editor UI, output validator, T06 PDF job commit or job receipt recovery. It is not full T11 closure. Host validation is Debian13 x86_64 only; Ubuntu/openEuler x86_64 and browser/desktop acceptance remain untested, ARM excluded.

Final local focused verification: lease-controller9 + claim-reader10 + command-queue7 passed 26/26 on real PostgreSQL17/local objects. The lock-wait command mutation changes command JSON and its digest but not the native-job request hash, so that test primarily proves the stored binding rejection; it does not separately exercise a privileged consistent rewrite of all hashes between the two reader calls. Independent static review found no blocker. Integration verification against the PR's final combined tree is recorded by the coordinator.


Additional consistent-rewrite regression: a test-only proxy forwards every role check and query to the actual restricted worker pool. After the first reader transaction has really committed (and released database locks), it pauses that return and uses a separate owner transaction to update a legal command JSON, its digest, and the matching native-job request hash together. Both real reader SQL calls succeed with different digests, the first native verification succeeds, and only one native verification is invoked: the controller rejects at its intervening digest comparison before final verification. A fresh unproxied controller subsequently accepts the new command, excluding malformed persisted state as the cause. This is deterministic test scheduling, not a production hook or a fake reader, and privileged owner corruption is fault injection rather than runtime-role capability. Failure leaves the real shared lease active.

After this addition, all ten lease-controller tests passed on real PostgreSQL17 (10/10; 11.8 seconds). The earlier combined 26/26 result predates this additional test; the coordinator performs final combined regression. No implementation change was needed.

Mutation verification additionally removed only the controller digest comparison temporarily, retaining fact comparison. The targeted consistent-rewrite test then failed with `Missing expected rejection` (1 failed), proving that this comparison is necessary for this case. The original controller was restored byte-for-byte; this intentional RED log is not a product regression.
