# Document broker: disabled IPC prototype

This is a **deny-only test prototype**, not a working isolated document runtime.
The binary always exits 78 with `DOCUMENT_BROKER_DISABLED`, including when passed
an enabling environment variable or argument. It opens no listener, connects to no
system bus, launches no document process, and exposes no systemd start/stop call.
The private typed submission driver compiles in normal builds but is unreachable
without an approved runtime, which currently cannot be constructed. The historical
simulated Manager model remains test-only; neither is exposed by the binary.

## What actually runs

- Rust/Tokio kernel Unix socketpairs, peer UID reads and comparison, big-endian u32
  length framing, exact one-frame/write-half-close exchange and bounded replies.
- A 64 KiB limit checked before allocating the declared body; a single absolute
  budget covers header, body, EOF and response. Two concurrent exchanges per broker
  instance and a lifetime 1,024-request replay cache bound resource use. A full cache
  fails closed rather than evicting IDs. This is not durable replay prevention.
- serde typed structs reject duplicate/unknown/null fields, trailing non-whitespace
  JSON, non-integer counters, unsafe JS integers, noncanonical IDs and deadlines.
  Only the generation-zero PPTX request subset is understood. The checked-in JSON
  fixture is validated by both Rust and the existing TypeScript request validator.
  Rust parsing checks syntax/canonical dates only, not whether a deadline is live.
  Actual admission must separately verify PG authority and monotonic lease budgets;
  past/future fixture dates have no execution effect in this deny-only prototype.
- Broker boot ID, ContextRef and the entire expected request are bound to an
  immutable **trusted test fixture**. Each request ID is syntax/replay checked and
  echoed in its disabled reply; it is not a durable pending-request ledger. No
  PostgreSQL grant is proven by Rust.
- Genuine zbus peer-to-peer D-Bus transport over a socketpair, a simulated Manager
  object, typed `a(sv)` candidate property exchange and real values checked on the
  receiver. The simulated method is not a systemd method. Metadata probe has a
  whole-operation timeout; disconnect and no-reply cases are tested.

Probe, Start and Stop all return `disabled/REAL_BACKEND_UNAVAILABLE`. The reply
contains request ID and boot ID only. It is **not** an ExecutionHandle, success
receipt, stop observation or permission to free a reservation. No arbitrary
ExecStart, unit properties, host paths, bus addresses or PG credentials are accepted.
The six fixed hardening values are encoding candidates, not a complete/accepted
systemd sandbox policy. There is deliberately no executable/unit name in them.

## Private Manager sequence model

The private `#[cfg(test)]` module constructs its own socketpair and fake Manager;
it cannot be supplied an external connection and is not compiled into normal
builds. It installs the JobRemoved stream, awaits Subscribe, then issues exactly
one fixed StartTransientUnit request. Introspection tests check the official
method argument shapes `s,s,a(sv),a(sa(sv)) -> o` and signal `u,o,s,s`.
The fixture has no ExecStart and is never submitted to a real manager.

Thirteen model tests cover signal-before-reply and reply-before-signal, identity
mismatch, duplicate queued completion, malformed signal signatures, bounded noise,
Subscribe failure/timeout, lost replies, cancellation, disconnect and reconnect.
One total monotonic timeout bounds each sequence. Early event storage is limited
to 16 events and 4,096 decoded field bytes, with per-field limits; these are
post-decode application bounds, not a D-Bus decoder memory limit.

Once a start call is attempted, every result retains the reservation. A correlated
JobRemoved result is metadata only, including `done`, not a successful document
result or proof of unit/cgroup termination. Ambiguity yields quarantine. A used
attempt cannot start again after reconnection, and old-generation fixtures cannot
advance it. This is in-memory test state, not durable cross-process fencing.
Already queued duplicate events are rejected; later events require a future
continuous reconciler. There is no StopUnit, adoption, real manager restart
recovery, execution handle, or capacity-release path in this model.

## Authentication and resource limitations

Peer UID comparison is not tenant authorization. The tests use same-user socketpair
endpoints and verify a deliberately mismatched expected UID is rejected. They do
not test a real cross-UID listener deployment. Same UID, inherited/transferred
connections, or knowing a context ID must not be treated as trusted dispatcher
provenance. Future socket ownership, worker identity, authenticated lease/context
handoff and durable broker fencing remain necessary. No root broker is started.

SCM_RIGHTS/ancillary FD passing is **unsupported**. Ordinary stream reads do not
adopt ancillary descriptors and do not prove rejection of every ancillary message.
There is no input/output FD-transfer API. A future implementation needs explicit
recvmsg/CMSG handling and its own lifetime/ownership tests before enabling transfer.

The 128-byte Version check occurs **after D-Bus decoding**; it is not a 128-byte
memory limit against an adversarial D-Bus peer. The metadata probe is only designed
for a trusted Manager connection supplied by a future trusted control plane. It
never opens a user-selected bus endpoint and never enables execution based on a
version string. The custom 64 KiB control framing is separate from D-Bus framing.

