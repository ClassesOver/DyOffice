# SaaS-only decoupling: product entrypoints

## Decision and boundary

DyOffice is a SaaS product, not a desktop application. This first stage changes
root product commands; it is not a claim that every desktop dependency has been
removed. It does not enable production isolation or change database migrations,
authentication, document data, or host security settings.

The previous default commands launched Electron and built installers. The new
commands are:

| Command | Current behavior |
| --- | --- |
| `npm run dev` / `npm start` | Existing Web Node entrypoint |
| `npm run build` / `npm run build:all` | Web shell (including PDF), DOCX, XLSX and PPTX browser bundles plus XLSX server gateway |
| `npm run build:web` | Web shell only, unchanged |
| `npm run build:web:native` | Explicit existing server-side XLSX native runtime build; not automatically installed or enabled |
| `npm run test:saas:entrypoints` | Default command boundary regression |

Root `predev`, `postinstall`, `shell`, `dev:docs`, and `dist:mac/win/linux`
product commands are removed, not renamed as a desktop compatibility offering.
Root `test` runs the shared-package suite, Web HTTP suite, Web unit suite and
entrypoint guard. Root `typecheck` runs shared-package checks and Web, DOCX,
XLSX, PPTX and browser-shell entrypoint checks. Removed desktop workspace suites
are not silently presented as tested. Real PostgreSQL, Rust worker, end-to-end
browser and sandbox tests retain their explicit dedicated commands.

## Installation and dependency boundary

The active workspaces are Web, the three shared Office editor source workspaces,
the shared shell UI workspace, Markdown source workspace consumed by the headless
CLI, and packages. Desktop-only PDF/HTML app workspaces are excluded; their
reusable engines remain packages. Markdown renderer sources are still imported
by CLI conversion and must not lose their declared dependencies. Electron,
electron-builder, electron-vite and electron-updater dependencies and launch/
installer metadata were removed from active workspace manifests. The npm-generated
root lockfile no longer resolves these desktop runtime or packaging packages.
`electron-utils` is retained because browser/editor paths reuse selected helpers;
its legacy desktop-only files are not in the Web build/typecheck closure.
`electron-to-chromium`
is browser-version compatibility data, not an Electron runtime.

A fresh root `npm ci` without `--ignore-scripts` is supported. Explicit build
steps still apply to Rust workers and approved analysis runtimes. Installing
JavaScript dependencies does not activate production isolation or a worker.
Web's unit tests now declare their Tiptap core/pm/document/text/bold imports
explicitly rather than depending on incidental packages from retired workspaces.

## Keep and extract, do not delete wholesale

- `apps/docs/src/renderer`, `apps/sheets/src/renderer` and Slides renderer code
  are reused by Web entrypoints. Keep editor commands, collaboration and UI.
- `apps/sheets/native/xlsx-engine` is a service-side engine used by
  `tools/dyoffice/build-native-sandbox.mjs`. It is not the desktop shell.
- `packages/electron-utils` mixes shared helpers with desktop runtime/type imports
  (for example drop-open, renderer-protocol, app-menu). Its package description
  is not a safe boundary. Shared/desktop export separation must pass the full
  retained package tests and typechecks before this stage is merge-ready.
- Web `local-shell` is browser UI, not the Electron `apps/shell` product.
- CLI/agent-core/analysis-runtime are server or agent components; their ability
  to spawn authorized server tasks does not make them desktop components.

## Next independent stages

1. Move reused renderer/host contracts into clearly named browser/server
   packages. Current relative source paths still reference apps/docs, sheets,
   slides and shell; these paths are not proof that Electron executes.
2. Remove now-inactive desktop main/preload/IPC/auto-update source and obsolete
   release instructions only after tracing every shared consumer. They are not
   supported entrypoints; their on-disk presence is a remaining cleanup item.
3. Validate the full authenticated server/worker flows and browser behavior.
   Bundle builds and unit tests are not Office feature parity or real production
   sandbox acceptance. Existing unsupported runtime capabilities remain closed.

No desktop user profile, local document, production data, database ledger or
remote deployment is deleted by this stage.
