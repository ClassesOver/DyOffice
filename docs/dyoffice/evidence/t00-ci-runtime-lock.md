# T00 existing-CI runtime locks

## Scope

Candidate based on PR #33 `b43779c9aa20e1500e1b6a84397039e53f4d03c0`.
This change locks the ten **existing DyOffice CI workflows**, not a production
API/worker image. It does not modify #32's separate host-service workflow.
The existing `packaging/docker/Dockerfile` is an upstream GenOffice desktop
headless conversion utility, not a DyOffice server deployment manifest.

## Verified inputs

- Node **22.23.5**, the official 2026-11-11 security release. The previous CI
  happened to resolve `22` to cached 22.23.4; freezing that older security patch
  is not the intended fix. [Release](https://nodejs.org/en/blog/release/v22.23.5),
  [publisher checksums](https://nodejs.org/dist/v22.23.5/SHASUMS256.txt).
  Linux x64 archive SHA-256 is
  `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`.
  After verifying that downloaded archive, its `bin/node` hashes to
  `2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd`.
  CI checks both actual version and executable bytes before dependency install.
- PostgreSQL 16: official `library/postgres` index
  `sha256:dd2bf3ce2dc83a81674cf7f217fcfd8a5009a4b325dda5b843bfee82a06cff6f`.
- Existing Bitnami legacy MinIO tag: index
  `sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20`.
  This pins the already-used CI dependency, not a recommendation to adopt
  a legacy distribution for production.

Registry evidence was fetched on 2026-11-16 from publisher Docker Hub metadata
and `registry-1.docker.io`. Each raw manifest response was SHA-256 hashed and
matched its `Docker-Content-Digest`; Linux amd64 child digests are recorded in
`tools/dyoffice/runtime-lock.json`. No digest was inferred from search snippets.
Node evidence uses the publisher HTTPS checksum; this is not a claim of having
verified a release signature or completed a vulnerability/security audit.

## Enforcement and real-service acceptance

`runtime-lock.mjs --runtime` checks the running Node executable. `--check` and
its tests check all reviewed DyOffice workflow declarations, exact Node patch,
required runtime checks, service image references and runtime-change triggers.
The `.nvmrc` default follows the same security release. Guard tests do not install
services and do not substitute for PostgreSQL or object-store integration.

The changed workflows trigger on `tools/dyoffice/runtime-lock*`, ensuring the
pin change runs all existing PostgreSQL account/login/password/session checks,
actual MinIO health and S3 lifecycle checks, Web build and original UI/PPTX gates.
Do not merge until those jobs pass on the candidate's exact commit. Inspect
service startup/pull logs for the pinned references; do not count a skipped
service test as success. No local Docker engine is available to this reviewer.

Local evidence before publication:

- Existing unpinned workflows fail the new declaration guard.
- After the patch, guard tests pass 4/4; all ten YAML files parse.
- Actual downloaded, checksum-verified Node 22.23.5 passes executable admission
  and the 4/4 tests. The executor's different Node 24 is correctly rejected.
- Real services and aggregate existing test suites remain pending exact CI.

## Explicit remaining boundary

`ubuntu-24.04` narrows runner selection but is **not an immutable OS image**.
Runner patch levels, apt-installed client packages, browser OS dependencies,
upstream general `ci.yml`, native toolchain ABI, and production deliverables
are not frozen by this candidate. T00 must not be marked fully closed solely
because these selected CI artifacts are pinned.

When #32 is integrated, separately adapt its actual docker-free host runtime:
PG17/Redis apt package versions and hashes, Node, Rust 1.93.0, and RustFS 1.0.6
(the latter already has a verified archive hash). Preserve its real service,
restricted-role, job and TLS browser tests. Do not copy old PG16 containers into
that architecture or misrepresent a package-version pin as a full apt snapshot.

Reviewer-driven regression: conditional/ignored guard steps, job-level skipping, and moving the guard after commands or into another job are rejected. The checker deliberately accepts only the reviewed literal YAML layout, not arbitrary YAML syntax; new layouts must be reviewed.
