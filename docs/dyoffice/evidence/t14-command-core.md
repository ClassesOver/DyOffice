# T14 command safety core — partial implementation, NOT closed

Baseline: `10793fcdc93f033c33a886434be35f3a6d83733d` on `feat/dyoffice-web`.

## Delivered

- Bounded canonical JSON validation and full command/registry approval digest.
- Explicit proposal → approval → single execution claim; no automatic approval.
- Deployment/user/session-scoped journal contract; mutation callbacks atomic and side-effect-free.
- Dispatch records `unknown_outcome` before any editor side effect. Duplicate and ambiguous commands never automatically replay.
- Batch-specific, generation-guarded undo; cancelling committed or ambiguous operations never claims rollback.
- `recordCommitted` requires an injected T06 receipt verifier; no transport success is treated as a commit.
- BrowserHost integration contract performs the final revision/lease/generation comparison immediately before a synchronous atomic editor operation.
- T13 provider output is only an untrusted candidate. Provider-generated IDs are not authenticated command identities.

## Verification

`node --experimental-strip-types --test apps/web/test/unit/command-state.test.mjs apps/web/test/unit/tool-executor.test.mjs`

16/16 pass on Node 24.22.1. Initial missing implementation tests were red before implementation. Strict targeted TypeScript compilation passed. These are pure/core tests using a **test-only in-memory journal** and a synthetic editor, plus an integration of the real service and BrowserHost executor. They do not prove durable database recovery or editor rendering.

Targeted types:

```
node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node apps/web/server/src/modules/commands/{approval,journal,service}.ts packages/browser-host/src/tool-executor.ts
```

## Mandatory integration gates / remaining work

1. PostgreSQL journal adapter with scoped RLS, atomic command-ID claims, durable commit-before-dispatch and real process-kill/restart tests. There is **no production memory fallback** and no migration in this draft.
2. Authenticated approval and outcome HTTP routes with CSRF, current user/role/lease checks inside the relevant transaction. The service is not an independent authentication boundary; `withAuthorizedCommand` must derive identity from a verified session after acquiring the principal/account/file/command locks, never request fields. No separate pre-transaction authority snapshot is accepted.
3. Trusted editor tool registry and argument-schema validation. `lookupTool` metadata is bound to approval; schema execution and anchor validation remain mandatory inside an actual adapter.
4. Synchronous compare-and-apply editor transaction, batch inverse and preview UI. The injected interface must never execute provider code, do async network effects or call generic editor undo history.
5. T06 receipt verifier must query authoritative revision/command provenance and validate deployment/owner/file/baseRevision/leaseEpoch/command identity and exact revision sha256/size inside the same authorized journal transaction. Merely finding a revision belonging to the file is insufficient. Current tests deliberately use a small synthetic verifier.
6. UI states for generating, preview/approval, applied-unsaved, saved, conflict, unknown; reload reconciliation and real-browser AI editing races.
7. Real provider/AI, external writes, and headless tools are not enabled. This slice only accepts registered live-editor document writers.

No existing T12/T13 route, workflow or migration is changed. Full repository/PG/browser suites were not run for this isolated slice. T14 remains open; draft publication is not acceptance or permission to enable writes.

## Independent review correction

The first review found that a separate authorization callback could become stale while waiting for a journal lock. Its reproduction claimed lease epoch 1 after authority advanced to 2. The independent callback was removed: the journal must provide fresh locked authority and the receipt verifier inside the same transaction. A regression now changes the lease during lock acquisition and proves both apply and undo remain undispatched. This test is a synthetic adapter check, not a PostgreSQL lock-wait acceptance test.

A separate disposal race test first reproduced a late application after executor disposal (`applied_uncommitted` instead of `conflict`). The executor now fences both new calls and pending claims permanently on dispose; the regression passes without editor mutation.
