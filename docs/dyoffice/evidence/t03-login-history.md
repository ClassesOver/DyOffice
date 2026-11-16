# T03 self login-history slice

Candidate is based on PR #38 `57e72697e50d904b101c26e1ec477afd6a304e5e`. No UI files changed here.

`GET /api/v1/auth/login-history` accepts the current session cookie, no selectors, and returns `{events:[{occurredAt,outcome}]}`. Outcomes are `success`, `failure`, `throttled`; results are the latest 20 attributable records, descending by database event time with an internal deterministic ID tie-breaker. No-store applies; no IP, username, hash, request/session/user ID or password is returned. This is a summary, not a complete audit export or device history.

New failed/throttled attempts resolve the normalized username within the trusted deployment and hold a user SHARE lock until audit transaction commit; only the immutable subject UUID is added. Unknown/invalid names stay unassigned. Successes and earlier authenticated reauthentication failures retain their actor attribution. Historical failures with only an account HMAC and no immutable actor/subject are deliberately omitted, including after username rename/reuse; no speculative backfill is performed. UI must disclose that early failed records may not be included.

Migration 0013 adds a fixed-output SECURITY DEFINER wrapper around the existing live credential guard; existing 0001–0012 are unchanged. Owner is the existing separate, controlled non-super/non-bypass migration role. Auth receives only non-delegatable EXECUTE, not raw audit SELECT. Business/worker/PUBLIC are denied; runtime admission verifies the exact function's owner, fixed search_path and privilege boundary. This protects supported authenticated service entry points; it does not claim to contain an already compromised auth SQL role, which already reads session hashes and manages credentials. No new user lookup or failure-detail response is exposed.

Verification:
- HTTP route contract: 3 expected 404 failures before implementation, then 3/3 pass.
- Web/server TypeScript: pass.
- Full Web test suite: 227 pass, 1 existing optional S3 skip, 0 failures.
- Independent security review: no identified blocker; HTTP 3/3 independently passed.
- Eight real PostgreSQL cases cover subject ownership, unknown/legacy events, rename/reuse and concurrent rename, throttle, bounds, cross-deployment events, selector rejection, NULL/invalid input, expiry/revocation/reset/disabled/version checks, and SQL role permissions. Local PostgreSQL is unavailable, so these are NOT reported as passed; exact draft CI remains a mandatory gate.

This slice alone does not close all T03/T04 or legacy-database migration requirements.
