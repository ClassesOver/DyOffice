# Document broker: disabled IPC prototype

This is a **deny-only test prototype**, not a working isolated document runtime.
The binary always exits 78 with `DOCUMENT_BROKER_DISABLED`, including when passed
an enabling environment variable or argument. It opens no listener, connects to no
system bus, launches no document process, and exposes no systemd start/stop call.
Mutating D-Bus calls exist only in a private, compile-time test module against its
own simulated Manager; that module is absent from normal library/binary builds.

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
SELinux/cgroup limits, openEuler x86_64, and actual document execution remain
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
0.3.55; the test-only futures-util dependency is pinned to 0.3.34. zbus is MIT; serde/json/time are MIT OR Apache-2.0; Tokio is MIT. This crate
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

Current architecture scope is x86_64 only. ARM/aarch64 is rejected by the
candidate capability matcher and is not a current acceptance gate. This scope
choice does not mean x86_64 runtime isolation has been verified.
