# T13 integration on the current target (not mounted)

Base inspected: `b66f2516c113d57d461b323e3b8827affaa28869`.
Integrated source: #78 `f48c889f177f9423fbf000ff982097bfaee87339`, including #74/#76.
This combines the admin-only budget/credential/pinned transport/parser/HTTP pipeline
with the already-merged cumulative output and cancellation authority bounds from
#89/#95. It does not enable the application route or ordinary-member consumption.

## Integration controls

- Reconstructed target source from its recursive tree and reconciled all changed
  source files; branch-added source blobs match #78. No T10/T14 source rollback.
- Six overlapping files reconciled: migration manifest, provider README/turns,
  two unit test files and BrowserHost AI transport. Existing output/cancellation
  guards coexist with disconnect signal and modelId/CSRF handling.
- Exactly one new migration: 0021_provider_budget after 0020_command_journal.
- Existing app.ts stays unchanged and does not mount provider routes. Credential
  RLS is unchanged. Runtime budget grants remain explicit trusted provisioning.

## Executed verification

- Focused provider/transport/HTTP: 174/174, no skips.
- Entire Web unit directory: 296/296, no skips.
- Ordinary Web: 274 passed, 1 existing explicit MinIO skip, 0 failed.
- Full browser/server TypeScript: passed.
- Web boundary checker: 998 files, 0 violations.
- Fresh isolated PostgreSQL 17 budget/credential/pipeline suite: 30/30, no skips.
  Credentials were synthetic; DNS/HTTPS mocked. No external model was contacted.
- Independent integration review found no blocker and reran overlap tests 42/42.
  The reviewer did not rerun PostgreSQL.

Two early local attempts never reached database assertions: plain strip-types
could not resolve an existing extensionless import, then copying a snapshot without
its app-local dependencies resolved yauzl 2 instead of the locked app-local 3.4.
Using the repository tsx runner and correct app-local dependency tree fixed the
execution environment; the complete suite was rerun green. No product workaround
or dependency/version change was made for those setup failures.

## Remaining gates

Still unmounted and admin-only. No real DNS/TLS peer/proxy/provider acceptance,
real key or document egress, ordinary-member entitlement, distributed admission,
vendor monetary guarantee, native/full monorepo suite, or production readiness is
claimed. Migration compatibility must be rechecked against the final merge target.
CI is not required by current owner direction; Actions configuration unchanged.

## Target refresh before publication

Refreshed to `bb6a77b23f3d9f77f8370acabc6687095eedbd86`: four T14 disposal
files only, no provider, authority or migration overlap. Their exact contents are
preserved. The full unit directory and browser/server TypeScript were rerun after
this refresh; the PostgreSQL30 and ordinary Web274+1 results above are from the
preceding b66f2516 candidate. No claim of rerunning those two suites on bb6a77b2.

## Final target refresh and repeated verification

Final publication base: `8931c4f495720564887490666714547c95b6d7ac` (#99).
Only three PDF raster files changed since bb6a77b2; all retained, with no provider
or migration overlap. Repeated verification on this final candidate: PostgreSQL
30/30, Web unit301/301, full browser/server TypeScript passed. Ordinary Web parallel
execution initially had one process-level pdf-cmap-safety failure without an
assertion diagnostic (279 passed,1 failed,1skip). The same CJK test passed isolated
1/1; the entire ordinary suite rerun serially passed280 with1explicit MinIO skip.
No code was changed to silence it; the precise cause of the parallel process exit
was not established, so it is not described as a proven product defect or a full
parallel pass. The resource-constrained run is disclosed rather than erased.
