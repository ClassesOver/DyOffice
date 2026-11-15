# Prototype store update consistency and failure recovery

Baseline: `a64107fc13b5728cd375819e317282a4b8cdcd2d`. This is a single-instance development-store correction, not T06 revision transaction completion.

## Confirmed defect

`store.update(async next => { await Promise.resolve(); next.preferences.theme = 'dark' })` previously returned successfully with memory reporting `dark` while `state.json` retained `system`. `change(next)` returned a Promise that was not awaited before serialization. The regression reproduces the disagreement against actual disk bytes and then reopens the store.

## Contract and minimal fix

Update mutators now explicitly support synchronous or asynchronous completion. The existing instance-local queue waits for the callback before serialization. Throw/rejection aborts its cloned snapshot and propagates to the caller; the queue recovers for subsequent updates. State is still published only after rename succeeds. Current application callers are four awaited `store.update` calls with synchronous callbacks, and remain compatible.

Callbacks are trusted internal code, not request-supplied functions. All changes must finish before their returned Promise settles; retaining `next` for background mutation is unsupported. They must not recursively await another update on the same queue. This change is not a distributed transaction, request cancellation mechanism or external-effect rollback.

## Evidence

`node --test apps/web/test/store.test.mjs`: five tests pass. The async consistency test failed on the original code with persisted theme `system` versus in-memory `dark`, then passed after the await fix. Additional real filesystem fault injection creates a directory at the temp-file path to force EISDIR, verifies committed memory/disk remain unchanged, removes the fault and proves queue recovery. Tests also cover callback throw/rejection and asynchronous queue ordering.

Combined `node --test apps/web/test/*.test.mjs`: 32/32 passed against the baseline's server/test snapshot plus this change. Independent security review reran all five focused tests and found no blocker. Root monorepo test remains blocked by missing i18n Vitest in the Web-only install; no full-monorepo pass is claimed.

The existing legacy-Web CI glob includes this new top-level test. Power-loss fsync, multi-process directory ownership, database CAS, revision history, leases and idempotency are NOT provided or verified. No DOCX files, public routes or capabilities changed.
