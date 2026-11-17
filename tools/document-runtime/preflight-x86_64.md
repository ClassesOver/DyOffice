# openEuler / Ubuntu x86_64 read-only preflight

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

The OS check accepts exactly `ID=openEuler` or `ID=ubuntu` and records the actual
nonempty VERSION_ID. No observed version is thereby certified. Pin the chosen
openEuler SP or Ubuntu LTS and package patch baseline separately for each host. Kernel and
systemd version are observations only, not supported-version allowlists. Visible
controllers do not prove delegation or effective limits. This output is not signed,
not a grant, and must never be consumed as a production capability certificate.
The collector injection is solely for unit testing read failures and fixtures.

## Required live acceptance (not performed by this script)

On separate disposable x86_64 openEuler and Ubuntu VMs, record exact SP/LTS,
package patch baseline, kernel/systemd package version, SELinux
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

Ubuntu is not presumed to meet the existing SELinux Enforcing candidate requirement;
AppArmor or an OS name is not an automatic substitute. Missing evidence stays BLOCKED.
Each distribution requires independent live acceptance; results never transfer between them.
ARM remains excluded.
