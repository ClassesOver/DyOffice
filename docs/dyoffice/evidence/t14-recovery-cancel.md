# T14 recovery cancellation correction

Independent draft based on #87 e662ff0. No merge, mounted route,
real credentials or real user documents changed.

The recovery transport previously checked abort only after awaited CSRF/fetch/read
operations returned. An uncooperative pending operation therefore never settled the
public request after cancelPending/dispose. reader.cancel was also awaited, so an
uncooperative cancellation could keep an error pending indefinitely.

The candidate races each wait against cancellation and observes late failures, retains
late-response cleanup, cancels streams without waiting for cleanup, and preserves
late-dispatch/result fences. This does NOT roll back already sent mutations, add a
request deadline, or retry any request.

Two initial new tests failed with pending instead of stopped. Independent review
found an additional response-arrival/cancellation microtask window; that regression
failed with cancelled=0 before the request-finally cleanup fix.

Final targeted tests: 18/18 independently rerun. Web unit: 328/328, zero skips.
Strict focused TypeScript passed. Full npm test attempted: exited 137/Killed in
@genoffice/docx-engine after earlier packages passed, so full monorepo is not passed.
Initial concurrent test:web:260pass/3fail/1skip: auth-only-admission and pdf-cmap-safety
process failures, orphan-reclamation missing yauzl export from incorrectly selected
root dependency. Restored candidate-local dependency links and reran serially;
see web-serial.log for final result. No PostgreSQL or actual GUI rerun for this slice.

Final ordinary Web serial rerun: 271 passed, 0 failed, 1 explicit optional S3 skip
(endpoint unset), 42.34s. No assertion or product code weakened for this rerun.
