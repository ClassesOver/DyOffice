# T14 explicit recovery control (optional experimental stage)

## Scope
Stacked after #85. The new server action accepts file ID, command ID and an observed
digest, not an old editor/envelope/claim. It reuses abandonCommand through a private,
one-shot, exact-ID adapter inside the existing authority/lifecycle/command lock
transaction. Trusted current tool policy is recomputed. Only a state-only terminal
change is allowed, guarded by SQL CAS and migration 0022. Existing writer/service
and its current-editor receipt verifier are unchanged. No new migration.

If commit wins first, the result is a verified committed historical receipt, not
successful abandonment. If abandonment wins, previous claims/bound uploads cannot
publish. It does not undo effects in another tab or retract an existing revision.
The reader remains non-mutating; only the separately constructed action can fence.

Optional HTTP routes enforce session authentication, Origin/CSRF, strict bounded
schemas and no-store. The standalone page supports only lookup and explicit
checkbox-plus-click abandonment. It does not execute/edit/save/take over leases.
Lost responses disable mutation until a new lookup. Stop/dispose does not claim
the already sent request was rolled back. BFCache return creates a new client and
read-only panel rather than reusing disposed state.

No production app.ts registration or navigation was changed. The QA harness is
local synthetic-account infrastructure only; it is not a product route or native
editor migration. The normal App/window.desktop is not loaded by the isolated page.

## Final verification
- Missing-action factory RED observed before implementation (API red, not SQL flaw).
- Initial real PG/S3 actions 11 + reader 16: 27/27; real HTTP 3/3.
- Final combined real PostgreSQL + RustFS regression: **85/85**, zero skips,
  135 seconds, including new actions/HTTP/reader and existing abandonment, upgrade,
  journal, HTTP commands and revision commit suites.
- Final frontend/route units **15/15**, independently rerun by reviewer; command-related aggregate **66/66**.
- Server TypeScript and boundary 1001 files/0 violations passed.
- Independent review found default redirect-follow could transmit a request body
  and CSRF header away from the fixed endpoint. Fixed both mutation and CSRF fetch
  with same-origin/redirect:error, CSRF format validation and fatal UTF-8 decoding.
  New tests failed before the fix and pass afterward. Reviewer independently
  confirmed the fix and found no remaining definite experimental draft blocker.
- Parent review found BFCache pagehide-dispose without pageshow remount. Fixed
  before final GUI testing; persisted-pageshow regression checks fresh lookup only.

## GUI fixture diagnostics (not product failures)
The first harness reused a booted Fastify instance and failed registration. The
second used default req-N request IDs, incompatible with UUID audit IDs; corrected
to the application's UUID generation. Scoped reporting was corrected after an
unscoped owner query returned no rows under FORCE RLS. Those empty rows are not
claimed as durable-state evidence. The corrected auth/report selftest passes.

An earlier GUI run demonstrated explicit acknowledgement, one committed abandonment
with a simulated lost HTTP response, unknown UI followed by read-only confirmation,
reload and Back/Forward recovery, and new-session denial. The final redirect-fixed
build was then retested as described below; the earlier run alone was not final
safety acceptance.

## Remaining gates
No controlled text editing/approval/commit composition, general Word support,
cross-session recovery, old inverse restoration or refresh-then-submit flow.
A future editor page must verify exact bytes/profile and establish a new normal
lease, never revive old editor authority from this recovery result.

Availability limit: requests have no total deadline. Stop/dispose fences late
mutation dispatch/results, but an outstanding CSRF fetch cannot be forcibly
terminated through the current callback. This is not claimed as network rollback.

## Final hardened build, real Chromium UI
Synthetic local-account login and same-session command recovery succeeded through
real PostgreSQL-backed HTTP endpoints. The GUI deliberately starts from a seeded
unknown command; it does not claim to have performed a real document edit.

1. Lost response: after explicit checkbox and click, the database transaction
   committed but the harness returned HTTP 503. UI showed an unknown result and
   disabled repeat abandonment. Manual lookup confirmed abandoned; reload and
   Back navigation recovered the state without replay.
2. Interrupted wait: after the database commit, the harness delayed the HTTP reply.
   “Stop waiting (does not withdraw request)” immediately cleared the actionable
   view. Manual lookup confirmed abandoned. The late response did not change it.
3. Scoped durable observations in both final scenarios: exactly one mutation,
   unknown_outcome -> abandoned_uncommitted, file current_revision unchanged.
4. In the earlier build, real logout/login demonstrated new-session denial; the
   server code did not change afterward. Final same-session reload was rechecked.

The fixture's PG and HTTP services were stopped cleanly after testing. Unit tests
separately cover BFCache persisted pageshow, explicit confirmation, disposal during
response reads, limits, invalid UTF-8/CSRF, and same-origin/redirect-error options.

## Reproduction (isolated local QA only)
From the repository root, run `node apps/web/tools/build-command-recovery-ui.mjs`.
Set `DYOFFICE_TEST_DATABASE_URL` to a disposable PostgreSQL test database and run
`bash qa-recovery/run.sh` in the same network namespace as the browser. Open
`http://localhost:18767/qa/recovery/login`; fixture credentials come from
`apps/web/test/helpers/identity.mjs`. `qa-recovery/mode` may contain `lost` or
`stall`; `qa-recovery/stop` triggers normal cleanup. These are synthetic QA switches,
not production routes. `QA_RECOVERY_SELFTEST=1` verifies auth/scoped reporting and
exits without listening. Do not point this harness at a production database.

Final independent review: reviewer reran 15 client/route tests and reviewed
85/85 PG, 66/66 units, and the two final scoped GUI before/after observations.
No remaining definite experimental draft blocker. PG/GUI were not independently
rerun by that reviewer. Root authorized draft publication, not merge or mounting.
