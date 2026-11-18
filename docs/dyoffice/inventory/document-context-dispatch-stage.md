# Context-bound restricted dispatch candidate (not production admission)

This optional, unregistered SQL candidate composes the existing native-authority,
unified-context and restricted-dispatch candidates. It changes no application
migration manifest, production grants, runtime allowlist, Rust launch constructor
or backend. Production broker/runtime approval stays unavailable. The new
classification is deliberately not accepted by the existing Rust native-only
consumer. A separately reviewed trusted composition is still needed there.

## What is actually bound

A restricted issuer supplies its already assigned reservation, native job claim
hash and trusted ContextRef/version. The SQL first checks the actual login role
OID/assignment, then calls existing `document_verify_context` and compares the
entire server-issued JSON request against the reservation, including tenant,
session binding, generation, runtime digest and policy. It records an immutable
reservation/context/version binding, calls the native issue transition and repeats
the context check after its native/capacity waits. Failure rolls back both the
binding and the transition. No client-provided request fields become authoritative.

The context consumer reuses restricted native caller identity, job/session/file/
lease fencing, reservation/epoch CAS and broker identity checks, then verifies the
recorded context again. A trigger also enforces context verification on the first
consume transition through the older native API, so that API cannot bypass a
recorded context's revocation. Legacy unbound dispatch remains native-only. Exact
replay through that older API remains `already_consumed` historical metadata,
not context authorization; the new API rechecks context even for exact replays.

All new helper/table ACLs are private, all definer search paths fixed, and no
PUBLIC execute privileges are added. This is not a malicious schema-owner defense.
The stored native claim remains in the existing private table, never returned.
A failed consume does not release capacity or erase a potentially submitted job.
An observed successful check is revocable after commit; it is not an irrevocable
lease, a launch grant, a stopped-cgroup proof or an execution result.

## Scope and evidence

The only unified context model currently supports immutable native read-only
PPTX outline, generation zero and an explicit **test-approved** runtime registry.
No real runtime has been certified; an absent/revoked registry or stale version
fails. Nothing here enables DOCX/XLSX/PPTX/PDF production sandbox execution, creates
a rootfs, installs the candidate, registers a production principal, or grants
privileges to an existing production role.

Verification uses a fresh disposable local PostgreSQL 17 cluster, actual restricted
LOGIN connections and the real existing SQL transaction functions. New cases cover
whole-request mismatches, wrong/missing/stale contexts, native lease changes,
registry revocation, private immutable bindings, context revocation during a
capacity-lock wait, foreign-login early rejection and lease expiry after waiting.
Existing restricted-dispatch tests retain the actual file import -> enqueue ->
claim -> job-lease -> issue/consume service path (PDF native-only, not the new
PPTX context path). New context tests seed native rows through the existing test
fixture; they are not a full live service-to-engine workflow. Kernel sandbox,
production TLS/login provisioning, full four-format flows and browser acceptance
are NOT_RUN. No fake runtime or mock database is presented as production evidence.
