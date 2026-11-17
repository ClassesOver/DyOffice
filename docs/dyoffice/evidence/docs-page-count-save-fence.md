# DOCX derived pagination save fence

Baseline: PR #134 `cc52d8b2`; CI job 134005409887 reproduced an incomplete native save with only `metadata:pageCount`, despite committed body bytes.

## Cause and narrow correction

`App.tsx` updates `pageInfo.total` asynchronously from visible layout slices. This is not a user editing intent. `buildDocBytes` passes `pageCount` to the engine, which consumes it only when regenerating header/footer NUMPAGES cached field values. A body-only save does not serialize that value. Previously the metadata snapshot treated any later layout count as an unsaved edit, leaving the Web bridge dirty after a successful body-only commit.

The snapshot now uses the same `hfSaveOptions` plan as serialization. It captures pageCount whenever a header/footer part may be written (including non-final section parts), and omits only that unused input for body-only / unlink-only saves. This is conservative for header/footer edits without NUMPAGES too. Header/footer edits and links themselves remain fenced, so a new edit during a body-only save cannot be silently consumed. Document identity, PM document, all other metadata, pending password, font settling and generation guards are unchanged. No retry or unconditional dirty reset was added.

## Evidence

- RED: real Tiptap + production serializer + Web bridge saved body bytes, then injected a late layout count while acknowledging the write. The new strict clean assertion failed; three existing tests passed.
- GREEN: 49 focused tests passed, including body bytes and clean acknowledgment followed by a new dirty edit; real footer NUMPAGES cached value 1 remains in saved bytes while a racing layout value 2 keeps the bridge dirty; document/core metadata races; non-final section capture and unlink-only/new-intent checks.
- Browser assertions and HTTP persistence checks are not weakened. The fix still requires the normal CI real-browser suite; local unit/serializer evidence is not browser acceptance.
