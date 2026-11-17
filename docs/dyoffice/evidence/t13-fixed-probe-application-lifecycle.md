# T13 default-off fixed provider probe and owned-work application drain

Baseline 56342af11c73a47b6547a4667a6d8826158ffd5a. No deployment or real-provider
request performed. All keys, prompts and provider responses in verification are
synthetic, with mock DNS/HTTPS and isolated PostgreSQL.

## This probe is NOT offline

The new optional trusted startup object `adminProviderProbe: { profiles }` is
absent by default. If an operator supplies real valid profiles, sealed credentials
and budget, the probe is capable of real outbound provider requests and charges.
It never runs automatically. The pre-existing `adminAiSyntheticProbe` is a separate
offline diagnostic and does not enable this feature. Local runtime remains
prohibited in production. No CLI/environment enablement is added.

Only `/api/v1/admin/ai-probe/turns` and its session-scoped cancel route are added.
No catalog or browser/UI is mounted. Generic AI turns remain unavailable. Accepted
input is modelId/turnId/scenario=hello, not free text, document/history, tools,
endpoint or credentials. The server builds a fixed synthetic prompt and tools=[].
Unexpected model tool candidates fail closed, never execute. Authentication,
Origin/CSRF and config_admin admission precede SSE headers; the pipeline repeats
live deployment/revision/credential/budget checks. Empty, duplicate, cross-deployment
or malformed profile admission fails closed; no ordinary-user grants are added.

## Lifecycle scope

The app owns both optional probes. preClose permanently disposes them. onClose
awaits their drains concurrently before invoking closeDb; timeout/dirty state
rejects shutdown and deliberately skips closeDb. Timeout is a trusted numeric
startup setting capped at35s. Startup/ready failures close/dispose the app without
forcing pool closure through a dirty drain. Fixed-probe authentication work is
tracked through its true settlement even after the HTTP waiter ends. The offline
probe now exposes the same owned-work drain, so its orphan queries do not escape
this ordering. No global claim is made for unrelated jobs: other resource owners
still need their normal shutdown protocols, and arbitrary closeDb callback time
is not bounded by the provider drain timer.

Uses #112 fail-closed reserve ambiguity behavior; it does not guess refunds,
retry live requests, or report unresolved settlement as clean.

## Evidence

Full unit+HTTP377/377; browser/server TypeScript pass. Real isolated PG pipeline20
plus offline probe4 =24/24, no skips. Actual loopback listener tests cover active
SSE, concurrent app.close, database row lock delaying unknown settlement, and
actual business-pool close only after settlement. Short timeout rejects close and
keeps the pool open; later unknown settlement is observed without falsely calling
the failed shutdown successful. Admission, fixed-body, member denial, unexpected
tool rejection and tool-free mocked success are covered. Direct lifecycle unit
checks cover hung authentication retained across disposal and eventual drain.

This prepares controlled local wiring. It is not real vendor DNS/TLS/proxy,
monetary-budget, production rollout, native-editor integration or T13 closure.

Independent final review: provider units167/167, fresh isolated PostgreSQL
pipeline20 + offline4 =24/24 with no skips, server TypeScript passed. Corrected
the route comment to explicitly say network-capable and potentially billable.
Publication refreshed nonoverlapping target a4ce11167f292119a9b3d35e2420180e07137374;
full unit+HTTP377/377 and browser/server TypeScript pass again. Enabling real
profiles/credentials and running a real request remains outside this work's
permission; no operator configuration, deployment or real request was performed.
