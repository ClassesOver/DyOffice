# T00 host-service runtime admission (candidate)

Scope: the actual host service stack introduced by PR #32 (`f0fbb751`), not the
older PostgreSQL 16 / MinIO container jobs covered by PR #36. This change does
not modify that PR or claim a production release, frozen runner, or complete T00.

## Locked inputs and admission

- Node 22.23.5 Linux x64: executable SHA-256
  `2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd`,
  derived from the official `nodejs.org/dist/v22.23.5/` archive whose SHA-256 is
  `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`.
  Every host job checks the executable before installing dependencies.
- PostgreSQL server/client: `17.12-1.pgdg24.04+1`; Redis server/tools:
  `5:7.0.15-1ubuntu0.24.04.5`. These were the packages actually installed by
  PR #32's successful job `133084781237`. APT must authenticate repository
  metadata and install those exact versions; no latest fallback or disabled
  signature checking. PGDG's official key fingerprint is checked against
  `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8` before repository use. Ubuntu
  dependencies remain authenticated distribution packages, not frozen packages.
  If versions disappear, CI fails and requires a reviewed lock update.
- Running PostgreSQL must report `170012`; running Redis must report `7.0.15`.
  Installed package checks alone do not satisfy service admission.
- RustFS 1.0.6: retain the official release ZIP and its existing SHA-256
  `4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea`.
  Admission rechecks the ZIP, compares the extracted executable to the installed
  executable, and checks actual readiness. Existing integration tests exercise
  S3 operations and isolation, not just the health response.
- Native job: Rust/Cargo 1.93.0, original Cargo.lock and `--locked` build.
  Existing native build manifest records source and executable SHA-256.
- Ubuntu 24.04, Linux x64, systemd >=255 and cgroup v2 are admission conditions.
  Kernel, glibc, compiler, runner image version and service executable hashes
  are observations in the uploaded manifest. They are NOT immutable pins.

## Evidence handling and acceptance

`.dyoffice-runtime-evidence/host-runtime.json` records selected nonsecret facts,
never process environment, service URLs, passwords, cookies, or native payloads.
Each of the three host jobs uploads its own artifact after actual admission.
All existing local-account, real PG/Redis/S3, browser, native isolation and
original editor/engine regression commands are retained. Fresh exact-SHA remote
CI is required; unit fixtures alone are not service acceptance.

Local tests: admission drift, optional-profile failure, package/key pins, and
three-job coverage pass; official Node binary passes early admission. Real
service results remain pending until this candidate's remote CI finishes.

## T00 versus T23

The original T00 contract requires locked dependency/environment evidence. The
acceptance matrix explicitly separates disposable test services from T23's
production deployment package. This host stack has no Worker image to pin:
`HOST-RUNTIME.md` replaces the image configuration with a validated host binary.
Therefore T00 should record this choice and the tested host ABI, not invent an
unbuilt image or claim production packaging.

Still separate: T23 production deployment/signed release/SBOM/offline artifacts;
security review of the root controller and host service policy; full reproducible
OS/toolchain distribution. Before combining #36 with this stack, retain every
new job, extend its workflow inventory, and re-run the combined tree. A green
legacy-container job cannot stand in for these host service tests.
