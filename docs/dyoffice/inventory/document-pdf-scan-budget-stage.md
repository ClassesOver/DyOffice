# PDF capability scanner content-stream budget

Baseline: `feat/dyoffice-web` at `f8facfc3afb51b9fc12e01ed45b4ded4cb279b06`.

## Defect and minimal fix

The existing capability scanner used unbounded `inflateSync` for page/Form content and swallowed page-content decoding errors into an empty string. A tiny highly compressed stream could allocate large decoded content, and a corrupt Flate stream could produce a successful blank-page report.

The scanner now uses Node's existing zlib `maxOutputLength` before decompression allocation, with a fixed **1 MiB decoded limit per content stream** and **8 MiB cumulative decoded budget per inspectPdf call**. Raw streams are length-checked before copying. The same budget is shared across page Contents arrays, pages and visited Form XObjects; repeated references that are actually scanned are charged again. Each call creates its own budget. Missing/non-stream content entries and decoding failures propagate to the common `UNREADABLE` path instead of a successful blank report. A genuinely absent Contents entry remains a valid blank page.

The limits are conservative scanner policy, not PDF format limits. Previously accepted large content can now be rejected as unreadable; no truncation, partial report or edit fallback is returned. The existing encrypted-document handling remains locked/password-required. No new parser, dependency, executable backend, runtime grant or production enablement is introduced.

## Evidence and boundaries

Initial regression reproduction: four rejection tests failed against the old implementation while the ordinary/at-limit stream test passed. Coverage includes compressed expansion, raw stream limit, Form XObject limit, cumulative repeated references across pages, same-page arrays, corrupt Flate, non-stream entries, per-call reset, at-limit content and normal split text content.

These checks bound only content bytes decoded by this scanner. `PDFDocument.load` happens before this budget and may decode PDF object streams; input size, parser traversal, font/resource/signature graphs, token count, CPU time and process memory are not globally bounded here. Existing filter interpretation is not expanded into complete PDF filter support. This is **not OS/process isolation**, adversarial-parser certification or supported-host acceptance. The production document execution boundary remains fail-closed, with no native backend started. Synthetic test PDFs are generated locally using the existing pdf-lib.

## Local verification

Node 22.23.5: `node --test apps/web/test/pdf*.test.mjs` passed **58/58**, zero failed/skipped, exit 0. This includes sixteen new budget/encryption-mapping regressions plus existing PDF capability/page/render/raster/rotation/recovery/tokenizer tests. Exact per-stream and aggregate boundary values remain readable; failure/success leave source bytes unchanged. Syntax and whitespace checks passed. No PostgreSQL, Redis, native backend or OS-isolation acceptance was needed or claimed for this pure scanner change. No CI result is claimed yet.


## Review correction: encryption is structural, not a byte substring

A review regression showed that the former global catch treated `/Encrypt` anywhere in input bytes as encryption evidence, including a trailing comment on an otherwise plaintext over-budget/corrupt PDF. Three added rejection tests reproduced this before correction. Loading and content scanning now have separate error paths. The existing pdf-lib parser is called with `ignoreEncryption` solely to obtain its structured `isEncrypted` metadata; encrypted documents immediately return the existing locked/password-required result before getPages or content scanning. There is no decryption, rendering or editing permission implied. Raw keyword detection is removed entirely, including load failures. This also avoids relying on pdf-lib's ES5 Error subclass `instanceof`, which failed for the existing encryption fixtures during an intermediate attempt (51/53).

Final regressions require UNREADABLE/status400 for an over-budget plaintext PDF plus fake EOF Encrypt comment, corrupt Flate plus fake marker, and malformed PDF plus marker. Valid plaintext plus marker stays plaintext; a parsed Encrypt trailer with corrupt content remains locked without scanning it. Final reviewed full PDF suite after encryption correction: 55/55, zero failures/skips, exit 0.


## Exact-budget empty stream correction

At exactly 8 MiB decoded, following zero-length raw/Flate content remains valid. Raw streams are checked against zero before copying. Because zlib requires a strictly positive maxOutputLength, an exhausted budget uses a one-byte decompression probe and then rejects any nonempty result; expanding streams cannot obtain an unbounded allocation. This bounds the requested zlib output, not all native zlib scratch allocation or global process memory. Empty output is accepted and consumes zero budget. Existing limits are unchanged.

The boundary regression failed before this correction, then passed alongside nonempty/expanding content rejection at exhausted budget. Fifteen half-MiB Forms pass; seventeen individually small Forms exceed the shared document budget and reject. Final complete PDF suite: **58/58**, zero failures/skips, exit 0 on Node 22.23.5.
