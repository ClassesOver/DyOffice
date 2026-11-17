# Actual deny-only broker / PostgreSQL dispatch composition

This slice connects the existing test-only native-job issuer and restricted
PostgreSQL authority bridge to the reservation coordinator and actual Rust code.
It is a **negative admission chain**, not successful sandbox execution or export.
No new database migration, application mount or production switch is introduced.

## Executed path

1. A real PG native job, edit lease, explicit scope binding and test-approved
   runtime context are verified by the existing restricted worker authority.
2. The coordinator reserves capacity and durably commits start intent.
3. `document-broker-admission.ts` spawns only a fixed repository build artifact,
   with no shell, command arguments, inherited credentials or document bytes.
   The only stdin is a bounded control frame containing the trusted request and
   context reference. stdout and stderr are each limited to 1024 bytes; the
   driver uses one 1500 ms deadline and observes cancellation.
4. The feature-gated Rust example runs the actual `ProbeBroker` over a real Unix
   socketpair with kernel peer credentials. Its response is always disabled.
   The response parser binds the request ID and expected boot ID to the frozen
   request/context invocation. This is correlation, NOT authentication. No
   success/handle/artifact/stop-proof result exists.
5. A disabled reply, failure or actual default binary exit 78 leaves the attempted
   launch uncertain. The coordinator retains the reservation. After rebuilding
   the PG adapter, the reconciler persists `blocked_uncertified`; capacity remains
   charged. It never calls a T06 writer.

The same-UID socketpair is wholly inside the test artifact. It does not establish
an independently authenticated broker listener or tenant authorization. The
trusted context supplied to this fixture is not an OS capability certificate.
The default binary still exits 78. Killing the local test artifact for cleanup
is never interpreted as evidence that a document unit/cgroup stopped.

## Tests and baseline

The existing 24-migration baseline is retained. The new PG negative suite shares
an extracted copy of the existing authority fixture without relaxing its roles,
RLS, native credential checks or cleanup. Its T06 snapshots first establish actual
native job authentication and assert a nonzero original revision. Across denial
and reconciliation the head stays identical, with no uploads, receipts or outbox
rows added. No synthetic artifact is passed into the existing commit API.

The broker-specific suite is separate from the pure TypeScript protocol glob:
missing Rust build artifacts fail explicitly, never silently skip.

From repository root, with the Rust toolchain available:

```sh
cargo build --manifest-path services/document-broker/Cargo.toml --locked --offline \
  --features unsafe-test-harness --example admission-fixture
cargo build --manifest-path services/document-broker/Cargo.toml --locked --offline \
  --bin dyoffice-document-broker
node --experimental-strip-types --test apps/web/test/sandbox-broker/*.test.mjs
# Supply the existing disposable DYOFFICE_TEST_DATABASE_URL for these tests:
node --experimental-strip-types --test --test-concurrency=1 \
  apps/web/test/sandbox-pg/document-authority.test.mjs \
  apps/web/test/sandbox-pg/document-broker-negative.test.mjs
```

The example requires both its explicit build feature and
`DOCUMENT_BROKER_TEST_HARNESS=1`. The Node test driver sets only that environment
variable, or an empty environment for the default disabled binary. Callers cannot
supply an executable path, command arguments or environment map.

## Still absent

Positive export and T06 preparation remain unavailable through this boundary.
They require an authenticated deployed broker, independently validated OS
isolation on openEuler/Ubuntu x86_64, a trusted runtime manifest, sealed artifact
reading, and full output provenance enforced in the same T06 commit transaction.
The outline-only coordinator must not be reinterpreted as export. No isolated
stop proof can be minted from an Ed25519 OS-unverified receipt or this denial.

## Real process faults

The same build-gated fixture has a closed enumeration of test faults: a 3-second
stall, 1025 stdout bytes followed by a stall, 1025 stderr bytes followed by a stall,
partial JSON, and exit without a reply. The driver maps these fixed values to a
single test-only environment variable; arbitrary command/argument/environment
input is still not accepted. Tests require timeout rejection before 2.5 seconds,
flood rejection before 1 second, and explicit cancellation before 1 second.
Temporarily removing the timer and stream limits makes the three corresponding
tests fail; restoring the guards returns them to green. Partial and empty replies
also reject. Each fault has a real PG regression verifying quarantined capacity,
blocked reconciliation and unchanged T06 state. Cancellation is additionally
exercised against an actual stalled child process. These faults never execute a
document or acquire OS isolation privileges.
