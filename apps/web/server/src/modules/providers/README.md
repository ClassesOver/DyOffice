# Provider turn coordinator (not mounted)

This module is a bounded T13 server foundation, not a configured provider API.
The local app must stay default-deny until T12 supplies authoritative configuration,
restricted secret resolution, admission/budget policy, and real integration tests.

`authorize(token, modelId)` must derive identity from the current credential, check
AI scope and the current enabled configuration, and return
an opaque permit. In this foundation it must not reserve budget or perform irreversible
side effects: late completion after cancellation has no settlement hook. Transactional
budget reservation/settlement is a required integration gate before mounting routes.
It must not trust an owner or provider URL from request JSON.
`revalidate(token, permit)` must fail on credential revocation or config revision changes.
The adapter receives the permit, never client routing overrides; a T12 adapter must
resolve secrets within a restricted callback. Identity/config state stays external.

This coordinator bounds active turns, scopes cancellation to deployment/user/session,
revalidates before model dispatch and each output, strips provider error details, and
imposes an absolute caller deadline even when a provider ignores AbortSignal.
Uncooperative dependencies retain their capacity slot until they settle; capacity
exhaustion then fails closed rather than admitting more orphan work. Operational
recovery for a permanently stuck adapter requires replacing that adapter/process.
No route, real provider, secret store or durable usage ledger is enabled here.

The coordinator also caps cumulative normalized JSON event payload bytes per turn
(default 4 MiB, configurable with `maxOutputBytes`), measured as UTF-8. The event
that would exceed the budget is not emitted; cancellation and cleanup follow the
normal failure path. This is a payload resource limit, not token billing, SSE wire
framing, or a replacement for provider-side generation limits.
