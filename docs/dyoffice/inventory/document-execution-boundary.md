# One-shot outline coordinator: test-only boundary skeleton

This change adds coordination code, not a working PG authority adapter, durable reservation store, broker or production isolation. Existing worker/main.ts and all production feature switches remain unchanged. `createDocumentExecutionBoundary()` always rejects. The separate injected factory requires both actual `NODE_ENV=test` and `unsafeTestOnly:true`; a fabricated enabled flag does not enable production. Run checks repeat the test-environment gate.

## Trusted ports and missing integrations

`document-execution-ports.ts` separates trusted authority/reservation adapters from a backend that receives only validated request metadata and copied document bytes. No database credentials or job/session tokens are sent to backend. Authority must return server-constructed request identity plus validUntil after verifying current PG job, file authorization, edit lease and revision. Every request field is compared with the immutable initial snapshot at pre/before-start/post/return checks.

Current JobClaim in worker-store.ts has ownerId/sessionId/authVersion and job epoch, not a complete tenant/editor/edit-lease snapshot. `ownerId` must not be silently substituted for `tenantId`, and `store.renew` alone cannot prove the edit lease. The real adapter may not be registered until these mappings and PG proofs are implemented. It must validate leases using PostgreSQL database time and conservatively convert remaining validity with round-trip time and clock skew accounted for; comparing local Date.now with validUntil is not proof of PG authorization. Current fake ports only exercise local sequencing and monotonic budgets. Current tests use explicit fake ports and prove control order only.

Reservations use a deterministic key: deployment/job/attempt/jobEpoch. Each port must be idempotent and version/CAS-fenced. reserve must return an exact positive ReservationGrant for that key; false/undefined/wrong-key results cannot permit start. bind/release/retain have a void success contract checked at runtime: any fulfilled non-undefined value (including a PostgreSQL CAS false) is a protocol failure, not a successful acknowledgment. The test factory rejects concurrent and repeated attempts within its lifetime, retains at most 1024 seen keys and refuses further admission at capacity. This local guard is not cross-process protection; persistent exclusivity and backend start idempotency are mandatory real-adapter obligations. A retain/reconcile tombstone must survive a reserve call whose response has not arrived, and late reserve/bind may not overwrite it. This storage contract is unimplemented here; a mock passing it is not durable-recovery evidence. If retain itself fails, the operation rejects and carries reservationKey for reconciliation, not a claim that retention was persisted.

## Sequence

Validate immutable request → check input size → copy bytes before first await → verify SHA256 → authority precheck → reserve → authority before-start check → mark start attempted synchronously → start → verify returned handle against expected deployment/job/attempt/epoch/runtime/profile → bind → execute outline with a fresh request ID → strict result/pending validation → authority postcheck → stop with complete expected handle → release only with confirmed matching stop → authority return check → deliver result.

Unknown/mismatched start handles are never passed to stop; that could kill a foreign instance. Their deterministic reservation stays unknown and must be reconciled. A late start result cannot execute or complete the operation. A synchronous invalid result never becomes a business success.

## Four reservation outcomes

1. **Not started:** reserve returned, but start was never attempted. A successful release with explicit notStarted evidence can reclaim it.
2. **Confirmed stopped:** valid handle was bound; trusted stop observation matches the full handle and confirms termination. Successful ledger release can reclaim it.
3. **Unknown:** reserve/start/bind/stop may have happened but cannot be proven. Retain/quarantine by deterministic key; never return a result or claim released.
4. **Ledger failure:** reserve/bind/release/retain failure or timeout is not success. Reject and retain/reconcile as possible; return the reservation key on failure. A release response loss remains unknown even if a late reply eventually arrives.

XLSX engine close is deliberately not wired here: its receipt only means session closure and cannot substitute for stop or reservation release. T06 and all mutations are outside this one-shot read-only skeleton.

## Time, cancellation and side effects

The configured test operation budget is one monotonic performance.now budget shared by all business awaits, bounded further by the request and verified authority expiry. Wall-clock expiry is also checked; each proof is mapped to a monotonic deadline and later checks may shorten, never extend, that deadline. Wall-clock rollback cannot extend operation or cleanup waits. It is not reset for each port. Cleanup gets a separate finite budget and does not inherit an aborted business signal. This is a shared wait budget, not a hard real-time cutoff: after it is exhausted the fixed cleanup flow may make at most two additional 1ms best-effort ledger waits. Event-loop scheduling can delay timers. A failed or timed-out retain is reported with the reconciliation key, never as a persisted tombstone. Pending operations receive AbortSignal where supported; ignoring it does not make them safe.

Every business task rechecks expiry/cancellation immediately before its callback, including after scheduling a microtask. Promise rejection is detected by an explicit failure branch even for empty-string/zero/false reasons. A bounded wait/Promise race is **not** process termination, transaction cancellation or rollback. Late callbacks cannot advance the local coordinator, return results or release capacity. The fixed ledger key and idempotent tombstone contract are necessary because remote side effects can finish later. Unknown stops retain capacity. Final return rechecks authorization after cleanup and performs a final synchronous cancellation/expiry check immediately before return, so a result is not leaked when revoke/expiry wins the race.

No background renew loop is added: this is a bounded short-lived one-shot request within its verified validity window. Long-lived sessions require a separately implemented PG-first renewal plus broker watchdog and persistent recovery; this skeleton must not be used to imply those exist.

## Evidence and limits

Tests cover input mutation/hash mismatch, pre/post revocation, changed tenant/session/editor/lease/job epoch/base/generation, expiry, start throw/hang/late success, foreign handle, execute timeout/abort, stop unknown/wrong identity/hang, reserve late resolution, bind failure, release response loss, cancellation at multiple awaits, and shared budget exhaustion. Test logs distinguish failed-first cases from final reruns. Real PostgreSQL, RustFS, systemd/openEuler and process-tree termination are not exercised by these fake-port tests.

The existing experimental root host is not adapted automatically: its XLSX command set, process-local accounting and dynamic runtime dependency setup do not satisfy this new identity, persistent reservation and runtime certification contract. Production remains unavailable until real adapters and deployment acceptance exist.
