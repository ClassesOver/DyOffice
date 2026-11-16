# T02 Fastify migration checkpoint

Baseline: `42f135cf`, branch `feat/dyoffice-web`, 2026-11-15. This is an incremental development-runtime migration, not T02/M0 or production signoff.

## Scope

- `server/src/app.ts` exposes `buildApp(config): Promise<FastifyInstance>`; startup uses it with Node type stripping.
- Health routes are independent modules with static application-owned response schemas; live remains healthy when the prototype data directory disappears, ready returns 503.
- Legacy routes and built/source assets retain their raw-stream handler through an explicit compatibility module. Ownership transfers in `preParsing`, after request policy hooks and before JSON/body consumption. Original upload/body limits and user/admin separation remain.
- Server-owned request IDs and safe Problem fields cover compatibility and framework errors. Fastify logging is disabled; no raw credentials or URLs are logged.
- Direct-peer IP rate limit defaults to 600 requests per minute, with health probes exempt. Client proxy headers are not trusted. In-memory counters protect this single-process development runtime only.
- SIGTERM/SIGINT call Fastify close; startup bind failures close the app and set nonzero exit status. The legacy `createApplication` factory remains available for regression and rollback.
- Pinned Fastify 5.12.8, rate-limit 10.3.0 and Node types 22.20.5. Both npm locks are synchronized. Existing engine/native dependencies are preserved.

## Verification

RED: the new API compatibility suite failed because `server/src/app.ts` did not exist. Additional tests demonstrated missing limiting (200 instead of 429) and SIGTERM termination without a clean exit. The limiting test then caught route-level hook order: the raw handler initially hijacked requests before the limiter. Moving the transfer to `preParsing` corrected this failure.

Final observed results:

- `npm run test:web:integration`: 8 passed, 0 failed/skipped, using real local HTTP and a real child server process.
- `npm run test:web`: 32 passed, 0 failed/skipped.
- `npm run typecheck:web`: BrowserHost/contracts and server TypeScript passed.
- `npm run test:web:build`: 2 passed, including emitted assets served by Fastify.
- `node --test tools/check-web-boundaries.test.mjs tools/audit-web-host.test.mjs tools/dyoffice/*.test.mjs apps/web/test/unit/*.test.mjs`: 67 passed, 0 failed/skipped.
- Compatibility baseline: 84 files, zero drift. Browser graph: 22 files, zero violations. IPC inventory: 538 members, zero unmatched/opaque; classification current.
- The 8 Fastify integration tests also passed under an actual Node 22 runtime installed with `npm exec --package=node@22`, in addition to the host Node 26.13.1 run.
- `git diff --check`: passed.

Fresh independent review identified two Important issues. Both were reproduced with failing tests against the real server: malformed URL router errors echoed URL queries, and uncommon HTTP methods bypassed auth/rate/error handlers. Shared `frameworkErrors` handling now emits safe Problem responses; every Node request method except the separate CONNECT tunnel event goes through the registered compatibility and health policies. Both regressions pass in the final 8-test suite. No deferred minor findings. No PostgreSQL, S3, native editor roundtrip, real model or production-auth test is claimed here.

## Remaining work and rollback

T02 still requires incremental migration of legacy domain routes and a complete versioned API. Health readiness currently covers prototype storage, not a real PostgreSQL/S3 deployment. T03/T04 must replace development tokens with local accounts, server-owned sessions and resource isolation. No document editing is enabled.

Rollback this checkpoint's startup switch to `createApplication` or revert the isolated commit; no data/schema migration is introduced. Do not run both implementations against the same prototype directory. Production remains explicitly refused before storage creation.
