# T02 modular API shell

> 2026-11-15 · Branch `cursor/t02-modular-api-afe4` · **Partial. Not a T02 sign-off.**

## Why this slice

T03b session core is already on `feat/dyoffice-t03b-session-core`. T03c and T04 depend on that work. T02 does not. T01 contracts are already on `feat/dyoffice-web`, so this slice starts the unfinished Fastify shell without editing the T03b session files.

## RED

Command, before `apps/web/server/src/app.mjs` existed:

```sh
node --test apps/web/test/integration/api-compat.test.mjs
```

Node v22.23.4. Result: 4 tests, 1 passed, 3 failed, 0 skipped. The legacy file, preference, and admin contract passed. The three modular tests failed with `ERR_MODULE_NOT_FOUND` for `apps/web/server/src/app.mjs`. That is a missing implementation, not an environment failure.

## What landed

- `buildApp(config)` in `apps/web/server/src/app.mjs` (Fastify 5.12.8, locked in both npm lockfiles).
- `GET /api/v1/health/live` and `GET /api/v1/health/ready`, with HEAD support. Readiness failures return `{state:'unavailable'}` and do not copy exception text.
- Server-generated UUID request IDs. Client `x-request-id` and `request-id` headers are ignored.
- Problem JSON for errors: `type`, `title`, `status`, `detail`, `error`, `requestId`. Bodies do not include the request URL, query values, or exception text.
- Static query schemas on the health routes. Unknown query keys are rejected. Schemas are application source, not request or MCP input.
- Single-process fixed-window limit keyed by the socket address. `X-Forwarded-For` does not choose the bucket. Health probes are exempt. This is not a multi-replica limiter.
- 1 MiB body limit. A larger body returns 413 and does not echo the payload.
- Unmigrated `/api/*` routes return 501 `接口尚未迁移到模块化 API`. They do not serve legacy data.
- `app.close()` stops the listening socket.
- `NODE_ENV=production` or `env: 'production'` refuses to construct the shell.
- Unknown config keys are rejected, including a caller-supplied schema.
- `server/index.mjs` still calls `createApplication`. `dev:web` and `start:web` are unchanged.
- `npm run test:web:integration -- test/integration/api-compat.test.mjs` runs that one file. It does not start PostgreSQL, S3, or Redis. The other planned Web test scripts are still absent.

## GREEN

Same host, after the shell existed:

```sh
npm run test:web:integration -- test/integration/api-compat.test.mjs
# 5 passed, 0 failed, 0 skipped

npm run test:web
# 52 passed, 0 failed, 0 skipped

npm run typecheck:web
# exit 0

node tools/check-web-boundaries.mjs
# 24 files, 0 violations

npm run test:web:build
# 2 passed, 0 failed

node tools/dyoffice/compatibility-baseline.mjs --check
# 84 files, 0 changes

git diff --check
# exit 0
```

No test was skipped. PostgreSQL identity tests were not re-run here; this slice does not change auth, sessions, or migrations. GitHub CI is the record for the pushed commit.

## Cutover (2026-11-15)

`dev:web` and `start:web` now call `buildApp` and listen on Fastify. `createApplication` builds the same app and returns its Node server so the existing suite keeps using `listen` and `close`.

Route modules:

- `modules/pages` for static assets
- `modules/preferences`
- `modules/admin` for models, admin config, and MCP test
- `modules/sources`
- `modules/files`
- `modules/documents` for the DOCX editor and read-only v1 file bridge
- health probes through the existing secret-free handler

A workspace context is required for those routes. Without it, `/api/*` still returns 501. Business request bodies are buffered by Fastify and checked by the same module validators as before. Health routes keep their static schemas. No request or MCP payload is compiled as a route schema.

`SIGTERM` and `SIGINT` call `app.close()`. The rate limit remains one process and does not trust `X-Forwarded-For`.

API credential checks run in the Fastify `onRequest` hook, before the body parser. An unauthenticated or wrong-role write is rejected without buffering the file-sized body. Health probes and static pages stay public. A regression leaves an 8 MiB `Content-Length` unfinished and still receives 401 or 403 within one second.

RED for this cutover, before `legacy-context.mjs` existed:

```sh
node --test apps/web/test/integration/route-cutover.test.mjs
# 1 failed, ERR_MODULE_NOT_FOUND for legacy-context.mjs
```

GREEN on Node v22.23.4 after the cutover:

```sh
npm run test:web
# 52 passed, 0 failed

npm run test:web:integration -- test/integration/api-compat.test.mjs
# 5 passed

npm run test:web:integration -- test/integration/route-cutover.test.mjs
# 1 passed

npm run typecheck:web
# exit 0

node tools/check-web-boundaries.mjs
# 24 files, 0 violations

npm run test:web:build
# 2 passed
```

The boundary fixture also links the hoisted root `node_modules`. Without that link, a workspace install could not resolve TypeScript from a checkout path that contains a space or hash, and the gate exited before printing violations.

## Still not production

Local username/password login, session revocation, PostgreSQL readiness, and a multi-process rate limit are not part of this cutover. `NODE_ENV=production` still refuses to start. Do not treat the development token server as T03 or T04.
