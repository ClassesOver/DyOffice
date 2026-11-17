# Fixed unit-policy candidates: not launchable units

The public Rust unit_policy module produces NonLaunchableUnitPolicy from exactly
profileId and policyVersion=1. Only the existing xlsx/pptx/docx/pdf-edit-v1 IDs are
recognized. It accepts no executable, argv, environment, rootfs, user, working
directory, unit name or arbitrary property. Unknown/duplicate fields and oversized
selection input fail. The object has no conversion into zbus launch properties.
resolve_launch always returns UnsupportedRuntimeManifest for every profile.

No four-format runtime artifacts are invented. Real trusted manifest building,
file hashing, symlink/swap prevention, immutable rootfs/FD sealing and actual engine
compatibility are still required before executable properties can be resolved.

## Candidate safety values

Values below are conservative test candidates, not approved production sizing or
an accepted complete isolation policy. The 30-second runtime aligns with current
experimental TS profile metadata; other resource choices are explicitly provisional.

| Properties | D-Bus setter type | Fixed candidate |
| --- | --- | --- |
| NoNewPrivileges, PrivateNetwork, PrivateDevices | b | true |
| ProtectSystem / ProtectHome | s | strict / yes |
| MemoryMax / MemorySwapMax | t | 536870912 / 0 bytes |
| TasksMax | t | 64 |
| CPUQuotaPerSecUSec | t | 1000000 microseconds/second |
| CapabilityBoundingSet | t | 0 |
| RestrictSUIDSGID, LockPersonality | b | true |
| UMask | u | 63 (octal 0077) |
| KillMode | s | control-group |
| RuntimeMaxUSec / TimeoutStopUSec | t | 30000000 / 5000000 |

Primary schema reference: [systemd v256 D-Bus](https://www.freedesktop.org/software/systemd/man/256/org.freedesktop.systemd1.html).
Setter and getter schemas are not interchangeable: test-only ExecStart uses
array-of-(string,array-of-string,boolean), a(sasb), with ignore_failure=false,
not the extended timestamp-bearing getter form. No caller supplies those values.

## Capability matching is not admission

The bounded fixture report requires exact schema systemd-v256 and Manager string
256, explicit distribution openEuler or ubuntu, x86_64 only, cgroup v2 CPU/memory/PID controllers, SELinux Enforcing,
and namespace/seccomp fixture assertions. Every required property must have the
exact signature/value, once only. Missing/extra/tampered properties fail. Unknown
versions, vendor-suffixed strings and release-name-based inference are unsupported;
there is no remove-property-and-retry or ordinary-process fallback.

This is intentionally only a match of caller-provided TEST metadata. Its result
always reports execution unavailable. It is not a discovery implementation,
verified kernel probe, certificate, or accepted openEuler version matrix. Actual
manager/package details and functional probes remain mandatory on each target.

## Private fixture and injection boundary

Only cfg(test) has an internal fixed fictional manifest with a fixture executable,
root, user, working directory and argv. No such files are created. It derives the
unit name from a fixed prefix and server-owned binary IDs encoded as hex, not a
caller-provided name. A real zbus P2P socketpair transports the typed values to a
custom InspectPolicy method. The receiver checks types AND values, rejects an
extra Environment and a substituted unit name, and rejects ignore_failure=true.
It never exposes or invokes StartTransientUnit or StopUnit. The fixture code is
absent from normal library/binary builds.

PrivateNetwork does not protect against visible accessible filesystem Unix sockets.
Address-family filters also do not revoke inherited/passed sockets or socketpairs.
These are boundary limitations, not a newly proven project exploit. Future target
acceptance must check system-bus/container-runtime socket invisibility, inherited
FD allowlisting/closure, no socket-activation leakage, rootfs mounts, SELinux and
actual namespace/seccomp enforcement. Property readback is not enforcement proof.
See the [openEuler acceptance matrix](document-openeuler-acceptance.md).

## Tests and non-goals

RED was a missing unit_policy module. Tests cover all profiles staying unsupported,
selection injection, unknown versions/features, malformed reports, and property
signature/value/duplicate/extra/missing rejection, plus real typed P2P exchange.
Normal binary exit 78 and disabled production factories are unchanged. No PG,
network, host permissions, SELinux or systemd settings are modified by this stage.

Per the current requested scope, ARM/aarch64 is excluded and explicitly rejected
by capability matching. ARM testing is not a current support or acceptance
requirement. Both openEuler x86_64 and Ubuntu x86_64 remain unverified targets, not approved environments.
The fixture’s v256 setter schema is not an assertion that either distro installs v256.
No result transfers between distributions; pin actual SP/LTS, patches and manager
capabilities independently. Existing SELinux requirements are not silently relaxed
for Ubuntu or replaced by AppArmor.
