# T13 admin-only persistent admission ledger (unmounted)

## Scope and dependencies
This stage adds migration `0021_provider_budget.sql`, a narrow server service and
real PostgreSQL tests. It depends on identity/session/business transaction support
and T12 `0018_global_config.sql` (`global_config_authorized` plus the configuration
writer advisory lock). It does not reference T14 `0020` tables. Migration ordering
is 0018, 0019, 0020, 0021 in the integrated manifest. This final stage appends
0021 after T14 draft #73 (ca6eba591ad60007f68ddd31a93c20af67aa5e6f); roles.ts
is unchanged, with an explicit trusted grant helper required for budget execution.
No app route, provider transport, secret policy or ordinary-user permission changes.

Only an authenticated, current `config_admin` session may use the ledger. The SQL
function independently rechecks actual session hash, user/session/deployment and
live admin role, before work and after row-lock waits. All reservation access binds
deployment, user, session, turn, entry, config revision and canonical request digest.
The caller must compute the digest from its server-owned canonical request, never
accept a client-declared digest as evidence. Token strings and request content are
never stored in these tables.

## Default deny and trusted provisioning
There is no default account and no credit API. Missing accounts fail closed;
`available_units` defaults to zero. The trusted migration owner must separately
provision an account for the exact user/entry/config revision and choose positive
`per_call_units`. Runtime never receives INSERT/UPDATE/DELETE/SELECT on either
ledger. Both tables have FORCE RLS; their sole policy permits only the trusted
migration owner, which also owns the fixed-search-path SECURITY DEFINER function.
The function performs all runtime scope/role checks explicitly. Public receives
neither table nor function privileges.

After applying 0021, an operator may call `grantProviderBudgetRuntime(ownerPool,
businessRole)` from the server module. This grants only EXECUTE on the one bounded
transition function. It grants no global_config_secrets access and does not alter
roles.ts. Do not grant this function or table ownership to client-facing roles.
The migration owner remains trusted to provision and reconcile internal accounting.

**Units are conservative internal per-call accounting, not precise token billing
and not proof of a vendor currency spending ceiling.** Actual dispatch remains
blocked until trusted pricing, bounded input and max_tokens/output enforcement,
provider protocol limits and scoped secret/egress adapters are integrated. A user
cannot select the cost: reservations capture the preprovisioned per-call amount.
No available amount is refunded for absent usage, timeout, provider failure or
unconfirmed dispatch. `settle` always charges the full reserved amount, including
when token usage is missing; it has no caller amount or token argument.

## Transactions and crash safety
Lock order is T12 shared configuration lock -> budget account -> reservation.
Reserve atomically subtracts account availability. Identical scoped turn bindings
return the same reservation; altered entry/revision/request digest cannot reuse it.
A returned existing cancelled/settled/unknown reservation never authorizes dispatch.
The service has no network callback and returns only after its principal transaction
commits. Callers must not implement provider I/O inside these DB transactions.

- `reserve(token,binding)` -> reserved; exact binding is idempotent.
- `claim(token,binding)` -> dispatching, with fresh durable claimId. Exactly one
  concurrent claim succeeds. A repeat never returns a reusable dispatch permit.
- `takeForDispatch(token,binding,claimId)` -> unknown. Exactly one transition from
  dispatching succeeds, commits its irreversible dispatch intent and only then
  returns binding data. The scoped secret consumer must call this immediately
  before its own locked revalidation/decryption/callback. A later secret/config
  failure stays unknown and holds funds; do not retry dispatch automatically.
- `verifyClaim` is read-only validation of dispatching, NOT permission to send.
- `markUnknown` retains the hold without authorizing a send.
- `settle` accepts unknown or already settled with exact claimId, charges the full
  captured amount and is idempotent. It never refunds based on missing usage.
- `cancel` refunds only reserved, once. Claimed/unknown/settled records never refund.
- `status` returns only the current caller's exact session-bound record.

A process exiting after takeForDispatch committed leaves unknown across service
recreation. Claim/dispatch/cancel replays cannot send again or mint funds. An
operator must reconcile orphaned dispatching/unknown records conservatively; there
is intentionally no TTL release. Revocation can prevent later settlement but cannot
release held units. Production reconciliation policy remains a separate gate.

## Verification
Unit RED: absent service failed the existence/ordinary-user rejection test, before
implementation. Unit GREEN: 1/1. Real PostgreSQL was run only after implementation;
initial fixture attempts exposed missing copied dependencies and T12 FORCE RLS on
owner fixture setup, corrected by establishing the actual admin session context.
These setup failures are not claimed as behavioral RED tests.

Real PostgreSQL 17 isolated port 55449, each case in fresh database/roles: 9/9,
zero skips. Coverage: missing/zero budget, ordinary-user denial; concurrent reserve
overspend prevention and changed-digest replay rejection; single claim and dispatch;
unknown hold and idempotent full settlement; config revision change; cancel/claim
race; cross-session and forged claim IDs; runtime direct DML/auth-role denial;
revoked session; a separate Node process exiting 77 after committed dispatch intent
followed by persistent unknown and rejected replay/refund. No provider/network test
or shared application database was used. Isolated PostgreSQL shut down afterward.
Strict targeted TypeScript check passes. This is not a full repository test pass,
financial-spend guarantee, ordinary-user AI support or completed T13 acceptance.

Final integrated verification: automatic loadMigrations applies 0021 (no manual
SQL patch in the fixtures); 19/19 real PostgreSQL cases pass, including 10 budget
cases and 9 secret-consumer/composition cases. The added budget case uses two
distinct admin login sessions competing for one remaining fixed-call allowance;
exactly one reservation commits and available units remain zero. Combined unit
checks pass 23/23. No full monorepo test result is claimed.
