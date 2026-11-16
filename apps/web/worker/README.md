# Native worker adapters and validation

The experimental XLSX Worker now runs the original Rust engine as a restricted
systemd process on Linux, without Docker. See [host runtime setup](HOST-RUNTIME.md)
for build requirements, privileges, environment variables and recovery behavior.

```sh
npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev
npm run build:web:native -- --with-probe
npm run typecheck:web:worker
# Set DYOFFICE_TEST_HOST_MANIFEST to the absolute host-manifest.json path:
npm run test:web:sandbox
# With dedicated PostgreSQL and Redis test URLs:
npm run test:web:native-jobs
```

The runtime verifies the configured executable SHA-256. Each native invocation
uses a unique dynamic nonroot user, private filesystem and network, bounded
resources, and a service-manager deadline that survives controller death.
The trusted controller currently requires root; API users cannot configure its
binary, command policy or systemd properties. Production mode remains refused.

Migration version 12 includes deployment readiness and revision-event dispatch.
Run owner provisioning before starting restricted business/worker pools. The
native output and successful task state commit together through the T06
transaction. Revision publication emits only an event UUID and does not assert
that a downstream search index has consumed it.

The XLSX adapter currently performs an unedited archive roundtrip and reopens
its result. Edited spreadsheets and their browser interface belong to T09.
The sandbox NodeNext typecheck covers sandbox, jobs, native XLSX and daemon code.

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
