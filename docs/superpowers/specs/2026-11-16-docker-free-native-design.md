# Docker-free native execution

User decision: on 2026-11-16, after discussing alternatives, the user explicitly requested no Docker containers. This supersedes the earlier Docker implementation choice for the T08 sandbox. The active goal is to close T08. Preserve the existing Rust XLSX fidelity path, multiuser authorization, job fencing and output transactions. Later T09–T26 work remains outside this goal.

Use the session's existing authorization and inline execution method. The choice of systemd below is the implementer's call, not a claim that the user selected its individual settings. No new feature or scope is introduced.

## Approaches

- Bare child process: few dependencies, but insufficient separation of host files, other users' jobs and network. Rejected as the final multiuser implementation.
- Linux restricted child processes managed by existing systemd: chosen. The server has systemd 255, unified cgroups and necessary privileges; an actual DynamicUser/network/resource-limited host process has exited successfully. The original Rust executable also boots directly on host glibc 2.39.
- Docker launcher: explicitly rejected by the user. Historical evidence remains dated provenance, not the deployment plan.

## Behavior and boundaries

Node Worker calls the same native roundtrip adapter, with input bytes, bounded JSON protocol, cancellation and output bytes. Each invocation runs the original Rust executable under a unique dynamic user, a minimal private filesystem view, private network, no added privileges, no capabilities, and restricted read/write workspace. Configure 512MiB memory/no swap, 64 tasks, 1 CPU share, 15s CPU/30s independent wall defaults; preserve the previous allowed configuration maxima and 32MiB file bounds. Admission stays at two invocations / 1GiB configured memory per controller.

systemd owns the unit's lifetime and cgroup after controller death. Native workspace is private tmpfs capped at 128MiB; Node accesses it through a validated process/workspace directory descriptor, never user paths. An owned root containing only executable/library files may survive interrupted preparation and needs bounded startup recovery. Do not delete unrelated system units or host directories.

Native code gets only explicit locale/workspace environment and stdio, no database, session, job claim or storage secrets. The Rust archive writer is retained; no alternative XLSX writer is introduced. Node validates/publishes output using existing T05/T06 and marks SQL success in the same transaction.

## Build and deployment

Build the existing Cargo project on the host using Cargo.lock, recording source/binary/toolchain hashes. No Docker build command or runtime socket dependency remains. PostgreSQL 17, Redis and object storage use independent services or configured external endpoints. CI must exercise host execution instead of requiring Docker service containers. Existing unrelated Docker services on the server are outside this change.

Production remains closed until the full later security/deployment/QA gates. Development launcher privilege must be explicit; do not grant arbitrary service control to API users. Test real host permissions/resources/timeout/cancellation and actual original XLSX bytes before claiming completion.
