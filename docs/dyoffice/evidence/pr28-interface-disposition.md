# PR #28 interface disposition and remaining authorization regressions

> Owner scope update, 2026-11-16: legacy-database import/conversion is explicitly excluded from this delivery and is not an acceptance blocker. Preserve fail-closed rejection of accidentally connecting the new runtime to a legacy ledger and preserve existing data. No automatic conversion, reassignment, deletion or claim that migration was implemented.

Read-only review of #28 head `a2e4a67ba4b221b45a2ad785cab666377903111d`.
All 59 server blobs were compared to GitHub's non-truncated recursive tree and matched
their Git blob SHA. This is a complete **server-source** check, not a claim to have
rebuilt that whole historical repository. Comparison target is the new-local source
in the final-combination workspace (still unpublished), whose relevant base is #38
`57e72697e50d904b101c26e1ec477afd6a304e5e`.

No branch was modified, merged or closed. Four isolated diagnostic probes passed;
they use fake query responses to establish interface/control-flow behavior and are
**not real PostgreSQL/RLS acceptance**. The proposed three new-stack PG regressions
are syntax-checked only and require the final candidate's real-service CI.

## Actual callers, not statements in PR prose

| #28 export/change | Actual #28 server caller | New-local replacement / disposition |
| --- | --- | --- |
| `createAuthorizer(pool)(principal, action, resource)` | No production caller found in the complete 59-file server tree. Only its own definition/import of the transaction helper. Tests invoke it; the “T08 calls” comment/README is not wiring. | Do not add an alias merely to satisfy the old name. Current jobs actually call `runFileTransaction` through `modules/jobs/service.ts`, derive authority from credentials and query owner-scoped job/revision rows. |
| `withPrincipalTransaction(pool, principal, fn)` | Only the above authorizer in server code | New `createPrincipalTransactions(...).withPrincipalTransaction(credential, fn)` is not drop-in. It verifies locked live session/job capability, derives the principal, sets transaction-local scope, rechecks before COMMIT and discards connections after rollback failure. |
| `principalFromSession` | Old `src/app.mjs` optional `config.auth.authenticate` hook | New `buildLocalApp` mounts native auth/permission services. The old role whitelist rejects new `personal`; blindly connecting a new session result returns null/401. |
| `ownerIdFromRequest` | Old `modules/objects/routes.mjs` only; falls back to context's development owner | New files/upload/content routes derive owner in the business transaction. Old objects URLs are not aliases; fallback is explicitly unimplemented in cookie mode. |
| Request principal in old revision routes | Old legacy-dispatch route, still using a JSON journal/runtime default principal during head registration | New revisions/leases go through authenticated SQL business transactions. Do not attach old shared journal/state to cookie login. |
| `config.auth` and `legacy` mode boundary | Old `assertModularConfig` explicitly rejects using both | Valuable fail-closed intent retained by new mode split. There is no reachable supported “old authenticated shared workspace” that needs to be resurrected. |
| `0005_rls.sql`, forward `0006_bootstrap_rls.sql` and historical bootstrap changes | Old migrator/old `dyoffice_*` tables and old-role deployment | Preserve as a separate old-stack repair/migration candidate if such installations need support. New ledger refusal does not apply those fixes, migrate old data, or make old applied checksums interchangeable. |

### Confirmed interface differences

- Old authorizer accepts `file:read/write/delete`, `object:read/write`,
  `revision:read/commit`, `job:enqueue/cancel`, but every action executes the
  same file/revision-file visibility lookup. It does not check an actual job row,
  current session, auth_version, claim epoch or action-specific mutation.
- Its `artifactId` is a **file identifier** (including `dyoffice_revision_files.file_id`).
  New enqueue input's `artifactId` is a **revision identifier**, and cancel takes
  **job ID**. Treating these as interchangeable can authorize the wrong resource.
- Old wrapper trusts its already-normalized principal; no live-session query occurs.
  The new wrapper accepts session/job secrets, not a caller-built owner/role object.
