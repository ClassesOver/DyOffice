# Unified document isolation: control-contract stage

This is an unconnected foundation, not a runtime sandbox or production release. It follows PR #126. Source mapping was made against `d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa`; before publication the relevant parser, worker, editor, application-registration and production-guard blobs were checked unchanged at `b9dd28f0ed562e739e79b80dd43a2f9669ebcdab`.

## Implemented

- Exact-key immutable document request/profile metadata; all four profiles remain experimental and production-disabled.
- Control handle/renew/adopt/stop/instance structures; systemd InvocationID is canonical 32-character lowercase hex. Trusted PostgreSQL authorization remains outside these syntax checks.
- Artifact envelope binds the trusted pending request, complete instance, command and generation; it does not prove the bytes or authorize T06 commit.
- Source-backed command schemas cover read-only PPTX outline and XLSX session close. Replies have strict nested schema, bounded size/count/path/font fields and unambiguous slide identities. Other engine commands remain denied. XLSX close validates its real Rust success frame against trusted current engine-session mapping; it never proves OS termination or releases a reservation.
- Local pending-outline/close gates snapshot expected context/deadline, validate before one-time consumption, and reject duplicate or expired replies. This is not durable replay recovery or permission revocation enforcement.
- PDF rotation operations have a standalone payload validator; it accepts no document bytes, proves no parsed PDF properties, and adds no runtime command.
- Source-backed entrypoint/reachability inventory and command disposition map distinguish browser workers, API parsers and future OS sandbox work.

A test-only one-shot outline coordinator now exercises trusted authority pre/before-start/post/return checks, fixed-key reservation grants, instance binding, bounded execution, confirmed-stop release and uncertainty retention. Default factory always refuses, and the test factory requires both actual test environment and an explicit unsafe-test option. Fault tests cover late side effects, false/failed ledger acknowledgments, cancellation races and wall-clock rollback; the broker and authority ports remain fake in those tests. A separate test-only PostgreSQL reservation candidate now exercises durable ledger transactions, with a real PG test suite described below.

No existing production entrypoint, registered database migration, runtime import, dependency, security setting or permission is changed. The new reservation SQL is an unregistered test candidate, not an installed application migration. No parser package is imported by these schema modules.

## Verification

Run from the repository root:

```sh
node --experimental-strip-types --test apps/web/test/sandbox/document-contract.test.mjs apps/web/test/sandbox/xlsx-close.test.mjs apps/web/test/sandbox/pdf-rotation-schema.test.mjs apps/web/test/sandbox/document-execution-boundary.test.mjs
```

Original control stage: 64 tests passed, no failures or skips. New implementation was preceded by missing-implementation tests; the control review regressions failed 6 cases before correction, outline failed 3 cases before implementation, and the pending gate failed 1 before implementation. Logs were retained in the working environment, not mistaken for checked-in production evidence.

The original eight TypeScript modules also passed an isolated strict check using the available TypeScript compiler with `--noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions`. This is not the full worker/application typecheck. An independently reviewed source snapshot and direct test rerun cover the contract stage; full repository regression was not run against a complete current checkout.

## Remaining scope

The broad Task 1 inventory and all four formats' complete request/reply schemas are not closed. This stage supplies bounded schema-only examples rather than admitting unvalidated commands. XLSX open remains refused because the real WorkbookMetadata reply contains nested styles/visuals/names/theme/protection data not yet fully validated; no simplified metadata projection is claimed as that schema. Runtime broker/IPC, immutable manifests, production reservation adapters and broker-assisted reconciliation, command adapters, production PostgreSQL authorization/T06 integration, browser-origin isolation, openEuler dual-architecture/SELinux tests and desktop fidelity are later work.

The entrypoint inventory identifies reachable non-production upload worker-thread validation and legacy DOCX API parsing. Existing production guards must remain; schema helpers do not remediate those runtime boundaries. See the inventory's source registration chains and required disposition before enabling any production path.

## PostgreSQL reservation candidate follow-up

