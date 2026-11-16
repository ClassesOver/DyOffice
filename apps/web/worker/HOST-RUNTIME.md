# Experimental native Worker on Linux

The current Worker launches the original Rust XLSX engine through systemd,
without Docker. This remains an experimental backend, not a production release.

Requirements: Node 22, Linux with systemd 255+ as the service manager and cgroup
v2, a C compiler, and Rust supporting edition 2024 (locally tested: 1.93.0).
PostgreSQL 17 and Redis run as separate host services. The controller currently
requires root to create restricted transient units and transfer files through
validated process-root descriptors. Native tasks themselves use unique dynamic
nonroot users, no capabilities, private network and bounded resources.

From the repository root:

```sh
npm run build:web:native -- --with-probe
```

The build uses the original Cargo.lock with `--locked`, one compilation job,
and a separate `.dyoffice-native-build/host-target` directory. Its private
`host-manifest.json` records source and executable hashes and compiler versions.
Set `DYOFFICE_NATIVE_BINARY` and `DYOFFICE_NATIVE_SHA256` from that manifest.
The Worker no longer accepts an image ID as its execution configuration.

Required controller configuration:

- `DYOFFICE_NATIVE_WORKER=experimental`
- `DYOFFICE_DEPLOYMENT_ID`: an already bootstrapped deployment UUID
- `DYOFFICE_WORKER_DATABASE_URL`: provisioned restricted Worker role
- `DYOFFICE_BUSINESS_DATABASE_URL`: provisioned restricted business role
- `DYOFFICE_REDIS_URL`: loopback Redis URL or authenticated TLS Redis URL
- `DYOFFICE_NATIVE_BINARY`: absolute path to the compiled XLSX executable
- `DYOFFICE_NATIVE_SHA256`: its SHA-256 hexadecimal digest
- Explicit File API object-store configuration matching the API instance

Run `npm run start:web:worker` with these settings. Startup verifies migration
checksums, shared database identity, bootstrap readiness, storage and native
process launch before reporting ready. Owner and auth-role credentials must not
be provided to this daemon. Credentials are not passed to native tasks.

Each task has an independent systemd wall deadline. SIGTERM drains the controller;
SIGKILL cannot remove that deadline. Startup and periodic recovery remove only
private roots belonging to the configured deployment, older than four minutes,
whose associated unit is confirmed inactive with no main process. Active units,
fresh roots, symlinks and other deployments are preserved.

For native isolation tests, set `DYOFFICE_TEST_HOST_MANIFEST` to the absolute
manifest path and run Node 22 with `--experimental-strip-types --test` on
`apps/web/test/host-native/*.test.mjs`. Database/native integration tests also
require disposable PostgreSQL and Redis URLs. These tests do not silently skip
when required services are unavailable.

## Revision event delivery

The daemon also publishes committed revision events to
`dyoffice-revisions-<deployment UUID>`. Redis receives only `{eventId}`; file
contents, owner identities, session tokens and storage paths remain outside the
message. SQL leases and acknowledgement tokens fence competing publishers.
`published_at` records transport publication, not downstream processing.

SQL periodically republishes each event, using its UUID as the stable BullMQ
job ID. This deduplicates pending hints and reconstructs a lost Redis queue.
Consumers must be idempotent and reauthorize the underlying revision before
reading it. This T08 transport does not claim that the later search/indexing
features have been implemented. Events remain durable in SQL; retention and
consumer-specific completion must not be inferred from queue acknowledgement.
