# Rust restricted dispatch consumer

This SaaS server-side private module calls the actual restricted PostgreSQL
consume/history functions introduced by the native-backed ledger. It does not
issue dispatches, construct ApprovedRuntime/LaunchSpec, call Manager, start a
listener, execute documents or commit T06 output. The default broker still exits78.

## Boundary

Production-compiled connection uses tokio-postgres with postgres-native-tls and
SslMode::Require, normal certificate-chain/hostname verification and explicitly
configured CA roots. Credentials and connection strings are not returned or
included in diagnostic errors. Configuration is private trusted composition input,
not a document/wire DSN; normal SQL always names public fixed functions. Only the
cfg(test) fixture permits loopback NoTls and a validated isolated schema. The test
entry is not available through unsafe-test-harness or a production binary.

The caller supplies a trusted immutable expected observation binding. This is not
independent native/runtime authorization. Strict decoding rejects unknown fields,
incorrect types, unsafe versions, identity/digest/expiry changes and inconsistent
classification/consumed combinations. SQL remains the sole authoritative CAS and
native-authorization implementation. No query executor is exposed to callers.

An attempt is single-use and non-Clone. It marks used before polling a database
transaction, validates the returned row before COMMIT, and returns only after
COMMIT completes. Cancellation, timeout, SQL errors, failed decoding or ambiguous
commit returns OutcomeUnknown after invocation. No automatic retry occurs.
An exact replay can only be already_consumed; history is explicitly historical,
including expired data, and cannot recover first-use authority. Pre-cancel does
not consume. After an operation is entered, the connection task is aborted and awaited
within 100ms on the consume/history path. Pre-cancel and already-used early
returns abort the connection task through Drop without that explicit wait. Cleanup is not proof the server rolled back; real tests
separately observe connection disappearance after blocked cancellation.

PG data is decoded by the mature driver before strict application validation;
this is not an adversarial server parser-memory budget. The SQL server/configured
CA are trusted. Native wrapper still does not authenticate tenant, session digest,
generation, policy or runtime approval. Database LOGIN/TLS identity is not broker
OS identity. Runtime and target-rootfs admission remain absent, and production
orchestration must establish them before consuming any dispatch.

## Evidence and reproduction

Pin versions in Cargo.lock. From repository root:

```
cargo test --locked --manifest-path services/document-broker/Cargo.toml
cargo clippy --locked --manifest-path services/document-broker/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path services/document-broker/Cargo.toml -- --check
```

The ignored cfg(test) child entry is intentionally invoked only by the explicit
real-PG Node suite with RUST_PG_TEST_BINARY set to the compiled lib test executable.
`apps/web/test/sandbox-pg/rust-consumer.test.mjs` runs real isolated LOGIN clients
and existing candidate SQL fixtures; `rust-tls.test.mjs` needs two temporary
PostgreSQL endpoints and temporary test CA certificates supplied by its recipe.
Fixture settings travel in a0600 temporary file, not credential-bearing argv.
No test key, cluster data or generated compiler artifact is distributable output.

Real database tests cover first consume, exact replay, new-process history,
concurrency, wrong expected boot rollback, foreign/revoked LOGIN, same-object
reuse, recovery/epoch fencing, pre-cancel and blocked timeout/cancel cleanup.
COMMIT confirmation-loss test injects a client-side error after actual COMMIT;
it is not a simulated network packet loss or actual process crash. A new Rust
process then reads consumed history and cannot recreate a first result.

Real TLS tests use the same production connection method against temporary PG:
trustedCA/localhost succeeds, wrongCA and wronghostname fail, and a plaintext-only
server fails with no downgrade. Local test LOGIN policy is unchanged; this does
not validate client certificates, production secret provisioning or production
network authentication. No target Ubuntu/openEuler runtime acceptance is claimed.

The repository recipe builds/discovers the exact cfg(test) executable and runs it:

```
# Use a disposable loopback database; fixture creates/drops random roles/schema.
DYOFFICE_TEST_DATABASE_URL=postgresql://testadmin@127.0.0.1:55447/dyoffice_test \
  bash apps/web/scripts/test-document-broker-pg.sh ledger
# PG_BIN must contain existing initdb and pg_ctl. No installation is performed.
PG_BIN=/path/to/postgresql/bin \
  bash apps/web/scripts/test-document-broker-pg.sh tls
```

The ledger fixture requires the existing isolated local trust-authentication setup
(no password in the URL). The TLS recipe creates fresh temporary clusters with
trust authentication, TLS_TEST_PORT(default55448)/TLS_PLAIN_PORT(default55449),
then stops them and removes certificates/keys/data. Existing cluster settings are
not changed. Requirements: existing PostgreSQL binaries, OpenSSL, Node, Cargo and
repository Node dependencies. TLS tests authenticate the server certificate only.
