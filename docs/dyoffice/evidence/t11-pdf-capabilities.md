# T11 PDF capability gate

> 2026-11-16 · Partial. Not a browser editor, not PDFium text extraction, not a worker export.

## Why this slice

T07 is owned by the DOCX browser pull request. T09 is XLSX and is out of scope. T03/T04 auth and row-level security are owned elsewhere. T08's worker is also in another pull request. T10 already has a Node session seam. The next dependency-safe slice is an explicit PDF capability gate that refuses operations this repository does not yet perform.

## What it does

`inspectPdf` accepts a `%PDF-` buffer. A plain file returns its 1-based page order and `read: 'structure'`. Annotation, text edit, page reorder, and redaction capabilities are `unsupported`. `requestPdfOperation` allows `read` and rejects the others. `coverText` fails with `COVER_IS_NOT_DELETION`, so painting over text is not recorded as removing the original. A file whose trailer names `/Encrypt` returns `password_required` and no page order. A non-PDF buffer is `MAGIC_MISMATCH`.

This does not mount `mountPdfEditor`, does not load PDFium, and does not change the DOCX editor.

## Verification

```sh
node --test apps/web/test/pdf-capabilities.test.mjs
```

The file first failed because `capabilities.mjs` did not exist. After the module, the file passes.

## Still open for T11

Real text-stream editing, annotation writing, signature invalidation, missing fonts, scanned-page detection, WASM, CSP, and browser round-trip. Those need the PDF renderer and are not claimed here.
