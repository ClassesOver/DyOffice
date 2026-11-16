# T03a local-account storage and bootstrap checkpoint

2026-11-15; baseline `85750f8b` on `feat/dyoffice-web`. This foundation does not yet expose HTTP login, local-account Web mode or production access. T03b/T03c/T04 remain pending.

## Implemented boundary

- PostgreSQL migration creates deployments, users, roles, personal workspaces, hashed-session/action-token storage and bootstrap audit intent. Login names use trimmed lowercase ASCII, 3–64 characters. SQL uniqueness and composite deployment/user foreign keys enforce the storage boundary. Auth lookup privileges and FORCE RLS are still T04 work.
- First Admin initialization locks a durable deployment row; concurrent calls have one winner. User, roles, workspace, audit and bootstrap closure commit atomically. Removing/demoting the administrator does not reopen bootstrap. No default account/password exists.
- Explicit Argon2id v19, 19 MiB, t=2, p=1, independent random salts. Passwords retain whitespace/Unicode, require 15 code points, and accept up to 1024 UTF-8 bytes. No forced character-class rules. Starter common-password denylist plus caller-provided local corpus. The small built-in list is **not** comprehensive breached-password coverage and must not be presented as production acceptance.
- Password verification for absent/invalid identities uses a real dummy Argon2id verification with the same parameters. Corrupt/out-of-policy stored hashes do bounded dummy work. Disabled identities reject even with the correct password. Returned candidates contain no password/hash and are not authenticated sessions: session creation and protected writes must revalidate under locks.
- Hash service bounds concurrent operations (default 2) and pending work (default 8); overflow fails rather than allocating an unbounded queue.
- Interactive CLI reads hidden password/confirmation from a terminal, accepts neither password arguments nor injected password variables, and rejects development tokens. Errors omit database URLs, passwords and SQL details. A local blocklist file can be supplied. A real PTY test caught and fixed a raw-mode/prompt race before completion.
- Drizzle maps typed reads; immutable reviewed SQL owns constraints. Migration execution is explicit, transactionally serialized, and checks the applied SHA-256. It is not run implicitly on Web startup.

## Verification and environment

Actual disposable PostgreSQL 17 container on loopback, tmpfs data, random credential; image pinned to `postgres@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7`. Tests use a real PG connection and fail if the required test URL is absent. Migration/test connections are privileged; these results **do not demonstrate runtime RLS**.

RED was observed before identity/password/CLI modules existed. A real terminal then reproduced a timeout after the first prompt: canonical input could arrive before raw mode, and Enter could be named `enter`. The automated PTY regression reproduced it; registering input/raw mode before displaying the prompt and handling both Enter forms made it pass.

Final observed results:

- `npm run test:web:integration` with the disposable database: 14 passed, 0 failed/skipped, including 5 real PostgreSQL account/constraint/PTY cases, CLI noninteractive rejection and the 8 Fastify regressions.
- All `apps/web/test/unit/*.test.mjs`: 37 passed, 0 failed/skipped.
- `npm run test:web`: 32 passed, 0 failed/skipped.
- `npm run test:web:build`: 2 passed.
- `npm run typecheck:web`: passed, including the bootstrap CLI.
- Auth/password/CLI/PTY tests under an actual Node 22 runtime: 10 passed, 0 failed/skipped.
- Compatibility/CI regression tests: 7 passed. Dependency baseline: 84 files, zero drift. Browser boundary: 22 files, zero violations. `git diff --check`: passed. CI provisions its own disposable PostgreSQL service and runs password tests plus the complete integration suite; local results are not a GitHub Actions success claim.

Local synthetic password measurement (Linux x64, Node 26.13.1, Xeon E5-2690 v4): 12 samples each; hash mean 27.44 ms, wrong-password verification 29.83 ms, unknown-identity dummy verification 29.06 ms; two concurrent hashes 28.95 ms; process peak RSS 258116 KiB. Reproduce with `node --experimental-strip-types tools/dyoffice/benchmark-passwords.mjs`. These are measurements on this host, not a timing-security proof, production capacity or a change to the required hash parameters.

Independent read-only review found no additional Critical/Important/Minor defects in the delivered storage/password scope; the terminal race was independently confirmed and covered by the final regression. Sessions, HTTP throttles/CSRF, admin activation/reset, revocation ordering and RLS are intentionally unimplemented and unverified here.

## Operation and rollback

`npm run bootstrap:admin` requires an interactive terminal plus explicit `DYOFFICE_DATABASE_URL` and stable UUID `DYOFFICE_DEPLOYMENT_ID`; optionally `DYOFFICE_PASSWORD_BLOCKLIST_FILE` names an approved local UTF-8 line-per-password corpus. Use a dedicated migration/initialization credential, not a broad business-runtime role. No real deployment has been initialized by this work; only disposable test deployments were created.

Web startup continues to use the development token compatibility server and refuses production. Do not put a local-login UI in front of the shared JSON store or infer user isolation from these direct service tests. T03b must create server-owned sessions, T03c must handle account administration, and T04 must implement restricted auth lookup and FORCE RLS before production writes.

Rollback application code without dropping identity data. The migration is additive and version/checksum tracked; destructive schema rollback is not automated. Back up credentials/database before applying to any real deployment. Prototype JSON files are not assigned to the first administrator; T22 owns explicit migration mapping.
