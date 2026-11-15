# Native worker adapters and validation

The XLSX adapter has a development-only Docker execution backend. From the repository root on Linux with Docker, cgroup v2 and builtin seccomp:

```sh
npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev
npm run build:web:native -- --with-probe
npm run typecheck:web:worker
npm run test:web:sandbox
```

The build compiles the original `apps/sheets/native/xlsx-engine` with its unchanged `Cargo.lock` in a pinned Rust image. It writes ignored `.dyoffice-native-build/manifest.json` with immutable runtime image IDs and source/binary hashes. `DYOFFICE_NATIVE_BUILD_CACHE` selects another local build cache; tests use `DYOFFICE_TEST_NATIVE_MANIFEST` to select its manifest. The probe image is test-only. Building downloads pinned builder/runtime images and the locked Cargo dependencies; runtime jobs have no network.

Each execution gets a new UID/GID 10001 container with private tmpfs, read-only root, no host mounts, no capabilities, no added privileges, builtin seccomp, no network, bounded memory/swap/PIDs/CPU/file size, protocol bytes and wall time. Admission permits at most two containers and 1 GiB configured memory per controller process. Input/output use a fixed Rust transport, no shell, host path or extracted archive. A small supervisor reads the live cgroup OOM counter before exiting because Docker can miss child OOM events. Native stderr is discarded and bounded; credentials are not inherited. Cleanup removes the container and temporary controller state on success, failure or cancellation.

`native/xlsx.ts` runs the existing Rust archive writer and reopens its output. This currently proves unedited package preservation. It does not persist edits or recalculation, expose a public worker route, or mark a durable job successful. The server now provides fenced job credentials and output/job completion in the same T06 revision transaction ([T08c evidence](../../../docs/dyoffice/evidence/t08c-atomic-job-output.md)); the controller and heartbeat loop connecting this adapter to that core are still required. `NODE_ENV=production` refuses this backend pending the later containment, deployment and release gates. A Docker socket is privileged infrastructure: keep the trusted controller separate from untrusted native processes; the socket is never mounted into their containers.

The sandbox NodeNext typecheck covers `src/sandbox` and `src/native/xlsx.ts`. The earlier PPTX source harness below has its own Bundler configuration and CI gate.

## Native PPTX validation harness

This private package is a test tool, not a deployed worker or HTTP service. It installs its own pinned development dependencies, without installing the root Electron workspace or changing the DOCX Web lockfile.

From the repository root:

```sh
npm ci --prefix apps/web/worker --workspaces=false --ignore-scripts --include=dev
npm run typecheck --prefix apps/web/worker --workspaces=false
npm test --prefix apps/web/worker --workspaces=false
```

The `DyOffice native PPTX gate` runs these commands for relevant pushes to `feat/dyoffice-web`/`main` and pull requests. It retains the existing Web boundary and full desktop workflows unchanged. Its explicit suites are session lifecycle/edit/export (9), package roundtrip (2), and adjacent native setText operations (2). Missing suites fail configuration instead of silently reducing coverage.

Tests resolve the checkout's real engine, ops, render and ZIP gate sources. TypeScript checks the same session/tests plus their source dependencies, with real declaration files and no fake `any` module declarations. The isolated lock is authoritative for this harness and can be refreshed separately from DOCX dependencies; versions should remain aligned with the reviewed native/Web baseline.

This is Node data-flow validation only. It does not certify browser canvas or image/font fidelity, PowerPoint acceptance, authentication, durable revision CAS, worker sandboxing, or deployment readiness. See `docs/dyoffice/evidence/pptx-node-session.md` for those boundaries. The full monorepo suite remains a separate requirement.
