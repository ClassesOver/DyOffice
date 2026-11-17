# T13 default-off admin route assembly

Baseline: `61237d8c19ddd2fca9d2322980d921c3ea6a4ba0`.

Adds a standalone trusted-bootstrap `registerAdminProviderAssembly` helper. No
entry point calls it: `app.ts`, production configuration, UI and permission core
are unchanged. Omitted/false activation does not read credentials/dependencies
or register routes. Only literal `true` activates the existing admin-only
pipeline and authenticated/CSRF-protected routes. It does not grant budget,
allow ordinary members, accept provider details from requests, or restore legacy
shared providers. The existing pipeline copies keys and retains all its pinned
egress, revision, default-zero budget and per-session turn boundaries.

Disposal is idempotent and per instance. `preClose` aborts before Fastify waits
for streaming connections to drain; `onClose` is a fallback. Startup callers
must close the app if ready/listen fails. No default production mounting is
introduced; a later controlled bootstrap decision remains necessary.

Verification uses synthetic keys, fake transaction callbacks and no real
provider/network calls: activation coercion denial, missing dependencies,
unmounted 404, cookie gate, admin-only rejection, preClose revocation, repeated
close and independent-instance disposal. Provider/HTTP regression initially: 158/158.

Review found disposal did not terminate identity/authorization-stage turns until
their deadline. A failing regression reproduced a 5-second pending SSE response.
The coordinator now exposes permanent dispose, stopping all turn stages and
cancellation waits; orphan dependencies retain their capacity until settlement.
The pipeline checks disposed again on entering a delayed authorization callback.
Real app.close tests cover pending identity and authorization (no late queries),
and real PostgreSQL with synthetic mock HTTPS covers an active response stream:
downstream terminates, upstream is destroyed, committed budget remains unknown.
Post-close settlement is explicitly awaited by the test, not claimed synchronous
or transaction cancellation. A further real loopback listening-socket test reproduced blocked HTTP session
authentication delaying shutdown. Assembly now races that authentication wait
against its disposal signal and rejects late results, without cancelling the
underlying DB query. The socket test passes without releasing that query until
after app.close and the client response complete. This covers local HTTP, not
production reverse proxies or TLS listeners.
Provider pipeline PostgreSQL tests: 12/12, no skips. Final full unit plus HTTP
tests: 346/346. Browser/server TypeScript checks pass.
Browser and server TypeScript checks pass. These are not real-provider, real
TLS/DNS, paid-budget, production deployment or end-to-end user acceptance.

Final resource review replaced the shared pending authentication shutdown Promise
with per-call removable rejection subscriptions. A regression checks 40 alternating
successful/failed authentication requests and verifies zero retained subscribers
after every completion and after close. The old shared-promise implementation
fails this regression. Final full unit plus HTTP count is 347/347, with both
TypeScript projects passing. This is subscription cleanup evidence, not a heap
profile or proof that an underlying uncooperative DB query is cancelled.

Publication refresh: latest target d7abec1f050e6b067241dfee918e32a5501fc093
has no overlapping changes. Refreshed all target changes locally; full unit plus
HTTP now 361/361, both TypeScript projects pass. Independent review reports
provider units 157/157 plus four shutdown races and PG 12/12. Listening-socket
coverage is specifically pending HTTP authentication; active provider-stream
shutdown uses Fastify inject with synthetic HTTPS, not a real vendor socket.
