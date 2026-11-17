# PDF fixed artifact and generated-fixture wire

## What actually runs

An independent pinned esbuild recipe bundles the existing rotation-job, rotate core and installed pdf-lib into a fixed `session.cjs` artifact. Despite that filename it is one request per process, not a persistent session. The entry, Node24/CJS target, minification, compiler version and flags are fixed; no caller-selected entry, compiler override or executable is accepted. Actual source/package/compiler snapshots and bundle bytes are hashed. Canonical manifest plus an externally held content digest identify these bytes. Two builds must agree.

Manifest flags remain productionEnabled=false, runtimeApproved=false and rootfsComplete=false. Source/package snapshots are not authenticated provenance. Node, system libraries, fonts and rootfs closure are not bundled or certified. Ubuntu/openEuler x86_64 are target labels only; testing is Debian13 x86_64. ARM excluded.

The fixture runner accepts only explicitly opted-in, newly generated synthetic PDFs under NODE_ENV=test. Child requires both test mode and generated-fixture flag. It runs ordinary Node with a minimal environment, no database credentials and a fixed candidate path. This is NOT an OS sandbox and must never receive real user/untrusted documents. Artifact verification followed by exec-by-path assumes a trusted temporary directory and retains TOCTOU.

## Protocol and limits

One uint32BE header length, at most16KiB canonical fatal-UTF8 JSON header, then exactly the declared raw bytes and EOF. Both directions check lengths before buffering, allocate one body Buffer only after the header validates a size at most32MiB, reject truncation/trailing data/multiple frames, and never retain an unbounded list of tiny chunks. Existing core's64MiB limit is not changed; this fixture narrows it. Command validation retains1–100 unique page operations and integer90-degree rotations. Application limits do not bound pdf-lib CPU/RSS or establish a hostile-child defense.

Request binds fresh requestId, contextId/version, jobId/epoch/attempt, fileId/baseRevision/leaseEpoch, input size/SHA and canonical command digest. Child recomputes actual input and command hashes before rotating. Result echoes the complete tuple and declares actual output size/SHA; parent requires exact tuple equality and independently recomputes bytes hash. Echo is correlation, not authentication, RuntimeHandle, execution grant or stop proof.

Child has its own fixed5s total input/operation timer; synchronous parser work cannot be preempted by that JS timer. Parent independently caps8s wall time and4KiB stderr, then uses a separate1s cleanup wait. It never delivers bytes until stdout EOF and child close with exit0, no signal/error/log output, valid one-frame response and matching tuple/hash. Timeout/error kills and waits for close; unconfirmed exit is reported as failure. A Node close observation is not cgroup/systemd/OS isolation evidence.

## Evidence and explicit orchestration

Artifact tests generate one/two-page PDFs with pdf-lib, run the actual minified child and reopen output to verify90/180-degree rotation and page count. Tests verify reproducible double-build digest, artifact replacement, production/no-opt-in refusal,32MiB limit, strict digest types, partial/trailing/multiple/malformed frames, standalone partial-input deadline, and fixed fault modes for wrong tuple/hash, truncation/trailing output, stderr flood, abnormal exit and abort. A fixed test-only15s child fault independently exercises the parent8s timeout; normal child input deadline remains5s. The1s unconfirmed-exit fallback destroys all local pipes, but that exceptional fallback was not dynamically forced. Faults are fixed repository fixture modes, not arbitrary executables. Exit-confirmation evidence is labeled child-close only.

A separate integration test explicitly composes existing real job/input/context services and real PostgreSQL pre/post verification around this generated-fixture runner. It is test orchestration, not a new production dispatcher. The owner registers the artifact content digest as a synthetic test-approved candidate to correlate bytes only, not certify runtime provenance. Success checks real rotated output. Actual job cancel, user lease takeover or context revoke between checks rejects acceptance after the child result; uploads/revisions/commits remain unchanged. It does not claim exact scheduling inside pdf-lib parsing or secure T06 saving.

Actual PDF runtime certification, authenticated broker, OS isolation, output sealing/validation, production dispatch, T06 job save and UI remain unfinished. No production permission/migration/registry is enabled here.

Final local evidence: artifact/wire4/4 and real-PG pre/post orchestration4/4 passed. Reproducible content digest `ea1c72d643113573c770e57aedb184c2d99f18418e9f3319ea4550ff92e1ccc5`; actual output angles90/180 verified. Earlier artifact `33396f...` was superseded by the bounded-body/timeout-review fixes and is not final. The initial compiler-version failure was a local dependency resolution mismatch (nearby esbuild0.28.2); pinned0.25.12 was retained and resolved from the existing matching package, not relaxed.
