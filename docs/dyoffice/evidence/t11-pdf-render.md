# T11 PDF browser mount and reopen

> 2026-11-16 · PDF.js viewer with a strict content security policy. PDFium WASM checks pixels. Annotation writing is not in this slice.

## Why this slice

The capability gate can classify a PDF, but it does not draw one. This slice mounts a reader and checks that exporting the unchanged bytes reopens to the same picture and the same text.

## What it does

A PDF tab loads `/pdf.html`. That page fetches the stored bytes and calls `mountPdfEditor`, which draws each page with PDF.js. The page and the response send the same content security policy: scripts, workers, and fonts come from this origin, and the policy has no `unsafe-eval`, no `unsafe-inline`, and no wildcard origin. PDF.js is opened with WASM compilation and font-face injection turned off. Standard font files are served from `/pdfjs/standard_fonts/` and only the known PDF.js filenames are accepted.

`renderPdfPages` rasterizes each page with PDFium WASM and reads the text with PDF.js. A text page has ink. A blank page has none. Opening the same bytes again returns the same pixel hash. A PDF whose text changed returns a different hash and the new text. An encrypted file returns no pages. Annotation and text edit still fail with `UNSUPPORTED`.

This does not write annotations, edit text, reorder pages, or redact. A password is not accepted.

## Verification

```sh
node --test apps/web/test/pdf-render.test.mjs
```

The file first failed because the viewer module did not exist. After the mount, the raster, and the policy header, the file passes.

## Still open

| Item | Result |
| --- | --- |
| Browser PDF.js mount and CSP | Done |
| Visual reopen of unchanged bytes | Done with PDFium pixel hashes and PDF.js text |
| Annotation writing | Deferred. The next T11 slice |
| Real text-stream editing | Deferred. No write path yet |
| Glyph coverage for missing fonts | Deferred. The font dictionary check remains structural |
