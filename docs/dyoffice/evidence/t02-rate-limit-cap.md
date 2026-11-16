# T02 bounded source-address limiter

Scope: development modular API shell only. The authenticated local runtime has
its own Fastify limiter; it is not changed here. No production enablement, new
route, authentication policy, file lifecycle or native editor change.

The old fixed-window map checked a 5000-entry threshold only *after* inserting a
new address and scanned all entries for expiry. When all entries were live,
nothing was removed: every new source grew memory and scanned the whole map.

The replacement caps tracked addresses at 5000. At capacity, unknown addresses
receive the existing 429 result with Retry-After until the oldest entry expires.
Existing addresses retain their quota; live entries are never evicted to make
space. Expired prefixes are removed in insertion/expiry order, so rejected new
addresses do not scan all live entries. Clock rollback is clamped conservatively
to retain expiry ordering. Per-source counters saturate at the configured limit.
This is an overload tradeoff: new legitimate sources can be rejected while the
map is full. It is not a distributed limiter or protection from all network DoS.

Verification:
- Three regression tests first failed on original code, then passed (3/3).
- Existing API compatibility suite: 5/5, including real loopback routes, limits,
  health, legacy contract, production rejection and listening socket shutdown.
- Source baseline matches GitHub feat/dyoffice-web blob
  0e2cdba6e849cc32c4cc5dcce1109cc95d84c141.
- Broader commands and their limits are recorded in the handoff after execution.

This change does not close full T02 or any editor milestone.

Broader verification (not a full pass):
- Independent reviewer repeated regression 3/3 and API compatibility 5/5.
- JavaScript syntax checks passed. Patch apply-check on baseline passed.
- Ordinary Web run: 262 passed, 1 optional skip, PDF render process failed;
  isolated PDF render rerun: 3/3 passed. Serial Web run: 261 passed, 1 optional
  skip, docs-mount process failed. These run-level failures are not erased by
  isolated reruns and their original cause is not established.
- Full `npm test` reached docx-engine 2239 passed/1 skipped, then pdf2docx was
  Killed (137). Later packages were not executed. No aggregate pass claimed.
- No PostgreSQL, browser UI, distributed capacity or production acceptance run.
- Isolated docs-mount rerun passed 4/4; does not replace failed serial suite.
