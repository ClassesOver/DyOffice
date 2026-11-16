# T11 private rotation job seam

Base d7abec1f. No T10 files changed. This is a local byte-processing increment, not a T06 save integration.

The existing T06 route/service requires authenticated source access, active editor lease, base revision, staged upload, validated bytes and idempotent commit. Calling the rotation core directly from a new permissive save endpoint would bypass those invariants, so this change deliberately does not expose an endpoint.

`createPdfRotationJob().execute(Buffer, requestJson, signal)` accepts exactly version 1, action rotatePages and an operations array. There are no path, credential, file or revision fields. It snapshots bytes, records source SHA256, limits request UTF8 bytes, permits one active call per instance without queueing, bounds input/output bytes and structurally reopens produced PDF. It returns bytes, inputSha256, sha256 and size only, never a durable save acknowledgement. Parser error details are not forwarded. Errors release busy state. Cancellation suppresses a result at await boundaries.

Tests began RED with missing implementation. Final new job suite 7 cases covers real rotation/digests, schema and UTF8 request bounds, overlapping jobs, cancellation before/during execution, caller buffer mutation, parser error sanitization, safety refusal codes and input limits. The original six plus rotation ten were independently run 16/16 before test-only boundary additions; final job seven independently rerun. Combined PDF suite 36/36; ordinary Web 297 passed / 1 optional S3 skip; boundary 999 files / 0 violations; syntax passed.

An earlier combined verification launched ordinary Web and the PDF suite concurrently. PDF render test process exited with only test-file failure in the default reporter; ordinary Web passed. Cause was not established. That failure log is retained; the later standalone serial PDF run passed 36/36. No product workaround or test suppression was applied and the failed run is not counted as passing.

## Explicit limits

- No HTTP registration, UI, permission grant, DB/schema change or T06 stage/receive/commit call. Source digest is an identity check, not authority: a trusted controller must bind it to an authorized file and exact base revision.
- No OS process, global admission or CPU/RSS/time enforcement. Busy is per instance. Abort cannot interrupt synchronous/native parsing. Output size is checked after allocation.
- Structural reopen is not PDFium/desktop fidelity acceptance. Original rotation still conservatively rejects forms/signatures; genuine encrypted/signed corpus remains untested.
- JSON has strict field/schema validation, but JSON.parse accepts duplicate keys. This is not a signature/canonical JSON protocol.
- No full aggregate or browser acceptance rerun; no T11 closure claim. Rollback removes the unused helper/tests; no data migration.

Next step: trusted controller orchestration under isolated worker resource policy, authenticated exact-revision read, then existing T06 lease/upload/commit fence with hash verification. Do not treat this helper output as saved.
