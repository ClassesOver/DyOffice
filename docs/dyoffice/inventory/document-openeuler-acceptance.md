# openEuler broker acceptance plan (not executed)

This is a target-host acceptance plan, not certification. Checked 2026-11-17 UTC:
the current cloud has
PID 1 `codex`, no system bus or systemd-private socket. Unix socketpair works;
creating an AF_UNIX/SOCK_STREAM socket fails with EPERM before bind. The connected
environment catalog contains only that cloud. Saved cloud configurations are not
verified openEuler hosts. No host policy was changed to bypass these restrictions.

## Dedicated hosts and approval boundary

Use disposable full VMs for **both x86_64 and aarch64**, with a pinned openEuler
24.03 LTS SP/patch baseline. Record actual installed versions rather than inferring
systemd/cgroup behavior from the release name. Each must have systemd PID 1,
system D-Bus, SELinux Enforcing, cgroup v2 with required memory/pids/cpu controllers,
and the namespace/seccomp capabilities of the fixed profile. Cross-compilation is
not runtime evidence. A starting lab budget of 2 vCPU, 4 GiB RAM and 20 GiB disk per
VM is a test suggestion, not a production sizing guarantee.

Use dedicated test identities, no production data or credentials, and recoverable
VM snapshots. Installing the broker and granting D-Bus/SELinux privileges needs a
separate reviewed authorization. Do not disable SELinux, weaken seccomp, change
host permissions or fall back to ordinary processes to make a test pass. Reboot
and destructive fault injection belong only in the dedicated VM test scope.

## Matrix (repeat on each architecture)

| Area | Required checks and acceptance |
| --- | --- |
| Environment fingerprint | OS/SP, kernel, architecture, systemd RPM and Manager Version, D-Bus implementation, SELinux policy, cgroup controllers, runtime/policy digest and source SHA |
| Typed property support | Match actual introspection and target-version documentation; unknown properties, absent controllers or failed hardening reject execution rather than downgrade |
| Listener identity | Real filesystem socket; correct and wrong UID, same-UID untrusted client, permissions and labels. Peer UID alone is not task authority |
| Subscription order | Install signal receiver and finish Subscribe before start; correlate returned job path, ID and unit, ignoring unrelated jobs |
| Rapid completion | Immediate zero/nonzero exit, exec failure and delayed start; event preceding method reply is retained. Successful start job is not proof of a running worker |
| Ambiguous start | Disconnect before send, after send and before reply. Reconnect/resubscribe and reconcile actual unit/job/InvocationID; never blindly repeat start |
| Instance substitution | Same unit name with different InvocationID, old broker boot/epoch/handle rejected; never stop another instance |
| Stop proof | Main process exits while child survives, ignored TERM, stop timeout. Release only after correct instance's entire cgroup has no live processes |
| Recovery | Broker/worker restart, temporary DB loss, crash before stop acknowledgement. Unknown state retains reservation; no new admission before reconciliation |
| Isolation | Cross-instance files/processes, host secrets, network, devices, capabilities and read-only-root writes denied; retain AVC/probe evidence |
| Host sockets and inherited FDs | Verify the sandbox cannot see/access host system-bus and container-runtime sockets through mounts. Enumerate inherited/passed FDs and socket-activation variables against an explicit allowlist; test denied access using both newly created and inherited Unix sockets/socketpairs |
| Limits | Exercise memory, PID, CPU, wall time, temporary disk, protocol and output bounds; observe actual enforcement and cleanup, not only configuration |
| Certification invalidation | Changed architecture/systemd/runtime/policy/environment fingerprint invalidates old approval; missing evidence keeps execution disabled |

`MainPID=0` and a completed stop job are insufficient. cgroup v2
`cgroup.events: populated=0` describes absence of living processes in the subtree,
but a stop proof must also bind the correct instance and handle disappearance and
reuse races. No single property read is a complete stop-proof implementation.

The documented Subscribe/job-correlation pattern is being modeled using private
simulated interfaces. Applying it to StartTransientUnit on a target systemd version
requires the real tests above. Private P2P tests do not establish system-bus routing,
polkit/SELinux admission, actual unit-property enforcement or process isolation.

PrivateNetwork does not deny filesystem Unix sockets that remain visible and
accessible. RestrictAddressFamilies does not constrain inherited/passed sockets or
socketpairs. Rootfs/mount visibility and FD ownership/closure therefore require
separate probes; property readback alone is insufficient. These are acceptance
requirements, not a claim of an observed vulnerability in the disabled candidate.

## Evidence and result format

For each case retain PASS / FAIL / BLOCKED / NOT IMPLEMENTED, source SHA,
architecture and environment fingerprint, command exit status, monotonic event
ordering, unit/job/InvocationID/cgroup identity, and redacted logs. Verify no live
instances remain at test end; unresolved instances stay quarantined. Never include
credentials or document contents in shared diagnostic artifacts.

**Current result: no real openEuler or systemd-unit acceptance has been run.**

## Primary references

- [systemd 256 D-Bus API](https://www.freedesktop.org/software/systemd/man/256/org.freedesktop.systemd1.html)
- [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [openEuler cgroup v2 configuration](https://docs.openeuler.org/en/docs/24.03_LTS/docs/Container/iSulad_support_for_cgroup_v2.html)
- [openEuler SELinux configuration](https://docs.openeuler.org/en/docs/24.03_LTS/docs/SecHarden/selinux-configuration.html)

- [systemd 256 execution sandbox semantics](https://www.freedesktop.org/software/systemd/man/256/systemd.exec.html)
- [systemd 257 inherited socket restrictions](https://www.freedesktop.org/software/systemd/man/257/systemd.exec.html)
