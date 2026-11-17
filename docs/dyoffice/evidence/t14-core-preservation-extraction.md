# T14 old-chain minimal extraction: core-property preservation

## Scope

Extracted from #80 onto feat/dyoffice-web at eeeb2261. `saveDocx` accepts an explicit `preserveCoreProperties` option. Default/false behavior is unchanged. True suppresses only automatic modified/revision updates; explicit property edits, privacy scrub and resource cleanup retain their existing precedence. This is not byte-identical ZIP preservation or a general Word compatibility claim. App statistics may remain stale.

No production caller, UI, route, compatibility interface, isolation fallback, or restricted document profile is enabled. The current command-save coordinator already owns Buffer bytes via `new Uint8Array(await serialize())`; that code is not replaced by the old chain.

## Verification

- Baseline patch.ts blob cd54c02791dc08188bb956e8255861774068c54c verified against eeeb2261.
- Test-first baseline: 3 failed / 10 passed; failures were automatic metadata updates despite the requested preservation policy.
- Final full docx-engine suite: 220 files, 2252 passed, 1 skipped (existing optional real-document raw-rpr corpus fixture absent).
- Engine TypeScript check passed.
- Independent focused core-preservation + doc-properties review/run: 29 passed. Follow-up adds output-part-name-set equality and repository formatting; final full suite rerun passed.
- This extraction has no PostgreSQL, browser, desktop or real systemd acceptance claim. CI status is not used as an integration gate under the owner's direction.

## Old PR disposition

Do not close #77/#80/#82/#87 solely for this increment. Remaining useful unique material must be evaluated independently:

- #77: immutable fenced-document-store prototype, React concurrency tests and native mutation inventory. Current target already has newer mutation fence and exact-transaction approved command primitives.
- #80: strict simple-DOCX profile and preservation/persistence experiments. Only the engine policy and portable engine regressions are extracted here; Buffer snapshot handling already exists in the current coordinator.
- #82: fixed LibreOffice-development-template profile, fixture and local persistence evidence. Narrow template support is not general Office compatibility.
- #87: controlled native model/controller and standalone QA experiment. Transport/recovery/provenance portions were separately integrated; the remaining controller must be adapted to current APIs rather than merging its ancestors.

Preserve remaining branches and evidence until separately integrated or explicitly retired. No full T14 closure is claimed.
