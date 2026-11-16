# T03/T04 current-stack acceptance matrix

> Owner scope update, 2026-11-16: legacy-database import/conversion is explicitly excluded from this delivery and is not an acceptance blocker. Preserve fail-closed rejection of accidentally connecting the new runtime to a legacy ledger and preserve existing data. No automatic conversion, reassignment, deletion or claim that migration was implemented.

## Current decision: bounded new-stack acceptance closed (2026-11-16)

The earlier A–G snapshot below is retained as history, not the current status.
Its final-combination pending gates are superseded by evidence H below. This closes
T03 local accounts and T04 isolation **for the connected local-account resources**,
not every planned future entry, the old database upgrade path, or production release.
No product code or security settings are changed by this evidence update.

### H. Exact final source and independently checked results

- Final PR #32 head: `157cc1c3549cdc2e91371b7b8ee2f1e4a90c7f89`.
- Merged source: `9b2c7aa587ab403935a46ae1f43ea8e326c84547`.
  GitHub compare returned no file differences between these commits (not truncated).
- Initial review baseline: `6f3702a514fbfdfcecec6746c9614a2ae0784369`.
  Publication baseline: `4386e6e8767c3810195799b8c6bf60958dcc02fa` after T01 #44.
  The intervening four-file delta only adds Host contract tests and T01 documents;
  the T03/T04 implementation and real-service acceptance sources remain unchanged.
  Comparison from the #32 merge lists only T00/T01 documentation, unit-command,
  package-script, workflow and compatibility-inventory changes. No auth, database,
  local-account UI, resource service or acceptance-test source changed. This is source
  continuity evidence, not a new execution of all services at the current commit.
