# T14 controlled editor prerequisite evidence

Experimental, not mounted in production. This is not general Word support, WYSIWYG, a completed UI, or full T14 acceptance.

## Transport and exact native model

- Command HTTP transport: same-origin, redirect rejection, strict CSRF and bounded fatal UTF-8 response decoding. Focused 8/8 independently rerun.
- SessionFileHost: same-origin and redirect rejection for all internal API requests, 1 MiB streamed JSON, unchanged exact binary hash/size, disposal fencing, one auth-only 403 retry. Combined affected unit/lease/barrier/command suite 107/107; independent new transport 12/12. No total network deadline is claimed.
- Real detached native DocParagraph model consumes one exact Transaction capability. Foreign, appended, recursive, reused and late transactions are rejected. Default adapter dispatch is unchanged. Native model/fence subset 15/15; independent static review.
- Native model support is deliberately narrower than the strict LO profile: maximum 32768 UTF-16 units per paragraph and 1 MiB aggregate UTF-8. It must reject unsupported inputs, never truncate. The complete App is not loaded or modified.

## Authoritative committed outcome

`getCommandOutcome` now checks committed receipts inside its existing locked transaction using the original writer verifier. It validates revision shape/file/non-base and requires verifier result exactly true. It does not infer command provenance from equal bytes or equal revision alone.

Four real PG regression cases (fresh editor, missing binding, wrong source command, binding hash corruption) all erroneously succeeded under the old outcome implementation and all reject under the fix. The durable file head remains unchanged. Fresh editor recovery must use the separate read-only recovery API; this change does not grant write capability. Other command states are unchanged.

All command unit tests 71/71; server TypeScript passed. The existing `recordCommitted` already-committed retry branch is unchanged and is not described as newly hardened.

## Real persistence evidence

- Transport compatibility chain: 41/41 zero skipped across BrowserHost, HTTP command, revision commit and previous LO/simple profile tests. Previous LO tests use a synthetic paragraph node and are not evidence of the new native model.
- Native/provenance/journal/HTTP/read-only recovery combined chain: 45/45 zero skipped.
- New actual-native subset: 5/5 comprising module smoke plus normal, lost commit response, lease takeover, and late disposal. Uses actual DocParagraph via controlled-text-model, real PG, local object storage and Fastify inject. RustFS being available in the runner is not evidence these native tests use S3.
- Node-only static asset imports are temporarily stubbed during native module loading and restored immediately. No editor, profile or transaction logic is mocked. This is not browser/render/layout evidence.
- Successful durable outputs equal checked export bytes, reimport to the expected paragraphs, and every logical part other than word/document.xml is byte-equal to the source. Takeover does not stage or publish. Late disposal rejects local success although the server may already have committed.
- Normal, lost-response and late-dispose durable DOCX outputs were reopened by the installed LibreOffice headless text filter. All three yield `Welcome world` and `Second paragraph`. Fontconfig emitted unwritable-cache warnings; no font/visual/layout assertion is made.

Native lost-response regression exercises existing exact-tuple coordinator reconciliation. The forthcoming restricted controller must not expose automatic retry/reconciliation after uncertainty; it routes to explicit fresh recovery instead.

## Remaining gates

Controlled controller, real browser interface, lifecycle integration and approval UX remain unvalidated. No automatic proposal/approval/lease takeover or default navigation is installed. An ambiguous recovery-pointer 404 is retained and blocks automatic new commands; no guessing of session identity or silent pointer deletion. Native Sheets bridge integration lacked its generated host manifest and is outside the passing subset. No full monorepo build or full suite pass is claimed.

## Restricted controller and real Chromium checkpoint

The default-off controller and disposable QA page are now implemented. This is a
single-command controlled-template demonstration, not general App integration.
It uses the real native paragraph model, a durable opaque localStorage pointer,
and an origin-wide exclusive Web Lock for pointer registration. Missing Web Locks
fails closed before lease acquisition. Approval, local application and save are
separate user actions; the controller exposes no undo or commit-replay action.
Its bind-return and commit-send boundaries recheck lifecycle/authority fences.

