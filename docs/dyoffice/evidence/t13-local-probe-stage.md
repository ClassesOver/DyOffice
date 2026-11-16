# T13 explicit local synthetic probe stage

Base draft #78 f48c889f177f9423fbf000ff982097bfaee87339, still unmerged. Depends on #73/0020 -> #74/0021 -> #76 -> #78; no migration change. T12 nonnative UI #79 is a separate sibling, not included or modified.

## Implemented
`buildLocalApp` has an explicit optional `adminProviderProbe:{profiles}` configuration. Default leaves the probe absent (404); production local runtime remains rejected. Missing pool/keyring, empty profiles, cross-deployment profiles and unsupported config keys fail startup. No environment auto-enable, budget grants, RLS changes, public catalog, test transport selector or general AI endpoint is introduced.

Only authenticated config_admin can GET `/api/v1/admin/ai-probe` or POST `/api/v1/admin/ai-probe/turns` and `/:id/cancel`. Writes additionally require existing origin/CSRF proof. Run accepts exactly modelId/turnId/scenario:'hello'; it builds fixed synthetic messages and tools=[] on the server. Free-form document/history/endpoint input is rejected. Current enabled/config revision/profile and durable budget must still pass #78 dispatch checks. Status dynamically rechecks each configured profile and returns only entry IDs (also used as labels); no IP/endpoint/key/ledger data. Status is not a network connectivity check and never runs a turn.

The browser controller runs only on explicit `run(modelId,callbacks)`; it is not mounted into Settings/Home/editor UI. It provides strict probe SSE schema, total 1MiB/256KiB frame bounds, bounded 65536-byte fatal-UTF8 status reads, same-origin/CSRF, no tool candidates, cancellation/disposal and terminal-once behavior. A terminal callback means the stream ended, not independent proof of real vendor correctness.

## Shutdown fix and limits
A real stalled HTTP response exposed that aborting only the pipeline inner controller did not promptly terminate the outer turn wait. The new coordinator abortAll is invoked by pipeline.dispose. App preClose disposes before Fastify waits on connections; onClose idempotently disposes then drains before closeDb. Real PG/HTTP test verifies upstream destruction before the closeDb callback and the retained unknown budget.

Drain waits at most35 seconds for actual owned turn/transport work. If an uncooperative dependency remains, it throws and intentionally does not call closeDb; shutdown is failed/incomplete, not a successful universal cleanup guarantee. Prior-sent requests/accepted events remain irreversible. No real keys are used in these tests.

## Evidence
- New route tests red (missing factory) ->3/3 green; actual app default-off/config tests red ->green.
- Real isolated PostgreSQL plus actual loopback HTTP:6/6 new tests; existing composed pipeline11/11, total17/17 zero skip. Synthetic encrypted credential and mocked DNS/HTTPS only. Includes browser controller through actual app, full settlement/replay, member/CSRF/freeform/revoked denial before dispatch, dynamic catalog invalidation, close of stalled SSE.
- Whole Web unit250/250; boundary994 files/0 violations. Complete server and browser TS passed.
- Independent server static review found no identified draft blocker; controller independently reviewed, then strict schema/status limits tightened with five red/green tests. Reviewers' own rerun counts are separate from integration results.
- Initial shutdown integration hung before outer abortAll fix; interrupted isolated test process, then exact regression reran green. A separate test-fixture partial config upsert was invalid and corrected to the existing complete DTO; no production policy loosened.

No real provider/DNS/TLS/peer/proxy acceptance, production enablement, ordinary-user grants, document AI, editor tool execution, GUI mounting or full native/monorepo pass is claimed. Do not mark T13 closed. Default remains off; this draft only supplies an explicit local experimental wiring capability, and no runtime instance is configured or left running by publication.

Ordinary Web suite with the repository's tsx loader:271 passed,1 explicit MinIO skip (`DYOFFICE_S3_ENDPOINT` absent),0 failed. An initial bare Node invocation failed resolving existing extensionless `packages/ai-provider/src/custom-profile`; rerunning with `node --import tsx --test --test-concurrency=1 test/*.test.mjs` passed without source changes. This is not a native/full-monorepo result.

Final independent review: server static checks plus3 route units independently passed. A different reviewer verified exact strict-controller blobs and independently reran13 probe+22 shared transport tests (35/35), finding no identified draft blocker. Neither reviewer reran the17 PG tests; those are implementer verification. Additional multibyte boundary/timeout coverage is future hardening, not claimed here.
