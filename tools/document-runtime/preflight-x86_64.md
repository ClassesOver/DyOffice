# openEuler x86_64 read-only preflight

This diagnostic cannot certify a broker, enable production, or replace real unit
acceptance. Every report is `BLOCKED`, `productionEligible:false`, and
`liveAcceptance:NOT_RUN`. Exit 2 is expected even when all static prerequisites
are visible. `prerequisitesSatisfied` only summarizes the listed observations.
It does not verify a usable manager connection or authorization.

Run from repository root:

```sh
node --test tools/document-runtime/preflight-x86_64.test.mjs
node tools/document-runtime/preflight-x86_64.mjs
```

Node built-ins only; no install step. The script reads fixed bounded files,
stats an existing system bus socket and the cgroup filesystem, and executes only
`/usr/bin/systemctl --version` with a 2-second/16-KiB bound. It does not connect to
D-Bus, create a listener, launch units, use sudo, change SELinux/network/permissions,
write files, or accept custom paths/commands. Missing/inaccessible/unsupported
observations fail the corresponding prerequisite. A false SELinux/socket check
means **not established**, not proof of permissive mode or socket absence.

The OS check targets exactly `ID=openEuler`, `VERSION_ID=24.03`; it does not infer
SP/package patch status. Record those separately in real acceptance. Kernel and
systemd version are observations only, not supported-version allowlists. Visible
controllers do not prove delegation or effective limits. This output is not signed,
not a grant, and must never be consumed as a production capability certificate.
The collector injection is solely for unit testing read failures and fixtures.

## Required live acceptance (not performed by this script)

On a disposable x86_64 openEuler VM, record exact SP/kernel/systemd RPM, SELinux
policy, runtime/policy digests and tested commit. Independently verify:

1. Fixed property encoding/acceptance and actual namespace/seccomp/cgroup effects;
   unknown/ineffective required hardening rejects without deleting properties.
2. Real pathname socket permissions and cross-UID admission, plus authenticated
   context/lease fencing. Same UID is not tenant authorization.
3. Subscribe and signal receiver before StartTransientUnit; correlate job identity;
   immediate success/failure, early signals and unrelated concurrent jobs.
4. Broker bus disconnect/reconnect before/after launch acknowledgement; reread unit
   and InvocationID, never repeat unknown starts or trust stale handles.
5. Child survival after main exit, stop timeout, crash/restart and cgroup emptiness;
   ambiguous stop retains reservation and artifacts for reconciliation.
6. Memory/PID/CPU/wall/tmp/output limits, cross-instance filesystem/network denial,
   and changed runtime/environment invalidating old acceptance evidence.

References: [systemd D-Bus](https://www.freedesktop.org/software/systemd/man/256/org.freedesktop.systemd1.html),
[systemd execution](https://www.freedesktop.org/software/systemd/man/256/systemd.exec.html),
[Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
Installed binaries, introspection and property readback alone do not establish
hardening. ARM and actual execution are outside this slice.
