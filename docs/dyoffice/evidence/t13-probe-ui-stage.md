# T13 standalone synthetic probe UI

Base draft #81 6996c33536617cb2666c0ab85dd661859fc2105f. Dependency chain unchanged; no migrations or T12 #79 Settings/Home/local-main source changes. No environment default, public shortcut, production enablement or real upstream configuration was added.

## Product change
A separate vanilla DOM/Vite page at `/admin/provider-probe/` is available only when local `adminProviderProbe` and `adminProviderProbeDirectory` are explicitly configured. Every HTML/JS/CSS GET/HEAD authenticates current config_admin before asset lookup. Missing/malformed builds fail startup. Unknown paths, source maps, legacy.html and pdf.html are not served. No-store and strict CSP (default none; self script/style/connect; no inline/eval, frames, objects, base or forms).

Only safe model selection and fixed hello run/cancel/refresh controls exist. No text/document/key/URL inputs, editor integration or tools. Output and labels use DOM text only. Output display cap65536 UTF-16 units; #81 separately bounds network bytes. Refresh/navigation never automatically runs a provider. Cancel is visibly best-effort and cannot retract already sent input. Error/cancel remain distinct from completion. Pagehide disposes; BFCache restoration reloads a fresh read-only page. CSRF is obtained afresh with5s timeout and pagehide abort.

## Red/green and review findings
- Missing page factory3 red ->3 green; BFCache lifecycle regression missing function ->green (4 total).
- New app directory prerequisite initially did not reject ->green. Independent review caught shared helper autoallowing legacy/pdf and pdf CSP override; actual admin route test observed200 then explicit path filter yields404.
- Build is independent:7 modules, about12.24kB JS/4.83kB gzip plus0.66kB CSS. No React/editor build required.

## Real browser evidence
Actual cloud Chromium through CUA, actual local app, fresh isolated PostgreSQL and synthetic test accounts/encrypted secret. DNS/HTTPS provider remained test-only mocked. Login shell built from #79 was used solely as the QA login entry, not included in this branch.

Observed in browser:
1. Admin owner login, probe page initially idle; no automatic dispatch.
2. Explicit Run displayed `SYNTHETIC OK` and completion disclaimer, not a real-model acceptance claim.
3. Return Home then browser Back restored enabled idle controls with blank response, not a disposed frozen page or another dispatch.
4. Stalled synthetic response disabled model/start/refresh, enabled Cancel. Cancel restored controls while retaining cancellation warning.
5. Malformed synthetic upstream showed failure and did not become success on done.
6. Logged out owner, logged in ordinary alice; direct page returned403 Forbidden with no page source.

Fixture read-only report:3 mocked dispatches, one settled and two unknown budget reservations. No real provider or document external transmission. Isolated HTTP18764/PG55449 were stopped and PostgreSQL shutdown completion verified. These ports are test evidence, not a deployed service or user-facing live link.

## Remaining gates
No real TLS/DNS/peer or real provider acceptance, ordinary-user policy, mounted editor/Settings entry, end-user production rollout or full native/monorepo pass. Default remains off. This stage verifies a local experimental UI, not T13 complete closure.

## Final verification
- Real isolated PG related18/18, zero skip (assets1, local probe6, pipeline11).
- Whole Web unit254/254, zero skip; ordinary Web271 passed/1 explicit MinIO skip because S3 endpoint is absent.
- Complete server TS and dedicated browser/probe TS configuration passed; boundary994 scanned files/0 violations. Separate Vite build passed.
- Independent design/static review and four DOM tests passed after fixes. Reviewer did not personally rerun PG, complete suites or GUI; those are implementer results.
