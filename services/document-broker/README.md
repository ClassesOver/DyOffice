# Document broker: disabled IPC prototype

This is a **deny-only test prototype**, not a working isolated document runtime.
The binary always exits 78 with `DOCUMENT_BROKER_DISABLED`, including when passed
an enabling environment variable or argument. It opens no listener, connects to no
system bus, launches no document process, and implements no systemd start/stop call.

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
installed does not provide a running manager. Unix socketpair succeeds; filesystem
Unix socket bind returns EPERM. No workaround, root elevation, network change,
policy change or ordinary-process document execution was attempted.

Real listener deployment, systemd transient units, runtime manifest/FD sealing,
SELinux/cgroup limits, openEuler x86_64/aarch64, and actual document execution remain
**unverified/not implemented**. The future real backend must subscribe before
starting, correlate returned job identity, handle rapid exit and bus reconnect,
and distinguish job completion from confirmed unit/cgroup termination. These are
future target-version acceptance requirements, not outcomes of the fake Manager.

The official systemd D-Bus reference is
<https://www.freedesktop.org/software/systemd/man/256/org.freedesktop.systemd1.html>.
Applying its subscribe/job-correlation pattern to StartTransientUnit requires real
systemd-version tests. This prototype does not implement that sequence.

## Reproducing

Toolchain: Rust 1.93.0. Direct crates are exactly pinned with transitive checksums in
Cargo.lock: serde 1.0.229, serde_json 1.0.154, Tokio 1.54.1, zbus 5.19.0 and time
0.3.55. zbus is MIT; serde/json/time are MIT OR Apache-2.0; Tokio is MIT. This crate
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
