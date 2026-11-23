# Contributing to DyOffice

Thanks for your interest in contributing. This document covers the local
setup, the checks a change must pass, and the conventions used in this
repository.

## Repository layout

- `apps/web` contains the browser workspace, Web API, and document worker.
- `apps/docs`, `apps/sheets`, `apps/slides`, and `apps/shell` supply editor and shell components used by the Web build.
- `packages/*` contains reusable document engines, AI providers, and UI libraries.
- `apps/sheets/native/xlsx-engine` contains the Rust spreadsheet engine.

## Engine packages

- `packages/docx-engine` — docx parsing → block tree (with `docxIndex`
  anchors and passthrough), OOXML fragment generation, byte-level paragraph
  patching.
- `packages/pptx-engine` / `packages/pptx-render` — pptx model and rendering.
- `packages/pdf2docx` — local PDF → DOCX conversion: PDFium character-level
  extraction, pure-geometry layout analysis, rebuild through `docx-engine`;
  the same analysis drives the PDF app's PowerPoint and Excel exports.
- `packages/html2docx` — local HTML → DOCX conversion: the page is rendered in
  the app's own Chromium, reduced in-browser to a document intent tree, and
  written as native OOXML with the `docx` library; only visuals with no Word
  counterpart are screenshotted. Drives the HTML app's Export as Word.
- `packages/hwp2docx` — local HWP/HWPX → DOCX conversion: HWPX (OWPML)
  parsed directly, binary `.hwp` read through rhwp (MIT, WebAssembly) into
  HWPX first; character and paragraph shapes, tables, pictures, sections,
  headers and footers rebuilt through `docx-engine`, anything else counted
  in `dropped`. Docs opens `.hwp`/`.hwpx` through it as converted `.docx`
  copies, like `.odt`.
- `packages/file-parse` — text extraction for AI attachments (office formats,
  text formats).
- `packages/agent-core` — the AI agent loop and skill composition shared by
  every app.
- `packages/ai-provider` — provider abstraction and streaming for the model
  backends.
- `packages/ai-search` — Genspark auth + web/image search tools.
- `packages/i18n`, `packages/ui`, `packages/project-store`,
  `packages/electron-utils` — shared i18n core, React UI kit, recent-files
  store, and Electron main-process helpers.

### Architecture notes (docx round trip)

```
open docx ─► archive original by hash (never touched)
          ─► docx-engine parses word/document.xml top-level elements (w:p / w:tbl / …)
          ─► Block tree, each block anchored by docxIndex + original XML slice
          ─► Tiptap streaming editor (manual + AI editing, dirty tracking)
save      ─► dirty blocks → OOXML fragments (referencing existing styles only)
          ─► splice into original document.xml (untouched blocks keep original bytes)
          ─► repack zip; all other entries copied byte-for-byte
```

The same philosophy holds in sheets and slides: the original file is the
source of truth, edits are applied as narrow patches, and everything the
editor didn't touch survives the round trip untouched.

## Getting started

Follow the [Web setup guide](apps/web/README.md#run-dyoffice-web) for the Node
and npm requirements, install commands, and runtime environment variables.
Run `npm run fixtures` after changing the DOCX engine fixtures.

## Checks every change must pass

CI runs these on every PR; please run them locally first:

```bash
npm run format:check # Prettier check for uncommitted changed/new files
npm run lint         # ESLint across the repo (0 errors required; warnings allowed)
npm run typecheck    # shared packages and Web entrypoints
npm test             # SaaS entrypoints, shared packages, and Web tests
npm run licenses     # production dependency licenses within the permissive allowlist
```

Formatting is intentionally incremental: existing files are not reformatted
unless they are part of your change. Run these exact commands before committing:

```bash
npm run format                              # format uncommitted changed/new files
npm run format:check                        # verify uncommitted changed/new files
npm run format:check -- --base origin/main  # verify committed files on your branch
```

CI supplies the PR or push base automatically and checks only files changed from
that base. This keeps the formatter gate useful without creating a repository-wide
formatting diff.

## Coding conventions

- **English only** in code, comments, commit messages, and docs. User-facing
  strings go through the i18n resources (`src/renderer/i18n/`, plus the inline
  main-process dictionaries in `src/main/`), which are the only places
  non-English text belongs (plus test fixture text).
- TypeScript everywhere; avoid adding new `any` surfaces where a precise type
  is cheap.
- Web tests live in `apps/web/test`. Shared browser layout checks use Playwright
  in `e2e` and run in CI.

- Keep files from growing without bound: if you are adding a substantial new
  concern to an already-large file, prefer a new module.

## Commit and PR guidelines

- Small, focused commits with imperative English subject lines
  (e.g. `fix docx table border round-trip`, `add slides chart legend parsing`).
- A PR should explain _why_ the change is needed, and mention which of the
  checks above you ran.
- File format fidelity is the core product promise: for changes touching
  open/save paths (docx/xlsx/pptx), include a round-trip test proving
  untouched content survives byte-for-byte.

## Reporting bugs and requesting features

Use the issue templates. For suspected security issues, do **not** open a
public issue — follow [SECURITY.md](SECURITY.md).

## Code of conduct

All community spaces follow the
[Contributor Covenant](CODE_OF_CONDUCT.md); participation implies acceptance.

## License and CLA

There is no CLA (contributor license agreement), and we do not plan to add
one. By contributing, you agree that your contributions are licensed under
the [Apache License 2.0](LICENSE) that covers this project — inbound =
outbound, per Apache-2.0 §5. Because community contributions keep their
Apache-2.0 terms, the open-source core cannot be retroactively relicensed.

The `ee/` directory is reserved for future enterprise modules under a
[separate license](ee/LICENSE) and does not accept external contributions —
pull requests from outside the maintainer team must not modify files under
`ee/` (enforced via [CODEOWNERS](.github/CODEOWNERS)).
