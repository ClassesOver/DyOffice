# PDF input/context prepared package

## Actual gap closed

The real input-snapshot and prepared-context services previously succeeded independently. A caller could accidentally pair an old input/command observation with a newer context or another job. This test-only module constructs both services internally and performs their identity binding. It never receives caller-created authority facts/context, never spawns a process, parses a PDF, or commits a revision.

prepare captures strict claim/registry descriptors before awaiting. It obtains actual job-authorized input, checks the authenticated input-size bound32MiB, issues a real prepared context, compares every native fact and command digest, and matches the context runtime digest to the externally pinned artifact content digest. It then verifies that same context again and privately copies/checks input length/hash. The external digest is content identity only, not authenticated source provenance or runtime approval. Existing test-approved registry fixtures remain non-executable.

The package creates a requestId and fixes the full context/version, job/epoch/attempt, file/base/lease and input/command digest tuple. The generated-fixture runner can accept this explicit UUID; its default remains a fresh generated UUID. Wire, child entry, artifact builder and production registries are unchanged.

## Output and lifecycle

acceptFixtureOutput synchronously consumes the package at the first attempt, before any await. Invalid shape/hash/binding also consumes it; concurrent or later accepts cannot both succeed. It captures exact own-data fields and privately copies the output before awaiting, enforces32MiB and actual SHA/size, then performs a fresh PG verification of the same context and every originally pinned fact/command/registry/runtime identity. It checks cancellation/gate/deadline immediately before returning an explicitly labeled fixture-output observation. After consumption, copyInput refuses.

All observation lifetimes are anchored at their individual monotonic call starts and combined by minimum. Later verification never extends an earlier budget; remainingMs is only a returned snapshot, not permission to restart a timer. copyInput checks local test gate, known cancellation and deadline, not a new database authorization on every copy. Returned output bytes are ordinary mutable copies, not sealed memory.

Issue can commit a non-executable context before its reply is lost or later binding fails. The module does not automatically issue again, process again, guess a cleanup ID, revoke an unconfirmed context, or release a potentially shared lease. Such contexts remain bounded by existing expiry. Separate transactions still allow revocation immediately after a successful observation. Future execution/save must check again.

Tuple/hash/fixtureOnly markers cannot authenticate child origin or prove that particular code ran. This module does not perform PDF structural/active-content validation, certify OS isolation, issue a runtime/save grant, or write T06. Only trusted newly generated synthetic PDFs are executed by tests through the already bounded fixture runner; untrusted/user documents must not be sent there.

## Tests and limits

Actual isolated PG/local-object tests cover successful input→context→fixed artifact→postcheck with actual90-degree output; revoke after child result; wrong pinned artifact; consistent command+job-hash rewrite after the input's final real COMMIT but before issue; exact revoke after issue COMMIT; private output capture and Promise.all concurrent accepts; wrong tuple consuming the package; one unknown issue reply leaving exactly one non-executable context without replay; and local signal cancellation before preparation (zero contexts) or after fixture output (one-shot rejection). SQL/Pool proxies only pause after actual COMMIT and perform real separate DB mutations, never fabricate authority responses. T06 uploads/revisions/commits remain unchanged by the package; real lease/context rows can be created.

First3/3 and expanded8/8 passed; final scope adds the direct signal-cancellation case for9 package tests. Final combined evidence and independent review are in the handoff/PR. Host is Debian13 x86_64/PostgreSQL17/local objects. Ubuntu/openEuler x86_64, browser/desktop acceptance and production isolation remain unverified. No ARM target, no production wiring or full T11 closure.
