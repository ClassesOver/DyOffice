# T03 self login-history design

Goal: fulfill T03d's self-only login-history summary without a raw audit export.

Approved scope: GET `/api/v1/auth/login-history`, cookie-only, fixed latest 20 records, each exactly `{occurredAt, outcome}` with success/failure/throttled. No owner, account hash, deployment, pagination or arbitrary selectors. No IP, user agent, request ID, credential material, account names or session identifiers. Existing `Cache-Control: no-store` applies.

Approaches: whole-table auth SELECT is rejected as unnecessary exposure. Joining historical username HMACs is rejected because rename/reuse makes historical ownership unknowable. Selected design: future failed/throttled attempts bind immutable `subject_user_id` at one atomic INSERT…SELECT MVCC statement snapshot; known success and prior authenticated failures use their immutable actor. Unknown accounts and legacy hash-only failures remain unassigned and are omitted, not backfilled.

Attribution is defined at audit statement snapshot, not request start or password verification. Uncommitted rename uses the still-visible old owner; committed rename uses the new owner or no owner. This avoids a known-account row-lock timeout oracle without suppressing audit errors.

A new forward migration installs a fixed-output SECURITY DEFINER function. It accepts only deployment, live credential hash and server-configured idle lifetime, and reuses the database user→session lock/revalidation guard to derive ownership. Only auth receives EXECUTE, never raw audit SELECT or grant option; business/worker/PUBLIC are denied. Runtime admission verifies owner, search_path and exact privileges. Existing trusted migration-owner model is retained, not a new privileged login.

Non-goals: full audit export, historical attribution recovery, IP/device display, account renaming API, arbitrary pagination. UI must say recent attributable records, not complete audit history. Old migrations and their checksums remain unchanged. Exact PostgreSQL CI is mandatory before completion.
