# T02 / BrowserHost HTTP file-read checkpoint

> 2026-11-15 · Branch `feat/dyoffice-web` · **Partial implementation, not a T02/T05/T07 acceptance**.

## Delivered and design decisions

- `apps/web/server/readonly-files.mjs` implements authenticated-gateway **read-only** GET endpoints under `/api/v1`. It is explicitly a temporary adapter over the existing single-person JSON/file prototype, **not** a multi-user production data layer.
  - `GET /api/v1/capabilities`: returns `unsupported` for all four editing formats until genuine browser viewers/editors exist.
  - `GET /api/v1/files/:fileId`: returns an OpenFileResult-shaped DTO with SHA-256, size, format and read-only file URL; its `sha256:<digest>` revision is only a content validator, not a PostgreSQL version ledger.
  - `GET /api/v1/files/:fileId/content?revision=...`: returns original bytes with `no-store`; missing revision returns 400, changed revision returns 409 and unknown ID returns 404. No endpoint for new document writes is added.
- `apps/web/server/application.mjs` plugs the handler **after existing bearer authentication and personal/admin separation**. Admin tokens cannot read private file bytes or metadata via the new routes.
- `packages/browser-host/src/http-files.ts` exposes `createHttpFileHost()` with same-origin HTTP fetching, permission/status mapping, strict content type handling, a streaming 50 MiB download cap (including early Content-Length rejection), and SHA-based payload integrity checking. Its `stageSave` / `commitSave` remain unavailable.
- Regression tests in `apps/web/test/readonly-files.test.mjs`, `readonly-api.test.mjs` and `test/unit/http-files.test.mjs`. The Web CI workflow now runs the TypeScript adapter test; the legacy Web test command covers the two plain-MJS server tests.

## Test evidence

In a temporary mirror of the changed read-only module and BrowserHost adapter, using Node v22.16.0:

```sh
node --experimental-strip-types --test apps/web/test/unit/http-files.test.mjs apps/web/test/readonly-files.test.mjs
# 4 tests passed, 0 failed

tsc --noEmit --strict --target es2022 --lib dom,es2022 --module nodenext --moduleResolution nodenext \
  --allowImportingTsExtensions packages/browser-host/src/{http-files,index}.ts packages/web-contracts/src/*.ts
# exit 0
```

The above was an **isolated** test of the new module, not the entire repository. `apps/web/test/readonly-api.test.mjs` requires an installed MCP SDK and the real app bootstrap; it has been committed for the full Web CI run but was **not** run locally in this mirror. No claim of full Web CI or four-format native editing success is made.

## Explicit limitations and next gates

- The prototype's `DYOFFICE_USER_TOKEN` is a single development identity. This does **not** demonstrate true multiuser separation, OIDC or RLS, and `createApplication` correctly rejects production startup.
- File contents are still stored in local files and JSON metadata. SHA-based reads do not implement staging/CAS/leaseEpoch/revision history. No browser edit/save UI is enabled.
- This is an incremental compatibility seam, **not** Fastify migration or completion of T02. T02 still requires Fastify module boundaries, error DTOs, deployment readiness and full Web CI.
- T03/T04 must introduce real identities and resource authorization; T05/T06 must introduce S3 revisions and atomic save transactions. Once that lands, replace these legacy-only paths with the authoritative database-backed read service.
- T07 must connect the actual GenOffice DOCX renderer and demonstrate open -> edit -> save -> download -> reopen. Until then, editor capabilities must remain `unsupported`.
- Independent review needed: malicious OOXML/PDF upload scanning, DNS/SSRF policy and storage recovery remain untouched.

## Next suggested work

1. Validate full `npm run test:web`, `npm run typecheck:web` and `npm run test:web:build` at one remote SHA. Fix any CI regressions.
2. Implement T02 versioned Fastify shell and explicit route compatibility without removing the legacy dev server until tests pass.
3. Start T03/T04 principal, session and resource ownership foundation before enabling save or incoming MCP editing tools.
