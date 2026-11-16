# PR #21 integration boundary

This candidate combines `feat/dyoffice-web` at `9410065e1cfb3be421c30b9e3a846c5477dbb606`
with PR #21 at `bdaee1b3a5f44c1b7418cf4a9d6c12f4c3b3cca0`.
It is not a database migration from the legacy stack and does not authorize production.

## Preservation and separation

- Keep PR #24's conservative DOCX table editing, unsupported Save As/create behavior,
  Web desktop bridge and safety regressions.
- Keep the original Home/Settings development entry and UI components. A local-account
  entry must use the new cookie/CSRF API, not silently fall back to shared-token JSON data.
- Preserve both histories' README descriptions. The implementation plan and BrowserHost
  file contract are three-way merged, rather than replaced by the older branch.
- Authentication is local username/password, not OIDC.
- Legacy `server/db/migrations` and new `server/src/db/migrations` are distinct schemas
  and ledgers, not one concatenated migration list. Duplicate numeric prefixes across
  those directories do not make the SQL interchangeable.
- The new migrator and startup check reject a database containing the legacy
  `dyoffice_schema_migrations` relation in any non-system schema. Detection precedes
  new DDL; catalog-query failures propagate. No old credentials/files are silently
  imported, reset, deleted, or assigned to the first new account.
- Existing legacy deployments must not point the new runtime at their database. A
  future explicit, reviewed data conversion and rollback plan is still required.

## Verification scope

The integrated source passed Web typechecking, legacy HTTP regressions, original
Home/Settings component regressions, production-build HTTP smoke checks, dependency
boundary scanning and compatibility-input validation during preparation. These are
not proof of real PostgreSQL authorization or browser login acceptance.

The local executor has no PostgreSQL/Redis service. The first clean root dependency
install exceeded temporary filesystem capacity. The candidate was moved to the
workspace volume and a complete `npm ci --ignore-scripts --include=dev` subsequently
succeeded. The exact published candidate's CI must independently install the locked
workspace dependencies and run the real services.

The new wrong-database regression requires its own disposable real PostgreSQL database,
`dyoffice_test_legacy_guard`, separately from all account/revision fixtures. It verifies
hidden-schema detection and unchanged legacy rows/new ledger on rejection. Missing
configuration is a failure, not a skip. Existing new-stack bootstrap concurrency,
owner-isolated jobs, revisions and RLS tests must also pass on the integrated tree;
older-stack PostgreSQL results cannot substitute for these checks.

Production startup remains refused. Passing local unit tests alone is insufficient to
merge this candidate as a validated local-account editor.

PR #29 PDF viewer is preserved. Shared static serving retains both its PDF CSP/MIME
changes and the native-entry page/asset-inventory/cache-policy options; this is an
explicit three-way resolution, not a whole-file replacement.