## Environment evidence and outstanding acceptance

Checked in the development environment: UID 1000; PID 1 is not systemd; there is no
system-bus or systemd-private socket. `systemd-run`/`dbus-daemon` binaries being
installed does not provide a running manager. Unix socketpair succeeds;
Unix filesystem-listener construction currently fails with EPERM at socket creation
(before bind). No workaround, root elevation, network change,
policy change or ordinary-process document execution was attempted.

Real listener deployment, systemd transient units, runtime manifest/FD sealing,
SELinux/cgroup limits, openEuler / Ubuntu x86_64, and actual document execution remain
**unverified/not implemented**. The future real backend must subscribe before
starting, correlate returned job identity, handle rapid exit and bus reconnect,
and distinguish job completion from confirmed unit/cgroup termination. These are
future target-version acceptance requirements, not outcomes of the fake Manager.

The official systemd D-Bus reference is
<https://www.freedesktop.org/software/systemd/man/256/org.freedesktop.systemd1.html>.
Applying its subscribe/job-correlation pattern to StartTransientUnit requires real
systemd-version tests. The private test model exercises the sequence over real
zbus P2P transport only. See the [target acceptance matrix](../../docs/dyoffice/inventory/document-openeuler-acceptance.md).

## Reproducing

Toolchain: Rust 1.93.0. Direct crates are exactly pinned with transitive checksums in
Cargo.lock: serde 1.0.229, serde_json 1.0.154, Tokio 1.54.1, zbus 5.19.0 and time
0.3.55; futures-util is pinned to 0.3.34 and is now a normal dependency of the private driver. zbus is MIT; serde/json/time are MIT OR Apache-2.0; Tokio is MIT. This crate
uses the repository's **Apache-2.0** license, is publish=false and does not inherit a
dependency's license as its own. Full transitive vulnerability/license review is
still required before production use; successful compilation is not that review.

```sh
cargo test --manifest-path services/document-broker/Cargo.toml --locked
cargo test --manifest-path services/document-broker/Cargo.toml --locked --offline
cargo fmt --manifest-path services/document-broker/Cargo.toml --check
cargo clippy --manifest-path services/document-broker/Cargo.toml --all-targets --locked -- -D warnings
node --experimental-strip-types --test apps/web/test/sandbox/broker-golden-contract.test.mjs
```

`target/` is ignored and not publication content. This slice does not wire the
broker into the web worker or change existing experimental host-process behavior.

## Fixed unit-policy candidates

The public unit_policy module validates strict profile selection and creates only
NonLaunchableUnitPolicy; resolve_launch always rejects because no trusted runtime
manifest exists. It does not expose executable/path/environment setters or a
conversion to launch properties. A private cfg(test) fictional manifest checks
actual typed P2P encoding without calling StartTransientUnit. Capability matching
accepts only exact v256 test metadata and never grants execution. See the
[unit-policy stage](../../docs/dyoffice/inventory/document-unit-policy-stage.md).
PrivateNetwork alone does not isolate accessible filesystem Unix sockets or
inherited FDs; real rootfs/FD/SELinux/kernel enforcement remains unverified.

Current distribution scope is openEuler and Ubuntu, both x86_64 only. ARM/aarch64 is rejected by the
candidate capability matcher and is not a current acceptance gate. This scope
choice does not mean either distribution has passed runtime isolation acceptance.
Fixture metadata must explicitly name distribution openEuler or ubuntu. The systemd-v256
setter schema is a reference fixture, not a claim about either distribution’s installed
manager. Each target needs independent live acceptance on pinned SP/LTS and patches.

## Sealed bytes primitive

Linux-only `sealed_bytes::SealedBytes` uses pinned rustix 1.1.6 to copy
1–65,536 bytes into a CLOEXEC memfd and seal WRITE/GROW/SHRINK/SEAL before
exposing a descriptor. This experimental cap is not a document upload limit.
Real kernel tests check positional reads and modification rejection through
duplicate descriptors. The primitive adds no hashing, engine execution or T06 integration; the
separate restricted SCM_RIGHTS experiment is described below. CLOEXEC does **not** assert NOEXEC, and immutable bytes
are not source authentication or OS isolation evidence.
See [stage boundary](../../docs/dyoffice/inventory/document-sealed-bytes-stage.md).

The Linux `sealed_transfer` experiment adds a separate nonblocking SEQPACKET
socketpair with a fixed 12-byte packet and exactly one SCM_RIGHTS descriptor.
Received descriptors must have the full seals, regular inode type, matching
bounded size and CLOEXEC. Truncated/malformed/extra-descriptor packets fail
closed with RAII cleanup. This same-process channel is **not** source
authentication and is not connected to the production control protocol or T06.

## Explicit fixed system-manager diagnostic