The test-only coordinator now requires a persisted start-intent acknowledgement before calling its backend. An unknown acknowledgement cannot be treated as proof that nothing started. The candidate PostgreSQL adapter adds deployment slot accounting, one-time attempt claims, job epoch fencing, quarantine tombstones, full-handle stop validation and versioned recovery claims. Unknown instances retain capacity; no TTL frees them. This is deployment slot capacity only, not tenant, CPU or memory quota enforcement.

The adapter uses the existing pg dependency and a dedicated test-owner pool. Its SQL is **not** registered in the application migration manifest, and no worker role gains table access. Production adoption still requires the next migration, restricted SQL functions and role audits, PG authorization mapping, broker-side idempotency/fencing and real runtime acceptance. PG exclusivity alone does not guarantee exactly-once external process launch. See [PostgreSQL candidate design and test commands](../inventory/document-reservation-postgres.md).

Follow-up verification: **65/65 protocol/coordinator tests and 16/16 real PostgreSQL tests passed**, with no skips. All nine TypeScript modules passed the isolated strict check. The PostgreSQL suite includes concurrent claims/capacity, transactional rollback, deadline expiry while blocked on a database lock, tombstone persistence, wrong stop identities, recovery ownership fencing and the coordinator against the real ledger with fake authority/backend. Independent review reproduced two additional defects before correction: A→B→A owner ABA permitting an old in-flight release, and a higher-epoch tombstone failing to fence an older start. Both now have real-PG RED→GREEN regressions.

These results do not include a full current-repository regression/typecheck, application migration/role acceptance, database-server restart, real broker/OS process lifecycle or production isolation. Adapter recreation proves persisted rows survive adapter state loss, not a complete service crash/restart acceptance.

## Native authorization and restricted-role follow-up

A second unregistered candidate now verifies native-job facts using the existing `lock_job_principal(..., false)` at entry and exit, exact live file/revision and edit-lease provenance, and the minimum database-derived deadline. It returns instantaneous, immediately revocable facts only. It does **not** fabricate tenant/session-binding/generation/runtime mappings or implement the complete unified authority port. Tokens and capability hashes are absent from returned evidence.

The real PostgreSQL fixture applies the existing 22 source migrations under an isolated non-superuser/no-BYPASSRLS owner. Temporary worker and outsider roles have no direct table permissions; only worker can invoke the candidate function. Tests verify fixed function search path, PUBLIC/private-helper denial, no object creation, cross-session/provenance/head mismatch, revocation and three deadline types expiring while blocked on an actual row lock. All temporary roles/schemas are removed. No existing deployment role or system setting changes.

Current local verification: **25/25 real PG tests** (9 authorization, 16 reservations), **65/65 protocol/coordinator tests**, and isolated strict checking of **10 TS modules**. A NULL-head fault-injection regression tightened SQL equality; current source already forbids NULL heads, so this is defensive handling, not an existing reachable application bug. Full-repository regression, application role admission/manifest integration and complete unified authority mapping remain unverified or unimplemented. See [native authority candidate](../inventory/document-native-authority-postgres.md).

## Explicit trusted-context follow-up

A test-only mapping bridge now combines the native evidence with three explicit, trusted registrations: one personal-owner isolation scope per deployment/owner, a deployment-bound `test-approved` runtime profile, and an immutable native execution context. Only generation-zero, read-only PPTX outline execution is supported. The issuer builds request fields from verified PG facts and pinned registrations; worker cannot issue contexts or write registries. The dispatcher supplies the fixed context reference and job capability separately from the document request.

Every phase rechecks native facts, context version and scope/runtime identity, state and expiry in one transaction. Monotonic version triggers and forbidden identity deletion prevent ordinary ABA recreation; contexts can only be CAS-revoked, not rewritten. Required `validForMs` is anchored to verification start to prevent delayed proof consumption or wall-clock rollback extending authorization. Real PG authority and reservations now exercise the outline coordinator together, still with a fake backend.

This is a candidate mapping contract, not a deployed tenant policy, enterprise ACL, trusted-dispatch service, runtime certification, or a claim that database-to-external-side-effect TOCTOU is eliminated. All production factories/profiles remain closed and candidate SQL remains unregistered. See [explicit context design](../inventory/document-unified-authority-postgres.md).

