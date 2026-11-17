# Explicit analysis insertion and independent document save

Status: implementation candidate on PR #134, based on `05709043`. The base's green CI is not acceptance of this candidate. Final combined native/browser CI is pending. Office host/save changes are separately reviewed and may still change before integration.

## Intended contract

- Only a user action can apply a verified artifact. No external harness receives Office write authority, file credentials, active-editor identity or a path capability.
- The panel captures its registered native target before asynchronous download; verifies the original session-bound server receipt, size and artifact-byte hash; prepares inert bounded content; and passes a final authorization callback into the original native editor operation.
- Insertion is `applied_uncommitted`. It does not save. Pending analysis also holds silent saves, including existing blur/timer/AI-completion paths. A separate explicit Save asks the original native bridge for a real revision receipt. Artifact commit is never presented as a document revision.
- Newer editing, target replacement, lost lease, changed session or an ambiguous response must not be labelled saved. Unknown operations are not blindly retried. User data and original explicit editing/saving remain intact.

## Supported content

| Artifact | Docs | Sheets |
| --- | --- | --- |
| UTF-8 plain text / Markdown report | Literal text after current paragraph | Literal cells at current selection |
| Strict comma-separated CSV table | Literal table after current paragraph | Literal rectangle at selection top-left; existing destination cells overwritten, with visible warning and Undo |
| PNG, HTML, SVG, code or unsupported formats | Inert download only | Inert download only |

No Markdown/HTML execution, formula or numeric/date/boolean inference, URL image loading, hidden truncation or broad document replacement is permitted. A conservative shared limit applies to content **and** provenance notes: 64 KiB, 500 rows/lines, 64 columns, 2,000 cells and 4,096 characters per line/cell. Incompatible or over-limit content is rejected as a whole.

## Provenance and expired inputs

New artifact commits copy schema column names/types/units and timezone from the already-authorized frozen snapshot. A harness cannot submit these fields as authoritative metadata. The durable receipt survives input expiry and preserves snapshot/query hash, row count and truncation independently of artifact-byte hash.

Controlled display and insertion include literal scope notes. Truncated input cannot establish full-dataset totals; untruncated input is not an independent completeness guarantee. Model-authored limitations are labelled as such. Legacy receipts missing metadata report the gap, never guess units or timezone.

The harness prompt explicitly requires checking these fields and forbids silent expired-input replacement. This is an instruction, **not a mechanical proof about natural-language conclusions**. Expired read/download never automatically executes SQL; a result-only grant cannot query its source. A separately authorized source-scoped bounded query remains possible, under current permissions, producing a separate input rather than silently overwriting the old provenance.

## Evidence available before final integration

- Content preparation: 6 tests; existing CSV regressions: 53 tests.
- Panel: 16 jsdom tests, including explicit two-step actions, overwrite warning, escaping, repeated clicks, unknown results and client/target/unmount races.
- Client/provenance: 18 focused tests, including server-projected metadata, detached copies, hash/session checks and full-result limit rejection.
- Task access: 17 tests, including result-only expired-input refusal and revoked-source zero additional connector calls.
- Real PostgreSQL combination: 8 tests passed, covering durable artifact/receipt recovery, owner/task/claim isolation, lineage, budgets, ambiguous object cleanup, expired input receipt recovery, metadata projection and original session changes.
- A local synthetic adapter uses real task-bearer artifact routes. It does not launch Codex, a model, a shell or an external data source.
- Added Docs/Sheets normal-CI browser cases retain explicit insert/no silent save, independent revision, persisted bytes, reload, and literal formula-looking/leading-zero string assertions. Local browser execution was not attempted; these cases await the authorized normal CI run.

No real second-harness/model acceptance, general PNG insertion, arbitrary large export, runtime production certification or notice/license distribution approval is asserted here.
