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


## Current architecture scope correction

At that stage the user narrowed this work to **openEuler x86_64 only**;
the subsequent scope below adds Ubuntu x86_64 without restoring ARM support.
Earlier dual-architecture acceptance references describe the superseded plan.
ARM64 is not a current supported target or acceptance gate; the candidate matcher
rejects it. This scope correction does not claim real x86_64 host acceptance.

## Parallel integration: real PDF/T06, entry retirement and host preparation

Existing PDF save preparation now has additional real PostgreSQL/RustFS integration
coverage: generated PDF bytes are rotated, staged/received, explicitly committed
through T06, read back and reopened. The original commitInput recovers an uncertain
successful commit; corrupted objects, revoked leases/sessions and receipt failures
cannot advance the head. A real successful S3 write followed by injected lost
acknowledgement stays receiving with quota reserved. No new job type, production
adapter or parser implementation was invented. The only fixture change allows
service-only setup with buildApp:false; default HTTP setup remains true.

The legacy development-token DOCX GET/POST and draft-upload POST parsing branches
are now retired with precise 501 responses and unsupported capability metadata.
The application no longer imports docx-session through that editing route. Original
uploads/downloads, immutable content/history, leases and restore remain available;
standalone engine tests remain, without implying an enabled editor. No generic
upload path, T06 service, ZIP parser or host isolation setting was changed here.

A fixed read-only x86_64 preflight collector reports prerequisite observations.
It never connects to D-Bus, creates sockets or starts units, and always reports
BLOCKED, productionEligible=false and liveAcceptance=NOT_RUN. Static prerequisites
cannot become an isolation certificate.

Verification: real PG/RustFS **82/82** (68 existing plus 14 PDF cases); protocol
**68/68**; preflight **16/16**. Entry-focused HTTP/engine/controller/import tests
**14/14**, independently checked; standard Web suite **347 passed, 0 failed,
1 existing skip** (the opt-in MinIO case lacked DYOFFICE_S3_ENDPOINT) in the
source-complete entry workspace with required tsx loader.
This is not all repository suites, browser/desktop acceptance, four-format parity
or real OS isolation. Independent PDF rerun covered 14/14. Local services stopped.
See [PDF/T06 scope](../inventory/document-pdf-t06-stage.md) and
[preflight usage](../../../tools/document-runtime/preflight-x86_64.md).

## Consolidated four-format and distribution follow-up

Current deployment targets are **openEuler x86_64 and Ubuntu x86_64**. ARM is
excluded. These are intended targets, not certified deployments. Explicit distro
matching, read-only preflight and the non-launchable policy fixture distinguish
the two. Ubuntu AppArmor is not treated as equivalent to the candidate SELinux
Enforcing requirement. Both distributions need separate version, kernel, security
policy and real-host acceptance. The available test host is Debian 13 x86_64.

The additional trusted-fixture tests exercise actual DOCX parsing/editing/export,
XLSX cell/formula XML/style editing and PPTX session/slide editing through existing
T06 services and RustFS. They do not certify formula recalculation, Office desktop
parity, arbitrary document support or a production-isolated native host. The
PPTX test uses the dependency's CJS export via createRequire so both tsx and native
strip-types test loaders work without patching production code or dependencies.

An optional PDF recovery HTTP composition is deliberately not registered in the
production application. Its only operation reads an existing receipt using the
current session, CSRF and owner authority. It does not rotate, save, upload, commit
or automatically retry; unresolved is not proof of failure. The route projects
only receipt fields and returns no-store responses. HTTP boundary tests with stub
adapters are distinct from the real HTTP/PostgreSQL/local-object tests.

See [XLSX scope](../inventory/document-xlsx-t06-stage.md) and
[PPTX scope](../inventory/document-pptx-t06-stage.md). Earlier sections record
historical stage results; they are not assertions about the latest merged target.

