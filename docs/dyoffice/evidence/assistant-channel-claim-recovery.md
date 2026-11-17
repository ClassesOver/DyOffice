# Claim acknowledgement recovery, not execution replay

Baseline: PR #134 `ad6eb63745f8fa2b2b888330913305e704942a1e`.

Design was independently reviewed before implementation. Existing channel transactions, session/file/member authority and channel row lock remain in force.

## Semantics

Owner/member claim routes optionally accept a UUID `requestId`. The existing request ledger scopes it to deployment, owner, conversation and authenticated actor; the parameter hash includes `operation: claim`, task, connection and epoch. Claim update, event and receipt persist in the same transaction. The receipt stores task/claim/epoch identifiers, not bearer credentials or tokens.

Exact replay returns the original claim only while the same task is still running under the same claim, live connection and epoch. Pause, expiry, revocation, disconnect, unknown outcome, terminal state, yielded state, a replacement claim/connection, changed parameters, or collision with another action rejects replay. Replaying a receipt does not emit another task event or grant another execution. Service reconstruction preserves this behavior; a new browser request ID cannot take over a running task.

The browser generates one ID per local attempted claim. Before any execution or native continuation it makes at most one same-ID retry for a fetch-style transport failure or explicit HTTP 5xx. It rechecks generation, executor, connection, channel and pause state before retry and validates the response afterward. Authorization/other 4xx, parsing errors, generic session-binding errors and invalid successful claim responses are not retried. Its existing attempted/running gates still prevent duplicate execution. It never retries execution or a lost result receipt.

Two lost claim responses leave the task unexecuted in the browser; disconnect records `unknown_outcome`. That status still requires reconciliation. This is not exactly-once external side effects and does not authorize sharing a request ID between independent executors. Legacy peer calls without a request ID keep fail-on-repeat behavior.

## Verification

- Client unit suite: 39 passed, 0 skipped. Missing first-ack recovery and twice-lost-reply cases were RED before implementation.
- Real PostgreSQL 17 claim recovery tests: concurrent same-ID claim, operation collision, service reconstruction, live-state/connection/epoch/deadline/revocation rejection and event non-duplication; real Fastify injection drops committed HTTP responses to verify one execution after one loss and zero executions after two losses.
- Native parent integration also drops the first committed continuation claim response. It asserts identical request/claim IDs on recovery and retains multi-round yield, unrelated user-run interleaving, scoped reverse reads and targeted native cancellation.
- Entire related real PG/HTTP/AgentLoop batch: 22 passed, 0 failed, 0 skipped. Tests use an independent disposable local cluster, stopped after the run.
- Server TypeScript and SaaS Docs TypeScript: exit 0.

A test initially attempted to alter a deadline via the restricted business role and was correctly denied. Only the test setup now uses the disposable database migration owner with scoped RLS settings to advance that deadline; runtime permissions were not broadened.

No external model, Codex runtime, browser E2E or full CLI suite was invoked. No production flags, manifests, migrations or default permissions changed.
