# T04 resource coverage: implemented resources versus disabled entrances

Scope: read-only inspection of coordinator's unpublished `t03-t04-closure` candidate on 2026-11-16. This is not a remote commit acceptance statement. No production source or other worker's files changed.

## Original acceptance boundary

`docs/dyoffice/implementation-plan.md` T04 asks for A/B access, same-pool reuse, rollback, Admin reading another user's files, cross-owner FKs, wrong background-task principal, restricted non-owner database role, FORCE RLS and every entrance's DB/direct-API policy tests. Therefore a default 501 cannot count as implementation of authorization for a future resource. Current plan appropriately leaves these aggregate checkboxes unchecked pending final combination evidence.

## Current local runtime registrations

- `server/src/app.ts:buildLocalApp` registers credential-backed auth/Admin users, preferences, files/uploads/content/revisions/leases/quota/capabilities and optional native jobs. File and revision transactions rederive authority from a session, not request-supplied owner. Job transactions use scoped live credentials. Admin role does not grant foreign file ownership.
- Actual consumers are `local-main.tsx` / `local-client.ts`, original Home bridge and native DOCX file host. Admin UI operates account metadata, not an implicit cross-owner file viewer.
- Existing real-PG suites cover ownership-rls, files, revision-commit, job-routes, scoped-startup, revocation-race and authority-write-races; final combined run still required. The previously delivered three #28 regressions add foreign/missing job error equivalence, role-epoch invalidated enqueue/cancel, and fully configured app legacy fallback refusal.
- `/native-docx/` authenticates session and resolves the requested file through files.openFile before serving entry HTML; static bundles are not a substitute for file ownership enforcement.

## Not implemented in new local runtime

| Area | Existing caller / old code | Local disposition |
|---|---|---|
| AI streamed turns | `packages/browser-host/src/ai-transport.ts` defaults `/api/v1/ai/turns`; Home `askEnabled:false` | No turn service registered. No conversations/AI ownership RLS acceptance can be claimed. |
| Data sources | Old `modules/sources/routes.mjs` handles `/api/sources` through legacy shared store | Not registered by buildLocalApp. Cookie principal must never fall back to old store. |
| Models/admin provider config | Old `modules/admin/routes.mjs` `/api/models`, `/api/admin/config` | Not registered; config_admin alone cannot enable old provider-secret access. |
| MCP test | Old legacy-dispatch `/api/admin/mcp/:id/test` invokes old Admin handling | No local MCP resource/service. Server credentials, SSRF policy, owner scope and per-tool authorization remain future work. |
| External token / tool execution | T19/future Agent/AI wiring | Not established by session RLS or disabled endpoints. Explicit credential derivation, audience/scope, revocation, tool/resource tests required before enabling. |

For all unknown `/api/*`, current wildcard authenticates session then throws 501. Missing/invalid session receives 401. This applies with optional files/jobs enabled and must not be weakened into routing to the legacy dispatcher. Existing old `api-compat.test.mjs` validates **buildApp development-token stack**, not new-local authorization.

## Executable rejection candidate

`t04-unimplemented-entrypoints.test.mjs` is a separate two-test candidate for `apps/web/test/local-integration/`. Uses the real `fileFixture` with restricted PG and nativeJobs enabled, no fake query/skip:

1. Anonymous and development Bearer credentials get 401 for concrete old-source/models/admin/MCP and proposed AI/conversation surfaces.
2. Alice/Bob/config_admin valid cookies with fresh CSRF and forged owner/principal payload get 501, not SSE; payload URL is not reflected.

Validation here: `node --check` passed only. Real PostgreSQL execution pending coordinator CI; do not count as passed or as implemented AI/MCP. The AI cancel/conversation cases intentionally lock the current disabled namespace, not claim a finalized API schema. The test does not instrument outbound sockets; 501 is a response contract, not standalone proof of zero external I/O.

Before future enablement replace the relevant disabled-case assertion with real A/B/Admin, foreign-vs-missing, revoked credentials, rollback/pool reuse and wrong-job-principal tests, plus resource schema/RLS/FK enforcement and provider/MCP network policy. Do not silently remove tests to turn the gate green. Historical database migration and production remain outside this evidence.
