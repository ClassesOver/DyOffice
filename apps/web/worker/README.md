# Native PPTX validation harness

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
