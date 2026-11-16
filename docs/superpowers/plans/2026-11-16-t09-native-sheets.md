# T09 native Sheets Web implementation plan

> Use superpowers:executing-plans inline; retain one fresh-context review at completion.

**Goal:** Close T09 with the original Univer/gateway/Rust edit-save-reopen path and real Excel acceptance.

**Architecture:** Browser reuses original Sheets renderer/tools; authenticated server adapters own Node gateway operations and isolated native execution. T06 owns revisions and edit leases.

**Tech Stack:** React, Univer, TypeScript, existing xlsx-gateway, Rust, Fastify, PostgreSQL, BullMQ, systemd, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-t09-native-sheets.md`

## Constraints

No Docker, alternate XLSX writer, exposed host paths, invented fidelity results, or weakened authorization. Preserve desktop behavior and T08 invariants. Keep PR21 integration separate. Run heavy suites sequentially on this host.

## 1. Trace native lifecycle and freeze acceptance fixtures

- [ ] Map preload methods used during real App mount/open/read/edit/save and gateway/native dependencies; identify reusable server modules and explicit host capability seams.
- [ ] Add hashed fixture(s) containing formulas with stale cache, dates, percentages, units/raw values, names, charts and an unknown part.
- [ ] Add real browser open/edit/save/reopen acceptance and observe RED before implementing the entry.

## 2. Authorized native workbook operations

- [ ] Test owned revision capture, session scope, bounded reads/edits, lease loss, stale base, cancellation and output fencing (RED).
- [ ] Adapt original gateway/planner and Rust protocol through T08; provide authenticated file/revision-based requests, preserve original archive and T06 commits.
- [ ] Verify edited formula/numeric/style/name/chart output and preservation against original fixtures; regress native/gateway suites.

## 3. Mount the native Sheets editor

- [ ] Implement `apps/web/src/editors/sheets-entry.tsx` exporting `mountSheetsEditor()` and the necessary explicit renderer host seam/bridge.
- [ ] Wire open/read/save, preferences, capabilities, loading/error/lease/conflict state using existing conventions.
- [ ] Reuse existing tool dispatch and batch undo; verify edits and undo through the actual browser editor.
- [ ] Add browser build/static routing and scoped entry configuration without importing Node into the browser graph.

## 4. Closure

- [ ] Pass browser E2E and affected Sheets/xlsx-gateway/native regression; type, boundary, baseline and appropriate API/security regressions.
- [ ] Reopen exported fixtures in connected Excel; check formulas, formats, names, charts and values and record exact evidence.
- [ ] Fresh-context final review; fix findings, document acceptance and commit `feat(sheets): adapt native workbook editing to web`.