Latest-target verification against `b8712ed27ef3b21b4289cbc405c67e138ef42b89`:
all 24 migrations and affected test dependencies were matched to remote blobs.
The focused aggregate passed **103/103**, zero skips: ledger/crypto 68, PDF 14,
XLSX 5, PPTX 6, DOCX 3, recovery HTTP 4 and HTTP boundary 3. One DOCX case is
engine-only; the last three HTTP cases use stub adapters. Thus 103 is not a count
of exclusively database tests. Three-format tests were independently rerun 14/14.
Recovery HTTP counters were corrected to use authenticated transactions with
nonzero fixture assertions, rather than relying on ownerPool visibility under
FORCE RLS. Four real HTTP cases use local objects, not RustFS.

The optional client has 6/6 deterministic transport tests and a targeted TS check;
it is not mounted and has no replay/polling/storage behavior. Protocol 68/68,
strict 13 modules, Rust 37/37 with locked/offline fmt/clippy/build, and preflight
17/17 passed. The binary still exits 78. This is a focused merged-candidate check,
not a latest full-repository, CI, browser, desktop or target-OS acceptance claim.

## Real local-application PDF path

`pdf-local-app.test.mjs` exercises the existing `buildLocalApp` over real loopback
HTTP with PostgreSQL restricted roles and local object storage, not the optional
recovery-only composition. Two cases passed and were independently rerun. The
source-complete Web/server/helper test tree was compared with head `08166257`:
251 files matched. Coverage includes CSRF-authenticated original upload/finish,
metadata, exact-revision byte/hash download, attachment/CSP/no-store headers,
cross-owner/admin and same-owner wrong-file revision denial, trash and logout.

PDF editing remains unsupported; the optional recovery endpoint remains unmounted
and the authenticated application API catchall returns 501. The workspace-open
204 assertion is not proof of durable tracking state. UI routing was inspected in
source, not exercised in a browser. There is no trusted application recovery-ticket
source or rotation/save controller yet, so no recovery button or in-process parser
was exposed as a safe production editing path.

## Actual deny-only broker to PG negative composition

The restricted native-job authority and reservation coordinator now call a fixed
Rust test artifact through a bounded Node driver. The artifact executes the
existing ProbeBroker on a real same-UID Unix socketpair. This proves a cross-language
denial path, not an authenticated deployed broker or an engine/OS certificate.
Default production factories still reject and the normal binary still exits 78.

After durable start intent, a correlated disabled response, exit 78, timeout,
stdout/stderr overflow, partial response or early close all retain uncertain
capacity. Reconstructing the PG adapter and reconciling leaves blocked_uncertified.
Authenticated snapshots with a nonzero original revision verify unchanged T06
tables and head; **no T06 writer is called**, so this is not positive output-save
integration. The original authority fixture was extracted without relaxing roles.

Independent tests passed: broker 10/10 and authority plus negative PG 29/29.
The fixed test-only fault modes dynamically exercise timeout, both stream caps,
partial/empty replies and cancellation. Removing the timer and stream limits
caused three actual failing tests before restoration. Callers cannot supply
commands, paths, arbitrary arguments or an environment map. Neither killing this
test process nor its exit code becomes document-unit/cgroup stop evidence.
See [negative-chain scope and commands](../inventory/document-broker-negative-chain.md).

Final combined regression after fixture extraction and fault additions: **110/110**
focused cases, zero skips (previous 103 plus seven real-Rust/PG negative cases).
The two real local-application PDF cases passed separately. Pure protocol remains
68/68 without a Rust build dependency; broker suite 10/10, strict 14 modules and
Rust 37/37 with feature-gated build/fmt/clippy passed. These remain the explicitly
bounded test scopes above, not full-repository or target-OS acceptance.

## Sealed byte and descriptor primitives

Pinned rustix 1.1.6 now supplies two separate Linux experiments. `SealedBytes`
copies 1–65,536 bytes into a fixed-name CLOEXEC memfd and verifies
WRITE/GROW/SHRINK/SEAL before exposing its descriptor. `sealed_transfer` uses a
nonblocking local SEQPACKET socketpair and a fixed 12-byte packet with exactly one
SCM_RIGHTS descriptor. Receive rejects truncation, extra/missing descriptors,
unreadable handles, nonregular or wrongly sized inodes, and missing seals. Full
seals are checked before fstat to avoid mutable-size observation before sealing.

