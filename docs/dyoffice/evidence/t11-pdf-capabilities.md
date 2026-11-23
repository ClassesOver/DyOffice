# T11 PDF capability gate

> 2026-11-16 · Capability gate. The browser mount and pixel reopen check are in [t11-pdf-render.md](t11-pdf-render.md).

> Historical implementation record. For the current GenOffice editor at `/native-pdf/` and its supported operations, see [Web parity evidence](genoffice-web-parity.md).

## Why this slice

T07 is owned by the DOCX browser pull request. T09 is XLSX and is out of scope. T03/T04 auth and row-level security are owned elsewhere. T08's worker is also in another pull request. T10 already has a Node session seam. The next dependency-safe slice is an explicit PDF capability gate that refuses operations this repository does not yet perform.

## What it does

`inspectPdf` accepts a `%PDF-` buffer. A plain file returns its 1-based page order and `read: 'structure'`. Annotation, text edit, page reorder, and redaction capabilities are `unsupported`. `requestPdfOperation` allows `read` and rejects the others. `coverText` fails with `COVER_IS_NOT_DELETION`, so painting over text is not recorded as removing the original. A file whose trailer names `/Encrypt` returns `password_required` and no page order. A non-PDF buffer is `MAGIC_MISMATCH`.

The later mount slice draws pages. This module still does not change the DOCX editor.

## Verification

```sh
node --test apps/web/test/pdf-capabilities.test.mjs
```

The file first failed because `capabilities.mjs` did not exist. After the module, the file passes.

## Page kind, fonts, and signatures

A page is `text` when a decoded content stream, including a Form XObject it invokes, contains a text-showing operator (`Tj`, `TJ`, `'`, or `"`). Comments, names, and string contents are not operators. A page that draws an image XObject and has no text operators is `scanned`, and `capabilities.scanned` is `no_text_layer`. A page with neither is `blank`. A signature field type or value inherited from the widget parent is still `present_unverified`. A standard font such as Helvetica is reported with `embedded: false`. A signature field is `present_unverified`. `trustSignature` fails with `SIGNATURE_UNVERIFIED`. The byte range is not checked and the signature is not treated as valid or invalid.

```sh
node --test apps/web/test/pdf-pages.test.mjs
```

The tests first failed because `pages` and `signatures` were missing. After the classifier, the file passes.

## Still open for T11

| Item | Result |
| --- | --- |
| Page order, password file, cover text is not deletion | Done in `pdf-capabilities.test.mjs` |
| Scanned page has no text layer | Done. Image-only pages are `scanned` |
| Missing embedded font | Done for the font dictionary. No glyph coverage check |
| Signature present | Done as unverified. Cryptographic validation is not performed |
| Real text-stream editing | Deferred. The gate still returns `UNSUPPORTED` because no editor write path exists |
| Annotation writing | Deferred for the same reason |
| Browser mount | PDF tabs open `/pdf.html`, which mounts PDF.js. See [t11-pdf-render.md](t11-pdf-render.md) |
| PDFium, WASM, and CSP | PDFium WASM rasterizes pages in the server test. The viewer CSP rejects eval and inline scripts |
| Visual re-open and export fidelity | Unchanged exported bytes keep the same PDFium pixel hash and PDF.js text |
