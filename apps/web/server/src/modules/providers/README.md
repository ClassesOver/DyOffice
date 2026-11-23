# Provider turn coordinator and opt-in HTTP adapter

## SaaS shared models

The local account entry point now uses `{mode: 'shared'}` by default. SaaS
administrators save provider, model, API key and base URL in global settings;
authorized personal accounts use that same configuration. No external profile
file or per-user/per-revision credit provisioning is required for this mode.
Configuration revisions remain internal concurrency and revocation fences.

`shared_provider_catalog()` returns current enabled chat entries with saved
credentials. `shared_provider_dispatch()` commits a session-bound, unique turn
receipt before networking; `shared_provider_secret()` releases the encrypted
credential once for that receipt. Runtime roles receive only function EXECUTE,
and cannot read or change the dispatch table directly. An ambiguous dispatch is never retried. A confirmed HTTP 400/422 output-budget
rejection can retry once at the reported lower limit, under a new receipt. Shared mode does not represent per-user billing.

The server resolves a public HTTPS destination from administrator-saved metadata
and uses the existing DNS-pinned TLS transport. This path currently implements
the OpenAI Responses API by default for all supported OpenAI-compatible providers,
including DeepSeek. A base URL such as `https://gateway.example/v1` resolves to
`/v1/responses`. For a chat-only upstream, save the full URL ending in
`/chat/completions`. The gateway does not retry a failed request under another
protocol. Both protocols start with the
desktop output budget (32,768 by default); lower discovered limits are cached
per endpoint and model for the lifetime of the gateway. A length stop after
generation is surfaced to the client and never triggers dispatch replay. Native
Anthropic and Gemini protocols require their corresponding transport adapters.
The administrator's **测试连接** action sends a short real request through this
same path and returns only success/failure. Browser code never receives API keys.

The older explicitly supplied `{profiles: [...]}` mode below retains its existing
separate per-user budget and deployment provisioning behavior.

The local account runtime mounts personal assistant routes only when explicitly
given a trusted profile list. The synthetic and fixed administrator probes remain
separate. Tests use synthetic credentials and a simulated upstream.

For local operation, apply migrations and reprovision the restricted runtime
roles. Set `DYOFFICE_PROVIDER_GATEWAY_PROFILES` to a trusted JSON file containing
an array of profiles with `deploymentId`, `entryId`, `revision`, `providerId`,
`model`, `baseUrl`, `endpoint`, `allowedIpv4`, and `maxOutputTokens`. The profile
pins an OpenAI-compatible chat endpoint and its allowed IPv4 addresses. The key
lives in the administrator's global configuration and requires the existing
global configuration keyring. Provision `provider_budget_accounts` separately
for each user and model configuration revision using the migration owner. The
gateway does not grant default credit. Changing global configuration invalidates
old profiles and requires matching current profiles and budget accounts.

## Authority contract

`authorize(token, modelId)` derives identity from the current credential, checks
AI scope and enabled configuration, and returns an opaque permit. It remains a
read-only lookup: a late completion after cancellation has no settlement hook.
Never reserve budget in this callback until a durable settlement protocol exists.
`revalidate(token, permit)` rejects credential revocation/config revision changes.
`stream` receives only the permit and projected request, never client URL/key fields.
An eventual T12 adapter must resolve secrets inside a restricted callback.

## HTTP contract

`registerProviderRoutes` is explicit opt-in and requires sessions, CSRF and a turn
runner. POST `/api/v1/ai/turns` accepts only `{turnId, modelId, request}` where request
contains `{system, messages, tools}`; cookies and CSRF are checked before parsing/
dispatch. The identifier selects server configuration, never a provider URL.
POST `/api/v1/ai/turns/:id/cancel` is bodyless and uses the same cookie/CSRF boundary.
Provider errors are reduced to one generic `error` frame followed by one `done`.
Successful responses contain one `done`; disconnected peers receive no guarantee
of a terminal frame. The browser maps either terminal form to exactly one onDone.

The coordinator limits active turns and absolute duration, revalidates every output,
and scopes explicit cancellation by deployment/user/session. HTTP disconnect also
aborts during authority lookup. Uncooperative dependencies keep their capacity slot
until settlement; this avoids unbounded orphan provider work. Transport output is
limited to 8 MiB by default, in addition to the coordinator's 256 KiB event bound.
Backpressure is awaited during events, not beyond termination for the two fixed
small terminal frames. No durable or billing budget is implied by these limits.

## Browser / T14 boundary

`createSseAgentTransport` keeps AgentTransport's stream/cancel/callback signatures.
An integration may opt into `modelId` and `getCsrfToken`; both dispatch and cancel
carry the proof. Cancellation before proof resolution sends no prompt. Unknown
usage remains absent, never a fabricated zero; malformed usage is rejected.
Complete tool events project only `{id, name, input}`. These remain untrusted
candidates. Neither HTTP nor browser transport approves or executes document tools.
T14 must choose a trusted command ID, bind current file/version/generation/lease,
canonicalize argument hashes, and obtain approval before execution.

## Remaining gates

The local DOCX and XLSX assistants reuse AgentLoop and the existing editor skills.
Personal SKILL.md files are resolved from the original session and explicitly
attached to a turn by the user. Only read tools are exposed in the local assistant;
document edits remain subject to T14 approval. PPTX and PDF do not yet have a
supported local assistant host. Customer-authorized real-model testing and
production rollout remain outstanding; the default turn endpoint is unavailable.

## Coordinator resource bounds

Cancellation identity lookups have a separate configurable deadline (`cancelTimeoutMs`,
default 10 seconds) and at most `maxActive` outstanding lookups. A stalled lookup
retains its slot until settlement, even after its caller times out; late identities
cannot cancel turns. Identity adapter errors are redacted. These are local process
limits, not distributed rate limiting or a substitute for route authentication.

The coordinator also caps cumulative normalized JSON event payload bytes per turn
(default 4 MiB, configurable with `maxOutputBytes`), measured as UTF-8. The event
that would exceed the budget is not emitted; cancellation and cleanup follow the
normal failure path. This is a payload resource limit, not token billing, SSE wire
framing, or a replacement for provider-side generation limits.

## Explicit admin pipeline foundation

The T12-backed administrator budget/credential composition from #74/#76/#78
continues to default to admin-only. Personal consumption uses separate SQL entry
points tied to the live session, current enabled revision, owner budget, and a
one-use dispatch credential. Ordinary sessions receive no general access to the
secret table. No monetary or real-provider guarantee follows from simulated tests.
