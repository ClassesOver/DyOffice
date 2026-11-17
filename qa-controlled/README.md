# Disposable controlled-text GUI QA

Not production mounted. Does not replace native App and is explicitly non-WYSIWYG.
Uses the actual controlled controller/model/DocParagraph and the restricted LO profile.
No editor/host/controller is exposed on window. No approval, claim, or save is automatic.
The checkbox approves only the displayed proposal. Page hide disposes; bfcache page show
constructs a fresh controller, which reads the opaque localStorage recovery pointer.
Errors never automatically replay/reconcile/clear that pointer. Recovery opens an isolated
page using the existing recovery UI and the same bounded CSRF transport.

Build from snapshot root: `GOMAXPROCS=2 node qa-controlled/build.mjs`.
Pure transport check: `node --import tsx --test qa-controlled/csrf.test.mjs`.
With coordinator-owned isolated PostgreSQL (never start shared services here):
`QA_CONTROLLED_SELFTEST=1 node --import tsx qa-controlled/server.mjs`.
GUI server: `bash qa-controlled/run.sh`; port 18768 (or QA_CONTROLLED_PORT=18769/18770/18771/18772/18773 only), localhost bind only.
Visit http://localhost:18768/qa/controlled/login with synthetic fixture alice credentials.
Write qa-controlled/stop to request cleanup. Never use real credentials/data.

The fixture creates its own dyoffice_test database/runtime roles and local object directory,
and cleanup drops only those generated resources. It imports the original audited LO binary
on first authenticated alice visit, without creating any proposal or approval.

`mode` contents may be `lost` (first successful durable commit response replaced by HTTP 503 with unconfirmed JSON and no receipt), `stall` (all successful commit replies delayed 10 seconds), or explicit `socket` (destroy first successful response socket). Empty/default is normal.
Chromium may automatically retransmit a POST after raw socket loss; the fresh 18773 socket-count rerun observed two network requests and proved one new save revision with exact database counts. The earlier 18769 socket run only recorded the final head and does not establish a revision count. Application code not retrying does not mean the HTTP/network layer never retries. Use 18771 for the new 503 scenario without clearing 18769 pointers.
These modes do NOT roll back committed changes. report.json observes durable head/journal
and counts incoming proposal/execute/stage/commit requests, not successful operations. No
secret/session credential is written in report. The GUI deliberately has no reset-pointer UI.
Use a fresh disposable service/session realm for separate scenarios; preserve existing pointers.

The esbuild alias map expands this candidate's package exports explicitly because direct
absolute directory aliases do not resolve exports-only packages. All retained workspace inputs
must resolve within this candidate; external third-party node_modules inputs are listed in
resolution.json. Nothing changes shared node_modules. Actual controller changes require a rebuild.
Only actual CSS/image/font loaders are used, not logic stubs or Node polyfills. No Vite build.

CSP limits script/style/connect/assets to self and disallows object/base/frame embedding.
The dependency graph includes JSZip's message scheduler and broad UI/provider barrels; do not
claim zero global listeners or no hidden behavior based solely on static bundle success.
Real-browser network/console inspection, service selftest, GUI flow and late-disposal/failure
acceptance are separate coordinator-owned checks. Browser bundling is not GUI acceptance.

## Same-origin two-tab competition

After authenticating alice, open `/qa/controlled` and `/qa/controlled?secondary=1`
before either proposes. The second selector imports another original LO fixture for the
same authenticated session, without acquiring a lease or making a command server-side.
Both controllers may become ready on different files/leases. Propose in A, then propose
in B: B must preserve A's durable pointer and send no second proposal. The primary
report scope remains unchanged; `secondary` adds its exact fileId/head/journal.
The updated selftest checks distinct file IDs, both heads and zero commands before UI work.

## Durable byte evidence

The observer reads the exact primary head's revision hash/size, downloads it through the
real file service using only the synthetic fixture identity, and validates its raw hash/size,
strict LO profile, complete ZIP part set and every non-document part against the original.
Only after verification does it write `durable.docx` and cache `verifiedStored` for that head.
`initial: true` distinguishes imported initial bytes from a later committed head. This is
read-only evidence, never another commit. It does not prove external Office rendering;
coordinator must reopen the saved file separately. No credential enters the report.

Socket-count rerun uses fresh origin 18773, never clears previous pointers. The owner-scoped read-only repeatable-read observation reports exact revision/source totals, safe commit/binding projections and a fully bound command/upload/commit/revision receipt join count. No session/editor IDs or credentials are projected. Initial byte proof is retained alongside current head proof.
