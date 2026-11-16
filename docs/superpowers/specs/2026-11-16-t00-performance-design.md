# T00 small-sample API measurement design

Approved scope: a disposable PostgreSQL/local-session API baseline, not section 8
capacity acceptance. Compare files/preferences/metadata at concurrency 1 and 4;
separate first observed requests, warmup, and repeated measured rounds. Report
all outcomes, p50/p95/p99, raw samples, CPU/memory, fixture and source provenance.
Loopback client latency is never described as server-side timing.

Approaches: A reuses real restricted identity/file fixtures and the locked CI
host; chosen for a small reproducible and resource-transparent first baseline.
B full four-editor/AI/24-hour capacity testing is deferred: frozen deployment,
representative samples and provider access are not established for that scope.

No production endpoint, credentials or data. The script requires disposable CI
opt-in, uses new randomized test databases/roles, and deletes only those fixture
resources through existing cleanup. Existing production code is unchanged.
Remaining section 8 cases remain not_run/blocked, never marked passed from this
microbaseline. Failure or non-200 results are retained and fail correctness.
