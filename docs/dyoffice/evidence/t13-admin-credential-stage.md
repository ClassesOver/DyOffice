# T13 admin-only scoped credential consumption (unmounted)

Depends on T12 backend #72 (0018/0019) and the companion 0021 provider budget stage.
T14 reserves 0020 independently. This stage does not add routes, enable ordinary
members, alter secret RLS, call a real provider, or claim full T13 completion.

## Authorization and dispatch boundary
T12 keys belong to a deployment, not to a personal user. Only config_admin sessions
may consume them here. Enabled/public model visibility is NOT delegated spending
authorization. Ordinary-member entitlement/credit allocation remains undesigned.

The factory accepts trusted server-only dependencies. Its consumer is injected
once by reviewed application composition, never supplied by an HTTP request.
The budgeted composition atomically consumes a previously claimed reservation via
takeForDispatch in a separate committed transaction (dispatching -> unknown).
Only that unique winner may enter the secret callback. Repeated, failed or crashed
operations cannot automatically dispatch again. Failures after the gate hold funds;
they are not proof that no upstream request occurred.

The callback transaction locks/revalidates the authenticated session, requires
config_admin, installs verified session hash/idle context for existing RLS, acquires
the shared deployment config lock, then rechecks SQL authorization. Entry kind chat,
enabled state, revision, provider id, base URL, model and deployment must match one
exact preconfigured profile. The shared lock excludes T12 configuration writers.
The DB secret AAD binds deployment/entry/provider/kind. It cannot be used across
those boundaries. Configuration/admin revocation committed before admission denies
entry. Session expiry during the callback is caught by final principal recheck,
but cannot retract an external side effect; unknown remains conservative.

## Credential lifetime
Keyring bytes are copied into a private closure; dispose clears that copy and
prevents new operations. A decrypted credential is passed as a temporary Buffer,
and known plaintext intermediates plus the callback Buffer are overwritten in
finally. Callback return values are discarded; errors become a fixed generic
message without upstream error causes, response bodies, endpoint or secret text.

This is NOT a secure enclave: trusted callback code can copy/retain bytes, native
crypto may have internal copies, and JS strings elsewhere cannot be reliably erased.
Do not claim Buffer.fill erases all copies. Consumers must not stringify/log keys,
retain credentials, emit request documents to logs, or return unfiltered provider
errors. dispose does not synchronously stop an already-running consumer.
No callback can be accepted from an untrusted plugin or request.

## Not yet implemented / production blockers
The endpoint profile is an exact allowlist, NOT DNS/SSRF protection. The eventual
reviewed transport still must pin vetted public addresses, forbid redirects and
retries, cap bytes/tokens/time, propagate AbortSignal and prohibit arbitrary headers.
The callback is awaited to completion before memory cleanup; uncooperative consumer
code can retain locks. Production transport deadline/teardown and admission capacity
remain mandatory.

Budget units are a fixed internal per-call conservative debit, not verified vendor
monetary cost or token-accurate settlement. Missing usage never causes an automatic
refund. Real pricing/output limits and operational unknown reconciliation remain
required before real use. No ordinary-member credential authorization is provided.

## Verification
Unit tests use real T12 encrypted synthetic envelopes, not real provider secrets.
They verify callback-only consumption, no return-key path, replay rejection through
the injected gate, failure cleanup, redaction, keyring snapshot/dispose, abort,
configuration mismatch and forbidden profile extras. Full repository tests are not
claimed by these targeted checks.

Final integrated verification on T14 draft #73 plus this stage: 22/22 credential
unit tests (23/23 including budget unit), and 19/19 PostgreSQL cases (10 budget,
9 credential/composition), zero skips. Automatic migration manifest applies 0021.
Real tests include concurrent budgeted callback replay, account admission across
two sessions, configuration changed during lock wait, admin role removed during
configuration wait, clock-based session expiry during that wait, and session
revocation committed before principal admission. No callback runs in denial cases.
Known plaintext buffers are zeroed after success and transaction failure.
The immutable scope includes requestDigest/turnId for future transport checking,
but no actual HTTP body exists here, so body-bound external execution remains unverified.
Independent final reviewer reran the 23 targeted unit tests and inspected the
integrated code/PG tests: no identified draft-publication blocker; they did not
rerun PostgreSQL. Full server TypeScript passed. The ordinary Web test directory
passed 265 with one explicit MinIO test skipped because DYOFFICE_S3_ENDPOINT was
not set (266 total, zero failures). The PG suite above does not claim S3 coverage.
The entire Web unit directory also passed 125/125, zero skips, on this snapshot.
No full monorepo/native engine suite or real upstream provider call was run.
