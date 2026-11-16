# Experimental native Worker on Linux

The current Worker launches the original Rust XLSX engine through systemd,
without Docker. This remains an experimental backend, not a production release.

Requirements: Node 22, Linux with systemd 255+ as the service manager and cgroup
v2, a C compiler, and Rust supporting edition 2024 (locally tested: 1.93.0).
PostgreSQL 17, Redis and S3-compatible object storage run as separate services.
The controller currently requires root to create restricted transient units and transfer files through
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
- `DYOFFICE_FILE_API=experimental` and `DYOFFICE_OBJECT_STORE=s3`
- `DYOFFICE_S3_BUCKET` and `DYOFFICE_S3_REGION`, matching the API's private bucket,
  with standard AWS SDK credentials/role; optionally `DYOFFICE_S3_ENDPOINT` and
  `DYOFFICE_S3_FORCE_PATH_STYLE`

The controller refuses missing or non-S3 storage before opening database or
queue connections. `local-dev` remains available to a standalone API under one
service account, but cannot be shared with this root controller: its `0600`
objects would be unreadable by a nonroot API. Configure both services for the
same S3 bucket when enabling native job execution.

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
require disposable PostgreSQL and Redis URLs. The daemon tests in
`npm run test:web:native-jobs` also require a loopback S3-compatible service via
`DYOFFICE_TEST_S3_ENDPOINT`, `DYOFFICE_TEST_S3_ACCESS_KEY` and
`DYOFFICE_TEST_S3_SECRET_KEY`; each test creates and removes its own bucket.
Preserve these test variables when running the suite as root. These tests do
not silently skip when required services are unavailable.

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

## Isolated Sheets package gateway

The Sheets runtime no longer imports the parser/planner into the API process.
Build `node apps/web/server/sheets/build.mjs` to produce both `gateway.mjs`
(for direct library tests) and the self-contained `gateway-process.mjs` runner.
Production-path execution only uses the runner inside the existing systemd
sandbox, with the same dynamic UID, private root/network, dropped capabilities,
cgroup limits, wall timeout and process-group termination as the Rust engine.
There is no non-isolated fallback. Missing root/systemd, bundle or dependencies
must fail startup before Sheets is advertised as editable.

Optional `DYOFFICE_XLSX_GATEWAY_RUNNER` selects a trusted deployment-installed
runner file. The old `DYOFFICE_XLSX_GATEWAY_MODULE` setting is rejected instead
of executing arbitrary in-process modules. Startup hashes the Node executable
and runner; each invocation verifies the hashes before copying read-only files
into its private root. The trusted Node interpreter can be up to160 MiB; the
Rust executable bound remains64 MiB. No user/request supplies either path.

Package reads and save plans receive request cancellation; shutdown aborts and
awaits both Rust and Node calls. Native admission is bounded and the host's two
slots are shared within the controller. Workbooks, total staged parts and output
remain bounded to32 MiB; request JSON is bounded to4 MiB, plans to256 unique safe
part names. The independent32 MiB JSON result bound includes base64/escaping
overhead: a near-limit plan can be explicitly rejected rather than allocated
without limit. Existing256 MiB ZIP inflation limits are unchanged inside the
sandbox and its512 MiB memory limit still applies.

Tests in `test/host-native/gateway.test.mjs` require a real root/systemd host.
They cover actual package/plan execution, cancelling an active Node process,
and retained UID/root/credential policy. Local protocol/service tests do not
substitute for those tests. In the current non-root, non-systemd workspace they
are blocked with `HOST_BACKEND_UNAVAILABLE`; this change remains unverified at
the real-host gate until the existing native-worker CI runs them successfully.

