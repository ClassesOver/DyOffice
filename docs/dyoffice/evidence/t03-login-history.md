# T03 self login-history slice

Candidate is based on PR #38 `57e72697e50d904b101c26e1ec477afd6a304e5e`. No UI files changed here.

`GET /api/v1/auth/login-history` accepts the current session cookie, no selectors, and returns `{events:[{occurredAt,outcome}]}`. Outcomes are `success`, `failure`, `throttled`; results are the latest 20 attributable records, descending by database event time with an internal deterministic ID tie-breaker. No-store applies; no IP, username, hash, request/session/user ID or password is returned. This is a summary, not a complete audit export or device history.

New failed/throttled attempts resolve the normalized username within the trusted deployment in a single INSERT…SELECT MVCC statement; only the immutable subject UUID is added. Attribution means ownership at the audit statement snapshot, not at request start or password-verification time. Uncommitted renames resolve to the old owner; committed changes resolve to the new owner or no owner. There is no account row-lock wait or separate lookup/insert gap. Unknown/invalid names stay unassigned. Successes and earlier authenticated reauthentication failures retain their actor attribution. Historical failures with only an account HMAC and no immutable actor/subject are deliberately omitted, including after username rename/reuse; no speculative backfill is performed. UI must disclose that early failed records may not be included.

Migration 0013 adds a fixed-output SECURITY DEFINER wrapper around the existing live credential guard; existing 0001–0012 are unchanged. Owner is the existing separate, controlled non-super/non-bypass migration role. Auth receives only non-delegatable EXECUTE, not raw audit SELECT. Business/worker/PUBLIC are denied; runtime admission verifies the exact function's owner, fixed search_path and privilege boundary. This protects supported authenticated service entry points; it does not claim to contain an already compromised auth SQL role, which already reads session hashes and manages credentials. No new user lookup or failure-detail response is exposed.

Verification:
- HTTP route contract: 3 expected 404 failures before implementation, then 3/3 pass.
- Web/server TypeScript: pass.
- Full Web test suite: 227 pass, 1 existing optional S3 skip, 0 failures.
- Independent security review: no identified blocker; HTTP 3/3 independently passed.
- Ten real PostgreSQL cases cover subject ownership, unknown/legacy events, rename/reuse and concurrent rename commit/rollback, known-versus-unknown locked-account responses and preserved throttle counters/audits, bounds, cross-deployment events, selector rejection, NULL/invalid input, expiry/revocation/reset/disabled/version checks, and SQL role permissions. Local PostgreSQL is unavailable, so these are NOT reported as passed; exact draft CI remains a mandatory gate.

This slice alone does not close all T03/T04 or legacy-database migration requirements.

The initial FOR SHARE implementation was withdrawn after identifying a locked-known-account response oracle; the draft includes a pre-fix expected-failing real PostgreSQL HTTP regression. The replacement preserves one audit record per rejected attempt, normal rate-limit transactions and successful-login auditing; it does not catch/drop audit errors. Exact red/green CI results remain pending until recorded.

Pre-fix real PostgreSQL evidence: commit `d02e23017290f213decc08863e66bff8b3cea271`, run `43809371517`, boundary job `133107343092`, case 97 failed after 5.42 seconds with **500 !== 401** at the status assertion (before response-body comparison). The same run was 148/150; its other failure was an expired-session fixture violating the existing `expires_at > created_at` check. The fixture now also backdates `created_at`, preserving the production constraint. The final oracle validates each request ID against its own header and compares only stable response fields. Exact post-fix PostgreSQL remains required.

Post-fix real PostgreSQL evidence: commit `53d01452854014850b777c40c4b92de6cdb9ce5d`, run `43810427170`, job `133110653242`: local integration **151/151, 0 skipped**, including all ten history cases. Locked known and unknown invalid logins both returned 401 with exactly two attributed/unassigned audit rows; both throttled variants retained 429, counters and one audit each. Subsequent jobs were 35/36 because the pre-existing upgrade test fixed its expected migration count at 12, while migration 0013 correctly made 13. Its oracle now compares the full version/checksum manifest and keeps every existing data/receipt/claim assertion. Full workflow success remains pending that test-only correction.
