# T13 opt-in SSE HTTP transport stage

Base: `10793fcdc93f033c33a886434be35f3a6d83733d`.

This stage connects the existing provider coordinator to an explicit, **unmounted**
Fastify route module and tests it with the existing BrowserHost AgentTransport.
No app wiring, T12 configuration schema or T14 execution file is changed.

## Coverage

- POST fetch SSE delta, complete tool candidate and usage callback contract.
- Cookie/CSRF rejection before dispatch; body/query allowlists reject client URL/key overrides.
- Disabled permit/provider failure redaction, bounded output and one terminal sequence.
- Bodyless session-scoped cancellation; external abort during stalled authorization.
- Real loopback HTTP disconnect while authorization is pending, with orphan capacity held until the dependency settles.
- Terminal frames do not wait forever for a non-reading peer.
- Browser model selection/CSRF, usage validation, candidate field projection, delayed CSRF cancellation, observer exceptions and exactly-once terminal callback.
- Pre-aborted signal regression: the RED case produced an unhandled rejection; the cancellation promise now always has a rejection observer before a race is attached.

Mocks stand in for model/authority services. The loopback check uses an isolated
HTTP server only, not shared PostgreSQL, S3 or Redis. Existing provider coordinator
and browser regressions are run with the new tests. Final exact-head counts and
independent review results are recorded in the PR.

## Not accepted

T12 is a prerequisite for safely enabling this endpoint. Read-only authorization
is not a billing reservation; requests cannot be mounted as production-ready until
configuration/secret access, budget settlement, model adapter parsing and egress
policy are independently verified. No real credential or provider was used. Real
model acceptance is **blocked**, native editor integration is not wired, and T14
must approve any candidate tool before execution. T13 checklist is not closed.

## Local verification of this stage

- Coordinator, browser transport and HTTP adapter tests: 41 passed, 0 failed, 0 skipped.
- Independent review repeated all 41 and separately verified pre-aborted signal cancellation exits cleanly without dispatch or orphan capacity.
- Browser Web TypeScript configuration passed. Strict targeted TypeScript check of provider routes/coordinator and transitive dependencies passed.
- Source boundary graph: 990 files, zero violations.
- Complete server TypeScript attempt was killed with exit 137; not reported as a pass. Full monorepo/native suites were not run in this stage. These limits do not become successes through the focused tests.
