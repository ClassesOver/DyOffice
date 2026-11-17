# Desktop packaging retirement and SaaS notices inventory

## Removed product entrypoints

The seven standalone Electron main bootstraps and Electron Vite configurations
are removed. Inactive HTML/PDF workspace manifests no longer advertise Electron
launch/build entrypoints or dependencies. The obsolete preload rebuild hook,
Electron builder, signing/notarization hooks and OS installer/uninstaller scripts
are removed as source files. None of those system-changing scripts was executed.

The old Flatpak, Nix and Docker recipes wrapped downloaded desktop release
binaries. They are removed, not repurposed as SaaS deployment recipes. This does
not remove or weaken the SaaS isolation broker, approved OCI runtime work, or
server-side XLSX engine.

Pure packaging tests are retired with the interfaces they tested. Empty Office
template parsing tests remain and now read the same fixtures directly without
loading an installer. PDFium wrapper/binary license assertions moved into the
new notices inventory test suite.

## Shared sources deliberately retained

Web still imports workbook-redactions, and the headless CLI still imports the
XLSX sidecar client and atomic writer from apps/sheets/src/main. These modules
and their shared desktop-api type contract remain intact. Renderer components,
CSS, fonts, blank Office templates and user document formats are unchanged.

The rest of main/preload and historical desktop test sources are not all deleted
in this stage. Before removing them, classify shared contracts and move shared
server/browser logic to neutral packages. No user profile, local document,
server data directory, credential store or database journal is touched.

## Notices do not depend on an installer

`npm run notices` now writes an explicit inventory to:

- artifacts/notices/THIRD-PARTY-INVENTORY.txt
- artifacts/notices/inventory-status.json

The inventory uses each installed npm lock path, preserving multiple installed
versions instead of resolving a package name only once. It includes build/test
dependencies conservatively; it is not yet an exact distributed artifact SBOM.
Missing required packages, lock-version mismatches and unavailable license texts
are errors. Missing optional platform packages are separately reported. Full
license text is not replaced by an SPDX identifier or copyright summary.

Existing fonts, Unicode, PDFium and supplementary NOTICE content are preserved.
Cargo metadata uses only `--offline --locked`. Incomplete native metadata causes
a nonzero command result even if JavaScript inventory errors are absent. Existing
historical notice files are not overwritten or removed.

## Real outstanding release blockers

The local inventory currently has 899 installed package records and 125 omitted
optional platform records. Forty packages have no readable full license text.
Native offline metadata is unavailable in the current command environment.
The command therefore exits 1 and records `distributionReady: false`.

These are unresolved distribution-evidence gaps, not waived obligations. Before
shipping, obtain the relevant license/NOTICE texts for the exact artifact
versions and verify native/WASM/runtime-image/OS materials and final asset
coverage. A completed installed-package inventory alone is not distribution
approval. This change does not enable production release or deployment.

## Validation

Focused retirement and inventory tests cover 11 cases. Shared empty Office
fixtures retain three parsing tests. Four-format builds and Web regression
checks remain required. Browser/OS isolation and any external-service CLI test
are separate; no previously refused test path is retried in this stage.
