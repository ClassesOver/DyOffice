# T15 PostgreSQL TLS query regression coverage

## Scope

Adds `apps/web/test/source-tls/postgres.test.mjs`, an opt-in real PostgreSQL
integration suite for the existing TypeScript SQL adapter. The SQL adapter,
egress policy, wire budget, SQL policy, grants and configuration modules were
compared byte-for-byte with `70e99c3a25c4a0dce4b25718485f4b3896ca23db`.
No production code changes are required. This does not touch the Rust broker.

The fixture creates three disposable PostgreSQL clusters bound to loopback,
on dynamically selected ports, with synthetic roles and certificates. It
requires trusted local PostgreSQL binaries and OpenSSL, and a non-root user.
It never connects to an existing database or changes the global trust store.
Fixtures use local `trust` authentication: password/SCRAM authentication is
explicitly **not** covered. The small port allocation/start race fails startup
rather than connecting silently to an existing database.

## Run

From the repository root, with dependencies installed:

```sh
PG_TEST_BIN=/absolute/path/to/postgresql/bin \
node --experimental-transform-types --test apps/web/test/source-tls/postgres.test.mjs
```

Set `LD_LIBRARY_PATH` as needed for a locally extracted PostgreSQL distribution.
Missing prerequisites fail rather than skip. The suite stops its clusters and
removes fixture files; cleanup failure is reported and retains the directory.
This is opt-in, not currently included in default unit CI.

## Verification

Tested with PostgreSQL 17 and Node 24:

- Real TLS connection executes role/grant checks, read-only transaction and
  bounded cursor, returning `pg_stat_ssl.ssl = true` and numeric text `123.45`.
- Untrusted CA is rejected (502).
- Trusted certificate with mismatched subjectAltName is rejected (502).
- A plaintext PostgreSQL server cannot downgrade required TLS (502).
- TLS does not authorize a superuser role (403).
- Endpoint outside the approved IP pin set is rejected (400).
- Seven tests including the parent passed, zero skipped.
- Existing `apps/web/test/unit/source-*.test.mjs`: 15 passed, zero skipped.
- Mutation check: replacing only the custom hostname verification callback with
  `undefined` made the wrong-SAN case fail with “Missing expected rejection”.
  The source was restored byte-for-byte and the suite rerun successfully.

## Remaining acceptance gaps

This does not close T15. It covers the TypeScript PostgreSQL adapter only, not
HTTP request/session binding, source lifecycle revocation, MySQL/StarRocks TLS,
Rust broker integration, production credentials, production network policy,
password authentication, or deployment acceptance. No claim is made that these
remaining paths are ready based on this isolated suite.