- Old rollback-error handling swallows ROLLBACK failure and releases without a poison
  argument. The new wrapper passes the error to release/discard. This is a diagnostic
  old-code limitation, not evidence that the current new-local path has that bug.
- Old `user` role and new `personal` role are intentionally different contracts.

## Existing new-local coverage versus narrowly remaining gaps

The current new stack already has real cross-user/Admin tests; do not duplicate
or label them all missing:

- `local-integration/job-routes.test.mjs`: B and config Admin cannot read/cancel
  A's job or enqueue from A's revision; lists return no foreign jobs; forged owner,
  unsupported executor and hostile paths reject; dev/off mode does not enable jobs.
  It also launches the actual configured API entry, not only an injected mock server.
- `jobs/durable-jobs.test.mjs`, `output-commit.test.mjs`: worker admission, job
  capability/claim epochs, stale/cancelled/revoked claims, bounded file input/output.
- `ownership-rls.test.mjs` and file/revision suites: A/B/Admin ownership, raw SQL
  restrictions, composite scope constraints, same-pool identity cleanup and rollback.
- `authority-write-races.test.mjs`: password/role/session revocation orderings and
  writer/revoker rollback. #38's real PG run passes these 12 cases.

Remaining regression opportunities, not confirmed production vulnerabilities:

| Gap | Why useful | Proposed regression |
| --- | --- | --- |
| Old shared object/source/conversation/config endpoints in a **fully configured** local app | Existing mode-isolation tests emphasize the auth-only fixture or a smaller URL set. Ensure adding real business/file/job modules never revives old JSON/objects routes. | Valid A/B/Admin cookies must receive explicit 501 on old unimplemented routes, never shared content; keep this separate from new owned preferences/files. |
| Foreign vs nonexistent job ID error equivalence | Existing tests assert foreign 404 but do not compare its public envelope with an unknown job. | Compare full GET/cancel public body excluding server-generated requestId for B and config Admin. |
| Revoked credential mutation on an owned job after role epoch change | Existing job HTTP test revokes then reads; generic authority tests cover writes, but the actual enqueue/cancel route should also remain fenced. | Change owner roles, then old cookie cannot enqueue a new job or cancel its old owned job (401). |
| Legacy deployment continuity | New stack intentionally rejects the old ledger; no legacy importer/cutover test exists. | Separate approved backup/mapping/checksum/row-count/rollback exercise if an actual old deployment is identified. This is not solved by a new API compatibility test. |
| External tools/tokens/streams | Not actual implemented #28 production callers and not covered by cookie-job acceptance | Leave T19/T13/T17 open; do not fabricate a generic principal adapter as coverage. |

`pr28-runtime-boundary.test.mjs` contains the first three proposed tests, intended
for `apps/web/test/local-integration/`. It imports the existing restricted PG fixture,
has no mock/skip path, and has not been counted as passed. It can be included by the
integration owner after review and run with the final candidate's ordinary local
integration CI glob. No other worker's source/test file was edited.

## Migration value and conclusion

**Safe replacement direction:** for the actually implemented new-local preferences,
files/revisions and job API, retain the stronger new credential-derived transactions,
RLS and service-specific owner checks. Preserve #28's default-deny, config-admin-is-not-
owner, pool-cleanup and hidden-resource intent as executable requirements, not old
function aliases or concatenated SQL migrations. Require final combined real PG tests.

**Not safely replaceable by assertion:** old deployed schema/credentials/data, old
bootstrap repair and applied migration histories. Their existence in production has
not been established, and new refusal is not conversion. Keep #28 open/unmerged while
the integration owner records this disposition and any real legacy-support decision.

No uncovered active new-local caller of the old `createAuthorizer` was found.
Unimplemented old routes stay unavailable rather than pretending to be adapted.
A statement that #28 “fully completes T04” is broader than its actual callers and
tests; conversely, none of the diagnostic probes is proof of a new-stack exploit.