- [Final Web run 43815137000](https://github.com/ClassesOver/DyOffice/actions/runs/43815137000):
  boundary-check, native-docx and native-worker all completed successfully.
  [Boundary job 133125360838](https://github.com/ClassesOver/DyOffice/actions/runs/43815137000/job/133125360838)
  raw logs were reread for the table below; the earlier branch results are not used
  as a substitute for this final combined run.

| Final combined gate | Observed result |
| --- | --- |
| Isolated wrong-legacy-ledger guard | 1 passed, 0 skipped |
| Visible original-shell local-account browser suite | 5 passed, 0 skipped: Admin lifecycle, Home/settings, self-password change, sessions, login history |
| Real PostgreSQL local integration | 156 passed, 0 skipped; includes all 12 password/role/session writer-lock order/rollback cases and final history attribution/grant checks |
| Durable SQL jobs | 36 passed, 0 skipped |
| Object storage | 22 passed, 0 skipped |
| TLS browser/API suite | 5 passed, 0 skipped |
| Separate legacy Web regression | 229 passed, 1 optional S3 skip; not a skip in the new account isolation suite |
| Web typecheck, minimal build and original local-shell build | Successful steps |
| Native worker and original Docs/DOCX regression | Separate final jobs successful; not a claim about all four format round trips |

The final log explicitly includes immutable history attribution across rename/reuse,
one-MVCC-snapshot failure attribution, fixed latest-20 projection, function grants,
revoked/expired credentials, and A/B/Admin direct-SQL and HTTP isolation. It also
includes same-backend size-one pool reuse/rollback, configured-local rejection of
shared legacy endpoints, and job/role-epoch revocation. These close the relevant
OPEN final-combination entries in historical sections 3–5 below.

### Visual evidence and limits

Downloaded final artifact `local-account-original-shell` (ID `14202611200`),
SHA-256 `f8af667030892280558c36fe4fb44591ab7a2c1bb011e44a13e750404ba2e5a2`,
matching GitHub's artifact digest. Reviewed all seven PNGs: Home, account,
general settings, Admin complete, password-changed, sessions and login-history.
They show the existing Home/Settings shell, aligned password fields, current-only
session status after revoke-others, and minimal history time/outcome projection.
No password or one-time activation/reset code is visible. Long settings pages are
scroll views, not proof that all offscreen controls fit at once. This visual review
is limited to the supplied viewport/light-theme captures; it is not responsive,
dark-mode, accessibility or full four-editor visual certification. Interaction
claims above come from the executed browser tests, not from screenshots alone.

### Scope that remains outside this closure

- AI/Agent, data-source and MCP resources are not yet connected in this new stack.
  Default denial is tested; their future resource authorization is not completed.
- External API tokens and their revocation belong to T19. New entry points must
  derive and fence their principals, not trust caller-supplied owner IDs.
- Legacy import/conversion is excluded by the owner. Wrong-ledger refusal and
  preservation remain enforced. #28 was closed as superseded, not merged or
  declared fully upgraded against a real legacy database.
- Production enablement, full breach corpus, target-host password cost/capacity,
  comprehensive audit export/retention, and all-format editor acceptance remain
  separate delivery gates. Existing production refusal is not removed.
- This update rereads final run evidence and source continuity; it does not claim
  new PostgreSQL/browser tests were run locally for the documentation commit.
  The owner excludes CI from this merge condition; Actions stays unchanged.

## Historical preparation snapshot (superseded by H above)

Snapshot: 2026-11-16. This document records **which code was actually tested**.
It does not turn branch-local results into an unrun final-combination result, authorize
a merge or deployment, or check off T19, legacy-data migration or production.

## 1. Candidate identity and evidence ledger

The final combination is **not yet a published commit at this snapshot**. Its coordinator
reports a complete local source combination of target
`474ce46a0e4878ffc9903a56e96d2242da04f13c`, the #38 candidate below,
#39 host-runtime changes, #40 login-history backend, and the separate login-history UI.
There is therefore no final candidate SHA or final real-service PASS to invent.
Before acceptance, replace this pending record with the published commit/tree, exact
workflow links and actual results, retaining the branch evidence below as history.

| Evidence ID | Exact source / workflow | Observed result and scope |
| --- | --- | --- |
| A | #32 `f0fbb751e3a75e827e1daa405636a30edc5db14f`; [Web 43802184979](https://github.com/ClassesOver/DyOffice/actions/runs/43802184979) | Successful integrated new-local baseline. It does not contain the later full Admin/session/history UI. Other historical-named workflows on this commit do not automatically validate the new schema. |
| B | #35 `4f0e158147c6b247ca99633c6929ff83b02d771b`; [Web 43806198710](https://github.com/ClassesOver/DyOffice/actions/runs/43806198710), [Shell 43806198737](https://github.com/ClassesOver/DyOffice/actions/runs/43806198737) | Both completed successfully. Actual PostgreSQL/Chromium local browser tests: Admin lifecycle, original Home/Settings, personal password change, 3/3 without skips. Full local integration: 132 passed. The earlier purpose-select accessible-name failure was fixed, not skipped. |
| C | #37 `693a87d03af2674cbf25a4ead4b27bf1f1862ca8`; [Web 43805857798](https://github.com/ClassesOver/DyOffice/actions/runs/43805857798) | Successful new-local revoke-others backend candidate. Its behavior is also incorporated/tested in D. |
| D | #38 `57e72697e50d904b101c26e1ec477afd6a304e5e`; [Web 43806308207](https://github.com/ClassesOver/DyOffice/actions/runs/43806308207), [Shell 43806308219](https://github.com/ClassesOver/DyOffice/actions/runs/43806308219) | Both completed successfully; Web boundary, native-worker and native-docx jobs all succeeded. Raw boundary job log confirms new-local PostgreSQL 141/141 and visible local browser 4/4, zero skips in those suites. The 12 password/role/session authority-write race cases are explicitly present and passed. Separate legacy Web suite has 224 passed and one optional S3 skip; this is not a skip in the new-local isolation suite. |
| E | #39 `bfda040d19ae2cc3e7fad1b9eebae7713b8ebd9a`; [Web 43807820290](https://github.com/ClassesOver/DyOffice/actions/runs/43807820290) | Runtime-lock candidate; all 10 exact workflows completed successfully. The three host jobs passed: TLS DOCX 5/5, SQL 132, Redis/jobs 36, storage 22, native isolation 16 and native jobs 12 (no required skips). Original Docs 6403 passed/20 existing skips and engine 2239 passed/1 existing skip remain separately reported. This does not replace the final combined run. |
| F | #40 `256b4e79491319edd8de32687a48c3575e6ca5c6`; [Web 43811415728](https://github.com/ClassesOver/DyOffice/actions/runs/43811415728) | Login-history backend and upgrade-test correction: all exact workflows passed. Real local PG 151/151, jobs 36/36, storage 22/22, TLS 5/5 and existing visible UI 4/4. Combined history UI and final tree remain pending. |
| G | Final combination described above | Coordinator reports local Web/server types, Web 229 passed plus one existing optional skip, and Shell 33 passed. These are coordinator-reported preparation checks, not this author's independently run final PostgreSQL/Chromium evidence. Final SHA, all relevant real-service runs and visual review remain pending. |

### Security regression and pending fix validation

The initial #40 user `FOR SHARE` attribution produced a known-account lock timeout:
real PostgreSQL on `d02e23017290f213decc08863e66bff8b3cea271`, run `43809371517`,
failed the HTTP status assertion **500 != 401**. It is withdrawn, not accepted.
The local combination now includes reviewed fix `53d01452854014850b777c40c4b92de6cdb9ce5d`:
one atomic MVCC INSERT…SELECT, no user-row lock, preserved audit writes and rate-limit
transactions. Attribution is ownership at the statement snapshot, not request start.
Its ten real PostgreSQL history cases passed in the 151/151 local suite on final #40
`256b4e79491319edd8de32687a48c3575e6ca5c6`. Final combined browser/PG gates remain pending. No audit failures are swallowed; no successful test is invented.

Source paths in the tables below are relative to `apps/web/`. A passing reference
means only its exact candidate and named suite, not every future entry or the entire plan.

## 2. Never combine the old and new identities

| Boundary | Historical/development stack | New local-account stack |
| --- | --- | --- |
| Source and ledger | MJS auth modules, `server/db/migrations`, `dyoffice_schema_migrations`, `dyoffice_*` tables | TS `server/src/`, `identity_migrations`, `users`, `sessions`, owned `files`/revisions/jobs |
| Principal/roles | Older evidence mentions `principalContext`, `user` and old cookie/route conventions | Credentials are checked by new session/authority services; new personal accounts receive `personal`; allowed roles include `config_admin`, `operator`, `auditor` |
| Personal state | Explicit development-token routes/shared JSON journal remain compatibility behavior, not multi-user SQL isolation | Local entry uses cookie/CSRF APIs and restricted auth/business/worker pools. No fallback to the shared journal. |
| Database upgrade | #28 and old bootstrap/renumbering tests describe a different migration chain | New startup/migrator rejects an old ledger even outside search_path. Refusal is not import, conversion, rollback or proof of zero data loss during an unimplemented migration. |
| Deployment | Existing old-schema CI may remain useful maintenance evidence | Production refusal stays in code. No production database, credentials, cutover or real users were used in these disposable tests. |

Do not use `t03-closeout.md`'s old migration numbers, `user` role, cookie spelling,
155-test count or lack-of-RLS statement as a description of this new-local candidate.
Retain that page as dated old-stack evidence, with an explicit scope banner/link.

## 3. T03 requirement-by-requirement

| Requirement | New implementation / executable acceptance | Proven now | Final-combination status |
| --- | --- | --- | --- |
| Normalized unique identity; one first-admin winner; no default password; Argon2/password policy | `server/src/modules/auth/{service,passwords}.ts`; `test/local-integration/{accounts,bootstrap-cli}.test.mjs`, password unit tests | New-local baseline A/D; real DB/TTY cases included | Re-run exact final commit; large breach corpus and production host-cost benchmarking are not implied |
| Cookie login/logout/me, CSRF/Origin, duplicate cookies, enumeration/throttle/expiry | `auth/{sessions,routes,csrf,throttle}.ts`; `local-integration/auth-session.test.mjs`, TLS browser suite | A/D real service acceptance | Re-run after #40 failure-attribution change |
| Admin list/create, disable/restore, role replacement, recent reauthentication | `admin/users/{service,routes}.ts`; `local-integration/admin-users.test.mjs`; `local-browser/admin-users.test.mjs` | B/D: visible original-settings UI performs real requests, including last-admin rejection | UI/server scopes must both pass final run; hiding a menu is not authorization |
| Activation/reset one-use, replay/expiry/concurrent redemption/rollback | `auth/routes.ts`, admin transactional service; `local-integration/password-reset.test.mjs` | D real PG; B/D visible create→activate→login and reset→new-password login | Re-run exact final; no mail service or automatic secret delivery claimed |
| Reset/disable/role changes revoke old authority; self-demotion requires new login | Admin service, session auth_version; lifecycle and authority race tests | B/D browser proves grant revocation, last-admin protection and successful self-demotion with another admin | Final new UI must preserve this, including stale-session failure behavior |
| Personal password change rotates current cookie and revokes others | `LocalPasswordForm`, local client, new auth route; `local-browser/password-settings.test.mjs` | B/D real browser: wrong current password, success, old credentials rejected, subsequent settings write | Re-run final settings/history/session combination |
| List/revoke own sessions, self-revoke, revoke-others | `sessions.ts`, routes; `local-integration/revoke-others.test.mjs`, `local-browser/session-settings.test.mjs` | D real PG/browser, including cross-owner denial, mutual revocation, idempotent same-current requests and writer fencing | Re-run exact final; no arbitrary owner/session selectors for bulk action |
| Self-only minimal login history | #40 fixed projection/function and `local-integration/login-history.test.mjs`; new original-account UI and `local-browser/login-history.test.mjs` | Source reviewed; local preparation only in this snapshot, F/G real run pending | **OPEN until actual combined PG/browser succeeds.** Latest 20 attributable events only; old hash-only failures deliberately omitted, no speculative backfill |
| Original visual/interaction style | Original Home, SettingsModal/account slots; Admin, password and sessions tests/screenshots | B/D real visible UI. Screenshots taken after one-time codes are hidden | New history UI and final composition need real screenshot/interaction review, not just a mock API test |
| Audit/secrets and external token scope | Audit DTO minimization, token hashes, restricted API; history returns time/outcome only | Existing new-local tests cover supported browser/account actions | T19 external API tokens, comprehensive audit export/retention and production monitoring remain outside this claim |

## 4. T04 isolation and revocation matrix

| Requirement from original T04 and revocation plan | Current executable evidence | Proven scope / remaining gate |
| --- | --- | --- |
| Reject privileged runtime credentials and unsafe grants | `local-integration/scoped-startup.test.mjs`, `ownership-rls.test.mjs`, startup negatives; `db/roles.ts` | D real non-owner auth/business roles. Reject owner/superuser/BYPASSRLS, DDL, excess column/grant/delegation privileges. New #40 function grants must additionally pass final admission/SQL tests. |
| A/B/Admin personal isolation through HTTP and SQL | `ownership-rls.test.mjs`, `files.test.mjs`, `revision-commit.test.mjs` | D real DB: guessed IDs, forged scope, Admin not owner, direct SQL/WITH CHECK, cross-owner composite references. Not simulated by frontend filtering. |
| FORCE RLS on actual current business resources | Migrations 0004 preferences/workspaces, 0005 files/uploads/revisions, 0006 leases/commit/outbox, job policies | D exact candidate's suites passed. Historical `dyoffice_files` lack of RLS is a separate old-stack fact, not evidence that new `files` has none. |
| Same pool A→B→none, success/error/rollback | `ownership-rls.test.mjs`: size-one pool, same backend PID, cleared transaction-local identity | D real restricted connection evidence; final must preserve source and rerun |
| Disable versus business writer, both lock orderings | `revocation-race.test.mjs`, file import authorization tests | D observed DB-lock barriers, not sleeps; preexisting writer commits first or revoked-first writer rejects |
| Password / roles / session revoke versus writer, commit and rollback | `authority-write-races.test.mjs`: 3 kinds × 4 order/rollback cases | D raw log explicitly passes all 12. Covers writer-first commit/rollback and revoker-first commit/rollback. Do not call these merely “pending source tests” anymore; do not transfer their PASS to unrun final G. |
| Bulk other-session revocation fencing | `revoke-others.test.mjs` | D real mutual/current/foreign-owner and writer-lock tests. New sessions after committed revoke are not retroactively forbidden. |
| Worker principal, wrong owner, cancelled/reclaimed/stale outputs | `test/jobs/{durable-jobs,output-commit,revision-delivery}.test.mjs`, `local-integration/job-routes.test.mjs`, native-job suites | D separate SQL/job/native-worker gates passed. SQL RLS alone is not OS process termination or recovery evidence; retain separate native-worker gate in final. |
| Direct TLS API and visible browser boundaries | `test/e2e/auth-browser.test.mjs` plus `test/local-browser/*.test.mjs` | D both exist with real services. Direct browser fetch/API tests do not substitute for visible account forms, and vice versa. Final must include the added history test, not silently skip it. |
| Wrong legacy database fails closed | `test/db-safety/legacy-database.test.mjs`, dedicated isolated guard DB | A/D CI gate; old rows remain unchanged and new ledger is not silently created. **No data migration accepted.** |
| Every future entrance | External API Token, live Agent streams, approved tools, enterprise integrations | **Not covered globally.** T19/T13/T17 must derive/fence their own principals. Current service coverage must not be renamed “all possible entrances.” |

RLS here protects supported parameterized service entry points and their SQL policy
boundaries. It is not a claim to contain an attacker already possessing an arbitrary
privileged SQL connection or control of the auth runtime.

## 5. Required final acceptance, without papering over gaps

1. Publish the final combination with exact parent(s), commit/tree and a documented delta.
2. Run final typechecks, unit/CI coverage, source/host/runtime locks and both original UI builds.
3. Run disposable real-PG local-integration including **login-history** and all 12 authority
   race cases; inspect zero required skips, actual restricted role admission and SQL grants.
4. Run visible local browser **five** test files: Admin, Home, password, sessions, history,
   plus the distinct TLS API/native DOCX browser gates. A history test file existing on disk
   is not an execution result.
5. Run wrong-ledger isolated-DB gate and separate SQL/jobs/real worker recovery gates.
   Preserve explicit production refusal. Investigate required failures; do not bypass them.
6. Record screenshots without codes/passwords and independent review. Record optional legacy
   skips separately instead of subtracting them from the new-stack acceptance count.
7. Only then update the **new-local** T03/T04 status with bounded scope and exact evidence.
   Do not check off T19, old-data import/cutover, external Office acceptance or production.

## 6. Exact stale-document correction targets for the integration owner

These are requested scope corrections, **not automatic completion checkboxes**:

- `implementation-plan.md` T03's bold “T03 身份与会话完成” paragraph and its following
  checked historical rows: label them “历史旧栈记录（MJS / dyoffice_schema_migrations）”.
  Add a new-local status link to this matrix. Replace no historical test result with
  new counts unless clearly separated by runtime and exact candidate.
- The same T03 section's “新建账号只有 user”, old migration 0001–0008, `principalContext`,
  old 155+1 count and “浏览器点击登录页未做” belong only to the old checkpoint.
  New-local uses `personal` and has B/D real visible UI evidence; its history extension
  still needs final G. Do not leave an unqualified global “browser not done” or “all done”.
- T03 “T04 only provides Principal / FORCE RLS deferred” and T04's 2026-11-15 opening are
  historical milestones. Add a dated new-stack progress paragraph pointing to section 4,
  while keeping final-combination checkbox state pending until section 5 passes.
- `evidence/t03-closeout.md`: put an explicit old-stack banner immediately after the title.
  Its role names, migration renumbering, no-RLS claim, old cookie and browser deferral
  are not the TS local runtime. Preserve the historical body; link current evidence.
- `evidence/t03-t04-acceptance-matrix.md` and
  `plans/t04-revocation-isolation-validation.md`: label “exact PG pending / no local PG”
  passages by the date/candidate they described; link D as later passed branch evidence
  and G as still-pending final combination. Do not erase the original RED/environment history.
- T05/T06 neighboring old `dyoffice_*`/JSON-journal completion claims are also stack-scoped.
  This T03/T04 document does not silently upgrade them or certify all later editor features.

A coherent plan must be accurate even while work is incomplete. These edits clarify the
evidence boundary; they cannot replace a missing test, an unsupported route, a migration
exercise, a reviewed deployable artifact or production authorization.

