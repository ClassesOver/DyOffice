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

## Still open for T02

Legacy file, preference, admin, DOCX, and MCP routes still live in `createApplication`. The shell's 501 responses are the migration marker, not a cutover. Rate limiting and graceful shutdown apply only to `buildApp`. Production login, Fastify route schemas for business APIs, and real readiness checks for PostgreSQL and object storage are not done. Do not mark T02 or M0 complete from this note.
