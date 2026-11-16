# T13 bounded provider drain and owned-resource shutdown sequence

Baseline d3db4d18de52034bd42f24eaa20411f52e8f9159. Isolated preparatory increment;
app.ts and existing assembly hooks are unchanged. No real provider is enabled.

The admin pipeline now offers drain({timeoutMs}) only after permanent dispose.
Default/max wait is 35 seconds, measured on a monotonic clock. It tracks active
stream cleanup, transport, pending run dependencies and pending cancellation
identity lookups. A timed-out waiter neither frees underlying capacity nor closes
resources. A later drain may observe actual completion. New run/cancel calls are
rejected after dispose. Failed budget cleanup is sticky and prevents a clean-drain
claim even after all pending promises end; reconciliation remains an operator task.

createProviderShutdown is an explicit, unmounted ownership helper: dispose, await
drain, then closeResources exactly once. Concurrent/reentrant calls share the same
completion. Drain failure/timeout leaves resources open and returns failure; no
silent retries. Close failure also remains a failed shutdown. The timeout bounds
drain, not an arbitrary closeResources callback. The caller must independently
fence/drain HTTP session/catalog or other jobs sharing those resources. This is
not yet a complete application lifecycle and must not be wired as a substitute
for those owners' shutdown protocols.

Verification uses synthetic keys and mocked DNS/HTTPS only. Unit regressions cover
run/cancel orphans, required disposal, future-request denial, order/idempotence and
failure suppressing close. Real isolated PostgreSQL pipeline14/14 (zero skips)
includes a paused unknown-budget transaction: close callback stays blocked, short
drain times out without unlocking, new turn cannot dispatch, release commits
unknown, and only then the actual business pool ends. Injected settlement failure
prevents pool close and future drain success. No timeout is reported as settlement,
rollback or refund. Existing active HTTP shutdown regression remains in this suite.

Independent review identified an ambiguous reservation gap: reserve may commit
while its caller receives an error. A real PG injected post-commit response loss
reproduced a reserved ledger row with zero dispatch but successful drain. The
pipeline now marks reservation-call errors as sticky cleanup uncertainty, so
shutdown refuses clean completion or resource closure. It neither retries nor
refunds an ambiguous record. Because the budget adapter redacts error provenance,
this conservatively includes reserve-stage denials that may in fact have rolled
back; operator reconciliation is needed rather than inventing commit certainty.

Independent final review: real PG pipeline15/15 plus separate ambiguous-commit
reproducer1/1; unit26/26 and server TypeScript passed. Publication refreshed the
nonoverlapping target db9109baafe8dd39d667bbc8c978a233b52e3ea1; focused provider+
HTTP171/171 and browser/server TypeScript pass. App/assembly still do not await
this drain. No full application graceful-shutdown acceptance is claimed.
