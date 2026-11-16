# Docker-free Native Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task by task, preserving the existing session execution method and whole-branch review at plan end.

**Goal:** Execute and deploy the real native backend without Docker to close T08 while preserving existing behavior.

**Architecture:** Replace only the native OS-launch boundary with systemd-managed restricted child processes. Retain queue, native protocol, File API, job capabilities and atomic revision completion. Migrate builds, fixtures, CI and deployment instructions to host services.

**Tech Stack:** Node22/TypeScript, original Rust/Cargo, Linux systemd255+/cgroup v2, PostgreSQL17, Redis/BullMQ.

**Spec:** `docs/superpowers/specs/2026-11-16-docker-free-native-design.md`

## Global Constraints

- No Docker container/socket/CLI dependency for application build, runtime or deployment.
- Preserve original Rust engine/Cargo.lock and all T08 requirements; do not implement later tasks as part of this goal.
- Native tasks receive no host credentials; permission/time/CPU/memory/PID/network/file bounds remain enforced.
- Never delete unrelated host units/directories/services; no production readiness claim before later gates.

## Review Focus

- Dynamic-user/PID reuse: workspace descriptor must belong to the same unit and invocation before I/O.
- Concurrent jobs: one job cannot inspect another job's files or parent credentials.
- Controller death: service manager enforces wall limit and terminates the whole process group.
- Output symlink/FIFO/replacement: read one bounded regular descriptor or fail closed.
- Startup/recovery: only expired owned preparation artifacts and units may be collected.

### Task 1: Host build and isolated process boundary

**Files:** create `apps/web/worker/src/sandbox/host-process.ts`; modify native build tool/helper manifest; add `apps/web/test/host-native/*.test.mjs`.

**Interfaces:** `createHostProcess({binary,sha256,deploymentId,allowedCommands,limits}).run(input,execute,{signal})` produces the existing request/readOutput session interface.

- [x] Write tests for real nonroot/caps/no-new-privileges/private root/network; CPU/memory/PIDs/wall/abort; output and independent controller death.
- [x] Observe RED for missing host launcher before implementation.
- [x] Implement fixed systemd arguments, dynamic user, minimal executable/dependency root, private 128MiB workspace and validated descriptor I/O.
- [x] Verify real kernel limits and original Rust roundtrip; no skipped unavailable-backend success.
- [x] Build original engine using host Cargo --locked, record executable/toolchain hashes and commit the tested boundary.

### Task 2: Switch Worker and durable integration

**Files:** modify `worker/src/main.ts`, native fixture helpers, job integration tests and root/app scripts.

**Interfaces:** retain `createXlsxJobExecutor` and atomic output APIs; use host native binary/hash instead of image ID. Preserve readonly deployment readiness added during T08f work.

- [x] Verify direct daemon startup with host binary/hash and no image configuration; host launcher RED was observed before implementation.
- [x] Switch startup probe and execution to host launcher; preserve graceful shutdown and fixed diagnostics.
- [x] Verify API → real Redis → Rust → validated immutable output → SQL success, cancellation/revoke/lost epoch/startup/duplicate cases. Controller death, claim recovery and committed-output replay were verified separately; a single full daemon kill/restart test was not run.
- [x] Commit verified daemon integration.

### Task 3: Docker-free fixtures, CI and cleanup

**Files:** native build tooling, `.github/workflows/dyoffice-web-boundaries.yml`, fixture service setup, README/evidence, obsolete Docker-specific runtime files.

- [x] Provision dedicated host PostgreSQL17/Redis fixtures without altering unrelated existing services; keep generated credentials private.
- [x] Update CI to build/run native processes and independent services without Docker; test coverage gate first RED.
- [x] Remove Docker-only runtime/build/deployment paths; historical evidence stays explicitly dated.
- [x] Run host isolation/native/SQL/API/browser/type/boundary/baseline gates sequentially on this small server.
- [x] Commit evidence and audit every T08 acceptance item; completion also requires durable outbox dispatch and final review.
