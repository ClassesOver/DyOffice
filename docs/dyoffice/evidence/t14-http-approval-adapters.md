# T14 optional HTTP, approval panel and T06 save adapters

Base: #73, ca6eba591ad60007f68ddd31a93c20af67aa5e6f. This is a separate, unmounted integration slice. No migration, role, app.ts, T12 Shell/Home/Settings or native editor file is changed.

## Design decision

The user delegated implementation choices and requested safe parallel progress. Use the existing session/CSRF and PostgreSQL authorization contracts, with an explicit UI decision before a separate execute action. Do not expose a generic method-dispatch endpoint or supply approval functions to provider transports. Do not adapt generic editor undo into an atomic batch inverse.

- Optional `registerCommandRoutes` has a fixed action allowlist, strict body/query schemas and bounded payload, session authentication and same-origin CSRF before service construction. `createCommandRequestFactory` constructs a fresh durable journal per request; its default empty trusted tool registry denies every proposal. No app registration is added.
- Same-origin command client carries CSRF, never retries execution, validates the complete returned envelope by bounded JSON value equality (not key order), and fences disposal during CSRF/network/body waits.
- Standalone DOM approval panel uses text nodes only for model parameters. Explicit review checkbox then approval, followed by a separate execute button. Duplicate requests and late disposed callbacks cannot enable another dispatch. Ambiguous errors stop at unknown outcome; no automatic retry.
- Save coordinator serializes a snapshot, checks editor generation before and after staging, binds exact upload/hash/size/idempotency key, then invokes the real SessionFileHost T06 save. Success additionally requires a non-base revision and a mandatory durable-command verifier querying the exact committed journal receipt. Lost binding replies retry the same immutable binding. Lost commit replies invoke SessionFileHost.reconcile, retaining the exact original tuple rather than staging or applying again.

## Verification and discovered regressions

- Core plus new HTTP/client/DOM/coordinator tests: **34/34 passed**, zero skip.
- Actual PostgreSQL, Fastify injection and real SessionFileHost adapter: **4/4 passed**. These are real session, owner, lease, migration and T06 transactions, not a browser UI run. Cases cover unapproved execution, cross-owner approval, generation/epoch mismatch, one-use claim, exact upload binding and lost-response reconciliation to committed journal outcome.
- Focused strict TypeScript passed; web boundary check scanned 997 files, zero violations.
- Red-before-green checks found and fixed JSONB envelope key-order rejection, dispose during asynchronous response-body/commit waits, invalid direct commitSave retry while SessionFileHost already held a pending commit, and false success when a definite rejected save reconciled to an unchanged base with identical bytes. The final regression rejects both that old base and unrelated same-byte revisions; it requires the command-specific committed receipt.

## Unfinished / deliberately disabled

This does not complete T14. The optional route/panel/client/coordinator have no production composition and no automatic write enablement. No actual native editor AtomicEditorTools adapter is available: existing generic undo and per-operation mutation methods cannot prove all-or-nothing batch effects or exact batch inverses. A real trusted adapter must validate tool schemas and stable selection anchors, advance generation for every edit/undo/reload, serialize the exact intended effect, and preserve newer dirty generations after an older snapshot saves. The coordinator does not itself alter editor dirty state.

The panel's DOM tests use jsdom, not a real browser or desktop editor. Real browser approval/edit/save/reload and full native system tests remain unverified. The full repository/aggregate build was not rerun for this isolated additive slice; targeted checks do not replace it. No claims about complete four-format tool coverage, semantic document-effect verification, recovery across new login sessions or production availability are made.
