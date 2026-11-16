# T07 browser DOCX mount

> 2026-11-16 · Browser round trip, desktop bridge, plain table cells, and page slicing. The Docs ribbon is not mounted, and no external Word binary is available.

## Why T07

T08 depends on T04 resource authorization. This work does not start auth, row-level security, or object-storage changes. T07 depends on T01 and T06, which are already on `feat/dyoffice-web`.

## RED

```sh
node --import tsx --test apps/web/test/docs-mount.test.mjs
```

The test failed because `packages/browser-host/src/files.ts` did not exist (`ERR_MODULE_NOT_FOUND`). A blank page was not treated as a pass.

## What landed

`mountDocsEditor(host, element, fileId)` opens the server DOCX projection, draws editable paragraphs and preserved blocks, undoes the last local text change, and commits through the host. `apps/web/src/editors/docs-entry.tsx` wires that mount to the HTTP editor host.

The round-trip test uploads a DOCX, changes `Hello` to `Hello there`, undoes that edit, saves again, mounts a fresh editor, and checks the reopened text. The saved package still contains `CellKeep` and `SECRET-HEADER`.

## Web desktop bridge

`createWebDesktop` is the browser replacement for `window.desktop` on the file, font, print, and clipboard calls this slice owns.

- Open and save go through the supplied host. The returned value is a one-shot data URL plus a SHA-256, not a local filesystem path.
- Unknown methods, printer enumeration, PDF export, and image clipboard writes throw `UNSUPPORTED`. They do not resolve as success.
- `fontAliases` returns only the configured fallback chain. An unknown family returns an empty list, and `fontMetrics` returns null, so a missing font is not reported as installed.
- `print` calls the browser print callback and returns `{ ok: true }` with no output path. Without a print callback it throws.

```sh
node --import tsx --test apps/web/test/web-desktop.test.mjs
```

This was red while `web-desktop.ts` was missing and green after the bridge existed.

## Plain table cells

A table whose every cell is one plain paragraph is editable. The save patches that cell with `patchTableCellTexts` and leaves the surrounding `w:tbl` / `w:tr` / `w:tc` bytes in place. A plain-text rewrite of the whole table is still rejected. The mounted editor exposes one field per cell, undoes the cell edit, saves, and reopens the package through `parseDocx`.

This was red while the projection omitted `cells` (`table.cells` was `undefined`) and green after the patch path existed.

```sh
node --import tsx --test --test-name-pattern 'plain table cell|rewrites a table cell' apps/web/test/docx-editor.test.mjs apps/web/test/docs-mount.test.mjs
```

## Pagination

`computePageSlices` places measured blocks onto pages. Two 80px blocks in a 100px content height produce two pages, and the second page starts at or after the first page ends. This does not claim that Node `@genoffice/font-metrics` matches Word's line heights.

```sh
node --import tsx --test apps/web/test/pagination.test.mjs
```

The import failed before the path pointed at `apps/docs/src/renderer/pagination-slices.ts`, then the assertion passed.

## Still open, and what is deferred

The GenOffice Docs ribbon `App` is not mounted. `Ribbon` takes the live tiptap editor, section, watermark, ink, and Zotero callbacks, and `App` is the desktop shell around that editor. `createWebDesktop` throws `UNSUPPORTED` for those desktop-only calls instead of reporting success. Putting that shell into the scanned web bundle would also import `@genoffice/font-metrics`, which reads font files with Node. That mount is still T07 work.

An external Word or LibreOffice reopen is deferred to operations. This environment has neither `soffice` nor `libreoffice`, so a Word process cannot be started here. The in-repo reopen is `parseDocx` on the saved package, which is what the cell test checks. It is not a Word compatibility sample.