Controller/model/native tests: 36/36. The cross-tab unit regression forces both
lock requests to queue before the first callback runs, and admits exactly one
proposal. Independent review confirmed the lock, lifecycle and default-off
boundaries. The QA shell preserves semantic recovery explanations rather than
replacing them with a raw transport error.

Actual Chromium, authenticated Fastify routes, PostgreSQL and local object storage
were exercised through the visible UI:

- Two different files were opened in same-origin tabs before proposing. A's
  proposal was registered; B could not submit or overwrite it. B's journal stayed
  empty. Reloading B displayed the old command's safe recovery link.
- Normal: explicit checkbox approval, actual native text application, save and
  verified durable receipt. Proposal/claim/stage/commit request counts each 1.
  Refresh and Back/Forward only recovered the existing committed command.
- Submission followed by a synthetic HTTP 503: the UI entered recovery-required,
  disabled further writes, retained the pointer and did not issue another commit.
  The fresh recovery page verified the exact committed receipt. Final request
  counts each 1. The final GUI build retained the explanatory recovery message.
- Applied but not saved: refresh destroyed the local model, read-only recovery
  showed applied_uncommitted, and explicit checked abandonment changed it to
  abandoned_uncommitted. Stage/commit remained 0 and durable head/hash unchanged.
  This is a future-save fence, not a claim that a local undo ran.
- Raw socket destruction after a real commit caused Chromium itself to resend the
  POST. The application did not request a replay. The original run only recorded
  the final head and cannot establish a revision count. A NEW isolated run added
  repeatable-read, read-only database evidence: 2 commit requests, 2 total revisions
  (1 import + 1 save), 1 revision_commit, 1 binding, and 1 exact command/upload/
  receipt/revision join. Upload/idempotency/command/hash/size matched the head.
  Thus the new run demonstrates idempotency under a browser transport retry;
  there is no promise that a browser never resends an HTTP request.

The normal and 503 durable files were downloaded, hash/size/profile checked and
compared against all original non-document parts; the separate native persistence
suite covers the same exact-byte checks. Four GUI output artifacts (normal, first
socket run and two 503 runs) reopened in LibreOffice to the expected text. This is
headless text reopening, not Office visual/layout or WPS acceptance. The later
counted socket run also has exact storage/profile/part proof; its separate LO
reopening is recorded with the local artifacts, not inferred from the same hash.

A passive QA-only resource/CSP observer saw only same-origin resource entries and
zero CSP violations on the final tested editing page. It does not observe all
browser/extension traffic. The bundle has known non-business scheduling listeners;
no claim of zero global handlers is made. The browser logs included extension
metadata errors, not a tested application error. All test services were stopped.

## Build resolution and outstanding acceptance

The QA browser build now maps this checkout's workspace package exports explicitly
and rejects inputs sourced from another workspace. It does not modify shared
node_modules. Third-party dependencies are separately listed in build metadata.
The native dependency barrel remains large (approximately 4.8 MB minified in the
initial model feasibility build); no small-bundle/performance claim is made.

Focused controller typechecking with the real ambient declarations was attempted.
Docs required allowImportingTsExtensions with its existing noEmit setting to import
the shared browser transport sources. The first subsequent run ended **Killed, exit 137** without a compiler diagnostic
and was not a pass. After all services and other tests were stopped, the same
focused configuration with real ambient declarations and a 768 MiB heap passed
serially (exit 0, 10.86 seconds). This completes the focused controller/model
type gate, not the complete Docs/monorepo aggregate typecheck. Server types and
focused transport types also passed. The earlier failure remains part of the record.
The native Sheets bridge still lacks a generated manifest in this environment.
No full-repository green, merge-ready, production mount, general Word support,
AI-provider write integration, cross-session recovery or full T14 closure is claimed.

Final broad Web unit regression: 324/324, zero skipped. Final Web boundary check: 1001 files, 0 violations. The counted socket GUI output separately reopened in LibreOffice to the expected two text paragraphs. All services stopped before the successful serial focused typecheck.

Final disposable QA helper/shell/transport tests, including exact revision-count projection: 11/11, zero skipped, exit 0.