`cargo run --locked --offline --bin manager-preflight` is a read-only diagnostic,
not a broker listener. It accepts no arguments and ignores `DBUS_SYSTEM_BUS_ADDRESS`:
the endpoint is always `unix:path=/run/dbus/system_bus_socket`. Under a single
2-second monotonic deadline (including connection/authentication), it obtains the
systemd1 unique owner, requires bus-reported UID 0 and PID 1, reads Manager Version
from that pinned owner, and checks the well-known owner has not changed. Forwarded
or differently namespaced system buses that cannot satisfy PID 1 are unsupported.
Errors produce a bounded reason and exit 2; invalid arguments exit 64. A successful
observation exits 0 but **always** reports `execution_available: false`.

This adds live bus-owner/manager observations to the Node preflight's socket-presence
and client-version checks. It does not authenticate a hostile root-controlled host,
prove SELinux/seccomp/namespace/cgroup effectiveness, validate an engine/rootfs,
reserve resources, start/stop units, or produce an execution grant. Version's
128-byte bound applies after zbus decoding, not to all transport allocations.
The daemon and fixed endpoint's host ownership remain trust prerequisites. No
caller endpoint, arbitrary connection or environment rerouting is supported.

Local verification on the current Debian/codex environment produces Unavailable:
there is no usable real system bus. Positive owner/metadata behavior has **not**
been accepted on Ubuntu/openEuler x86_64. Pure identity/metadata/deadline tests are
not live-host acceptance; no fake Manager is presented as a trusted host.
`cargo run --bin dyoffice-document-broker` (also the default-run target) remains
unchanged and exits 78. Real systemd startup still requires an authorized target
host, restricted broker deployment and verified runtime/rootfs material.

The Manager proxy explicitly disables property caching (`CacheProperties::No`),
so Version uses only `Properties.Get`, not a `GetAll` fetch or a property-change
subscription. An actual private socketpair protocol regression showed the original
lazy cache invoked an unrelated fixture Environment getter; it now asserts that
getter is never called. This is a narrow call-surface regression, not positive
systemd-host acceptance. The existing older `systemd_probe` remains a separate
prototype; this fixed-endpoint diagnostic does not call it.

## Private typed submission driver (not enabled)

`systemd_driver` now compiles in normal builds, but is private and has no public
connection or launch API. `ApprovedRuntime` is uninhabited: neither normal builds
nor the `unsafe-test-harness` feature can construct a launch specification. The
only fixture constructor is `cfg(test)`. The original binary still exits 78.

The implementation pins the fixed system-bus manager unique owner (bus-reported
UID 0/PID 1), prepares owner/job streams, subscribes, and sends typed transient
unit properties only to that unique owner. A single monotonic deadline covers
connection, identity queries, subscription, submission and final observation.
No arbitrary caller executable/rootfs/argv/env/unit fields are accepted. Test
paths are deliberately nonexistent fixture paths and are not production manifests.

A consumed attempt cannot be replayed or retried on reconnect. Lost responses,
owner changes, cancellation and disconnect after submission quarantine it. A job
completion is only metadata: it never proves a stopped unit/cgroup and never
releases a reservation. The local attempt object is not persistent cross-process
fencing; PG start-intent and a durable broker identity registry are still needed.

Private P2P tests run the same typed sending/association implementation, including
real D-Bus signature/value checks, but do not validate systemd/kernel isolation.
Decoded signal count/byte limits do not bound zbus parser allocation. Real runtime
provenance/rootfs, safe user/FD/socket layout, LSM/kernel capability acceptance,
and actual unit lifecycle/reconciliation remain prerequisites. This driver is
not registered in an execution dispatcher or T06 save path.

The owner watcher remains alive through the final GetNameOwner roundtrip; a
queued release/reacquire transition is rejected even if its returned unique owner
matches the initial value. This is observation through the checked reply, not a
promise that the owner cannot change after the function returns. The regression
uses the same submit-and-finalize control flow with an actual P2P submission,
then injects owner loss during the final query; it asserts quarantine and no retry.

## Private sealed-input binding (not runtime admission)

`BoundInput` joins the bounded control-frame parser with the real sealed-FD
receiver. It requires Start and exact equality with a trusted expected frame,
then checks actual immutable bytes against input size and SHA-256. The entire
frame is retained privately; reads for any different frame fail. This binds
content to the supplied request identity; it does not establish that the supplied
expected frame is authorized, live, or from an authenticated dispatcher.

The 64 KiB prototype cap remains. Reads use positional offsets, bounded forward
progress and reject interrupted, short-to-EOF or failed reads without returning
partial content. A consumed receiver closes on failure, including queued FDs.
Seals are checked by the receiver before metadata/content reads. This adds no
listener, D-Bus FD passing, launch permission or production dispatcher wiring.
Deadline/lease validation, authorization, replay prevention and authenticated
handoff remain separate prerequisites. Production still exits 78. Tests use real
local memfd/seqpacket transport, not a Docker isolation acceptance environment.
