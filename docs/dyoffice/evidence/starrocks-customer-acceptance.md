# Customer StarRocks recheck — 2026-11-17

This follow-up supersedes the earlier network-timeout verdict in `workspace-source-tools.md`. The test used the exact customer endpoint and credentials provided by the user; neither passwords nor raw customer rows/grants are stored in the repository. No account, grant, table, route or firewall changes were executed.

## Observed customer results

- The previously blocked TCP endpoint became reachable and returned the MySQL protocol handshake in approximately 74 ms. The existing route now used the host LAN interface; the agent did not change it.
- Login succeeded. Separate single-expression queries identified **StarRocks 3.5.7-d2da301** and selected database **rj**. The MySQL compatibility VERSION() string is 8.0.33 and is not the StarRocks release number.
- A bounded information_schema table sample returned ten base tables. A single existing customer table was read with LIMIT 1; one row/14 columns were received and discarded without printing data values.
- A generated, non-customer series returned exactly 1,001 values (1 through 1,001). Decimal text `12.50` and BIGINT text `9007199254740993` were preserved by the diagnostic driver. This does not change the current application's number-based snapshot limit.
- The target rejected TLS negotiation with `HANDSHAKE_NO_SSL_SUPPORT`. Subsequent user-authorized read-only diagnostics used plaintext explicitly and are not secure-transport acceptance. The application still requires verified TLS unless the operator explicitly approves this exact target as insecure/private.
- SHOW GRANTS proved the supplied account inherits the **root** role. A dedicated least-privilege read-only account has not been supplied or created. No unsafe INSERT/UPDATE privilege test was attempted on customer data.

## Confirmed product defect and repair

The generic MySQL adapter issued `SHOW GRANTS FOR CURRENT_USER()` and assumed the grant was in column zero. StarRocks 3.5 instead accepts `SHOW GRANTS`, returning **UserIdentity / Catalog / Grants**. The old path therefore surfaced a generic 502 before evaluating permissions.

The adapter now selects the correct dialect statement and decodes the named columns. Its narrow positive grant validator accepts only explicit internal-catalog SELECT on the approved database's tables/views (and optional internal-catalog USAGE). It rejects root/admin or unresolved inherited roles, writes, grant option, other databases/catalogs, malformed result shapes and multiple statements. It does not infer read-only authority from an account name or from a read-only SQL parser alone.

The test-connection endpoint now reports `READONLY_ROLE_REQUIRED` for a 403 and the management UI explains that an approved, dedicated read-only account is needed.

## Executed verification

- New StarRocks dialect/shape/grant cases + existing source security/wire-budget checks: **11/11 passed**.
- Source-management and workspace-tool regressions: **19/19 passed**.
- Targeted real PostgreSQL excess-privilege test confirms the public connection-test result uses `READONLY_ROLE_REQUIRED`: **1/1 passed**.
- Source UI suite including the new privilege message: **9/9 passed**.
- Server/shell TypeScript and diff checks passed.
- Against the actual customer root account, the repaired product connector now rejects with **403 / READONLY_ROLE_REQUIRED**, observed in approximately 46 ms, rather than the old dialect failure 502. The intended `SELECT 1` application query is not admitted after privilege rejection.

## Acceptance ledger

| Gate | Verdict |
| --- | --- |
| TCP/login/server identification | Passed on recheck |
| Bounded read-only customer sample | Passed for the explicitly authorized diagnostic |
| Native grant-statement/column-shape compatibility | Fixed and exercised against the customer server |
| Reject supplied root-role account in product | Passed |
| Successful product query using a dedicated read-only account | Blocked: account not supplied |
| Verified customer SQL TLS | Blocked: server does not support TLS negotiation |
| Safe inherited read-only role expansion | Not implemented; unresolved roles fail closed |
| Production release acceptance | Not claimed |

References used to verify the server dialect: StarRocks official `branch-3.5` documentation, `docs/en/sql-reference/sql-statements/account-management/SHOW_GRANTS.md`; official generate_series documentation. Customer acceptance remains conditional on a properly scoped source account and an approved transport configuration.
