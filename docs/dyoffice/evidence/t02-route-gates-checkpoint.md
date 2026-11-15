# T02 continued: development API request boundary and health probes

> Date: 2026-11-15. Scope: incremental changes to the existing **development-only** Node HTTP server. This is **not** Fastify migration, production readiness, multi-user authorization, or T02 signoff.

## Changed files

| File | Responsibility |
| --- | --- |
| `apps/web/server/request-boundary.mjs` | Reusable dev Bearer principal classification and route authorization, with duplicate/malformed Authorization rejection |
| `apps/web/server/health.mjs` | Minimal public GET/HEAD liveness and readiness probes, no secret/config information in responses |
| `apps/web/server/application.mjs` | Use the shared auth guard for legacy and versioned file routes; invoke health before authentication |
| `apps/web/test/request-boundary.test.mjs` | Token formatting, duplicate headers, user/admin permission unit tests |
| `apps/web/test/health.test.mjs` | Health route status, no-store, HEAD, 405, degraded readiness |
| `apps/web/test/route-gates.test.mjs` | Live HTTP integration test against real `createApplication`: request IDs, bearer rejection, duplicated headers, permissions |

Existing `/api/preferences`, `/api/admin/config`, `/api/files` and versioned read endpoints retain their original success contract. The dev application still refuses production startup.

## Verified locally

A local isolated mirror of the two new modules, the existing `http-response.mjs` and their unit tests was run with Node 22.16.0:

```sh
node --test apps/web/test/health.test.mjs apps/web/test/request-boundary.test.mjs
# 3 passed, 0 failed
node --check apps/web/server/health.mjs
node --check apps/web/server/request-boundary.mjs
# both exit 0
```

The first test run exposed a response-envelope collision: `sendJson` reserves `status` as the numeric HTTP error status. The health payload now uses `state`; the corrected suite passes. Do not restore the ambiguous property.

The integration test `route-gates.test.mjs` was committed for `npm run test:web` and the GitHub Web gate but could **not** be run in this isolated mirror because `createApplication` imports the actual MCP SDK. Its completion status must be read from CI, not inferred from the unit test.

## Explicit limitations and next step

- These route checks are a **single dev user + configuration admin** prototype, not OIDC identities, workspace ownership, RLS, or production-grade authentication.
- The readiness probe only checks access to the local data directory and availability of in-memory state. Enterprise readiness must check PostgreSQL, S3, key material and active migrations, without exposing sensitive diagnostics publicly.
- Strict `Bearer` formatting is intentional. Repeated Authorization headers or a bare token are rejected rather than silently picking the first value.
- `health` is a public liveness/readiness path; it does not allow personal/Admin API access.
- Fastify module migration remains T02's next substantial implementation. Introduce the dependency, both lock files and integration tests **together**, then cut over route-by-route. Until then, the working HTTP server remains unchanged in its startup behavior.
- T03/T04 enterprise identity and resource isolation must precede production file writes, incoming MCP edit tools, or customer data.

**Status:** T02 partial; no four-format editor roundtrip, model execution, document revision transaction or production deployment claim.
