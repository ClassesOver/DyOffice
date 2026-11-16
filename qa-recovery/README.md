# Disposable command-recovery QA

This manually invoked harness uses the current recovery API. It is not a production
route, deployment service, editor adapter, compatibility layer, or CI requirement.
It preserves the useful QA scenarios from PR #86 after its product changes were
integrated by #101. No retired product implementation is copied back.

## Run

Install the repository dependencies. Start dedicated, disposable PostgreSQL and
S3-compatible services bound to loopback. Supply all of:

- `DYOFFICE_TEST_DATABASE_URL`: a loopback admin connection to `dyoffice_test` (or
  `dyoffice_test_<suffix>`). The fixture creates and drops its own database/roles.
- `DYOFFICE_TEST_S3_ENDPOINT`: a loopback service URL.
- `DYOFFICE_TEST_S3_ACCESS_KEY` and `DYOFFICE_TEST_S3_SECRET_KEY`: disposable keys.

Use only synthetic credentials and data. The S3 fixture creates a unique test
bucket and removes its objects/bucket afterward. **Never point this at production.**

```sh
QA_RECOVERY_SELFTEST=1 bash qa-recovery/run.sh
# Optional manual browser session, separately from automated acceptance:
bash qa-recovery/run.sh
```

The wrapper builds the current browser recovery module and fails if the build or
selftest fails. Selftest performs no browser automation. It verifies a real S3
DOCX import, PostgreSQL journal, same-session login, scoped durable observation,
lookup response projection, invalid-digest fence, CSRF/origin rejection, new
same-owner session rejection, concurrent initial visits sharing one command, logout
revocation, abandonment whose committed response is lost,
idempotent retry, unchanged file head, and serving the freshly built UI asset.

The optional manual session binds only `127.0.0.1:18767`. Open
`http://localhost:18767/qa/recovery/login`, using synthetic `alice` and the test
password from `apps/web/test/helpers/identity.mjs`. Logging out invalidates the
command's session; a new login must not recover its command. The page deliberately
does not load the native editor or claim an actual editing/save round-trip.

While running, write `lost` or `stall` to `qa-recovery/mode` to simulate a lost
response after a committed abandonment or a 10-second delayed response. `lost`
fires once per server process. Delete the mode file to restore normal responses.
Create `qa-recovery/stop` for orderly shutdown. `qa-recovery/report.json` contains
only synthetic IDs, operation counts, journal state and current revision, never
session tokens. Start a fresh run for another synthetic unknown-outcome command.
The wrapper clears stale stop/mode controls at startup. Generated controls,
reports and logs are not source artifacts.

All registered cleanup operations are attempted even after setup or test failure;
original and cleanup errors are retained together. Unexpected process termination
may still require cleanup of the dedicated disposable service volume.