Real-kernel tests cover attempted writes/truncation, shared-offset-independent
reads, received CLOEXEC, sender/original-handle closure, malformed packets and
descriptor-count restoration on failure. The write-only descriptor rejection
was added after an actual failing test. Omitted-seal mutations also failed and
were restored. Independent full Rust regression passed **42/42**, including four
sealed-byte tests and one sequential multi-assertion FD-transfer test, plus fmt
and clippy with warnings denied.

The 64 KiB experimental cap is not full Office-output support. These primitives
prove neither hashing/provenance nor tenant/peer authentication, NOEXEC, trusted
engine execution, global resource quotas or OS isolation. The same-process
channel is not connected to the production control protocol or positive T06.
Unsupported syscalls fail without filesystem fallback or changed host settings.
See [sealed-byte/FD scope](../inventory/document-sealed-bytes-stage.md).

## Actual PPTX module content-identity preparation

The offline tool now builds the existing PPTX session entry using pinned esbuild
0.25.12 and records the exact onLoad buffers compiled. Node's SHA-256 binds fixed
profile/policy/architecture, recipe, observed compiler identity, sorted input
snapshots and the generated module's path/mode/size/bytes in a domain-separated
manifest digest. Verification requires an independently held expected digest;
replacing both the artifact and its manifest cannot silently replace that anchor.

One aggregate test with multiple assertions passed independently and directly:
actual repeated builds, joint replacement and fixed-metadata mutations, malformed
manifests, links/nonregular files, size/mode changes, and the offline CLI. An actual
non-hoisted compiler-layout failure was corrected by resolving the native package
relative to esbuild's wrapper, not by searching PATH. A separate temporary source
layout produced the same digest. The observed 97 workspace inputs matched the
`e0d5be42` remote blobs; 111 dependency inputs were hashed but not authenticated.

No generated module is executed in these tests. The roughly 898 KB minified module
is not a bootable rootfs: Node/loader/OS libraries/fonts and supply-chain/license
validation remain missing, and dynamic imports/resources are not proven closed.
Ordinary candidate directories remain mutable; snapshot hash verification cannot
authorize later exec-by-path. `runtimeApproved`, `rootfsComplete` and
`productionEnabled` stay false. No launch resolver or PG runtime approval changed.
See [PPTX runtime candidate scope](../inventory/document-pptx-runtime-candidate.md).

PDF existing-service expiry coverage was also extended, without introducing a
controller or recovery ticket: three real PostgreSQL/local-object tests passed
and were independently rerun. They cover natural lease expiry before preparation,
expiry after preparation with explicit commit retry, and account disable/re-enable
without reviving the old session. Original head/revision and processor/upload
counts are checked. Unknown commit remains unknown; tests do not authorize a
retry to regenerate content. No new production PDF functionality, authority type,
OS runtime, route or UI was enabled.

## Nonlaunchable Node/PPTX runtime subset

The next offline stage prepares real bounded Node and PPTX byte snapshots, not
just a scan: fixed current Node 24 on Linux x86_64, the independently identified
PPTX candidate, and canonical upstream/subset manifests. Files are 0644 data;
that mode does not provide NOEXEC or sandboxing. The independently retained
subset digest binds actual file bytes and the upstream identity. Fixed readelf
inspects the copied Node with minimal environment and bounded time/output;
no copied binary, loader or document module is executed. See
`../inventory/document-pptx-runtime-subset.md` for exact CLI and limits.

Current observed Node is dynamically linked; the loader and seven declared
libraries are not collected or certified. Current session rendering defaults
to heuristic metrics without a system font file, not desktop font fidelity.
Ubuntu/openEuler provenance, recursive library/dynamic-resource closure, fixed
wire entry, licenses and real isolation acceptance remain outstanding. No
runtime resolver, PG approval, production flag or T06 positive path is enabled.

Final direct and independent artifact regression each passed 3/3 aggregate
cases, including existing module identity and new subset checks; protocol
regression passed 68/68. These are offline preparation/validation tests, not
real-rootfs execution or a fresh whole-repository regression. Generated binary
snapshots and logs are not committed.