Context-bridge stage verification: **38/38 real PostgreSQL tests**, **67/67 protocol/coordinator tests**, and isolated strict checking of **11 TS modules** passed. Coverage includes actual overlapping verify/revoke transactions in both lock orders, expiry while blocked on runtime/scope/context locks, required monotonic validity, and a restricted session unable to write registries, invoke issuer-only revocation or switch to owner. Tests remove all four temporary role classes (including issuer) and the disposable schema. This is not a real login/network-authentication acceptance test or full-repository regression.

## Rust/zbus deny-only broker prototype

The independent `services/document-broker` crate now actually compiles and exercises kernel Unix socketpairs, peer UID comparison, bounded one-frame transport, replay/capacity limits, canonical wire parsing, and zbus P2P typed-property exchange with a simulated Manager. Its binary always exits disabled, and Probe/Start/Stop never return an execution handle or stop proof. No document process, systemd unit or fallback process is launched. The TypeScript and Rust validators share a golden immutable request fixture.

Verification: **15/15 Rust tests**, locked/offline replay, `cargo fmt --check`, clippy with warnings denied, **68/68 TypeScript protocol tests**, **38/38 real PG tests**, and strict checking of the 11 sandbox TS modules passed. Independent review reran the Rust checks and TypeScript suite. Cargo.lock and Rust 1.93.0 are pinned; build caches are excluded. The crate follows the repository's Apache-2.0 license.

Environment limits were observed, not assumed away: no running systemd manager/system bus, and filesystem socket bind returns EPERM; socketpair works. No other connected execution environment was available. This prototype does not prove listener deployment, cross-UID isolation, PG-to-broker authentication, D-Bus security policy, runtime manifests/FD transfer, real start/stop/cgroup cleanup, openEuler compatibility or production isolation. The detailed limitations and future fast-exit/JobRemoved/bus-reconnect acceptance are in [the broker README](../../../services/document-broker/README.md).


## Private Manager lifecycle model follow-up

The broker now has a private `#[cfg(test)]` module with typed Manager
Subscribe/StartTransientUnit/JobRemoved signatures and actual zbus P2P transport to
a simulated peer. The module is absent from normal library/binary builds and has
no externally supplied bus connection. It installs the signal stream before
Subscribe, waits for subscription before start, and matches returned job path/ID
and unit against bounded early events under one total deadline.

Tests cover event-before-reply and reply-before-event, subscription failure/timeout,
wrong identities/signatures, early duplicate events, noise limits, method errors,
cancellation, submitted-but-disconnected outcomes and reconnect without replay.
JobObserved is only metadata: no execution handle or stop proof is produced, and
all attempted starts retain capacity. Connection generation is an in-memory test
model, not durable broker reconciliation. Later events, real bus reconnection,
InvocationID/cgroup reconciliation and database coupling remain future work.

Stage verification: **28/28 Rust tests** (13 new lifecycle cases plus 15 existing),
locked/offline replay, fmt and clippy passed. Normal build succeeds and binary
still exits 78 disabled. **68/68 TS**, **38/38 real PG**, and strict checking of
11 TS modules passed. No production entrypoint or host security setting changed.

The 2026-11-17 environment recheck is more precise than the prior bind wording:
filesystem-listener socket creation itself returns EPERM before bind; socketpair
works. No registered remote/openEuler host was available. The
[openEuler acceptance matrix](../inventory/document-openeuler-acceptance.md) records
the two-architecture real-host prerequisites, tests and evidence still needed.
These simulated results do not certify real systemd or document isolation.


## Persistent recovery ledger and proven-no-start reclamation

The real PostgreSQL candidate now persists launch evidence (`unknown`,
`not_started`, `may_started`), recovery tasks and claim-bound observations.
Reservation admission/retain enqueue and terminal release update tasks in the same
transaction. Recovery claims rotate owner capabilities under reservation-version
CAS, fencing previous coordinators; observations are content-fixed, idempotent and
bounded to 64 per reservation. Launch evidence cannot be downgraded.

The test-only runner connects the coordinator's existing uncertain-cleanup retain
path to that durable ledger. It exposes **no broker port**. Only a locked current
claim with an existing original request, `not_started` evidence and no handle can
release capacity. Tombstones and possible-start instances remain quarantined and
charged; a missing or uncertified broker cannot be bypassed. This is not a
production scheduler or completed live-instance reconciliation.

