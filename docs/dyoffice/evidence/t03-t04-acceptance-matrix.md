# T03/T04 integration acceptance matrix

> Final evidence update, 2026-11-16: this page retains its dated preparation history. The final #32 combination subsequently passed; see [current matrix H](t03-t04-current-stack-acceptance.md) for exact final results, source continuity, visual evidence and remaining scope. Older pending wording below is not the current status.
> Scope update, 2026-11-16: Historical pre-CI inventory for the initial #21 integration. Its pending statements describe that checkpoint, not the later #38 run. See [current-stack acceptance](t03-t04-current-stack-acceptance.md): #38 passed real PG/browser gates, while the final history/host combination remains pending and must revalidate the now-fixed history-attribution regression.

## Scope and evidence rules

This matrix compares `implementation-plan.md` T03/T04 and
`plans/t04-revocation-isolation-validation.md` with the #21 integration candidate.
It is a source/test inventory, **not a passing PostgreSQL acceptance report**.
The integrated candidate combines target development-mode code with the new
`server/src/db` local-account stack. These are distinct runtimes and schemas.

- Authoritative new-local ledger: `identity_migrations`; tables `users`, `files`, etc.
- Historical development/old-account ledger: `dyoffice_schema_migrations`; tables `dyoffice_*`.
- #28 SQL and its successful historical bootstrap CI do not validate the new stack.
- No evidence establishes a deployed #28 database. Do not assume one exists.
- All tests below must pass on the exact integration commit. Earlier branch CI,
  mock tests and source inspection do not substitute for that run.

## Acceptance matrix

Paths in the test column are relative to `apps/web/test/`.

| Requirement | New-stack implementation | Executable evidence | Current acceptance state |
| --- | --- | --- | --- |
| T03a unique normalized identity, no default password, one bootstrap winner | `modules/auth/service.ts`, `passwords.ts`; migrations 0001–0003 | `local-integration/accounts.test.mjs`: concurrent bootstrap, blocked passwords, generic verification, DB constraints, real TTY input; `unit/passwords.test.mjs` | Tests present; exact candidate real PG/TTY run required |
| T03b real login and server-only session hash | `modules/auth/{sessions,routes,csrf}.ts` | `local-integration/auth-session.test.mjs`: Secure cookie/hash, me roles, CSRF/Origin, duplicate cookies, invalid credentials | Tests present; runtime fixture now uses restricted auth role; rerun required |
| Logout, session revoke, idle/absolute expiry, reauthentication | session service, auth-version checks | `auth-session.test.mjs`: logout, self revoke, rotation, idle/absolute/disabled/version tests | Tests present; exact candidate PG required |
| T03c administrator create/disable/enable/roles | `modules/admin/users/service.ts` | `local-integration/admin-users.test.mjs`: duplicate creation, recent-auth/CSRF, revoked authority, last-admin and cross-deployment cases | Tests present; exact candidate PG required |
| Activation/reset one-use and password change atomicity | auth/admin transaction services | `local-integration/password-reset.test.mjs`: concurrent consume, replay/expiry, reset freeze, password change, forced rollback after changes | Tests present; exact candidate PG required |
| Authentication pool never privileged, including auth-only app | unconditional `assertRuntimePool(db.pool, 'auth')` in `app.ts`; `db/roles.ts` | `auth-only-admission.test.mjs`: 3 negative startup cases; `local-integration/scoped-startup.test.mjs`: actual owner rejection and restricted auth success | Simulated DB startup cases RED→GREEN locally; PG companion blocked locally by missing DB URL |
| Auth/business/worker credentials separated | role provisioning/admission and shared-database guard | `ownership-rls.test.mjs`, `scoped-startup.test.mjs`, `jobs/durable-jobs.test.mjs`: no owner/BYPASSRLS/DDL/credential reads, no escalation, role/column/delegation grant rejection | Tests present; actual restricted connections must pass CI |
| A/B/Admin personal preferences isolated | `db/context.ts`, `modules/policy/authorize.ts`, 0004 RLS | `ownership-rls.test.mjs`: HTTP aliases, forged identity, Admin isolation, SQL mutations and composite workspace FK | Tests present; exact PG required |
| Same pool A→B→none, including throw/SQL rollback | transaction-local GUC and rollback/discard handling | `ownership-rls.test.mjs`: pool size one, same backend PID, cleared GUC after success and errors | Tests present; exact PG required |
| File/revision ownership is not admin authority | file/revision services and 0005/0006 RLS | `local-integration/files.test.mjs`: A/B/Admin guessed IDs and raw SQL; `revision-commit.test.mjs`: cross-user history/lease/commit and append-only policies | Tests present; PG and real object-store runs required |
| Business write vs disable is linearizable | user→session SHARE locks, final clock/authority recheck | `revocation-race.test.mjs`: writer-first and disable-first with observed lock barriers; files tests also hold authority through import commit | Tests present; exact PG required |
| Session revocation fences future writes | same transaction guard | `revocation-race.test.mjs`: self-revoke waits for writer; `auth-session.test.mjs`: revoke-first waiting authentication | `authority-write-races.test.mjs` now adds both orderings and writer/revoker rollback; exact PG execution pending |
| Password/auth-version and role changes vs business write | shared user/session locking mechanism | static old-session rejection and account lifecycle tests exist | `authority-write-races.test.mjs` now adds real password/role service races in both orders with rollback; written and syntax-checked, not yet PG-passed |
| Background job identity cannot be client supplied | job capability/hash/epoch bound to locked SQL job; transaction derives principal | `local-integration/job-routes.test.mjs`; `jobs/durable-jobs.test.mjs`: B/Admin denial, identity spoofing, worker-role boundary; `jobs/output-commit.test.mjs`: file binding, expired/cancelled/revoked claims, final input-mutation check | Tests present; PG job suites required; API remains experimental |
| Job cancellation/revocation prevents stale output | claim fencing, final transaction check, atomic revision/job completion | `jobs/output-commit.test.mjs`: cancelled staged output, reclaimed epoch, deadline during I/O, atomic rollback; native-job suites exercise executor termination | SQL job suite and native worker suite are separate gates; SQL green alone does not prove process kill/recovery |
| Real browser cookie/CSRF and cross-user behavior | TLS session API, restricted fixture | `e2e/auth-browser.test.mjs`: cookie/logout, account reset lifecycle, A/B prefs, file lifecycle and saves | Requires actual Chromium over TLS on exact candidate; API `page.evaluate` is not proof of visible login-page interactions |
| New local must never fall back to shared development state | mode split, local dev-token rejection, production refusal | `auth-session.test.mjs`, `scoped-startup.test.mjs`; existing development route suite | Existing tests plus local-shell-specific browser gate must pass; do not attach legacy personal JSON store to cookie auth |
| Wrong old database is rejected, not silently treated as empty | new-stack legacy-ledger guard in migration/startup | `db-safety/*.test.mjs` with dedicated `DYOFFICE_LEGACY_GUARD_TEST_DATABASE_URL` | Added to CI; does not migrate historical user/files data |
| External API Token / live Agent stream / approved tool revocation | T19/T13/T17 boundaries | Not supplied by these T03/T04 suites | Explicitly deferred to their tasks; no claim that cookie deletion stops all streams/tools |

