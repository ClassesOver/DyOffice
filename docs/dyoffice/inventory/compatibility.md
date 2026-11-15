# T00 dependency and compatibility input baseline

This records **source inputs**, not completed native/browser compatibility acceptance.
The machine-readable [compatibility-lock.json](compatibility-lock.json) contains SHA-256
and byte counts for manifests, lockfiles, native build configuration and bundled font
bytes. It also records selected resolved npm versions/integrity and both Cargo lock
package lists. It does not change dependency versions or silently unify separate locks.

## Reproduce and review drift

Run from the repository root, using Node (no dependency installation is required):

```sh
node --test tools/dyoffice/compatibility-baseline.test.mjs
node tools/dyoffice/compatibility-baseline.mjs --check
```

A changed, missing, or added covered input fails the check. To intentionally accept
new inputs, review the dependency/font/native change first, run `--write`, inspect
the JSON diff and rerun the checks. `--check` never writes the baseline. A matching
snapshot only proves input identity; it does not prove that the files are safe or
that a native binary works. The Web CI gate runs the checker regressions and
read-only baseline validation,
including on root-lock, license, font, checker and baseline changes. This is still
only a T00 input-consistency gate; later deployment work should consume the manifest
rather than equating it with runtime acceptance, an SBOM or an image digest.

## Inspected versions and execution boundaries

| Input | Resolved/declaration | What is actually established | Remaining verification |
| --- | --- | --- | --- |
| Root runtime requirement | Node `>=22.12.0`, npm `>=10` | Declared in root package manifest | Pin production Node image/digest and run supported-runtime matrix |
| Verification host | Node 24.22.1, Linux | This task's standalone checks and Web regressions execute here | CI Node 22 and production runtime still require their own results |
| TypeScript | Root and Web locks 5.9.3 | Exact lock input available | Does not establish whole-repo typecheck success |
| MCP SDK | Root lock 1.32.1; Web lock 1.32.2 | Two different installation contexts; Web server uses `apps/web` install | Do not claim protocol/client compatibility from package version or mocked handshake |
| Web start/test scripts | `apps/web/package.json` scripts only | `dev`, `start`, and `test` load `tsx` so the server can import the DOCX engine sources. Locked dependency versions in that manifest are unchanged | `tsx` comes from the workspace install. The boundary workflow uses `npm ci --ignore-scripts` and does not run Electron's postinstall |
| Electron | Root lock 43.8.3 | Desktop dependency retained upstream | Web must not need Electron runtime; desktop version is not a server ABI guarantee |
| Univer | `@univerjs/core` 0.25.1 | Existing spreadsheet UI dependency | Browser adapter, formula persistence and real Excel reopen pending |
| PDF | PDFium 2.15.1, PDF.js 6.2.108, pdf-lib 1.17.1 | Parser/renderer package identities | WASM assets/workers/CSP, fonts and genuine text edit/export pending |
| XLSX sidecar | Rust edition 2024; calamine 0.37.0, ironcalc 0.9.1, zip 9.1.0 | Cargo lock and explicit build config exist | Compiler toolchain, target/ABI, worker sandbox and native roundtrip pending |
| Windows clipboard helper | Separate Cargo manifest/lock/config | Desktop-only native component is independently tracked | Not a Web feature; do not launch or expose local clipboard commands from the server |

The XLSX build passes `.cargo/config.toml` explicitly, because its working directory
is `apps/sheets`, not the native crate directory. Windows x64/ARM64 targets request
static MSVC CRT linking. Preserve this upstream configuration; it is not evidence
of Linux container compatibility or successful Windows execution. No pinned Rust
toolchain or production image manifest was found in the scoped native sources.
`cargo`/`rustc` are unavailable on the verification host, so native compilation and
native tests are **blocked**, not passed.

## Fonts, licenses and provenance

The baseline includes 66 `.ttf`/`.otf`/`.woff`/`.woff2` assets under the actual bundled
font roots `apps/docs/src/renderer/fonts` and `packages/ui/src/fonts`, plus the font
README, bundled OFL license text and root NOTICE/LICENSE. Font byte changes, additions, deletions and renames
are detected. A content hash is not a license review.

[The upstream font README](../../../apps/docs/src/renderer/fonts/README.md) documents
Carlito/Liberation OFL and Caladea Apache provenance, derived-font naming and build
scripts. [NOTICE](../../../NOTICE) also identifies downloadable font catalogues and
explains that the release third-party notices are generated at packaging time.
Downloaded/system fonts, customer's fonts, generated runtime caches and host font
configuration are not covered by this bundled-input manifest. T00/T21/T23 must still
verify license texts and generated NOTICE/SBOM in the actual deliverable, and verify
font metric/rendering behavior in the selected browser/worker images.

## What remains open before T00 is complete

- Complete the per-IPC/per-tool call inventory: every bridge member now has a
  proposed class in [host-ipc.md](host-ipc.md); signatures/error modes and the
  agent tool live/headless split are still open.
- Build and exercise the actual browser host, not only a file-import scaffold.
- Lock validated Node/Rust/worker image/architecture choices, including font assets,
  after native/WASM spikes; no image digest is invented in this baseline.
- Run affected upstream tests, native sidecar tests, four-format round trips and
  external Office reopening. Results must distinguish passed, failed, blocked and
  not run.
- Run real MCP target-client/version, model and data-source acceptance separately.

No product capability or implementation-plan checkbox is marked complete by this
input manifest. Its useful guarantee is narrow: reviewers can tell exactly which
covered dependencies, native build inputs and bundled font bytes changed.
