# Ubuntu Docker: fixed benign container-manager diagnostic

## Scope and design

This diagnostic uses the existing private Rust/zbus systemd driver, not Docker
Engine API, a shell command runner, or a production runtime grant. The only new
launch specification exists under cfg(test). It starts `/usr/bin/sleep 30` in
`dyoffice-container-probe.service`, with a two-second systemd runtime deadline,
DynamicUser, read-only system, private network/devices/tmp, inaccessible /run,
/root and /home, dropped capabilities and bounded memory/PIDs. It accepts no
paths, commands, documents, images, properties or broker credentials as input.
ApprovedRuntime remains uninhabited; the normal broker still exits 78.

The alternative Docker API/Bollard route is intentionally not implemented. The
selected deployment is Compose for the entire application, with a separate
Ubuntu document-runtime container whose PID 1 is systemd. Its trusted broker
uses that container's private D-Bus; API/worker see only the broker protocol.

## Integration with deployment PR #143

Keep this an explicit diagnostic profile, outside default application startup.
Use Ubuntu 24.04 and an independently pinned, audited diagnostic image containing
systemd, its local system bus, `/usr/bin/sleep`, and the Cargo library test binary.
Do not expose host D-Bus, host /run, Docker sockets, host PID/network namespace,
or the entire host cgroup tree read-write. Do not use privileged, disable LSM or
seccomp, or automatically add capabilities when checks fail. No host installation
of API/worker is required. Docker host cgroup delegation remains a prerequisite.

The operator must first verify Docker/runtime configuration externally: private
PID/user/cgroup namespaces, valid UID/GID mappings, only the delegated subtree
writable, cpu/memory/pids delegated, supported nested namespace/mount operations,
seccomp and LSM enforced. These facts cannot all be attested by an in-container
process. A Docker marker or writable cgroup mount is NOT proof of safe delegation.
Never fabricate markers or change security settings merely to get a passing run.

## Fail-closed gates, before any mutating D-Bus call

The test rejects unless all are observed: explicit diagnostic opt-in; Ubuntu
24.04; a regular /.dockerenv and PID 1 container=docker marker; PID 1 systemd;
private cgroup-v2 root view; a read-write cgroup2 mount and cpu/memory/pids;
UID and GID 0 mapped away from host 0 with the entire systemd DynamicUser range
61184–65519 mapped (continuous split ranges allowed; holes reject); seccomp
filter mode; the fixed local bus socket; no standard Docker control socket.
For both standard Docker paths, only NotFound counts as absent; symlinks, other
existing objects and lookup errors all reject.
Unknown or unreadable observations reject. This is a conservative supported
fixture check, not general Docker detection or a host authenticity certificate.
The existing driver separately pins the D-Bus manager owner, UID 0/PID 1,
observes JobRemoved, detects owner transitions and quarantines uncertain results.

## Explicit command (inside externally audited diagnostic container only)

    DYOFFICE_CONTAINER_PROBE=ubuntu-docker-benign-only cargo test --locked \
      --manifest-path services/document-broker/Cargo.toml --lib \
      systemd_driver::container_diagnostic::fixed_sleep_unit_times_out \
      -- --exact --ignored --nocapture

Prefer executing the prebuilt test binary with the same exact test filter in the
final image; a compiler/dependency cache need not be installed in the container.
There is a 20-second diagnostic deadline. Any failure after submission means the
operator must inspect this fixed unit, not blindly retry or claim it stopped.
The test requires JobRemoved=done, verifies effective configured RuntimeMax,
MemoryMax, TasksMax and DynamicUser properties, then observes Service Result=
timeout and MainPID=0. Success always reports execution_available=false and
isolation_certified=false. It does not automatically remove/reset the unit.

## Remaining acceptance, not claimed by this diagnostic

A passing sleep unit is NOT hostile-document isolation. Still required: actual
CPU/memory/PID exhaustion, inaccessible host/broker data, forbidden network,
descendant process termination and empty cgroup confirmation, broker SIGKILL
while the unit runs, container restart/recovery identity checks, supported-host
LSM/capability behavior, and fixed runtime-image/module provenance. The probe
reads configured memory/PID settings; it does not prove their enforcement.
No production boundary or PDF/PPTX execution path may consume this result.

## Local verification

The preflight positive/negative tests were written red-first. They cover each
mandatory gate and UID/GID mapping rejection. Cargo tests and a local denial
exercise are recorded in the handoff. This workspace has no Docker command or
standard Docker socket and PID 1 is not systemd: no real Docker/systemd probe
success has been observed here. No Docker image has been built or run.
