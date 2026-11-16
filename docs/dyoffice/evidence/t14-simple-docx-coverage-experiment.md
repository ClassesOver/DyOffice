# Restricted DOCX preservation experiment

This is an unmounted prototype experiment, not a standard-Word compatibility claim.
The fixtures in the experiment are synthetic and built with the repository's
`buildDocx` helper. No Word-origin provenance, OOXML XSD conformance, or visual equivalence was verified.
The synthetic theme is minimal; this is an actual engine/ZIP preservation test,
not proof of a complete Office theme implementation.

## Observed engine behavior

Actual `parseDocx` / `saveDocx`, with raw XML SaveBlocks modifying only one text:

- Existing `docProps/core.xml` modified timestamp and numeric revision are updated
  by default. A core part without those tags remains byte-identical.
- Synthetic app/settings/fontTable/theme parts remain byte-identical without
  corresponding SaveOptions. The combined package registers each with content
  types and standard package/document relationships, not just orphan ZIP entries.
- Synthetic paragraph rsid attributes, pPr alignment/spacing and rPr bold/font/size
  survive raw XML text replacement exactly. This does not prove a full editor
  can represent or preview that formatting, or safely resolve multiple runs.
- Every tested unchanged original-block save returns original bytes exactly.
- `app.xml` Pages/Words remain the old values. Byte preservation is NOT refreshed
  statistics, rendered-layout equivalence, or application-level semantic parity.

## Narrow explicit option

`SaveOptions.preserveCoreProperties?: boolean` suppresses only automatic core
modified/revision updates. Default behavior is unchanged. It does NOT disable
privacy scrubbing, explicit property updates, resource cleanup, normalization or
other engine transformations. An explicit privacy-scrub regression verifies that
creator data is still removed when this flag is set.

Red/green: before implementation, 9 baseline experiments pass and both new
preservation/privacy assertions fail; after implementation, 13 experiments pass
(including explicit false, and true plus explicit property/savedAt precedence).
The existing strict capability's 16 tests also pass (29 total). Focused strict
TypeScript checks cover the module and both test files. Its acceptance policy has
NOT been widened and it does not yet use the new option.

## Repository inventory (not Word provenance)

36 DOCX archives under `apps/docs/tests/pagination-corpus`: 24 have no additional
non-directory parts beyond the five base parts; four add only settings. Across
all files: settings 9, image1.png 4, header1.xml 2, footer1.xml 2, footnotes 2,
numbering 2. This is only ZIP inventory, not 24 accepted documents. Their XML,
paragraph structure, ZIP headers and namespace layouts can still be rejected.
The corpus has a repository generation script and metadata; a filename or Word
pagination baseline does not prove the archive itself was authored in Word.

## Why five parts; possible next scope

The five-part restriction is a deliberately audited package/relationship schema,
not an inherent engine requirement. Unknown parts are not safe merely because
one save happens to preserve them. Retain exact whole-package comparison.

A bounded next schema could explicitly permit core/app and selected inert
settings/font-table/theme content, validate every relationship/content type and
reject unsupported settings (protection, revision tracking, personal-info scrub,
external links, embedded fonts, story references). Core requires the explicit
option AND post-save byte comparison. Theme/font resolution and default styles
mean plain structural paragraphs are not necessarily visually unformatted.

Rsid attributes are low-cost lexical preservation candidates. Single-run pPr/rPr
could remain verbatim for a text-only action, but require a clear non-WYSIWYG
approval contract and proof the selected command does not imply format changes.
Multi-run formatting, fields, revisions, comments, tables, drawings, linked
parts, footnotes and headers remain out of scope. Supporting those is a new
editor/serialization contract, not a ZIP allowlist adjustment.

Before product expansion: real-source corpus provenance, independent security
review, bounded namespace-aware parsing, actual authorized editor/T06-chain
regression, and rendered/Office verification. Do not post-process engine output
to hide unwanted transformations or claim exact preservation after dropping data.

## Durable save-chain experiment

The explicit option was also exercised through authenticated approval, real PM
text mutation, PostgreSQL command journal, SessionFileHost and T06. Six cases pass:
strict normal/lost-response save, stale user-edit and takeover rejection, plus
registered ancillary-package normal/lost-response save. The latter two use a
TEST-ONLY builder/import wrapper, not the production strict capability. They
verify every downloaded logical part against the original, allowing only the
precise document.xml replacement, and compare downloaded bytes to verified output.
Storage is local object storage, not RustFS. No Office UI or production entry was
used. Log: simple-save-metadata.log, 6/6, zero skips.

Existing engine doc-properties regression: 16/16 passed independently of the new
experiment tests. The core option is not yet published, and no capability allowlist
or product routing has been widened.

## Delivery and migration cost

1. **Deliverable now:** an unmounted feasibility proof and a narrowly typed engine
   option. The strict profile can preserve a small explicit subset, not general
   Word documents. Repository inventory cannot supply a real-world acceptance rate.
2. **Bounded next implementation:** allowlisted ancillary schemas plus fully
   validated relationships/content types; reject protection/tracking/external or
   embedded-resource settings; real-source corpus; explicit text-only preview and
   approval wording; lifecycle/lease/close/reload/unknown-save handling; browser and
   Office verification. Existing T06/journal/atomic PM modules are reusable. This
   still requires new product assembly and cannot be delivered by changing five
   filenames in an allowlist.
3. **Native general-editor migration:** unaffected by this experiment. It still
   needs the previously inventoried 52 serializer inputs, direct setters/ref writes,
   sub-editors, asynchronous fonts/parts and save/reload paths on a consistent
   lifetime fence. Multi-run/complex stories require their own command and inverse
   contracts. A restricted text mode does not replace that migration.

Final option regression: 13 ancillary/core-policy experiments plus 16 strict
profile tests pass (29/29). Explicit false still applies savedAt and revision+1;
true ignores automatic savedAt while an explicit title property still applies.
The existing privacy case still clears creator. Focused strict TypeScript passes.