Verification: **51/51 real PostgreSQL tests**, **68/68 TS protocol tests**, and
strict checking of **12 sandbox TS modules** passed. Tests cover competing claims,
stale writers, both controlled start-intent/recovery orderings, coordinator unknown
stop followed by adapter recreation, history limits, and transaction rollback when
observation/task writes fail. An actual successful COMMIT followed by an injected
client exception verifies claim and completion confirmation-loss recovery. This
is not real network packet loss, database-server crash or OS-process crash testing.
Three fault-test mutation checks failed as intended in an isolated source copy and
passed with the unchanged implementation restored; they found no new code defect.

Candidate SQL is for fresh isolated schemas only, with no unsafe default backfill
of existing rows. It remains unregistered; production factory stays disabled.
See [recovery stage details](../inventory/document-reconcile-stage.md).

## Authenticated broker assertions, not OS stop proof

The test-only PG adapter now issues one server-derived challenge per current
blocked recovery claim with a full persisted handle. A trusted test owner pins
Ed25519 public keys to deployment/broker boot/version; the schema only permits
`test-only` scope and `os_stop_certified=false`. Private keys are generated only
in test memory. There is no worker self-registration or production trust setup.

Node's built-in Ed25519 verifies a fixed domain-separated canonical frame, bounded
to 4 KiB before parsing, with exact SPKI and signature lengths. Signed fields bind
challenge/nonce, key and claim versions, expiry and every instance-handle field.
Within the PG transaction, current owner, key status/version, identity and DB time
are rechecked. Nonce consumption is atomic and exact replays require current
validity. Receipts cannot update reservation/task state, produce StopObservation,
or release capacity, including when the signed report says `stopped`.

Verification: **68/68 real PG plus crypto tests**, **68/68 TS protocol tests**, and
strict checking of **13 sandbox TS modules** passed. Coverage includes incorrect
keys/domains/fields, bounded canonical parsing, concurrent consumption, key
revocation/rotation, stale claims, lock-wait expiry, receipt rollback and committed
client-confirmation-loss replay. Three defects were demonstrated RED and fixed:
expired receipt replay, key identity reset via TRUNCATE, and receipt INSERT delay
crossing expiry. The final check rolls back expired writes.

The fixed result `authenticated_assertion_os_unverified` records provenance at the
last transaction check. It is not a guarantee of validity at COMMIT/client receipt,
a TTL authorization, real broker provisioning, or evidence of cgroup emptiness.
Real host acceptance and least-privilege ledger admission remain outstanding;
production stays disabled. See [assertion stage details](../inventory/document-broker-assertion-stage.md).

## Fixed non-launchable unit policies

The Rust broker now constructs fixed candidate metadata for all four profile IDs.
The public NonLaunchableUnitPolicy has private fields, no conversion to launch
properties, and accepts only exact profile/policy selection. Every launch resolver
call still returns UnsupportedRuntimeManifest. No missing engine/rootfs artifact
is invented, and callers cannot supply paths, commands, argv, environment or units.

The capability matcher compares bounded caller-supplied test metadata against the
explicit systemd-v256 setter reference and exact property values. A match always
reports execution unavailable; it is not a host probe or certification. Only a
private cfg(test) fictional manifest can encode ExecStart/root/user/work-directory
values. Genuine P2P transport uses a custom InspectPolicy receiver to verify setter
types and values, never StartTransientUnit. Production binary remains disabled.

Verification: **36/36 Rust tests**, locked/offline, fmt, clippy and normal build
passed; independent review also ran **68/68 TS** and observed binary exit 78.
PG/TypeScript implementation is unchanged from the preceding **68/68 real PG**
and strict **13-module TS** stage. No dependency or host settings changed.

The openEuler matrix now explicitly requires host system-bus/container-runtime
socket invisibility and inherited/passed-FD and socket-activation checks. Neither
PrivateNetwork nor address-family filtering substitutes for those boundaries.
Real setter acceptance and actual namespace/seccomp/SELinux/cgroup enforcement
remain unverified on both target architectures. See [unit-policy stage details](../inventory/document-unit-policy-stage.md).