## #28 disposition mapping (no PR closure authorized here)

- Old `db/context.mjs` GUC wrapper is replaced for new local by the stronger
  `src/db/context.ts` credential-derived principal and pre/post authority checks.
- Old FORCE-RLS migrations target different tables; new 0004/0005/0006 and job
  migrations must be tested independently. Do not apply old SQL to new tables.
- Old `createAuthorizer(principal, action, resource)` and new scope authorization
  are not drop-in signatures. New jobs use their own service and SQL capability
  guard; preserve tests for every actual route instead of renaming calls.
- #28 immutable history/bootstrap repair remains a historical maintenance
  candidate. Its migration aliases and old-library fixtures are not part of the
  new-local schema deployment. Do not merge incompatible migration chains.
- Shared development file/catalog/revision behavior may remain for explicit dev
  mode, but its JSON journal is single-process and is not PostgreSQL RLS or HA.

## Required closeout sequence

1. Freeze the integrated candidate and record its commit SHA.
2. Run real PostgreSQL local-integration, jobs, wrong-ledger isolated-DB tests,
   plus object storage and actual TLS Chromium suites. Check that no required
   test is silently skipped. Run the native worker gate for its separate claim.
3. Execute the new 12-case `authority-write-races.test.mjs` password/role/session
   bidirectional commit/rollback matrix. Until real PG passes, keep it open
   rather than marking T04 fully complete.
4. Review local-shell login/account UI evidence separately from direct API TLS
   tests. Production remains blocked by explicit code guards.
5. Update the plan's stale mixed-stack statements using that commit's results:
   current T03 text references old MJS principal/0001–0008 and old role `user`,
   while new local uses TS and role `personal`; current T04 checkboxes remain
   unchecked. Neither should be globally flipped based on another stack's CI.
6. Keep old databases unchanged. A historical-to-new data importer requires a
   separate freeze/backup/mapping/hash-and-count verification/cutover exercise.
   No such production data migration is claimed by this candidate.

## Local observations for this review

- Authentication guard: three real application startup negative tests with
  simulated PG responses first failed with `Missing expected rejection`, then
  passed after unconditional auth admission.
- Web unit run after that change: 209 passed, 1 skipped, 0 failed (210 total).
- Web and server TypeScript checks passed at that working-tree checkpoint.
- Real-PG auth-only test attempted locally and failed before SQL with
  `Disposable PostgreSQL admin connection required`; no PG acceptance claimed.
- These are working-tree observations before final integration publication,
  not evidence for a later commit. CI results must be appended with exact SHA.

- Follow-up candidate adds 12 real-PG password/role/session revocation vs writer
  cases, covering both transaction orderings and either side rolling back.
  Real services and SQL remain unchanged; a test transaction wrapper pauses
  before COMMIT and injects a controlled rollback. Syntax check passed; the
  attempted focused execution failed at missing database configuration, not
  at a behavioral assertion. This is pending CI evidence, not RED→GREEN.

