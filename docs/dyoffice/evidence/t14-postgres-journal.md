# T14 PostgreSQL journal and T06 save association

Status: backend-only draft, not full T14 acceptance. Exact integration base: bc7f509deeb32ee84f7ad7e8dcbef8c0cf476fc0 (T12 backend #72 merged; no T12 UI). Depends on T12 backend migrations 0018/0019 and the T14 command safety core (#69). Adds only forward migration 0020; existing migration bytes and ACK/T05 functions are unchanged.

## Implemented boundary

- Durable deployment/user/session-scoped journal and immutable upload binding, FORCE RLS, least-privilege business access. Authentication and account/file/lease/command locking share the transaction that claims execution. Final session and live-lease deadline checks survive lock waits.
- Claims persist `unknown_outcome` before editor effects. A restarted process cannot replay an ambiguous claim. Approval deadlines use database time.
- A command's exact ready upload, editor, base revision, lease epoch, idempotency key, hash and size are bound before saving. A T06 revision-commit trigger atomically marks the command committed in the same save transaction. Undo and save serialize to one winner. Bound uploads cannot omit or replace sourceCommandId. Unbound legacy saves remain supported.
- Receipt verification joins binding, upload, revision receipt and immutable revision. It does not merely check that a revision exists. Purged files retain command tombstones and reject further mutations.
- SQL guard rejects absent/null approval identity and claim fields, immutable-claim rebinding, invalid state transitions and approval extension. No HTTP route, UI approval or provider execution is mounted.

## Verification

Actual PostgreSQL 17 and RustFS, isolated ports and randomly scoped test databases. Serial run: **62/62 passed, zero skipped** (95.6 seconds on the exact backend-only integration snapshot; earlier run 93.4 seconds), covering:

```
node --import tsx --test --test-concurrency=1 \
 test/local-integration/command-journal.test.mjs \
 test/local-integration/command-upgrade.test.mjs \
 test/local-integration/revision-commit.test.mjs \
 test/local-integration/permanent-purge.test.mjs \
 test/local-integration/orphan-reclamation.test.mjs \
 test/local-integration/t12-upgrade.test.mjs \
 test/local-integration/purge-upgrade.test.mjs \
 test/jobs/revision-ack-deadline.test.mjs
```

Run from apps/web with the repository's test database and S3 fixture variables. Includes real lock-wait lease/session revocation, concurrent duplicate claims and save/undo, cross-user/session RLS, restricted-role grants, v19-to-v20 upgrade ledger, unchanged ACK/T05 authority functions, and actual child-process exits: exit 77 after durable claim retains unknown; exit 81 before outer save commit rolls back both file head and journal.

Regression-first evidence: old SQL accepted missing digest; old receipt-only association allowed save after undo and failed atomic command completion; an earlier trigger allowed a bound upload to omit sourceCommandId. Each failed in real PostgreSQL before its corresponding fix, and is included in the final passing run. An earlier PostgreSQL-only related run passed 61/62 but lacked the required S3 service; it was rerun above with real RustFS, not treated as passing.

## Remaining gates

Full server aggregate typecheck was killed with exit 137, without compiler diagnostics. Final focused strict module TypeScript passed; pure command/executor tests passed 16/16; web boundary scan passed (993 files, zero violations). These do not substitute for aggregate CI. Independent static review found no remaining definite draft-publication blocker; the reviewer did not independently rerun the 62-test service suite.

No browser end-to-end, actual document-tool schema/anchor validation, preview/approval UI, HTTP/CSRF dispatch, provider integration or reauthentication-history recovery is implemented here. The adapter is per authenticated session; a new login does not silently inherit old-session commands. Server editorGeneration is a caller precondition, not observed editor state: trusted BrowserHost synchronous compare-and-apply remains mandatory. Receipt association proves exact upload provenance and atomic commit, not semantic equivalence between model arguments and saved document bytes. An audited real editor adapter must establish that relationship before writes are enabled.

No production deployment, background deletion or automatic command retry is enabled. T14 remains unclosed.
