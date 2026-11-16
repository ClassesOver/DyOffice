# T04 bootstrap after FORCE RLS

`0006_bootstrap_rls.sql` repairs first-admin initialization without modifying the
checksummed `0001`–`0005` migration history or removing FORCE RLS. Apply migrations
before invoking the existing local bootstrap CLI. PostgreSQL 16 is required.

Each database gets `dyoffice_bootstrap_<database OID>`. PostgreSQL database OIDs
are cluster-unique, so separate databases do not share bootstrap membership or
policies. A role already present at that exact identity causes migration failure:
no existing members, ownership or ACLs are silently adopted. The immutable journal
skips an already-applied 0006. DDL identifiers are quoted with `format('%I', ...)`;
role identity comes from `pg_database`, never HTTP/CLI user input.

The NOLOGIN, NOSUPERUSER, NOBYPASSRLS role can SELECT and INSERT only the four
identity/bootstrap tables. It cannot update credentials or access file/revision
tables. The migration executor receives membership with INHERIT FALSE. The CLI
uses fixed SQL `set_config('role', ..., true)` within its existing atomic
transaction; PostgreSQL checks SET ROLE authority and resets the role on exit.
This is a persistent operator capability, not request authorization. Never grant
it to app/auth logins, reuse migration/operator credentials in runtime pools, or
expose bootstrap over HTTP. A database restore into a new database identity needs
explicit operator-role reprovisioning; do not blindly drop/reuse old roles.

The regression preserves the 0005 checksum, journals 0001–0005, rejects a
pre-existing role without journaling 0006, and then applies 0006. It bootstraps
through an independent non-superuser/NOBYPASSRLS table owner, tests concurrent
exactly-one initialization and role reset, and rejects independent app/auth login
role switches. Another database in the same cluster must migrate and bootstrap
under a different role; neither database's operator can use the other's role.
The hasher is a fixture in this RLS test; Argon2 verification remains in the
local-identity integration test.

Local validation: identity/migration/bootstrap tests passed; real PostgreSQL was
skipped because no server/URL was available. The T04 workflow runs the upgrade
test first on fresh PostgreSQL 16, then the existing ownership suites. SQL role
switching, cross-database isolation and upgrade behavior remain a merge gate until
that real CI run passes. This does not establish general production readiness.
