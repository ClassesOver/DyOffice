# T13 local-only synthetic administrator probe

Baseline f42f9113fb386444753353b5800c9fb36b2e2b70. This is a fixed diagnostic,
not a model response, real-provider acceptance or a production rollout.

The actual buildLocalApp accepts adminAiSyntheticProbe only as a boolean. Omitted
or false leaves the existing authenticated unimplemented-route fallback (501),
without registering the probe. Literal true requires the restricted business
pool and mounts POST /api/v1/admin/ai/synthetic-probe. The existing production
runtime prohibition remains unchanged. No CLI/environment toggle is added.

The endpoint accepts only an empty object and no query fields, has a 128-byte
body bound, same-origin session CSRF, no-store replies, live session validation,
and current deployment-scoped config_admin checks via principal transactions.
The existing turn coordinator provides a five-second deadline, one active slot,
retains pending orphan capacity, and terminates waits at app shutdown. Authority
is rechecked before the fixed synthetic result. No request text is processed.

The module has no provider/config/credential/budget/transport dependency. It never
reads secrets, grants or spends budget, resolves a provider or calls a model.
The real AI turns endpoint remains unmounted. Successful output explicitly says
mode=synthetic, externalRequests=0, credentialsRead=false, billable=false.

Verification: full unit plus HTTP 364/364; browser/server TypeScript pass. Real
isolated PG: probe 4/4 and existing simulated-provider pipeline 12/12, no skips.
Probe coverage includes actual application default/false/true mounting, ordinary
member denial, revoked and cross-deployment sessions, CSRF/origin/token injection,
extra request fields, configuration coercion, missing restricted pool, and the
production prohibition. DNS/HTTPS are forbidden in the successful probe test.
Unit tests cover pending authentication/principal waits at real app.close and
revoked role before response. No external vendor, credentials, cost or real-user
data was used. No claim of production TLS/proxy, model roundtrip or T13 closure.

Independent review: provider units 160/160, extra single-slot blocking/reuse
checks, and real PG 16/16 passed without skips. The reviewer's server TypeScript
process exited 137; a 384 MB heap retry exited 134 with an explicit heap OOM.
That independent type check did not pass. The implementer's earlier full browser
and server checks did pass. Do not conflate those separate runs. The test's
network interdiction covers https.request and dns.lookup, not a network sandbox;
static review additionally found no outbound path in the synthetic module.
