# T07 browser DOCX mount

> 2026-11-16 · First browser round trip. Not the desktop Docs ribbon, not pagination, and not an external Word reopen.

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

## Still inside T07

The GenOffice Docs ribbon `App` is not mounted. It calls dozens of desktop methods for tabs, Zotero, CLI, model settings, and export. The bridge now rejects those instead of pretending they worked. Mounting the ribbon page still has to be wired to this bridge without importing Node font metrics into the browser bundle. Pagination is not claimed, because `@genoffice/font-metrics` reads font files with Node and metric parity is not proven. In-table text is shown and preserved; the save path does not rewrite table cells as plain text. An external Word reopen needs a machine with Word and is an operations check, not something this environment can execute.
