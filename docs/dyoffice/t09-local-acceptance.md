# T09 local browser and Excel acceptance

This is a disposable local acceptance environment. It reuses the actual Sheets
renderer, restricted PostgreSQL roles, File API, T06 revision commits and native
systemd sandbox. It is not the production startup path. The controller requires
root; native jobs still execute as bounded, isolated nonroot users.

## Prepare

Use the `feat/t09-native-sheets` branch and an isolated PostgreSQL 17 test
instance. `DYOFFICE_TEST_DATABASE_URL` must name a loopback `dyoffice_test` or
`dyoffice_test_*` database. Its test administrator must be able to create/drop
disposable databases and roles. Do not use a production database.

From the repository root, install and build as your regular user:

```sh
npm ci --ignore-scripts --include=dev
RUSTUP_DIST_SERVER=https://rsproxy.cn \
  RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup \
  rustup toolchain install 1.93.0 --profile minimal
RUSTUP_TOOLCHAIN=1.93.0 npm run build:web:native -- --with-probe
npm run build:sheets --workspace=@dyoffice/web
```

The compiler, source hash and executable hash are recorded in
`.dyoffice-native-build/host-manifest.json`. For local acceptance only, an
already-installed stable compiler supporting edition 2024 can be used with
`RUSTUP_TOOLCHAIN=stable`; record its actual version and keep CI pinned to 1.93.0.
The acceptance launcher validates
the executable hash before startup; it does not run a different native backend
when the manifest or root permissions are missing.

## Start

Set `DYOFFICE_TEST_DATABASE_URL` through your local test configuration, then run:

```sh
sudo --preserve-env=DYOFFICE_TEST_DATABASE_URL,DYOFFICE_TEST_HOST_MANIFEST \
  "$(command -v node)" --experimental-strip-types \
  tools/dyoffice/acceptance-sheets.mjs
```

`sudo` prompts in your terminal if needed. Do not send your password to an
assistant or put it into a script. For a preflight only, append `--check`.

The launcher binds to **https://127.0.0.1:3443/**. Its one-day self-signed
certificate is only for this loopback test. It prints a disposable `alice`
account and test password. Log in through the form; the page uses the normal
CSRF challenge, password login and Secure Cookie flow. It imports the hashed
`apps/web/test/fixtures/sheets/acceptance.xlsx` fixture into that account's
workspace. It does not inject a session cookie or disable authentication.

Keep the process running during acceptance. Ctrl+C closes the server and removes
its temporary object files, gateway build, test database and roles. Download your
saved workbook before stopping it. If the process is forcibly killed, inspect
its disposable test resources rather than assuming cleanup completed.

## Verify in the browser

1. The original Sheets/Univer editor opens with the Editing status.
2. Before editing: A2 is 12.5; B2 is `=A2*2` with calculated value 25. The fixture
   intentionally contains a stale cache of 999, which must not be displayed as
   the calculated result.
3. Change A2 to 21.25. B2 must become 42.5. F2, `=SUM(Revenue)`, must also reflect
   the change through its named range; its original calculated value was 20.
4. C2 retains serial 45292 / date **2024-01-01**; D2 displays **12.50%**; E2
   retains raw 1234.567 and displays **1234.57 kg**.
5. Use Undo/Redo, save with Ctrl+S, then reload. A2 must still be 21.25.
6. Download using **Download saved version**. This downloads the committed
   revision, not the unsaved browser model.

The standard acceptance workbook has a chart, not an image. Image display is a
separate outstanding acceptance item; media-byte integration tests alone do not
prove browser image display.

## Verify in Microsoft Excel

Open the **downloaded edited workbook** in actual Microsoft Excel. Record the
Excel version, workbook SHA-256, any repair/security dialogs, the cell/formula
checks above, the Revenue defined name and the chart. Reopen an Excel-saved copy
and check that these remain editable. Do not substitute a parser, LibreOffice or
the original unedited fixture for this gate.

A passing automated CI run is not external Excel acceptance. Keep PR #30 draft
until the external acceptance and outstanding browser image verification are
recorded in `docs/dyoffice/evidence/t09-runtime.md`.

## Current validation

The launcher has passed Node syntax checking and its prerequisite failure path
was exercised without root/a native build. Its successful startup, interactive
flow and cleanup still require a root-capable local run. The renderer build
passed independently. See PR #30 checks for automated renderer/native regression
results; this runbook makes no claim that local Excel verification has occurred.
