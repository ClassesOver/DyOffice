# Read-only hosted Ubuntu Docker capability audit

## Purpose

This is the first executable check toward the Ubuntu Docker/container-internal
systemd/zbus target. It is not another runtime, Docker API execution backend,
container isolation approval, or document engine. No image is pulled/built and no
container is created. The existing production broker remains disabled.

The manual workflow runs only in ClassesOver/DyOffice on feat/dyoffice-web,
checks out the dispatch SHA with persisted credentials disabled, grants only
contents:read, pins both actions by commit, and uses ubuntu-24.04 (not latest).
There are no inputs, secrets, sudo, privileged flags, mounts, daemon changes or
security-setting changes. It does not run on untrusted pull-request events.

## What actually runs

The Python standard-library collector reads bounded /etc/os-release,
/proc/1/comm and cgroup-controller files. Its three fixed command types are:

- stat of the cgroup filesystem;
- systemctl show of Docker daemon Delegate (read-only);
- docker info with a fixed selected-field JSON template, explicitly targeting
  unix:///var/run/docker.sock after verifying the leaf is a real socket.

Subprocesses have a five-second deadline, 16 KiB stdout limit, discarded stderr,
no stdin and a minimal environment. DOCKER_HOST/CONTEXT/TLS configuration and
arbitrary parent credentials are not inherited. The script never prints full
Docker info, environment, command stderr, registry credentials or daemon config.
Only fixed check booleans, missing/unverified names and allowed controller names
are published. This deliberately does not probe alternate/remote Docker contexts.

## Interpretation

Ubuntu24.04/systemd/cgroup2/controllers/Docker metadata/usernamespace/seccomp and
daemon Delegate are candidate host prerequisites only. Daemon Delegate does not
prove delegation of a particular container subtree. Rootless mode or userns
metadata does not prove the required container UID/GID map. The collector has no
container whose nested namespaces, private bus, unit or resources it can verify.

Therefore even complete host prerequisites produce status=unsupported,
container_probe_run=false and execution_available=false, plus explicit unverified
conditions. The CLI exits 2. The workflow does not mask this nonzero result; its
artifact step still saves the constrained JSON. A red unsupported audit is not a
failed isolation acceptance test and must not be reported as a passing one.
Errors/missing observations reject rather than falling back to guessed values.
The current cloud workspace is not the hosted runner: local evidence is solely
collector tests and the local unsupported report, not hosted Docker evidence.

## Commands

    python3 -m unittest discover -s tools/dyoffice/tests -p test_ubuntu_docker_audit.py -v
    python3 tools/dyoffice/audit-ubuntu-docker.py ubuntu-docker-audit.json

Dispatch the named workflow after review/merge. Record the exact workflow SHA,
runner image/version and bounded report. Do not change the daemon to fix missing
prerequisites. No use of runner passwordless sudo is needed or authorized here.

## Concrete next step after the audit (not executed by this PR)

If any host prerequisite is missing, stop the positive path and report which
specific capability is unavailable. Do not install rootless mode, change uidmaps,
remount cgroups or add SYS_ADMIN/privileged automatically.

If prerequisites are present, prepare a separately reviewed fixed benign Ubuntu
24.04 diagnostic image with immutable official base digest, systemd/private bus,
/usr/bin/sleep, and the exact #147 diagnostic test binary. Do not accept an image
or command from workflow input. Audit actual container configuration externally:
private PID/user/cgroup namespaces, UID/GID0 mapped away from host0, continuous
61184..65519 mapped range, correct delegated subtree with no parent/sibling write,
seccomp/LSM and no host bus/socket/paths. No privileged or security weakening.
Only after those checks may the #147 fixed sleep/zbus test run inside the
container; its two-second manager deadline and readback are bounded observations,
not full isolation approval. Preserve reports for failures as well as success.

The next acceptance then tests broker SIGKILL and descendant cleanup, actual
resource exhaustion and filesystem/network denial. Only after that can separately
verified runtime images and four-format document processing be considered. No
positive container or document evidence is inferred from this read-only audit.

## CI inventory admission

The workflow remains in the complete runtime-lock inventory. It is a manual
Python host observation, not a Node workload: only its exact filename has a
dedicated SHA-256 admission check of the complete workflow bytes. No wildcard or
configurable workflow-name exemption exists. Any change, including whitespace,
triggers explicit review and fails until the reviewed digest is updated. Existing
Node workflows retain all original setup/version/executable guard requirements.
This digest fixes workflow syntax, not the hosted runner's Python/OS executable
bytes; it must not be described as an immutable host runtime or isolation proof.
Regression mutations cover permissions, trigger, runner, ref guard, privilege
insertion, missing/incorrect digest, unlisted workflows and cross-file borrowing.
The existing boundary CI includes the exact audit workflow path in both push and
pull_request path filters, so a workflow-only edit triggers the runtime-lock
check. Regression tests independently remove each event's path and require
failure; the diagnostic workflow itself remains manual-only.
