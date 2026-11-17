# Real PDF preparation, T06 and RustFS integration

This stage composes existing source, not a new export schema or invented job type.
Trusted, generated PDF fixtures run through the existing pdf-lib rotation helper,
PDF save preparation, real PostgreSQL File/Lease/Revision services and a real
loopback RustFS service. Output is read back from object storage and reopened to
assert the actual page angle. This is not OS isolation or desktop fidelity proof.

## Source and interfaces

Sources were fetched from ClassesOver/DyOffice at b9dd28f0 (the current target
baseline), rather than assuming older local copies were current:

| Existing file | Git blob |
| --- | --- |
| server/src/pdf/save-preparation.mjs | 81d09d12574057d6a66610ecd8dbd8da044354ca |
| server/src/pdf/rotation-job.mjs | bc284ed94d1e0aef9b681414547740fc1d7a3b7c |
| server/src/modules/revisions/service.ts | 96cae57f21f61d438cd1c84ff0f367b81e68a5b4 |
| test/helpers/restricted.mjs | 112dc0bd94fe0f207305a92560e557cf709a5ba1 |
| test/local-integration/pdf-save-preparation.test.mjs | e140ae39aa389920a317a55abb7784b1c4f39199 |

Paths in the table are relative to apps/web. Original migration files 0001–0022
and service dependencies are test materializations, not new publication content.
Yauzl 3.4.0 was installed in an isolated local test dependency directory because
it was missing; no repository dependency manifest/lockfile was changed.

The flow is acquire existing session lease → source download/verification → real
rotation/export/reopen → revisions.stageUpload → files.receiveUpload → explicit
revisions.commitRevision. Preparation does not commit, retry, or create job
credentials. Preserve the original commitInput after uncertain commit results;
replaying preparation would create a different upload, not recover a receipt.

## Changes

- restrictedFixture supports buildApp:false to compose real roles/auth/services
  without importing or starting HTTP/editor routes. Default remains true. Its
  original role provisioning, forced RLS and principal transactions remain intact.
- The existing seven PDF integration tests request this service-only fixture.
- New pdf-save-s3.test.mjs adds a restricted-role check and six real RustFS cases.
- No production file/revision service, HTTP route, job enabledTypes, native worker
  startup, runtime policy or isolation gate was changed.

## Fault coverage

The new cases verify output hash/size, immutable storage and actual PDF rotation;
exact receipt replay; real committed transaction followed by injected loss of
client acknowledgement; corruption of an object in a dedicated test bucket;
SQL receipt failure with metadata/outbox/quota rollback and exact retry; lease
and session revocation; and actual successful S3 publication followed by an
injected acknowledgement failure. The latter retains a receiving upload and
reserved quota, with no head advancement, receipt or outbox publication.

All metadata assertions use the authenticated principal transaction. Direct owner
queries are not used to infer absence of rows under FORCE RLS. Signing/server
credentials and test document contents are not included in logs.

The first environment failures were missing source/dependency materialization,
not claimed production bugs. Existing service logic passed the new integration
cases without a business-code change. The acknowledgement-loss tests inject a
client exception after actual success, not real network packet loss or OS crashes.

## Running and scope

With disposable PostgreSQL and loopback RustFS available, set the normal
DYOFFICE_TEST_DATABASE_URL (database name dyoffice_test or dyoffice_test_*),
DYOFFICE_TEST_S3_ENDPOINT and test-only S3 credential environment variables. Run:

```sh
node --experimental-strip-types --test --test-concurrency=1 apps/web/test/local-integration/pdf-save-preparation.test.mjs apps/web/test/local-integration/pdf-save-s3.test.mjs
```

The tests create independent databases/nonprivileged roles and per-test buckets,
then clean up. No production role or system configuration is modified. The default
HTTP fixture path is unchanged but the full HTTP suite is not claimed tested in
this partial source workspace.

Current format status: PDF rotation plus T06 is the exercised slice. XLSX has an
existing native-job/T06 executor but real host isolation remains unavailable;
PPTX has existing native/session save seams and DOCX has separate processing
paths, not verified end-to-end by these PDF tests. This is not four-format parity,
a production adapter approval, or an x86_64/openEuler isolation acceptance.
