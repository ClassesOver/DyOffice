# T00 final source/runtime evidence reconciliation

Date: 2026-11-16. This record reconciles the original T00 engineering scope, not production or four-editor feature acceptance. Preserve `t00-closeout.md` and `t00-engineering-gates.md` as historical snapshots: their unpinned runtime and incomplete scanner observations predate the subsequent integrated changes.

## Source and completed execution

PR #32 head `157cc1c3549cdc2e91371b7b8ee2f1e4a90c7f89` is integrated by merge `9b2c7aa587ab403935a46ae1f43ea8e326c84547`. The [Web gate run 43815137000](https://github.com/ClassesOver/DyOffice/actions/runs/43815137000) completed successfully, including boundary-check, native-worker and native-docx. The long original Docs regression is no longer pending. This is an exact PR execution result, not a fresh rerun of the target merge or any subsequent documentation candidate.

The artifact records test-merge `65a81a49cdeba3b16e9349250fbac08eb88ec586`, not the PR head. Source review established its tree equals head tree `0497e30318ef2776b800ad194631a10dfa060148`. This pass also rechecked GitHub compare from head to both the test merge and actual merge: each is one commit ahead with an empty file diff and no truncation. Retain the recorded commit distinction when citing results.

## Independently downloaded artifact verification

The following ZIP files were downloaded again from GitHub's artifact API. Local SHA-256 matched the declared GitHub digest in every case. Each JSON records the same test-merge source above.

| Artifact | ID | ZIP SHA-256 |
| --- | --- | --- |
| host-runtime-boundary-check | 14203175352 | ac87ad23552caf1e1476d8733102d33a6cb3afe1426183d6697a712812e2d081 |
| host-runtime-native-docx | 14202632869 | 3b14a6ba34d43ddf78005fcf1e2b60f761867e4dffc81010bc87a443e7f4abf8 |
| host-runtime-native-worker | 14201799497 | 2aeadc5c48e1a135a6aafc88d33a2d3f636afa12516254e1a47a9bb0c60166fe |
| t00-small-api-baseline | 14203275027 | 83f0e0fecaf11be50960bf5bdfebe69edd2cac4ef19f6d7e90f9d863d7ea3ad8 |

All three runtime reports contain Node 22.23.5 with executable SHA-256 `2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd`, installed PostgreSQL 17.12 and Redis 7.0.15 package versions, and running versions `170012` / `7.0.15`. Worker additionally records Rust/Cargo 1.93.0. Worker and boundary reports record RustFS 1.0.6, verified archive SHA-256 `4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea`, binary SHA-256 `250be6671ba447e93c1da14b6f042038aae913811990c6f3aef7efde463fec7f` and readiness true. DOCX does not claim a RustFS probe.

Ubuntu, kernel, glibc and runner-image observations are not immutable OS pins. The older PostgreSQL 16/MinIO container profile has separate digest locks documented in `t00-ci-runtime-lock.md`; it is not the host PostgreSQL 17/RustFS profile. Production API/worker images and production SBOM remain T23 deliverables.

## Original T00 disposition

- Browser Node/Electron negative regressions and source boundary gate exist; the integrated CI source graph has 600 files with zero violations. Historical RED cases distinguish dependency boundary violations from failed installation.
- All 151 discovered tool declarations have reviewed proposed placements. This is a declaration inventory, not implemented or authorized live tooling.
- Four editor IPC inventory contains 538 classified members; compatibility inventory locks 84 inputs. Signatures/ABI/font behavior and each implemented adapter still require their later task acceptance.
- Integrated Web tests record 229 passes and one optional skip; minimum build/HTTP and real host gates succeeded. A skipped optional S3 case is not a pass; the separate real storage suite supplies different coverage.
- Source-gate, runtime-lock and integration commits already exist. Do not replay the old staged T00 directory onto the new stack.
- The small API baseline now has real measurements, detailed separately. It does not establish section 8 server-only latency, representative capacity, endurance or recovery targets.

## Bounded acceptance and publication

The original five T00 baseline/inventory/build items are accepted on the reviewed integrated source above. Independent review verified the four archive hashes, all 558 performance outcomes and 18 statistical rows, source identity, final step bindings and scope boundaries. This documentation change records that completed baseline, not a new product implementation or a new CI execution.

Repository Actions remains intentionally disabled; do not re-enable it or attribute #32 results to this documentation commit. No legacy-data conversion is required by current scope; fail-closed old-ledger protection remains required. T23 production packaging and section 8/T25 capacity, endurance and recovery remain unaccepted. Every later implemented adapter and AI/MCP entry point still needs its own authorization and functional acceptance.

## Final step binding

[boundary-check job 133125360838](https://github.com/ClassesOver/DyOffice/actions/runs/43815137000/job/133125360838) completed successfully. Steps 12/13/22/24/25 bind the tool, compatibility, IPC and browser boundary claims; step 27 binds minimum build/HTTP; step 35 binds legacy Web results. This pass fetched the final job logs and step summaries, not only artifact JSON. All three final jobs report completed/success.
