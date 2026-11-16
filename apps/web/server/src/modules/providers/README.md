# Provider turn coordinator and opt-in HTTP adapter (not mounted)

This is a bounded T13 transport stage, not an enabled model service. `app.ts` does
not register these routes. T12 must supply authoritative configuration, restricted
secret resolution and transactional budget admission/settlement before mounting.
No external provider, key, or customer document is sent by this stage's tests.

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

T12 configuration/secret adapter, durable usage reservation and settlement, model
adapter parsing/SSRF policy, customer-authorized real-model tests, native editor UI
wiring, and T14 command approval/execution are separate unaccepted integrations.
The default product endpoint remains unavailable. Passing mock transport tests is
not T13 completion and is not proof of a real model response.
