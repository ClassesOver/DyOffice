# T11 page rotation export core

Base: 61237d8. Small real-edit increment, not full T11 closure.

## Scope and design

`rotatePdfPages(Buffer, [{page, degrees}])` returns new PDF bytes. Pages use 1-based indices and relative quarter turns. No route, public capability, permissions or persistence changes. Existing read-only capability gate stays closed. Page rotation was chosen over page copying (destination preservation risk) or text replacement (font/content-stream semantics): it changes the page Rotate entry without replacing content streams.

Inputs are snapshotted before async parsing. Invalid/duplicate/out-of-range operations fail before modification. Input is limited to 64 MiB and documents to 100 pages. Signatures, signature permissions and all AcroForm documents fail closed. All indirect objects plus nested dictionaries/arrays/stream dictionaries are scanned, bounded to 100000 visited objects. No encryption bypass option is used. Output is newly serialized by pdf-lib; byte identity is not promised. Metadata and form appearances are not regenerated.

## Reproduction and verification

Initial test failed with missing implementation. Independent review identified direct nested signature bypass and mutable-input race. Both were captured as failing regressions and fixed before approval. The encryption refusal test also exposed pdf-lib Error subclass instanceof failure; /Encrypt byte detection now only chooses the refusal code, never permission to proceed.

Quarter-turn raster ink count differed by two antialiasing pixels, so exact rotated-ink equality is not claimed. Real PDFium reopening confirms swapped dimensions and nonblank ink; PDF.js extracted text is unchanged. Inverse rotation restores exact pixel hash/ink/text; untouched pages stay identical. Annotation references and content-stream bytes are retained.

On the isolated target integration: new rotation tests 10/10; complete PDF tests 29/29 with serial test execution; independent rotation review 10/10; ordinary Web 290 passed, 1 optional S3 skip, 0 failed; boundary 999 files, 0 violations; node syntax check passed. Latest target's 69 changes since the previous verified integration were fetched and blob-hash checked. No dependencies added.

## Limits and remaining work

Limits after PDF parsing are not parser resource isolation. The /Encrypt error-code heuristic can mislabel malformed nonencrypted files containing that text, but still rejects them. Encryption test is a synthetic encrypted trailer, signature tests synthetic structural objects: genuine encrypted/signed documents, complex PDF fidelity and desktop comparison remain unverified. Browser acceptance is deferred, not passed. This round does not rerun the previously Chromium-blocked aggregate suite.

No HTTP command, T06 save/revision/lease flow, UI affordance or desktop fidelity claim. Annotation writing, text editing, reorder and redaction remain unsupported. Next increment must integrate a narrowly authorized explicit rotation command with save consistency, not expose this helper through a permissive generic endpoint. Rollback removes this unused core and its tests; no schema or data migration.
